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
import { save_pr_reviews } from "../persistence.js";
import type { EntityRegistry } from "../registry.js";
// Import after mocks are registered
import { check_ci_status } from "../review-utils.js";
import type { ClaudeSessionManager } from "../session.js";
import {
  type WebhookContext,
  _reset_active_reviews_for_testing,
  handle_github_webhook,
} from "../webhook-handler.js";

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
          { name: "Lint", state: "SUCCESS", bucket: "pass" },
          { name: "Build", state: "SUCCESS", bucket: "pass" },
          { name: "Test", state: "SUCCESS", bucket: "pass" },
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
          { name: "Lint", state: "SUCCESS", bucket: "pass" },
          { name: "Build", state: "IN_PROGRESS", bucket: "pending" },
          { name: "Test", state: "PENDING", bucket: "pending" },
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
          { name: "Lint", state: "FAILURE", bucket: "fail" },
          { name: "Build", state: "SUCCESS", bucket: "pass" },
          { name: "Test", state: "FAILURE", bucket: "fail" },
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
          { name: "Lint", state: "NEUTRAL", bucket: "pass" },
          { name: "Deploy", state: "SKIPPED", bucket: "skipping" },
          { name: "Build", state: "SUCCESS", bucket: "pass" },
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
        stdout: JSON.stringify([{ name: "Build", state: "QUEUED", bucket: "pending" }]),
      }),
    });

    const result = await check_ci_status(42, "/tmp/test-repo");

    expect(result.passed).toBe(false);
    expect(result.pending).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("returns passed when gh pr checks errors with 'no checks reported' (#233)", async () => {
    route_exec({
      "gh pr checks": () => new Error("no required checks reported"),
    });

    const result = await check_ci_status(42, "/tmp/test-repo");

    expect(result.passed).toBe(true);
    expect(result.pending).toBe(false);
    expect(result.failures).toEqual([]);
  });

  it("still returns pending for non-'no checks' errors (#233)", async () => {
    route_exec({
      "gh pr checks": () => new Error("network timeout"),
    });

    const result = await check_ci_status(42, "/tmp/test-repo");

    expect(result.passed).toBe(false);
    expect(result.pending).toBe(true);
    expect(result.failures).toEqual([]);
  });
});

// ── Fallback to unfiltered checks when branch protection is unavailable (#361) ──

/**
 * `gh pr checks --required` only reports checks marked required by branch
 * protection. On repos where branch protection cannot be configured, it reports
 * nothing even though CI is running — so `check_ci_status` must retry without
 * `--required`. These tests route the two shapes independently.
 */
function route_required_and_unfiltered(
  required: ExecRoute,
  unfiltered: ExecRoute,
): { calls: string[][] } {
  const calls: string[][] = [];
  route_exec({
    "gh pr checks": (args, opts) => {
      calls.push(args);
      return args.includes("--required") ? required(args, opts) : unfiltered(args, opts);
    },
  });
  return { calls };
}

/** gh's error when `--required` matches nothing (cli/cli checks.go). */
const NO_REQUIRED_CHECKS = new Error("no required checks reported on the 'feature/test' branch");

/** gh's error when the PR has no checks at all. */
const NO_CHECKS_AT_ALL = new Error("no checks reported on the 'feature/test' branch");

describe("check_ci_status — falls back to unfiltered checks (#361)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(routes)) delete routes[key];
  });

  it("reports the real state when --required errors but CI exists", async () => {
    const { calls } = route_required_and_unfiltered(
      () => NO_REQUIRED_CHECKS,
      () => ({
        stdout: JSON.stringify([
          { name: "Detect changes", state: "SUCCESS", bucket: "pass" },
          { name: "backend", state: "SUCCESS", bucket: "pass" },
          { name: "frontend", state: "SUCCESS", bucket: "pass" },
          { name: "gate", state: "SUCCESS", bucket: "pass" },
        ]),
      }),
    );

    const result = await check_ci_status(42, "/tmp/test-repo");

    expect(result).toEqual({ passed: true, pending: false, failures: [] });
    expect(calls).toHaveLength(2);
    expect(calls[1]).not.toContain("--required");
    expect(calls[1]).toEqual(["pr", "checks", "42", "--json", "name,state,bucket"]);
  });

  it("reports the real state when --required returns an empty list", async () => {
    const { calls } = route_required_and_unfiltered(
      () => ({ stdout: JSON.stringify([]) }),
      () => ({
        stdout: JSON.stringify([{ name: "backend", state: "SUCCESS", bucket: "pass" }]),
      }),
    );

    const result = await check_ci_status(42, "/tmp/test-repo");

    expect(result).toEqual({ passed: true, pending: false, failures: [] });
    expect(calls).toHaveLength(2);
  });

  it("reports pending when the unfiltered checks are still running", async () => {
    const { calls } = route_required_and_unfiltered(
      () => NO_REQUIRED_CHECKS,
      () => ({
        stdout: JSON.stringify([
          { name: "Detect changes", state: "SUCCESS", bucket: "pass" },
          { name: "backend", state: "IN_PROGRESS", bucket: "pending" },
          { name: "frontend", state: "QUEUED", bucket: "pending" },
          { name: "gate", state: "PENDING", bucket: "pending" },
        ]),
      }),
    );

    const result = await check_ci_status(42, "/tmp/test-repo");

    expect(result).toEqual({ passed: false, pending: true, failures: [] });
    expect(calls).toHaveLength(2);
  });

  it("reports failures from the unfiltered checks", async () => {
    const { calls } = route_required_and_unfiltered(
      () => NO_REQUIRED_CHECKS,
      () => ({
        stdout: JSON.stringify([
          { name: "backend", state: "FAILURE", bucket: "fail" },
          { name: "frontend", state: "SUCCESS", bucket: "pass" },
          { name: "gate", state: "TIMED_OUT", bucket: "fail" },
        ]),
      }),
    );

    const result = await check_ci_status(42, "/tmp/test-repo");

    expect(result.passed).toBe(false);
    expect(result.pending).toBe(false);
    expect(result.failures).toEqual(["backend", "gate"]);
    expect(calls).toHaveLength(2);
  });

  it("treats SKIPPED and NEUTRAL unfiltered checks as passing (partial CI must not wedge)", async () => {
    const { calls } = route_required_and_unfiltered(
      () => NO_REQUIRED_CHECKS,
      () => ({
        stdout: JSON.stringify([
          { name: "Detect changes", state: "SUCCESS", bucket: "pass" },
          { name: "backend", state: "SKIPPED", bucket: "skipping" },
          { name: "frontend", state: "SUCCESS", bucket: "pass" },
          { name: "gate", state: "NEUTRAL", bucket: "pass" },
        ]),
      }),
    );

    const result = await check_ci_status(42, "/tmp/test-repo");

    expect(result).toEqual({ passed: true, pending: false, failures: [] });
    expect(calls).toHaveLength(2);
  });

  it("reports no CI only when the unfiltered query also reports nothing", async () => {
    const { calls } = route_required_and_unfiltered(
      () => NO_REQUIRED_CHECKS,
      () => NO_CHECKS_AT_ALL,
    );

    const result = await check_ci_status(42, "/tmp/test-repo");

    expect(result).toEqual({ passed: true, pending: false, failures: [] });
    expect(calls).toHaveLength(2);
  });

  it("reports no CI when the unfiltered query returns an empty list", async () => {
    const { calls } = route_required_and_unfiltered(
      () => NO_REQUIRED_CHECKS,
      () => ({ stdout: JSON.stringify([]) }),
    );

    const result = await check_ci_status(42, "/tmp/test-repo");

    expect(result).toEqual({ passed: true, pending: false, failures: [] });
    expect(calls).toHaveLength(2);
  });

  it("fails closed when the fallback query hits an infrastructure error", async () => {
    route_required_and_unfiltered(
      () => NO_REQUIRED_CHECKS,
      () => new Error("HTTP 401: Bad credentials"),
    );

    const result = await check_ci_status(42, "/tmp/test-repo");

    expect(result).toEqual({ passed: false, pending: true, failures: [] });
  });

  it("fails closed without falling back when the --required query hits an infrastructure error", async () => {
    const { calls } = route_required_and_unfiltered(
      () => new Error("API rate limit exceeded"),
      () => ({
        stdout: JSON.stringify([{ name: "backend", state: "SUCCESS", bucket: "pass" }]),
      }),
    );

    const result = await check_ci_status(42, "/tmp/test-repo");

    expect(result).toEqual({ passed: false, pending: true, failures: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--required");
  });

  it("does not fall back when --required reports checks", async () => {
    const { calls } = route_required_and_unfiltered(
      () => ({
        stdout: JSON.stringify([{ name: "required-gate", state: "FAILURE", bucket: "fail" }]),
      }),
      () => ({
        stdout: JSON.stringify([{ name: "optional", state: "SUCCESS", bucket: "pass" }]),
      }),
    );

    const result = await check_ci_status(42, "/tmp/test-repo");

    expect(result.failures).toEqual(["required-gate"]);
    expect(calls).toHaveLength(1);
  });

  it("fails closed when the fallback returns unparseable output", async () => {
    route_required_and_unfiltered(
      () => NO_REQUIRED_CHECKS,
      () => ({ stdout: "not json" }),
    );

    const result = await check_ci_status(42, "/tmp/test-repo");

    expect(result).toEqual({ passed: false, pending: true, failures: [] });
  });

  it("passes GH_TOKEN to the fallback query too", async () => {
    const envs: Array<Record<string, unknown>> = [];
    route_exec({
      "gh pr checks": (args, opts) => {
        envs.push(opts.env as Record<string, unknown>);
        if (args.includes("--required")) return NO_REQUIRED_CHECKS;
        return {
          stdout: JSON.stringify([{ name: "backend", state: "SUCCESS", bucket: "pass" }]),
        };
      },
    });

    await check_ci_status(42, "/tmp/test-repo", "ghs_test_token");

    expect(envs).toHaveLength(2);
    expect(envs[1]!.GH_TOKEN).toBe("ghs_test_token");
  });
});

// ── The `--json` field contract with the real gh CLI (#372) ──

/**
 * `gh pr checks --json` validates field names client-side and exits 1 on an
 * unknown one. It has never exposed a `conclusion` field — the completed
 * verdict is carried by `state`.
 *
 * We asked for `conclusion` anyway. gh rejected every query with
 *
 *     Unknown JSON field: "conclusion"
 *
 * which `query_pr_checks` classifies as an infrastructure error, so
 * `check_ci_status` failed closed to `pending: true` for every PR, on every
 * entity, forever. That is what parked PR #371 while its only check was green.
 *
 * The old fixtures hid it: they invented `{ state: "COMPLETED", conclusion:
 * "SUCCESS" }`, a shape gh never emits, and the command mock replayed it
 * regardless of the `--json` argument. These tests validate the requested
 * fields the way gh does, so a field that does not exist fails here first.
 */

/** Fields `gh pr checks --json` actually accepts (gh 2.87.3). */
const GH_PR_CHECKS_JSON_FIELDS = new Set([
  "bucket",
  "completedAt",
  "description",
  "event",
  "link",
  "name",
  "startedAt",
  "state",
  "workflow",
]);

/**
 * Stand-in for the real `gh pr checks --json`: rejects unknown fields exactly
 * as gh does, and otherwise replays the supplied checks.
 */
function route_gh_validating_json_fields(checks: Array<Record<string, string>>): {
  calls: string[][];
} {
  const calls: string[][] = [];
  route_exec({
    "gh pr checks": (args) => {
      calls.push(args);
      const json_index = args.indexOf("--json");
      const requested = json_index === -1 ? [] : (args[json_index + 1] ?? "").split(",");
      for (const field of requested) {
        if (!GH_PR_CHECKS_JSON_FIELDS.has(field)) {
          return new Error(
            `Command failed: gh ${args.join(" ")}\nUnknown JSON field: "${field}"\nAvailable fields:\n  ${[...GH_PR_CHECKS_JSON_FIELDS].join("\n  ")}\n`,
          );
        }
      }
      return { stdout: JSON.stringify(checks) };
    },
  });
  return { calls };
}

describe("check_ci_status — only requests JSON fields gh supports (#372)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(routes)) delete routes[key];
  });

  it("reads a green PR as passing instead of failing closed on an unknown field", async () => {
    const { calls } = route_gh_validating_json_fields([
      { bucket: "pass", name: "Lint / Type-check / Test", state: "SUCCESS" },
    ]);

    const result = await check_ci_status(42, "/tmp/test-repo");

    expect(result).toEqual({ passed: true, pending: false, failures: [] });
    expect(calls[0]).not.toContain("name,state,conclusion");
  });

  it("still reports pending while a check is running", async () => {
    route_gh_validating_json_fields([
      { bucket: "pass", name: "Lint", state: "SUCCESS" },
      { bucket: "pending", name: "Test", state: "IN_PROGRESS" },
    ]);

    const result = await check_ci_status(42, "/tmp/test-repo");

    expect(result).toEqual({ passed: false, pending: true, failures: [] });
  });

  it("still reports failures", async () => {
    route_gh_validating_json_fields([
      { bucket: "fail", name: "Lint", state: "FAILURE" },
      { bucket: "pass", name: "Test", state: "SUCCESS" },
    ]);

    const result = await check_ci_status(42, "/tmp/test-repo");

    expect(result).toEqual({ passed: false, pending: false, failures: ["Lint"] });
  });

  it("keeps NEUTRAL and SKIPPED passing — change detection skips real jobs", async () => {
    route_gh_validating_json_fields([
      { bucket: "pass", name: "backend", state: "NEUTRAL" },
      { bucket: "skipping", name: "frontend", state: "SKIPPED" },
      { bucket: "pass", name: "gate", state: "SUCCESS" },
    ]);

    const result = await check_ci_status(42, "/tmp/test-repo");

    expect(result).toEqual({ passed: true, pending: false, failures: [] });
  });

  it("treats a gh 'pending' bucket as pending even for a state we don't enumerate", async () => {
    // WAITING/REQUESTED are real gh states (deployment approval gates). Reading
    // them as failures would spawn a CI fixer against a green PR.
    route_gh_validating_json_fields([{ bucket: "pending", name: "deploy", state: "WAITING" }]);

    const result = await check_ci_status(42, "/tmp/test-repo");

    expect(result).toEqual({ passed: false, pending: true, failures: [] });
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

function make_alert_router() {
  return {
    post_alert: vi.fn().mockResolvedValue({ message_id: null }),
    resolve_incident: vi.fn().mockResolvedValue(undefined),
  };
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
    alert_router: make_alert_router() as unknown as WebhookContext["alert_router"],
    ...overrides,
  };
}

describe("webhook handler — workflow_run events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Reset module-level dedup table so same-PR events across tests don't
    // get dropped as duplicates of an earlier test's state.
    _reset_active_reviews_for_testing();
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
    const alert_router = ctx.alert_router as unknown as { post_alert: ReturnType<typeof vi.fn> };
    // Updated in #199/#253: alert now posts a top-level embed via alert router
    expect(alert_router.post_alert).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_id: "test-entity",
        tier: "action_required",
        title: expect.stringContaining("Deploy failed on main"),
        body: expect.stringContaining("Gary triaging"),
      }),
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

/** Head SHA carried by the PR webhook payload in these tests. */
const HEAD_SHA = "abc1230000000000000000000000000000000000";

describe("webhook handler — CI gating on review completion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Reset module-level dedup table so same-PR events across tests don't
    // get dropped as duplicates of an earlier test's state.
    _reset_active_reviews_for_testing();
  });

  /**
   * Helper: send a PR webhook, wait for spawn, then emit session:completed
   * to trigger handle_review_completion. Returns the context for assertions.
   */
  async function trigger_review_completion(
    ci_route: ExecRoute,
    ctx_overrides: Partial<WebhookContext> = {},
    extra_routes: Record<string, ExecRoute> = {},
  ): Promise<{ ctx: WebhookContext; discord: { send_to_entity: ReturnType<typeof vi.fn> } }> {
    // Route gh pr view (check_pr_merged → not merged), gh pr checks (CI status),
    // and gh run list/view for CI fix log fetching (#196)
    route_exec({
      "gh pr view": () => ({ stdout: "OPEN" }),
      "gh pr checks": ci_route,
      "gh run list": () => ({ stdout: JSON.stringify([]) }),
      "gh run view": () => ({ stdout: "" }),
      ...extra_routes,
    });

    const payload = JSON.stringify({
      action: "opened",
      pull_request: {
        number: 42,
        title: "feat: test feature",
        head: { ref: "feature/test", sha: HEAD_SHA },
        body: "Test body",
        user: { login: "test-user" },
      },
      repository: { full_name: "test-org/lobster-farm" },
      installation: { id: 12345 },
    });

    const ctx = make_context(ctx_overrides);
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
    const alert_router = ctx.alert_router as unknown as { post_alert: ReturnType<typeof vi.fn> };
    return { ctx, discord, alert_router };
  }

  it("blocks merge and spawns CI fixer when CI checks are failing", async () => {
    const { alert_router } = await trigger_review_completion(() => ({
      stdout: JSON.stringify([
        { name: "Lint", state: "SUCCESS", bucket: "pass" },
        { name: "Build", state: "FAILURE", bucket: "fail" },
      ]),
    }));

    // Should alert about CI failure and spawn builder to fix (#196)
    expect(alert_router.post_alert).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_id: "test-entity",
        tier: "routine",
        body: expect.stringContaining("spawning builder"),
      }),
    );
  });

  it("parks instead of merging when CI checks are still pending", async () => {
    const merge_route = vi.fn(() => ({ stdout: "merged" }));
    const { discord } = await trigger_review_completion(
      () => ({
        stdout: JSON.stringify([
          { name: "Lint", state: "SUCCESS", bucket: "pass" },
          { name: "Build", state: "IN_PROGRESS", bucket: "pending" },
        ]),
      }),
      {},
      { "gh pr merge": merge_route },
    );

    expect(merge_route).not.toHaveBeenCalled();
    expect(discord.send_to_entity).not.toHaveBeenCalled();
  });

  it("blocks merge when gh pr checks command fails (infrastructure error)", async () => {
    const { discord } = await trigger_review_completion(() => new Error("API rate limit exceeded"));

    // Command failure returns { passed: false, pending: true } — silent skip, no alert
    expect(discord.send_to_entity).not.toHaveBeenCalled();
  });

  it("does NOT merge past pending CI even when pr-cron is disabled (#355)", async () => {
    const config_with_cron_disabled = {
      paths: { lobsterfarm_dir: "/tmp/test-lf", projects_dir: "/tmp" },
      pr_cron: { enabled: false },
    } as WebhookContext["config"];

    const merge_route = vi.fn(() => ({ stdout: "merged" }));

    const { alert_router } = await trigger_review_completion(
      () => ({
        stdout: JSON.stringify([{ name: "Build", state: "IN_PROGRESS", bucket: "pending" }]),
      }),
      { config: config_with_cron_disabled },
      {
        "gh pr merge": merge_route,
        "gh repo view": () => ({ stdout: "test-org/lobster-farm" }),
      },
    );

    // The pr_cron setting is irrelevant — running CI is never bypassed.
    expect(merge_route).not.toHaveBeenCalled();
    expect(alert_router.post_alert).not.toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining("CI pending bypassed") }),
    );
  });

  it("persists the approval pinned to the reviewed SHA so check_suite can finish it (#355)", async () => {
    const config_with_cron_disabled = {
      paths: { lobsterfarm_dir: "/tmp/test-lf", projects_dir: "/tmp" },
      pr_cron: { enabled: false },
    } as WebhookContext["config"];

    await trigger_review_completion(
      () => ({
        stdout: JSON.stringify([{ name: "Build", state: "IN_PROGRESS", bucket: "pending" }]),
      }),
      { config: config_with_cron_disabled },
    );

    const saved = vi.mocked(save_pr_reviews).mock.calls[0]?.[0];
    expect(saved?.["test-entity:42"]).toMatchObject({
      entity_id: "test-entity",
      pr_number: 42,
      outcome: "approved",
      v1_approved_sha: HEAD_SHA,
    });
  });

  it("still merges immediately when the repo has no checks configured (#355)", async () => {
    const merge_route = vi.fn(() => ({ stdout: "merged" }));

    // `gh pr checks --required` exits non-zero with "no required checks
    // reported" when nothing is configured — the docs-only path.
    const { alert_router } = await trigger_review_completion(
      () => new Error("no required checks reported on the 'feature/test' branch"),
      {},
      {
        "gh pr merge": merge_route,
        "gh repo view": () => ({ stdout: "test-org/lobster-farm" }),
      },
    );

    expect(merge_route).toHaveBeenCalled();
    expect(alert_router.post_alert).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_id: "test-entity",
        title: expect.stringContaining("merged"),
      }),
    );
  });

  it("does NOT merge when --required reports nothing but CI is still running (#361)", async () => {
    const merge_route = vi.fn(() => ({ stdout: "merged" }));

    // Repo without branch protection: `--required` errors, but the unfiltered
    // query shows four real jobs, one of them still executing.
    const { discord } = await trigger_review_completion(
      (args) => {
        if (args.includes("--required")) {
          return new Error("no required checks reported on the 'feature/test' branch");
        }
        return {
          stdout: JSON.stringify([
            { name: "Detect changes", state: "SUCCESS", bucket: "pass" },
            { name: "backend", state: "IN_PROGRESS", bucket: "pending" },
            { name: "frontend", state: "SUCCESS", bucket: "pass" },
            { name: "gate", state: "QUEUED", bucket: "pending" },
          ]),
        };
      },
      {},
      {
        "gh pr merge": merge_route,
        "gh repo view": () => ({ stdout: "test-org/lobster-farm" }),
      },
    );

    expect(merge_route).not.toHaveBeenCalled();
    expect(discord.send_to_entity).not.toHaveBeenCalled();
  });
});
