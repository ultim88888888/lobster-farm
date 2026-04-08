/**
 * Tests for CI check gating (#189).
 *
 * Covers:
 * - check_ci_status() with various check states
 * - workflow_run webhook event handling (deploy failure notifications)
 *
 * Uses the same command-routing mock pattern as auto-rebase.test.ts.
 */

import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Command routing for check_ci_status tests ──

type ExecRoute = (
  args: string[],
  opts: Record<string, unknown>,
) => { stdout: string; stderr?: string } | Error;

const routes: Record<string, ExecRoute> = {};

function find_route_key(cmd: string, args: string[]): string | null {
  const tokens = [cmd, ...args.slice(0, 3)];
  for (let len = tokens.length; len > 0; len--) {
    const candidate = tokens.slice(0, len).join(" ");
    if (routes[candidate] !== undefined) return candidate;
  }
  return null;
}

function route_exec(new_routes: Record<string, ExecRoute>): void {
  for (const key of Object.keys(routes)) delete routes[key];
  Object.assign(routes, new_routes);
}

// ── Mock node:child_process ──

vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");

  const promisified = async (
    cmd: string,
    args: string[],
    opts: Record<string, unknown> = {},
  ): Promise<{ stdout: string; stderr: string }> => {
    const key = find_route_key(cmd, args);
    if (!key) {
      throw new Error(`Unmocked command: ${cmd} ${args.join(" ")}`);
    }
    const result = routes[key]!(args, opts);
    if (result instanceof Error) throw result;
    return { stdout: result.stdout, stderr: result.stderr ?? "" };
  };

  const stub = (..._args: unknown[]) => {
    throw new Error("execFile mock: use promisify, not direct calls");
  };
  (stub as unknown as Record<symbol, unknown>)[promisify.custom] = promisified;

  return { execFile: stub };
});

// ── Mocks for webhook handler tests ──

vi.mock("../worktree-cleanup.js", () => ({
  cleanup_after_merge: vi.fn(async () => {}),
}));

vi.mock("../sentry.js", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

vi.mock("../actions.js", () => ({
  detect_review_outcome: vi.fn(async () => "approved"),
}));

vi.mock("../issue-utils.js", () => ({
  extract_first_linked_issue: vi.fn(() => null),
  extract_linked_issues: vi.fn(() => []),
  fetch_issue_context: vi.fn(async () => ""),
  close_linked_issues: vi.fn(async () => []),
  nwo_from_url: vi.fn(() => "test-org/lobster-farm"),
}));

// Mock persistence — CI fix loop uses pr_reviews, deploy triage uses deploy_triage (#196, #199)
vi.mock("../persistence.js", () => ({
  load_pr_reviews: vi.fn(async () => ({})),
  save_pr_reviews: vi.fn(async () => {}),
  load_deploy_triage: vi.fn(async () => ({})),
  save_deploy_triage: vi.fn(async () => {}),
}));

import type { DiscordBot } from "../discord.js";
import type { GitHubAppAuth } from "../github-app.js";
import type { EntityRegistry } from "../registry.js";
// Import after mocks are registered
import { check_ci_status } from "../review-utils.js";
import type { ClaudeSessionManager } from "../session.js";
import { type WebhookContext, handle_github_webhook } from "../webhook-handler.js";

// ── check_ci_status tests ──

describe("check_ci_status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(routes)) delete routes[key];
  });

  it("returns passed when all checks succeed", async () => {
    route_exec({
      "gh pr checks": () => ({
        stdout: JSON.stringify([
          { name: "Lint", state: "COMPLETED", conclusion: "SUCCESS" },
          { name: "Build", state: "COMPLETED", conclusion: "SUCCESS" },
          { name: "Test", state: "COMPLETED", conclusion: "SUCCESS" },
        ]),
      }),
    });

    const result = await check_ci_status(42, "/tmp/test-repo");

    expect(result.passed).toBe(true);
    expect(result.pending).toBe(false);
    expect(result.failures).toEqual([]);
  });

  it("returns pending when checks are still running", async () => {
    route_exec({
      "gh pr checks": () => ({
        stdout: JSON.stringify([
          { name: "Lint", state: "COMPLETED", conclusion: "SUCCESS" },
          { name: "Build", state: "IN_PROGRESS", conclusion: "" },
          { name: "Test", state: "PENDING", conclusion: "" },
        ]),
      }),
    });

    const result = await check_ci_status(42, "/tmp/test-repo");

    expect(result.passed).toBe(false);
    expect(result.pending).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("returns failures when checks have failed", async () => {
    route_exec({
      "gh pr checks": () => ({
        stdout: JSON.stringify([
          { name: "Lint", state: "COMPLETED", conclusion: "FAILURE" },
          { name: "Build", state: "COMPLETED", conclusion: "SUCCESS" },
          { name: "Test", state: "COMPLETED", conclusion: "FAILURE" },
        ]),
      }),
    });

    const result = await check_ci_status(42, "/tmp/test-repo");

    expect(result.passed).toBe(false);
    expect(result.pending).toBe(false);
    expect(result.failures).toEqual(["Lint", "Test"]);
  });

  it("returns passed when no checks are configured", async () => {
    route_exec({
      "gh pr checks": () => ({
        stdout: JSON.stringify([]),
      }),
    });

    const result = await check_ci_status(42, "/tmp/test-repo");

    expect(result.passed).toBe(true);
    expect(result.pending).toBe(false);
    expect(result.failures).toEqual([]);
  });

  it("treats NEUTRAL and SKIPPED conclusions as passing", async () => {
    route_exec({
      "gh pr checks": () => ({
        stdout: JSON.stringify([
          { name: "Lint", state: "COMPLETED", conclusion: "NEUTRAL" },
          { name: "Deploy", state: "COMPLETED", conclusion: "SKIPPED" },
          { name: "Build", state: "COMPLETED", conclusion: "SUCCESS" },
        ]),
      }),
    });

    const result = await check_ci_status(42, "/tmp/test-repo");

    expect(result.passed).toBe(true);
    expect(result.pending).toBe(false);
    expect(result.failures).toEqual([]);
  });

  it("returns pending when gh pr checks command fails (infrastructure error)", async () => {
    route_exec({
      "gh pr checks": () => new Error("API rate limit exceeded"),
    });

    const result = await check_ci_status(42, "/tmp/test-repo");

    expect(result.passed).toBe(false);
    expect(result.pending).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("passes GH_TOKEN in environment when provided", async () => {
    let captured_env: Record<string, unknown> | undefined;

    route_exec({
      "gh pr checks": (_args, opts) => {
        captured_env = opts.env as Record<string, unknown>;
        return { stdout: JSON.stringify([]) };
      },
    });

    await check_ci_status(42, "/tmp/test-repo", "ghs_test_token");

    expect(captured_env).toBeDefined();
    expect(captured_env!.GH_TOKEN).toBe("ghs_test_token");
  });

  it("handles QUEUED state as pending", async () => {
    route_exec({
      "gh pr checks": () => ({
        stdout: JSON.stringify([{ name: "Build", state: "QUEUED", conclusion: "" }]),
      }),
    });

    const result = await check_ci_status(42, "/tmp/test-repo");

    expect(result.passed).toBe(false);
    expect(result.pending).toBe(true);
    expect(result.failures).toEqual([]);
  });
});

// ── Webhook handler workflow_run tests ──

const WEBHOOK_SECRET = "test-secret-for-ci-gating";

function sign_payload(payload: string): string {
  const hmac = createHmac("sha256", WEBHOOK_SECRET).update(payload).digest("hex");
  return `sha256=${hmac}`;
}

function make_request(body: string, headers: Record<string, string> = {}): IncomingMessage {
  const emitter = new EventEmitter();
  const req = emitter as unknown as IncomingMessage;
  req.headers = { ...headers };

  process.nextTick(() => {
    emitter.emit("data", Buffer.from(body));
    emitter.emit("end");
  });

  return req;
}

function make_response(): ServerResponse & { _status: number; _body: string } {
  const res = {
    _status: 0,
    _body: "",
    writeHead(s: number, _headers: Record<string, string>) {
      res._status = s;
    },
    end(data: string) {
      res._body = data;
    },
    headersSent: false,
  } as unknown as ServerResponse & { _status: number; _body: string };
  return res;
}

function make_github_app(): GitHubAppAuth {
  return {
    verify_signature: vi.fn((payload: string, sig: string) => {
      const expected = createHmac("sha256", WEBHOOK_SECRET).update(payload).digest("hex");
      return sig === `sha256=${expected}`;
    }),
    get_token: vi.fn().mockResolvedValue("ghs_mock_token"),
    get_token_for_installation: vi
      .fn()
      .mockImplementation((id: string) => Promise.resolve(`ghs_install_${id}`)),
  } as unknown as GitHubAppAuth;
}

function make_registry(): EntityRegistry {
  return {
    get_active: vi.fn().mockReturnValue([
      {
        entity: {
          id: "test-entity",
          repos: [
            {
              name: "lobster-farm",
              url: "https://github.com/test-org/lobster-farm.git",
              path: "/tmp/test-repo",
            },
          ],
        },
      },
    ]),
  } as unknown as EntityRegistry;
}

function make_discord(): DiscordBot {
  return {
    send_to_entity: vi.fn().mockResolvedValue(undefined),
  } as unknown as DiscordBot;
}

function make_session_manager(): ClaudeSessionManager {
  const emitter = new EventEmitter();
  const manager = Object.assign(emitter, {
    spawn: vi.fn().mockResolvedValue({
      session_id: "test-session-123",
      entity_id: "test-entity",
      feature_id: "pr-review-42",
      archetype: "reviewer",
      started_at: new Date(),
      pid: 12345,
    }),
    get_active: vi.fn().mockReturnValue([]),
  });
  return manager as unknown as ClaudeSessionManager;
}

function make_context(overrides: Partial<WebhookContext> = {}): WebhookContext {
  return {
    github_app: make_github_app(),
    session_manager: make_session_manager(),
    registry: make_registry(),
    discord: make_discord(),
    config: {
      paths: { lobsterfarm_dir: "/tmp/test-lf", projects_dir: "/tmp" },
    } as WebhookContext["config"],
    pool: null,
    pr_watches: null,
    ...overrides,
  };
}

describe("webhook handler — workflow_run events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("sends alert when workflow_run fails on main from a push event", async () => {
    // Route commands needed by spawn_deploy_triage (log fetching)
    route_exec({
      "gh run list": () => ({
        stdout: JSON.stringify([{ databaseId: 123, name: "Deploy Backend" }]),
      }),
      "gh run view": () => ({
        stdout: "Error: deploy failed\n",
      }),
    });

    const payload = JSON.stringify({
      action: "completed",
      workflow_run: {
        id: 123,
        name: "Deploy Backend",
        conclusion: "failure",
        event: "push",
        head_branch: "main",
        head_sha: "abc123",
        html_url: "https://github.com/test-org/lobster-farm/actions/runs/123",
      },
      repository: { full_name: "test-org/lobster-farm" },
      installation: { id: 12345 },
    });

    const ctx = make_context();
    const req = make_request(payload, {
      "x-hub-signature-256": sign_payload(payload),
      "x-github-event": "workflow_run",
    });
    const res = make_response();

    await handle_github_webhook(req, res, ctx);

    // Wait for async route_event to process
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(res._status).toBe(200);
    const discord = ctx.discord as unknown as { send_to_entity: ReturnType<typeof vi.fn> };
    // Updated in #199: alert now mentions Gary triaging instead of a raw failure message
    expect(discord.send_to_entity).toHaveBeenCalledWith(
      "test-entity",
      "alerts",
      expect.stringContaining("Deploy failed on main"),
      "reviewer",
    );
    expect(discord.send_to_entity).toHaveBeenCalledWith(
      "test-entity",
      "alerts",
      expect.stringContaining("Gary triaging"),
      "reviewer",
    );
  });

  it("ignores workflow_run events with success conclusion", async () => {
    const payload = JSON.stringify({
      action: "completed",
      workflow_run: {
        name: "Deploy Backend",
        conclusion: "success",
        event: "push",
        head_branch: "main",
        html_url: "https://github.com/test-org/lobster-farm/actions/runs/456",
      },
      repository: { full_name: "test-org/lobster-farm" },
    });

    const ctx = make_context();
    const req = make_request(payload, {
      "x-hub-signature-256": sign_payload(payload),
      "x-github-event": "workflow_run",
    });
    const res = make_response();

    await handle_github_webhook(req, res, ctx);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(res._status).toBe(200);
    const discord = ctx.discord as unknown as { send_to_entity: ReturnType<typeof vi.fn> };
    expect(discord.send_to_entity).not.toHaveBeenCalled();
  });

  it("ignores workflow_run failures on non-main branches", async () => {
    const payload = JSON.stringify({
      action: "completed",
      workflow_run: {
        name: "CI",
        conclusion: "failure",
        event: "push",
        head_branch: "feature/test",
        html_url: "https://github.com/test-org/lobster-farm/actions/runs/789",
      },
      repository: { full_name: "test-org/lobster-farm" },
    });

    const ctx = make_context();
    const req = make_request(payload, {
      "x-hub-signature-256": sign_payload(payload),
      "x-github-event": "workflow_run",
    });
    const res = make_response();

    await handle_github_webhook(req, res, ctx);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(res._status).toBe(200);
    const discord = ctx.discord as unknown as { send_to_entity: ReturnType<typeof vi.fn> };
    expect(discord.send_to_entity).not.toHaveBeenCalled();
  });

  it("ignores workflow_run failures from pull_request events (not push)", async () => {
    const payload = JSON.stringify({
      action: "completed",
      workflow_run: {
        name: "CI",
        conclusion: "failure",
        event: "pull_request",
        head_branch: "main",
        html_url: "https://github.com/test-org/lobster-farm/actions/runs/101",
      },
      repository: { full_name: "test-org/lobster-farm" },
    });

    const ctx = make_context();
    const req = make_request(payload, {
      "x-hub-signature-256": sign_payload(payload),
      "x-github-event": "workflow_run",
    });
    const res = make_response();

    await handle_github_webhook(req, res, ctx);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(res._status).toBe(200);
    const discord = ctx.discord as unknown as { send_to_entity: ReturnType<typeof vi.fn> };
    expect(discord.send_to_entity).not.toHaveBeenCalled();
  });

  it("ignores workflow_run for unknown repos", async () => {
    const payload = JSON.stringify({
      action: "completed",
      workflow_run: {
        name: "Deploy",
        conclusion: "failure",
        event: "push",
        head_branch: "main",
        html_url: "https://github.com/unknown-org/unknown-repo/actions/runs/999",
      },
      repository: { full_name: "unknown-org/unknown-repo" },
    });

    const ctx = make_context();
    const req = make_request(payload, {
      "x-hub-signature-256": sign_payload(payload),
      "x-github-event": "workflow_run",
    });
    const res = make_response();

    await handle_github_webhook(req, res, ctx);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(res._status).toBe(200);
    const discord = ctx.discord as unknown as { send_to_entity: ReturnType<typeof vi.fn> };
    expect(discord.send_to_entity).not.toHaveBeenCalled();
  });
});

// ── Integration tests: review-completion → CI gating ──

describe("webhook handler — CI gating on review completion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  /**
   * Helper: send a PR webhook, wait for spawn, then emit session:completed
   * to trigger handle_review_completion. Returns the context for assertions.
   */
  async function trigger_review_completion(
    ci_route: ExecRoute,
  ): Promise<{ ctx: WebhookContext; discord: { send_to_entity: ReturnType<typeof vi.fn> } }> {
    // Route gh pr view (check_pr_merged → not merged), gh pr checks (CI status),
    // and gh run list/view for CI fix log fetching (#196)
    route_exec({
      "gh pr view": () => ({ stdout: "OPEN" }),
      "gh pr checks": ci_route,
      "gh run list": () => ({ stdout: JSON.stringify([]) }),
      "gh run view": () => ({ stdout: "" }),
    });

    const payload = JSON.stringify({
      action: "opened",
      pull_request: {
        number: 42,
        title: "feat: test feature",
        head: { ref: "feature/test" },
        body: "Test body",
        user: { login: "test-user" },
      },
      repository: { full_name: "test-org/lobster-farm" },
      installation: { id: 12345 },
    });

    const ctx = make_context();
    const req = make_request(payload, {
      "x-hub-signature-256": sign_payload(payload),
      "x-github-event": "pull_request",
    });
    const res = make_response();

    await handle_github_webhook(req, res, ctx);

    // Wait for spawn_review to set up listeners
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Emit session:completed to trigger handle_review_completion
    const session_manager = ctx.session_manager as unknown as EventEmitter;
    session_manager.emit("session:completed", {
      session_id: "test-session-123",
      exit_code: 0,
    });

    // Wait for the async handle_review_completion chain
    await new Promise((resolve) => setTimeout(resolve, 100));

    const discord = ctx.discord as unknown as { send_to_entity: ReturnType<typeof vi.fn> };
    return { ctx, discord };
  }

  it("blocks merge and spawns CI fixer when CI checks are failing", async () => {
    const { discord } = await trigger_review_completion(() => ({
      stdout: JSON.stringify([
        { name: "Lint", state: "COMPLETED", conclusion: "SUCCESS" },
        { name: "Build", state: "COMPLETED", conclusion: "FAILURE" },
      ]),
    }));

    // Should alert about CI failure and spawn builder to fix (#196)
    expect(discord.send_to_entity).toHaveBeenCalledWith(
      "test-entity",
      "alerts",
      expect.stringContaining("spawning builder to fix"),
      "reviewer",
    );
    expect(discord.send_to_entity).toHaveBeenCalledWith(
      "test-entity",
      "alerts",
      expect.stringContaining("Build"),
      "reviewer",
    );
  });

  it("skips merge when CI checks are pending (no alert, retries on next cycle)", async () => {
    const { discord } = await trigger_review_completion(() => ({
      stdout: JSON.stringify([
        { name: "Lint", state: "COMPLETED", conclusion: "SUCCESS" },
        { name: "Build", state: "IN_PROGRESS", conclusion: "" },
      ]),
    }));

    // Should not send any alerts — pending is a silent skip
    expect(discord.send_to_entity).not.toHaveBeenCalled();
  });

  it("blocks merge when gh pr checks command fails (infrastructure error)", async () => {
    const { discord } = await trigger_review_completion(() => new Error("API rate limit exceeded"));

    // Command failure returns { passed: false, pending: true } — silent skip, no alert
    expect(discord.send_to_entity).not.toHaveBeenCalled();
  });
});
