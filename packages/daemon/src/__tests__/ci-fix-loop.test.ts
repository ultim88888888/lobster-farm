/**
 * Tests for the CI fix loop (#196).
 *
 * Covers:
 * - fetch_ci_failure_logs() — fetching and truncating CI failure output
 * - build_ci_fix_prompt() — prompt construction for the builder
 * - Webhook handler spawns builder on CI failure (integration)
 * - Retry cap: stops after MAX_CI_FIX_ATTEMPTS (3)
 * - Dedup: skips CI fix when review/fix already in-flight
 *
 * Uses the same command-routing mock pattern as ci-gating.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

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

// Mock persistence — keep an in-memory store
let mock_pr_state: Record<string, unknown> = {};
vi.mock("../persistence.js", () => ({
  load_pr_reviews: vi.fn(async () => mock_pr_state),
  save_pr_reviews: vi.fn(async (state: Record<string, unknown>) => {
    mock_pr_state = { ...state };
  }),
}));

// Import after mocks are registered
import {
  fetch_ci_failure_logs,
  build_ci_fix_prompt,
  type CIFailureLog,
} from "../review-utils.js";
import {
  handle_github_webhook,
  type WebhookContext,
} from "../webhook-handler.js";
import type { GitHubAppAuth } from "../github-app.js";
import type { EntityRegistry } from "../registry.js";
import type { ClaudeSessionManager } from "../session.js";
import type { DiscordBot } from "../discord.js";

// ── fetch_ci_failure_logs tests ──

describe("fetch_ci_failure_logs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(routes)) delete routes[key];
  });

  it("returns failure logs for failed runs", async () => {
    route_exec({
      "gh run list": () => ({
        stdout: JSON.stringify([
          { databaseId: 123, name: "CI" },
        ]),
      }),
      "gh run view": () => ({
        stdout: "Error: lint failed\n  src/foo.ts(10): unexpected token\n",
      }),
    });

    const logs = await fetch_ci_failure_logs("feature/test", "/tmp/test-repo");

    expect(logs).toHaveLength(1);
    expect(logs[0]!.check_name).toBe("CI");
    expect(logs[0]!.log_output).toContain("lint failed");
  });

  it("returns empty array when no failed runs found", async () => {
    route_exec({
      "gh run list": () => ({
        stdout: JSON.stringify([]),
      }),
    });

    const logs = await fetch_ci_failure_logs("feature/test", "/tmp/test-repo");

    expect(logs).toEqual([]);
  });

  it("returns empty array when gh run list fails", async () => {
    route_exec({
      "gh run list": () => new Error("API error"),
    });

    const logs = await fetch_ci_failure_logs("feature/test", "/tmp/test-repo");

    expect(logs).toEqual([]);
  });

  it("truncates long log output to last 100 lines", async () => {
    const long_output = Array.from({ length: 200 }, (_, i) => `line ${String(i + 1)}`).join("\n");

    route_exec({
      "gh run list": () => ({
        stdout: JSON.stringify([
          { databaseId: 456, name: "Build" },
        ]),
      }),
      "gh run view": () => ({
        stdout: long_output,
      }),
    });

    const logs = await fetch_ci_failure_logs("feature/test", "/tmp/test-repo");

    expect(logs).toHaveLength(1);
    expect(logs[0]!.log_output).toContain("truncated");
    expect(logs[0]!.log_output).toContain("line 200");
    expect(logs[0]!.log_output).not.toContain("line 1\n");
  });

  it("includes fallback message when log fetch fails for a run", async () => {
    route_exec({
      "gh run list": () => ({
        stdout: JSON.stringify([
          { databaseId: 789, name: "Test" },
        ]),
      }),
      "gh run view": () => new Error("Not found"),
    });

    const logs = await fetch_ci_failure_logs("feature/test", "/tmp/test-repo");

    expect(logs).toHaveLength(1);
    expect(logs[0]!.check_name).toBe("Test");
    expect(logs[0]!.log_output).toContain("Could not fetch failure logs");
    expect(logs[0]!.log_output).toContain("789");
  });

  it("passes GH_TOKEN in environment when provided", async () => {
    let captured_env: Record<string, unknown> | undefined;

    route_exec({
      "gh run list": (_args, opts) => {
        captured_env = opts["env"] as Record<string, unknown>;
        return { stdout: JSON.stringify([]) };
      },
    });

    await fetch_ci_failure_logs("feature/test", "/tmp/test-repo", "ghs_test_token");

    expect(captured_env).toBeDefined();
    expect(captured_env!["GH_TOKEN"]).toBe("ghs_test_token");
  });
});

// ── build_ci_fix_prompt tests ──

describe("build_ci_fix_prompt", () => {
  it("includes PR number, title, and branch", () => {
    const prompt = build_ci_fix_prompt(42, "Add caching", "feature/caching", []);

    expect(prompt).toContain("PR #42");
    expect(prompt).toContain("Add caching");
    expect(prompt).toContain("feature/caching");
  });

  it("includes CI failure logs when provided", () => {
    const logs: CIFailureLog[] = [
      { check_name: "Lint", log_output: "Error: unexpected semicolon" },
      { check_name: "Test", log_output: "FAIL src/foo.test.ts" },
    ];

    const prompt = build_ci_fix_prompt(42, "Add caching", "feature/caching", logs);

    expect(prompt).toContain("## CI Failure Logs");
    expect(prompt).toContain("### Lint");
    expect(prompt).toContain("unexpected semicolon");
    expect(prompt).toContain("### Test");
    expect(prompt).toContain("FAIL src/foo.test.ts");
  });

  it("includes instructions section", () => {
    const prompt = build_ci_fix_prompt(42, "Title", "branch", []);

    expect(prompt).toContain("## Instructions");
    expect(prompt).toContain("Check out the branch");
    expect(prompt).toContain("fix");
    expect(prompt).toContain("Do NOT merge the PR");
  });

  it("omits CI Failure Logs section when no logs", () => {
    const prompt = build_ci_fix_prompt(42, "Title", "branch", []);

    expect(prompt).not.toContain("## CI Failure Logs");
    expect(prompt).toContain("## Instructions");
  });

  it("includes failing check names as fallback when logs are empty", () => {
    const prompt = build_ci_fix_prompt(42, "Title", "feature/test", [], ["Lint", "Build"]);

    expect(prompt).toContain("Failing CI checks: Lint, Build");
    expect(prompt).toContain("Detailed logs unavailable");
    expect(prompt).toContain("gh run list --branch feature/test");
    expect(prompt).not.toContain("## CI Failure Logs");
  });

  it("prefers full logs over check name fallback", () => {
    const logs: CIFailureLog[] = [
      { check_name: "Lint", log_output: "Error: unexpected semicolon" },
    ];
    const prompt = build_ci_fix_prompt(42, "Title", "branch", logs, ["Lint", "Build"]);

    expect(prompt).toContain("## CI Failure Logs");
    expect(prompt).not.toContain("Failing CI checks:");
    expect(prompt).not.toContain("Detailed logs unavailable");
  });
});

// ── Integration tests: webhook handler spawns CI fix builder ──

const WEBHOOK_SECRET = "test-secret-for-ci-fix-loop";

function sign_payload(payload: string): string {
  const hmac = createHmac("sha256", WEBHOOK_SECRET).update(payload).digest("hex");
  return `sha256=${hmac}`;
}

function make_request(
  body: string,
  headers: Record<string, string> = {},
): IncomingMessage {
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
    get_token_for_installation: vi.fn().mockImplementation(
      (id: string) => Promise.resolve(`ghs_install_${id}`),
    ),
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
    config: { paths: { lobsterfarm_dir: "/tmp/test-lf", projects_dir: "/tmp" } } as WebhookContext["config"],
    pool: null,
    pr_watches: null,
    ...overrides,
  };
}

/**
 * Helper: send a PR webhook, wait for spawn, then emit session:completed
 * to trigger handle_review_completion. Returns the context for assertions.
 */
async function trigger_review_completion(
  ci_route: ExecRoute,
  extra_routes: Record<string, ExecRoute> = {},
): Promise<{ ctx: WebhookContext; discord: { send_to_entity: ReturnType<typeof vi.fn> }; session_manager: { spawn: ReturnType<typeof vi.fn> } }> {
  route_exec({
    // check_pr_merged returns not merged
    "gh pr view": () => ({ stdout: "OPEN" }),
    // CI status
    "gh pr checks": ci_route,
    // fetch_ci_failure_logs
    "gh run list": () => ({
      stdout: JSON.stringify([
        { databaseId: 100, name: "CI" },
      ]),
    }),
    "gh run view": () => ({
      stdout: "Error: type check failed\n  src/foo.ts(10): Type 'string' not assignable to 'number'\n",
    }),
    ...extra_routes,
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
  await new Promise((resolve) => setTimeout(resolve, 150));

  const discord = ctx.discord as unknown as { send_to_entity: ReturnType<typeof vi.fn> };
  const sm = ctx.session_manager as unknown as { spawn: ReturnType<typeof vi.fn> };
  return { ctx, discord, session_manager: sm };
}

describe("webhook handler — CI fix loop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    mock_pr_state = {};
  });

  it("spawns a builder when CI checks fail on an approved PR", async () => {
    const { session_manager, discord } = await trigger_review_completion(() => ({
      stdout: JSON.stringify([
        { name: "Lint", state: "COMPLETED", conclusion: "SUCCESS" },
        { name: "Build", state: "COMPLETED", conclusion: "FAILURE" },
      ]),
    }));

    // Should spawn builder with ci-fix feature ID
    // First spawn is the reviewer, second spawn is the CI fix builder
    const spawn_calls = session_manager.spawn.mock.calls;
    const ci_fix_spawn = spawn_calls.find(
      (call: unknown[]) => (call[0] as { feature_id: string }).feature_id === "ci-fix-42",
    );
    expect(ci_fix_spawn).toBeDefined();
    expect((ci_fix_spawn![0] as { archetype: string }).archetype).toBe("builder");
    expect((ci_fix_spawn![0] as { dna: string[] }).dna).toEqual(["coding-dna"]);

    // Should alert about spawning CI fix
    expect(discord.send_to_entity).toHaveBeenCalledWith(
      "test-entity",
      "alerts",
      expect.stringContaining("spawning builder to fix"),
      "reviewer",
    );
    expect(discord.send_to_entity).toHaveBeenCalledWith(
      "test-entity",
      "alerts",
      expect.stringContaining("attempt 1/3"),
      "reviewer",
    );
  });

  it("increments ci_fix_attempts counter", async () => {
    await trigger_review_completion(() => ({
      stdout: JSON.stringify([
        { name: "Test", state: "COMPLETED", conclusion: "FAILURE" },
      ]),
    }));

    // Check that the persisted state has ci_fix_attempts = 1
    const entry = mock_pr_state["test-entity:42"] as { ci_fix_attempts?: number } | undefined;
    expect(entry).toBeDefined();
    expect(entry!.ci_fix_attempts).toBe(1);
  });

  it("sets ci_failure_alerted to prevent pr-cron double-spawn", async () => {
    await trigger_review_completion(() => ({
      stdout: JSON.stringify([
        { name: "Build", state: "COMPLETED", conclusion: "FAILURE" },
        { name: "Lint", state: "COMPLETED", conclusion: "FAILURE" },
      ]),
    }));

    // ci_failure_alerted should be set with sorted failure names
    const entry = mock_pr_state["test-entity:42"] as { ci_failure_alerted?: string } | undefined;
    expect(entry).toBeDefined();
    expect(entry!.ci_failure_alerted).toBe(JSON.stringify(["Build", "Lint"]));
  });

  it("does NOT reset ci_fix_attempts on fresh approval — cap is lifetime-of-issue", async () => {
    // Pre-set the counter to 3 (exhausted from a previous loop).
    // The retry cap should be lifetime-of-issue, not per-reviewer-cycle.
    // Resetting on approval would create an infinite loop: builder pushes fix →
    // new review → approval → reset → CI fails → spawn → repeat.
    mock_pr_state = {
      "test-entity:42": {
        entity_id: "test-entity",
        pr_number: 42,
        reviewed_at: new Date().toISOString(),
        outcome: "approved",
        ci_fix_attempts: 3,
      },
    };

    const { session_manager, discord } = await trigger_review_completion(() => ({
      stdout: JSON.stringify([
        { name: "Build", state: "COMPLETED", conclusion: "FAILURE" },
      ]),
    }));

    // Should NOT spawn a CI fix builder — counter is at 3, cap reached
    const spawn_calls = session_manager.spawn.mock.calls;
    const ci_fix_spawns = spawn_calls.filter(
      (call: unknown[]) => (call[0] as { feature_id: string }).feature_id === "ci-fix-42",
    );
    expect(ci_fix_spawns).toHaveLength(0);

    // Counter should still be 3 — not reset
    const entry = mock_pr_state["test-entity:42"] as { ci_fix_attempts?: number } | undefined;
    expect(entry?.ci_fix_attempts).toBe(3);

    // Should alert about reaching the cap
    expect(discord.send_to_entity).toHaveBeenCalledWith(
      "test-entity",
      "alerts",
      expect.stringContaining("human intervention"),
      "reviewer",
    );
  });

  it("respects ci_fix_attempts cap even on fresh reviewer approval", async () => {
    // Pre-set the counter to 2 (below cap) — simulates previous fix attempts
    mock_pr_state = {
      "test-entity:42": {
        entity_id: "test-entity",
        pr_number: 42,
        reviewed_at: new Date().toISOString(),
        outcome: "approved",
        ci_fix_attempts: 2,
      },
    };

    // CI still failing — fresh approval should NOT reset counter
    const { session_manager } = await trigger_review_completion(() => ({
      stdout: JSON.stringify([
        { name: "Build", state: "COMPLETED", conclusion: "FAILURE" },
      ]),
    }));

    // Should spawn because we're at 2 < 3
    const spawn_calls = session_manager.spawn.mock.calls;
    const ci_fix_spawns = spawn_calls.filter(
      (call: unknown[]) => (call[0] as { feature_id: string }).feature_id === "ci-fix-42",
    );
    expect(ci_fix_spawns).toHaveLength(1);

    // Counter should be 3 (2 + 1, NOT reset to 0 then incremented)
    const entry = mock_pr_state["test-entity:42"] as { ci_fix_attempts?: number } | undefined;
    expect(entry).toBeDefined();
    expect(entry!.ci_fix_attempts).toBe(3);
  });

  it("does not consume retry slot on token resolution failure", async () => {
    mock_pr_state = {};

    // Trigger a review where token resolution will fail on the CI fix path
    const ctx = make_context();

    // Make get_token succeed for reviewer spawn but fail for CI fix
    // The reviewer uses get_token_for_installation (installation_id = "12345")
    // The CI fixer also uses get_token_for_installation
    let call_count = 0;
    const github_app = ctx.github_app as unknown as {
      get_token_for_installation: ReturnType<typeof vi.fn>;
    };
    github_app.get_token_for_installation = vi.fn().mockImplementation(() => {
      call_count++;
      // First two calls: reviewer spawn (1) + handle_review_completion (2)
      if (call_count <= 2) return Promise.resolve("ghs_mock_token");
      // Third call: CI fix token resolution — fail
      return Promise.reject(new Error("Certificate expired"));
    });

    route_exec({
      "gh pr view": () => ({ stdout: "OPEN" }),
      "gh pr checks": () => ({
        stdout: JSON.stringify([
          { name: "Build", state: "COMPLETED", conclusion: "FAILURE" },
        ]),
      }),
      "gh run list": () => ({
        stdout: JSON.stringify([{ databaseId: 100, name: "CI" }]),
      }),
      "gh run view": () => ({
        stdout: "Error: build failed\n",
      }),
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

    const req = make_request(payload, {
      "x-hub-signature-256": sign_payload(payload),
      "x-github-event": "pull_request",
    });
    const res = make_response();

    await handle_github_webhook(req, res, ctx);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const session_manager = ctx.session_manager as unknown as EventEmitter;
    session_manager.emit("session:completed", {
      session_id: "test-session-123",
      exit_code: 0,
    });

    await new Promise((resolve) => setTimeout(resolve, 150));

    // ci_fix_attempts should NOT have been incremented since token failed
    const entry = mock_pr_state["test-entity:42"] as { ci_fix_attempts?: number } | undefined;
    // Entry may not exist or should have ci_fix_attempts as 0 or undefined
    expect(entry?.ci_fix_attempts ?? 0).toBe(0);
  });
});
