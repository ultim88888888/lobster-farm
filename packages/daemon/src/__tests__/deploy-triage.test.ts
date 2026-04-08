/**
 * Tests for the deploy triage loop (#199).
 *
 * Covers:
 * - build_deploy_triage_prompt() — prompt construction for Gary
 * - Retry cap: stops after MAX_DEPLOY_FIX_ATTEMPTS (2)
 * - Safety valve: 4+ attempts in 24h pauses auto-triage
 * - Dedup: same run ID at cap doesn't spawn again
 * - Token failure: does not consume a retry slot
 *
 * Uses the same command-routing mock pattern as ci-fix-loop.test.ts.
 */

import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Command routing ──

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

// ── Mocks for webhook handler deps ──

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

// Mock persistence — keep in-memory stores for both PR and deploy triage state
let mock_pr_state: Record<string, unknown> = {};
let mock_deploy_state: Record<string, unknown> = {};
vi.mock("../persistence.js", () => ({
  load_pr_reviews: vi.fn(async () => mock_pr_state),
  save_pr_reviews: vi.fn(async (state: Record<string, unknown>) => {
    mock_pr_state = { ...state };
  }),
  load_deploy_triage: vi.fn(async () => mock_deploy_state),
  save_deploy_triage: vi.fn(async (state: Record<string, unknown>) => {
    mock_deploy_state = { ...state };
  }),
}));

import type { DiscordBot } from "../discord.js";
import type { GitHubAppAuth } from "../github-app.js";
import type { EntityRegistry } from "../registry.js";
// Import after mocks are registered
import {
  type CIFailureLog,
  MAX_DEPLOY_FIX_ATTEMPTS,
  build_deploy_triage_prompt,
} from "../review-utils.js";
import type { ClaudeSessionManager } from "../session.js";
import { type WebhookContext, handle_github_webhook } from "../webhook-handler.js";

// ── build_deploy_triage_prompt tests ──

describe("build_deploy_triage_prompt", () => {
  it("includes workflow name, URL, run ID, and repo path", () => {
    const prompt = build_deploy_triage_prompt(
      "Deploy",
      "https://github.com/org/repo/actions/runs/123",
      123,
      "/tmp/repo",
      [],
      1,
      2,
    );

    expect(prompt).toContain("Deploy");
    expect(prompt).toContain("https://github.com/org/repo/actions/runs/123");
    expect(prompt).toContain("123");
    expect(prompt).toContain("/tmp/repo");
  });

  it("includes attempt counter", () => {
    const prompt = build_deploy_triage_prompt(
      "Deploy",
      "https://example.com",
      1,
      "/tmp/repo",
      [],
      2,
      2,
    );

    expect(prompt).toContain("Attempt: 2/2");
  });

  it("includes failure logs when provided", () => {
    const logs: CIFailureLog[] = [
      { check_name: "deploy", log_output: "ResourceInitializationError: missing key" },
    ];
    const prompt = build_deploy_triage_prompt(
      "Deploy",
      "https://example.com",
      1,
      "/tmp/repo",
      logs,
      1,
      2,
    );

    expect(prompt).toContain("## Failure Logs");
    expect(prompt).toContain("### deploy");
    expect(prompt).toContain("ResourceInitializationError");
  });

  it("shows fallback message when no logs available", () => {
    const prompt = build_deploy_triage_prompt(
      "Deploy",
      "https://example.com",
      42,
      "/tmp/repo",
      [],
      1,
      2,
    );

    expect(prompt).toContain("No failure logs could be fetched");
    expect(prompt).toContain("gh run view 42 --log-failed");
  });

  it("includes triage instructions", () => {
    const prompt = build_deploy_triage_prompt(
      "Deploy",
      "https://example.com",
      1,
      "/tmp/repo",
      [],
      1,
      2,
    );

    expect(prompt).toContain("Diagnose");
    expect(prompt).toContain("Classify");
    expect(prompt).toContain("Do NOT push directly to main");
  });
});

// ── Integration tests: webhook handler spawns deploy triage ──

const WEBHOOK_SECRET = "test-secret-for-deploy-triage";

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
      session_id: "test-session-deploy",
      entity_id: "test-entity",
      feature_id: "deploy-triage-99999",
      archetype: "planner",
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

function make_workflow_run_payload(run_id = 99999): string {
  return JSON.stringify({
    action: "completed",
    workflow_run: {
      id: run_id,
      name: "Deploy",
      conclusion: "failure",
      event: "push",
      head_branch: "main",
      head_sha: "abc123def456",
      html_url: `https://github.com/test-org/lobster-farm/actions/runs/${String(run_id)}`,
    },
    repository: { full_name: "test-org/lobster-farm" },
    installation: { id: 12345 },
  });
}

async function send_workflow_run_webhook(ctx: WebhookContext, run_id = 99999): Promise<void> {
  route_exec({
    "gh run list": () => ({
      stdout: JSON.stringify([{ databaseId: run_id, name: "Deploy" }]),
    }),
    "gh run view": () => ({
      stdout: "Error: ResourceInitializationError\n  task definition revision mismatch\n",
    }),
  });

  const payload = make_workflow_run_payload(run_id);
  const req = make_request(payload, {
    "x-hub-signature-256": sign_payload(payload),
    "x-github-event": "workflow_run",
  });
  const res = make_response();

  await handle_github_webhook(req, res, ctx);

  // Wait for async processing
  await new Promise((resolve) => setTimeout(resolve, 150));
}

describe("webhook handler — deploy triage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    mock_pr_state = {};
    mock_deploy_state = {};
  });

  it("spawns Gary when a deploy workflow fails on main", async () => {
    const ctx = make_context();
    await send_workflow_run_webhook(ctx);

    const sm = ctx.session_manager as unknown as { spawn: ReturnType<typeof vi.fn> };
    const spawn_calls = sm.spawn.mock.calls;
    const triage_spawn = spawn_calls.find(
      (call: unknown[]) => (call[0] as { feature_id: string }).feature_id === "deploy-triage-99999",
    );

    expect(triage_spawn).toBeDefined();
    expect((triage_spawn![0] as { archetype: string }).archetype).toBe("planner");
    expect((triage_spawn![0] as { dna: string[] }).dna).toEqual(["planning-dna"]);
    expect((triage_spawn![0] as { model: { model: string; think: string } }).model).toEqual({
      model: "opus",
      think: "high",
    });
  });

  it("posts triage alert to #alerts", async () => {
    const ctx = make_context();
    await send_workflow_run_webhook(ctx);

    const discord = ctx.discord as unknown as { send_to_entity: ReturnType<typeof vi.fn> };
    expect(discord.send_to_entity).toHaveBeenCalledWith(
      "test-entity",
      "alerts",
      expect.stringContaining("Gary triaging"),
      "reviewer",
    );
    expect(discord.send_to_entity).toHaveBeenCalledWith(
      "test-entity",
      "alerts",
      expect.stringContaining("attempt 1/2"),
      "reviewer",
    );
  });

  it("increments fix_attempts counter in deploy triage state", async () => {
    const ctx = make_context();
    await send_workflow_run_webhook(ctx);

    const entry = mock_deploy_state["test-entity:99999"] as
      | {
          fix_attempts?: number;
          entity_id?: string;
          workflow_run_id?: number;
        }
      | undefined;
    expect(entry).toBeDefined();
    expect(entry!.fix_attempts).toBe(1);
    expect(entry!.entity_id).toBe("test-entity");
    expect(entry!.workflow_run_id).toBe(99999);
  });

  it("stops after MAX_DEPLOY_FIX_ATTEMPTS (2) and alerts exhaustion", async () => {
    // Pre-set the counter to the cap
    mock_deploy_state = {
      "test-entity:99999": {
        entity_id: "test-entity",
        workflow_run_id: 99999,
        workflow_name: "Deploy",
        workflow_url: "https://example.com",
        head_sha: "abc123",
        first_seen_at: new Date().toISOString(),
        fix_attempts: MAX_DEPLOY_FIX_ATTEMPTS, // at cap
        last_attempt_at: new Date().toISOString(),
        resolved: false,
      },
    };

    const ctx = make_context();
    await send_workflow_run_webhook(ctx);

    // Should NOT spawn Gary
    const sm = ctx.session_manager as unknown as { spawn: ReturnType<typeof vi.fn> };
    expect(sm.spawn).not.toHaveBeenCalled();

    // Should alert about exhaustion
    const discord = ctx.discord as unknown as { send_to_entity: ReturnType<typeof vi.fn> };
    expect(discord.send_to_entity).toHaveBeenCalledWith(
      "test-entity",
      "alerts",
      expect.stringContaining("Manual intervention needed"),
      "reviewer",
    );
    expect(discord.send_to_entity).toHaveBeenCalledWith(
      "test-entity",
      "alerts",
      expect.stringContaining("fix loop exhausted"),
      "reviewer",
    );
  });

  it("triggers safety valve when entity has 4+ attempts in 24h", async () => {
    // Pre-set state with multiple runs accumulating 4 attempts
    const recent = new Date().toISOString();
    mock_deploy_state = {
      "test-entity:11111": {
        entity_id: "test-entity",
        workflow_run_id: 11111,
        workflow_name: "Deploy",
        workflow_url: "https://example.com/1",
        head_sha: "aaa",
        first_seen_at: recent,
        fix_attempts: 2,
        last_attempt_at: recent,
        resolved: false,
      },
      "test-entity:22222": {
        entity_id: "test-entity",
        workflow_run_id: 22222,
        workflow_name: "Deploy",
        workflow_url: "https://example.com/2",
        head_sha: "bbb",
        first_seen_at: recent,
        fix_attempts: 2,
        last_attempt_at: recent,
        resolved: false,
      },
    };

    const ctx = make_context();
    // Send a new workflow run (different run ID, same entity)
    await send_workflow_run_webhook(ctx, 33333);

    // Should NOT spawn Gary
    const sm = ctx.session_manager as unknown as { spawn: ReturnType<typeof vi.fn> };
    expect(sm.spawn).not.toHaveBeenCalled();

    // Should alert about safety valve
    const discord = ctx.discord as unknown as { send_to_entity: ReturnType<typeof vi.fn> };
    expect(discord.send_to_entity).toHaveBeenCalledWith(
      "test-entity",
      "alerts",
      expect.stringContaining("safety valve"),
      "reviewer",
    );
  });

  it("does not trigger safety valve for old attempts (>24h)", async () => {
    // Pre-set state with attempts from 48 hours ago (should not count)
    const old_time = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    mock_deploy_state = {
      "test-entity:11111": {
        entity_id: "test-entity",
        workflow_run_id: 11111,
        workflow_name: "Deploy",
        workflow_url: "https://example.com/1",
        head_sha: "aaa",
        first_seen_at: old_time,
        fix_attempts: 2,
        last_attempt_at: old_time,
        resolved: false,
      },
      "test-entity:22222": {
        entity_id: "test-entity",
        workflow_run_id: 22222,
        workflow_name: "Deploy",
        workflow_url: "https://example.com/2",
        head_sha: "bbb",
        first_seen_at: old_time,
        fix_attempts: 2,
        last_attempt_at: old_time,
        resolved: false,
      },
    };

    const ctx = make_context();
    await send_workflow_run_webhook(ctx, 33333);

    // Should spawn Gary — old attempts don't count
    const sm = ctx.session_manager as unknown as { spawn: ReturnType<typeof vi.fn> };
    const triage_spawn = sm.spawn.mock.calls.find(
      (call: unknown[]) => (call[0] as { feature_id: string }).feature_id === "deploy-triage-33333",
    );
    expect(triage_spawn).toBeDefined();
  });

  it("does not consume retry slot on token resolution failure", async () => {
    const ctx = make_context();

    // Make token resolution fail
    const github_app = ctx.github_app as unknown as {
      get_token_for_installation: ReturnType<typeof vi.fn>;
    };
    github_app.get_token_for_installation = vi
      .fn()
      .mockRejectedValue(new Error("Certificate expired"));

    route_exec({
      "gh run list": () => ({
        stdout: JSON.stringify([{ databaseId: 99999, name: "Deploy" }]),
      }),
      "gh run view": () => ({
        stdout: "Error: deploy failed\n",
      }),
    });

    const payload = make_workflow_run_payload();
    const req = make_request(payload, {
      "x-hub-signature-256": sign_payload(payload),
      "x-github-event": "workflow_run",
    });
    const res = make_response();

    await handle_github_webhook(req, res, ctx);
    await new Promise((resolve) => setTimeout(resolve, 150));

    // fix_attempts should NOT have been incremented
    const entry = mock_deploy_state["test-entity:99999"] as
      | {
          fix_attempts?: number;
        }
      | undefined;
    // Entry should not exist or have 0 attempts
    expect(entry?.fix_attempts ?? 0).toBe(0);

    // Should NOT have spawned Gary
    const sm = ctx.session_manager as unknown as { spawn: ReturnType<typeof vi.fn> };
    expect(sm.spawn).not.toHaveBeenCalled();
  });

  it("ignores workflow_run events that are not failures on main", async () => {
    const ctx = make_context();

    // Success event — should be ignored
    const payload = JSON.stringify({
      action: "completed",
      workflow_run: {
        id: 99999,
        name: "Deploy",
        conclusion: "success",
        event: "push",
        head_branch: "main",
        head_sha: "abc123",
        html_url: "https://example.com",
      },
      repository: { full_name: "test-org/lobster-farm" },
      installation: { id: 12345 },
    });

    const req = make_request(payload, {
      "x-hub-signature-256": sign_payload(payload),
      "x-github-event": "workflow_run",
    });
    const res = make_response();

    await handle_github_webhook(req, res, ctx);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const sm = ctx.session_manager as unknown as { spawn: ReturnType<typeof vi.fn> };
    expect(sm.spawn).not.toHaveBeenCalled();
  });

  it("ignores workflow_run failures on non-main branches", async () => {
    const ctx = make_context();

    const payload = JSON.stringify({
      action: "completed",
      workflow_run: {
        id: 99999,
        name: "CI",
        conclusion: "failure",
        event: "push",
        head_branch: "feature/test",
        head_sha: "abc123",
        html_url: "https://example.com",
      },
      repository: { full_name: "test-org/lobster-farm" },
      installation: { id: 12345 },
    });

    const req = make_request(payload, {
      "x-hub-signature-256": sign_payload(payload),
      "x-github-event": "workflow_run",
    });
    const res = make_response();

    await handle_github_webhook(req, res, ctx);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const sm = ctx.session_manager as unknown as { spawn: ReturnType<typeof vi.fn> };
    expect(sm.spawn).not.toHaveBeenCalled();
  });

  it("passes GH_TOKEN to spawned Gary session", async () => {
    const ctx = make_context();
    await send_workflow_run_webhook(ctx);

    const sm = ctx.session_manager as unknown as { spawn: ReturnType<typeof vi.fn> };
    const triage_spawn = sm.spawn.mock.calls.find(
      (call: unknown[]) => (call[0] as { feature_id: string }).feature_id === "deploy-triage-99999",
    );

    expect(triage_spawn).toBeDefined();
    expect((triage_spawn![0] as { env: Record<string, string> }).env).toEqual({
      GH_TOKEN: "ghs_install_12345",
    });
  });
});
