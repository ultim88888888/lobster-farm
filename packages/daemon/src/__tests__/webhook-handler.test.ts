import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubAppAuth } from "../github-app.js";
import type { EntityRegistry } from "../registry.js";
import type { ClaudeSessionManager } from "../session.js";
import {
  type WebhookContext,
  _reset_active_reviews_for_testing,
  build_reviewer_prompt,
  get_active_webhook_reviews,
  handle_github_webhook,
} from "../webhook-handler.js";

// Mock node:child_process — needed for has_existing_bot_review and check_pr_merged.
// vi.hoisted ensures the mock ref is available when the vi.mock factory runs.
const { execFile_mock } = vi.hoisted(() => {
  const mock = vi.fn();
  const CUSTOM = Symbol.for("nodejs.util.promisify.custom");
  Object.defineProperty(mock, CUSTOM, {
    value: (...args: unknown[]) => {
      return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        mock(...args, (err: Error | null, stdout: string, stderr: string) => {
          if (err) reject(err);
          else resolve({ stdout, stderr });
        });
      });
    },
    configurable: true,
  });
  return { execFile_mock: mock };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFile: execFile_mock };
});

// Mock worktree-cleanup to avoid real git operations
vi.mock("../worktree-cleanup.js", () => ({
  cleanup_after_merge: vi.fn(async () => {}),
}));

// Mock sentry to avoid real error reporting
vi.mock("../sentry.js", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

// Mock actions to avoid real exec calls
vi.mock("../actions.js", () => ({
  detect_review_outcome: vi.fn(async () => "approved"),
}));

// Mock review-utils
vi.mock("../review-utils.js", () => ({
  fetch_review_comments: vi.fn(async () => []),
  build_review_fix_prompt: vi.fn(() => "fix prompt"),
  check_merge_conflicts: vi.fn(async () => false),
  attempt_auto_merge: vi.fn(async () => ({ merged: true, method: "direct" })),
  check_ci_status: vi.fn(async () => ({ passed: true, pending: false, failures: [] })),
  // merge-gate.ts and the v2 path import these transitively (#257)
  fetch_pr_mergeability: vi.fn(async () => ({
    mergeable: "MERGEABLE",
    merge_state_status: "CLEAN",
    head_sha: "deadbeef",
  })),
  try_local_rebase: vi.fn(async () => ({ success: true })),
  fetch_ci_failure_logs: vi.fn(async () => []),
  build_ci_fix_prompt: vi.fn(() => "ci fix prompt"),
  build_deploy_triage_prompt: vi.fn(() => "deploy triage prompt"),
  MAX_CI_FIX_ATTEMPTS: 3,
  MAX_DEPLOY_FIX_ATTEMPTS: 2,
}));

// Mock issue-utils — default: no linked issues
vi.mock("../issue-utils.js", () => ({
  extract_first_linked_issue: vi.fn(() => null),
  extract_linked_issues: vi.fn(() => []),
  fetch_issue_context: vi.fn(async () => ""),
  close_linked_issues: vi.fn(async () => []),
}));

// ── Test helpers ──

const WEBHOOK_SECRET = "test-secret-for-webhook-tests";

function sign_payload(payload: string, secret: string = WEBHOOK_SECRET): string {
  const hmac = createHmac("sha256", secret).update(payload).digest("hex");
  return `sha256=${hmac}`;
}

function make_pr_payload(
  action = "opened",
  pr_number = 42,
  repo_full_name = "test-org/lobster-farm",
  overrides: Record<string, unknown> = {},
  options: { installation_id?: number; head_sha?: string } = {},
): string {
  // Default SHA is deterministic per PR so same-PR events collide by default.
  // Tests that exercise HEAD movement pass an explicit head_sha override.
  const head_sha = options.head_sha ?? `sha-${String(pr_number)}-abcdef`;

  // Build the head object. Allow overrides.head to take precedence (some
  // existing tests override `head.ref`), but always fill in a sha if missing.
  const override_head = (overrides.head as { ref?: string; sha?: string } | undefined) ?? {};
  const head = {
    ref: override_head.ref ?? "feature/test",
    sha: override_head.sha ?? head_sha,
  };

  const pr_overrides = { ...overrides };
  delete pr_overrides.head;

  const payload: Record<string, unknown> = {
    action,
    pull_request: {
      number: pr_number,
      title: "Test PR",
      head,
      body: "Closes #10",
      user: { login: "testuser" },
      ...pr_overrides,
    },
    repository: { full_name: repo_full_name },
  };

  if (options.installation_id != null) {
    payload.installation = { id: options.installation_id };
  }

  return JSON.stringify(payload);
}

/** Create a mock IncomingMessage that emits body data. */
function make_request(body: string, headers: Record<string, string> = {}): IncomingMessage {
  const emitter = new EventEmitter();
  const req = emitter as unknown as IncomingMessage;
  req.headers = {
    ...headers,
  };

  // Simulate body streaming after the handler attaches listeners
  process.nextTick(() => {
    emitter.emit("data", Buffer.from(body));
    emitter.emit("end");
  });

  return req;
}

/** Capture the response written by the handler. */
function make_response(): ServerResponse & { _status: number; _body: string } {
  let status = 0;
  let body = "";
  const res = {
    _status: 0,
    _body: "",
    writeHead(s: number, _headers: Record<string, string>) {
      status = s;
      res._status = s;
    },
    end(data: string) {
      body = data;
      res._body = data;
    },
    headersSent: false,
  } as unknown as ServerResponse & { _status: number; _body: string };
  return res;
}

/** Create a mock GitHub App auth. */
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

/** Create a mock entity registry with one entity. */
function make_registry(): EntityRegistry {
  return {
    get_active: vi.fn().mockReturnValue([
      {
        entity: {
          id: "lobster-farm",
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

/** Create a mock session manager. */
function make_session_manager(): ClaudeSessionManager {
  const emitter = new EventEmitter();
  const manager = Object.assign(emitter, {
    spawn: vi.fn().mockResolvedValue({
      session_id: "test-session-123",
      entity_id: "lobster-farm",
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
    discord: null,
    config: {
      paths: { lobsterfarm_dir: "/tmp/test-lf", projects_dir: "/tmp" },
    } as WebhookContext["config"],
    pool: null,
    pr_watches: null,
    ...overrides,
  };
}

// ── Tests ──

describe("handle_github_webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Module-level dedup table must be reset between tests — vi.clearAllMocks()
    // does not touch plain Maps in imported modules.
    _reset_active_reviews_for_testing();
    // Default: exec calls fail (fail-open — has_existing_bot_review returns false,
    // check_pr_merged returns false). Override in specific tests as needed.
    execFile_mock.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === "function") {
        (cb as (err: Error | null, stdout: string, stderr: string) => void)(
          new Error("mock: exec not configured"),
          "",
          "",
        );
      }
    });
  });

  describe("signature verification", () => {
    it("returns 401 when X-Hub-Signature-256 header is missing", async () => {
      const body = make_pr_payload();
      const req = make_request(body, {
        "x-github-event": "pull_request",
      });
      const res = make_response();
      const ctx = make_context();

      await handle_github_webhook(req, res, ctx);

      expect(res._status).toBe(401);
      expect(res._body).toContain("Missing X-Hub-Signature-256");
    });

    it("returns 401 when signature is invalid", async () => {
      const body = make_pr_payload();
      const req = make_request(body, {
        "x-github-event": "pull_request",
        "x-hub-signature-256": "sha256=invalid_signature_00000000000000000000000000000000",
      });
      const res = make_response();
      const ctx = make_context();

      await handle_github_webhook(req, res, ctx);

      expect(res._status).toBe(401);
      expect(res._body).toContain("Invalid signature");
    });

    it("returns 200 when signature is valid", async () => {
      const body = make_pr_payload();
      const req = make_request(body, {
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign_payload(body),
      });
      const res = make_response();
      const ctx = make_context();

      await handle_github_webhook(req, res, ctx);

      expect(res._status).toBe(200);
    });
  });

  describe("event routing", () => {
    it("returns 200 and ignores non-pull_request events", async () => {
      const body = JSON.stringify({ action: "completed" });
      const req = make_request(body, {
        "x-github-event": "check_run",
        "x-hub-signature-256": sign_payload(body),
      });
      const res = make_response();
      const ctx = make_context();

      await handle_github_webhook(req, res, ctx);

      expect(res._status).toBe(200);
      // No reviewer spawned
      expect((ctx.session_manager as any).spawn).not.toHaveBeenCalled();
    });

    it("does not spawn reviewer for pull_request.closed without merge", async () => {
      const body = make_pr_payload("closed", 300, "test-org/lobster-farm", { merged: false });
      const req = make_request(body, {
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign_payload(body),
      });
      const res = make_response();
      const ctx = make_context();

      await handle_github_webhook(req, res, ctx);

      // Give async route_event time to process
      await new Promise((r) => setTimeout(r, 100));

      expect(res._status).toBe(200);
      expect((ctx.session_manager as any).spawn).not.toHaveBeenCalled();
    });

    it("closes linked issues on pull_request.closed with merge", async () => {
      const { extract_linked_issues, close_linked_issues } = await import("../issue-utils.js");
      (extract_linked_issues as ReturnType<typeof vi.fn>).mockReturnValue([10]);
      (close_linked_issues as ReturnType<typeof vi.fn>).mockResolvedValue([
        { issue_number: 10, success: true },
      ]);
      const log_spy = vi.spyOn(console, "log").mockImplementation(() => {});

      try {
        const body = make_pr_payload("closed", 300, "test-org/lobster-farm", { merged: true });
        const req = make_request(body, {
          "x-github-event": "pull_request",
          "x-hub-signature-256": sign_payload(body),
        });
        const res = make_response();
        const ctx = make_context();

        await handle_github_webhook(req, res, ctx);

        // Give async route_event time to process
        await vi.waitFor(
          () => {
            expect(close_linked_issues).toHaveBeenCalledWith(
              "test-org/lobster-farm",
              300,
              [10],
              "ghs_mock_token",
            );
          },
          { timeout: 2000 },
        );

        expect(res._status).toBe(200);
        // No reviewer spawned for merged PRs
        expect((ctx.session_manager as any).spawn).not.toHaveBeenCalled();
      } finally {
        log_spy.mockRestore();
        (extract_linked_issues as ReturnType<typeof vi.fn>).mockReturnValue([]);
      }
    });

    it("spawns reviewer for pull_request.opened", async () => {
      const body = make_pr_payload("opened", 200);
      const req = make_request(body, {
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign_payload(body),
      });
      const res = make_response();
      const ctx = make_context();

      await handle_github_webhook(req, res, ctx);

      // Handler returns 200 immediately, spawning is async
      expect(res._status).toBe(200);

      // Wait for async spawn chain (get_token + spawn)
      await vi.waitFor(
        () => {
          expect((ctx.session_manager as any).spawn).toHaveBeenCalledTimes(1);
        },
        { timeout: 2000 },
      );

      const spawn_args = (ctx.session_manager as any).spawn.mock.calls[0]![0];
      expect(spawn_args.entity_id).toBe("lobster-farm");
      expect(spawn_args.archetype).toBe("reviewer");
      expect(spawn_args.env).toEqual({ GH_TOKEN: "ghs_mock_token" });
    });

    it("spawns reviewer for pull_request.synchronize", async () => {
      const body = make_pr_payload("synchronize", 201);
      const req = make_request(body, {
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign_payload(body),
      });
      const res = make_response();
      const ctx = make_context();

      await handle_github_webhook(req, res, ctx);

      await vi.waitFor(
        () => {
          expect((ctx.session_manager as any).spawn).toHaveBeenCalledTimes(1);
        },
        { timeout: 2000 },
      );
    });

    it("ignores unknown repos (returns 200, no spawn)", async () => {
      const body = make_pr_payload("opened", 301, "unknown-org/unknown-repo");
      const req = make_request(body, {
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign_payload(body),
      });
      const res = make_response();
      const ctx = make_context();

      await handle_github_webhook(req, res, ctx);

      // Give async route_event time to process
      await new Promise((r) => setTimeout(r, 100));

      expect(res._status).toBe(200);
      expect((ctx.session_manager as any).spawn).not.toHaveBeenCalled();
    });
  });

  describe("missing event header", () => {
    it("returns 400 when X-GitHub-Event header is missing", async () => {
      const body = make_pr_payload();
      const req = make_request(body, {
        "x-hub-signature-256": sign_payload(body),
        // No x-github-event
      });
      const res = make_response();
      const ctx = make_context();

      await handle_github_webhook(req, res, ctx);

      expect(res._status).toBe(400);
      expect(res._body).toContain("Missing X-GitHub-Event");
    });
  });

  describe("invalid JSON", () => {
    it("returns 400 for malformed JSON body", async () => {
      const body = "this is not json";
      const req = make_request(body, {
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign_payload(body),
      });
      const res = make_response();
      const ctx = make_context();

      await handle_github_webhook(req, res, ctx);

      expect(res._status).toBe(400);
      expect(res._body).toContain("Invalid JSON");
    });
  });

  describe("PR merge triggers worktree cleanup", () => {
    it("calls cleanup_after_merge with repo path and branch", async () => {
      const { cleanup_after_merge } = await import("../worktree-cleanup.js");
      const log_spy = vi.spyOn(console, "log").mockImplementation(() => {});

      try {
        const body = make_pr_payload("closed", 55, "test-org/lobster-farm", {
          merged: true,
          head: { ref: "feature/55-cool" },
        });
        const req = make_request(body, {
          "x-github-event": "pull_request",
          "x-hub-signature-256": sign_payload(body),
        });
        const res = make_response();
        const ctx = make_context();

        await handle_github_webhook(req, res, ctx);

        expect(res._status).toBe(200);

        await vi.waitFor(
          () => {
            expect(cleanup_after_merge).toHaveBeenCalledWith("/tmp/test-repo", "feature/55-cool");
          },
          { timeout: 2000 },
        );
      } finally {
        log_spy.mockRestore();
      }
    });

    it("does not trigger cleanup on closed-without-merge PR", async () => {
      const { cleanup_after_merge } = await import("../worktree-cleanup.js");
      const log_spy = vi.spyOn(console, "log").mockImplementation(() => {});

      try {
        const body = make_pr_payload("closed", 56, "test-org/lobster-farm", {
          merged: false,
        });
        const req = make_request(body, {
          "x-github-event": "pull_request",
          "x-hub-signature-256": sign_payload(body),
        });
        const res = make_response();
        const ctx = make_context();

        await handle_github_webhook(req, res, ctx);

        // Give async route_event time to process
        await new Promise((r) => setTimeout(r, 100));

        expect(cleanup_after_merge).not.toHaveBeenCalled();
      } finally {
        log_spy.mockRestore();
      }
    });
  });

  describe("issue closing on PR merge", () => {
    it("extracts and closes linked issues from merged PR body", async () => {
      const { extract_linked_issues, close_linked_issues } = await import("../issue-utils.js");
      (extract_linked_issues as ReturnType<typeof vi.fn>).mockReturnValue([10, 20]);
      (close_linked_issues as ReturnType<typeof vi.fn>).mockResolvedValue([
        { issue_number: 10, success: true },
        { issue_number: 20, success: true },
      ]);
      const log_spy = vi.spyOn(console, "log").mockImplementation(() => {});

      try {
        const body = make_pr_payload("closed", 77, "test-org/lobster-farm", {
          merged: true,
          body: "Closes #10\nFixes #20",
        });
        const req = make_request(body, {
          "x-github-event": "pull_request",
          "x-hub-signature-256": sign_payload(body),
        });
        const res = make_response();
        const ctx = make_context();

        await handle_github_webhook(req, res, ctx);

        await vi.waitFor(
          () => {
            expect(close_linked_issues).toHaveBeenCalledWith(
              "test-org/lobster-farm",
              77,
              [10, 20],
              "ghs_mock_token",
            );
          },
          { timeout: 2000 },
        );
      } finally {
        log_spy.mockRestore();
        (extract_linked_issues as ReturnType<typeof vi.fn>).mockReturnValue([]);
      }
    });

    it("continues to worktree cleanup even if token retrieval fails", async () => {
      const { extract_linked_issues, close_linked_issues } = await import("../issue-utils.js");
      const { cleanup_after_merge } = await import("../worktree-cleanup.js");
      (extract_linked_issues as ReturnType<typeof vi.fn>).mockReturnValue([99]);

      const ctx = make_context();
      (ctx.github_app.get_token as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("token fetch failed"),
      );

      const log_spy = vi.spyOn(console, "log").mockImplementation(() => {});
      const error_spy = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        const body = make_pr_payload("closed", 88, "test-org/lobster-farm", {
          merged: true,
          head: { ref: "feature/88-thing" },
        });
        const req = make_request(body, {
          "x-github-event": "pull_request",
          "x-hub-signature-256": sign_payload(body),
        });
        const res = make_response();

        await handle_github_webhook(req, res, ctx);

        await vi.waitFor(
          () => {
            // Issue closing should NOT have been called (token failed)
            expect(close_linked_issues).not.toHaveBeenCalled();
            // But worktree cleanup should still have been called
            expect(cleanup_after_merge).toHaveBeenCalledWith("/tmp/test-repo", "feature/88-thing");
          },
          { timeout: 2000 },
        );
      } finally {
        log_spy.mockRestore();
        error_spy.mockRestore();
        (extract_linked_issues as ReturnType<typeof vi.fn>).mockReturnValue([]);
      }
    });
  });

  describe("graceful no-op for unhandled events", () => {
    it("ignores non-reviewable PR actions (labeled, assigned, etc.)", async () => {
      for (const action of ["labeled", "assigned", "review_requested", "edited"]) {
        const body = make_pr_payload(action, 400);
        const req = make_request(body, {
          "x-github-event": "pull_request",
          "x-hub-signature-256": sign_payload(body),
        });
        const res = make_response();
        const ctx = make_context();

        await handle_github_webhook(req, res, ctx);

        // Give async processing time
        await new Promise((r) => setTimeout(r, 50));

        expect(res._status).toBe(200);
        expect((ctx.session_manager as any).spawn).not.toHaveBeenCalled();
      }
    });

    it("returns 200 for push events (non-pull_request)", async () => {
      const body = JSON.stringify({
        ref: "refs/heads/main",
        commits: [{ message: "test" }],
      });
      const req = make_request(body, {
        "x-github-event": "push",
        "x-hub-signature-256": sign_payload(body),
      });
      const res = make_response();
      const ctx = make_context();

      await handle_github_webhook(req, res, ctx);

      expect(res._status).toBe(200);
      expect((ctx.session_manager as any).spawn).not.toHaveBeenCalled();
    });

    it("handles PR event with missing pull_request field gracefully", async () => {
      const body = JSON.stringify({
        action: "opened",
        repository: { full_name: "test-org/lobster-farm" },
        // Missing pull_request field
      });
      const req = make_request(body, {
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign_payload(body),
      });
      const res = make_response();
      const ctx = make_context();

      await handle_github_webhook(req, res, ctx);

      // Give async processing time
      await new Promise((r) => setTimeout(r, 100));

      expect(res._status).toBe(200);
      expect((ctx.session_manager as any).spawn).not.toHaveBeenCalled();
    });

    it("handles PR event with missing repository field gracefully", async () => {
      const body = JSON.stringify({
        action: "opened",
        pull_request: {
          number: 500,
          title: "Test",
          head: { ref: "feature/test" },
          body: null,
          user: { login: "user" },
        },
        // Missing repository field
      });
      const req = make_request(body, {
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign_payload(body),
      });
      const res = make_response();
      const ctx = make_context();

      await handle_github_webhook(req, res, ctx);

      await new Promise((r) => setTimeout(r, 100));

      expect(res._status).toBe(200);
      expect((ctx.session_manager as any).spawn).not.toHaveBeenCalled();
    });
  });

  describe("deduplication", () => {
    it("marks review for requeue when synchronize with NEW head_sha arrives during active review", async () => {
      // Regression for #258: a real HEAD movement (new SHA) should requeue,
      // but only a NEW SHA does — same-SHA events are dropped (tested below).

      // First request: opens a review on SHA "sha-aaa"
      const body1 = make_pr_payload(
        "opened",
        600,
        "test-org/lobster-farm",
        {},
        {
          head_sha: "sha-aaa",
        },
      );
      const req1 = make_request(body1, {
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign_payload(body1),
      });
      const res1 = make_response();

      // Create a session manager that never completes (simulates in-flight review)
      const hanging_manager = make_session_manager();
      const ctx = make_context({ session_manager: hanging_manager });

      await handle_github_webhook(req1, res1, ctx);

      // Wait for spawn to be called
      await vi.waitFor(
        () => {
          expect((hanging_manager as any).spawn).toHaveBeenCalledTimes(1);
        },
        { timeout: 2000 },
      );

      // Second request: synchronize event for same PR with a DIFFERENT head_sha
      const body2 = make_pr_payload(
        "synchronize",
        600,
        "test-org/lobster-farm",
        {},
        {
          head_sha: "sha-bbb",
        },
      );
      const req2 = make_request(body2, {
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign_payload(body2),
      });
      const res2 = make_response();

      await handle_github_webhook(req2, res2, ctx);

      // Give async processing time
      await new Promise((r) => setTimeout(r, 100));

      // Should NOT have spawned a second reviewer (the old one is still running)
      expect((hanging_manager as any).spawn).toHaveBeenCalledTimes(1);

      // The active in-flight review should be marked for requeue
      const active = get_active_webhook_reviews();
      const review = active.find(
        (r) => r.entity_id === "lobster-farm" && r.pr_number === 600 && r.state === "in_flight",
      );
      expect(review).toBeDefined();
      expect(review!.head_sha).toBe("sha-aaa");
      expect(review!.needs_requeue).toBe(true);
    });

    it("coalesces back-to-back same-SHA events (opened + synchronize) into one review", async () => {
      // Regression for #258: two events for the same HEAD SHA must not spawn
      // two reviewers, and must not set needs_requeue (there's nothing new to
      // review). This is the #258 "duplicate back-to-back reviews" fix.

      const ctx = make_context();

      // First event: opened
      const body1 = make_pr_payload(
        "opened",
        601,
        "test-org/lobster-farm",
        {},
        {
          head_sha: "sha-same",
        },
      );
      const req1 = make_request(body1, {
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign_payload(body1),
      });
      const res1 = make_response();
      await handle_github_webhook(req1, res1, ctx);

      await vi.waitFor(
        () => {
          expect((ctx.session_manager as any).spawn).toHaveBeenCalledTimes(1);
        },
        { timeout: 2000 },
      );

      // Second event: synchronize with the SAME head_sha (e.g. webhook retry,
      // or clustered GitHub delivery). Must be dropped as a duplicate.
      const body2 = make_pr_payload(
        "synchronize",
        601,
        "test-org/lobster-farm",
        {},
        {
          head_sha: "sha-same",
        },
      );
      const req2 = make_request(body2, {
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign_payload(body2),
      });
      const res2 = make_response();
      await handle_github_webhook(req2, res2, ctx);

      // Give async processing time
      await new Promise((r) => setTimeout(r, 100));

      // Only ONE spawn total — the duplicate was dropped
      expect((ctx.session_manager as any).spawn).toHaveBeenCalledTimes(1);

      // And the in-flight review should NOT be flagged for requeue — there is
      // nothing new to review.
      const active = get_active_webhook_reviews();
      const review = active.find((r) => r.entity_id === "lobster-farm" && r.pr_number === 601);
      expect(review).toBeDefined();
      expect(review!.needs_requeue).toBe(false);
    });

    it("drops same-SHA events that arrive after review completion (TTL hold)", async () => {
      // After a review completes, the entry transitions to `completed` with a
      // TTL hold. Any webhook for the same SHA arriving during that hold must
      // be dropped to prevent the #258 "back-to-back review on identical
      // commit" bug.

      const ctx = make_context();

      // First event: opened — spawns reviewer
      const body1 = make_pr_payload(
        "opened",
        602,
        "test-org/lobster-farm",
        {},
        {
          head_sha: "sha-hold",
        },
      );
      const req1 = make_request(body1, {
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign_payload(body1),
      });
      const res1 = make_response();
      await handle_github_webhook(req1, res1, ctx);

      // Wait for spawn
      await vi.waitFor(
        () => {
          expect((ctx.session_manager as any).spawn).toHaveBeenCalledTimes(1);
        },
        { timeout: 2000 },
      );

      // Simulate the reviewer session completing (session:completed event)
      const spawn_result = await (ctx.session_manager as any).spawn.mock.results[0].value;
      (ctx.session_manager as any).emit("session:completed", {
        session_id: spawn_result.session_id,
        exit_code: 0,
      });

      // Wait until the active review transitions to `completed`
      await vi.waitFor(
        () => {
          const entry = get_active_webhook_reviews().find((r) => r.pr_number === 602);
          expect(entry).toBeDefined();
          expect(entry!.state).toBe("completed");
        },
        { timeout: 2000 },
      );

      // Second event: another synchronize with the SAME sha. Because the
      // completed entry is still in the TTL hold window, this must be dropped.
      const body2 = make_pr_payload(
        "synchronize",
        602,
        "test-org/lobster-farm",
        {},
        {
          head_sha: "sha-hold",
        },
      );
      const req2 = make_request(body2, {
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign_payload(body2),
      });
      const res2 = make_response();
      await handle_github_webhook(req2, res2, ctx);

      // Give async processing time
      await new Promise((r) => setTimeout(r, 150));

      // Still exactly one spawn — the duplicate was dropped during the hold
      expect((ctx.session_manager as any).spawn).toHaveBeenCalledTimes(1);
    });

    it("prefers in_flight entry over completed entry when both exist for the same PR", async () => {
      // Regression for #258: after a requeue, SHA-A's entry is `completed` (inserted
      // first) and SHA-B's entry is `in_flight` (inserted second). If a third SHA-C
      // webhook arrives, find_review_for_pr must return SHA-B's in_flight entry,
      // not SHA-A's completed entry — otherwise the dedup gate is bypassed and a
      // duplicate reviewer spawns while SHA-B's review is still running.

      const ctx = make_context();

      // Step 1: SHA-A opens a review
      const body1 = make_pr_payload(
        "opened",
        603,
        "test-org/lobster-farm",
        {},
        { head_sha: "sha-aaa" },
      );
      const req1 = make_request(body1, {
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign_payload(body1),
      });
      await handle_github_webhook(req1, make_response(), ctx);

      await vi.waitFor(
        () => {
          expect((ctx.session_manager as any).spawn).toHaveBeenCalledTimes(1);
        },
        { timeout: 2000 },
      );

      // Step 2: SHA-B arrives while SHA-A is in-flight → requeue
      const body2 = make_pr_payload(
        "synchronize",
        603,
        "test-org/lobster-farm",
        {},
        { head_sha: "sha-bbb" },
      );
      const req2 = make_request(body2, {
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign_payload(body2),
      });
      await handle_github_webhook(req2, make_response(), ctx);
      await new Promise((r) => setTimeout(r, 50));

      // Still one spawn, SHA-A is requeue-flagged
      expect((ctx.session_manager as any).spawn).toHaveBeenCalledTimes(1);

      // Step 3: SHA-A's review completes → transitions to `completed`, spawns SHA-B
      const spawn_result = await (ctx.session_manager as any).spawn.mock.results[0].value;
      (ctx.session_manager as any).emit("session:completed", {
        session_id: spawn_result.session_id,
        exit_code: 0,
      });

      // Wait for SHA-B's review to be spawned via requeue
      await vi.waitFor(
        () => {
          expect((ctx.session_manager as any).spawn).toHaveBeenCalledTimes(2);
        },
        { timeout: 2000 },
      );

      // Now: SHA-A entry is `completed` (TTL hold), SHA-B entry is `in_flight`.
      // Verify both exist in the expected states.
      const active = get_active_webhook_reviews();
      const sha_a = active.find((r) => r.head_sha === "sha-aaa");
      const sha_b = active.find((r) => r.head_sha === "sha-bbb");
      expect(sha_a).toBeDefined();
      expect(sha_a!.state).toBe("completed");
      expect(sha_b).toBeDefined();
      expect(sha_b!.state).toBe("in_flight");

      // Step 4: SHA-C arrives during the 60s TTL window. find_review_for_pr must
      // find SHA-B (in_flight), NOT SHA-A (completed). So SHA-C should be queued
      // as a requeue on SHA-B, NOT spawn a third reviewer.
      const body3 = make_pr_payload(
        "synchronize",
        603,
        "test-org/lobster-farm",
        {},
        { head_sha: "sha-ccc" },
      );
      const req3 = make_request(body3, {
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign_payload(body3),
      });
      await handle_github_webhook(req3, make_response(), ctx);
      await new Promise((r) => setTimeout(r, 50));

      // Must NOT have spawned a third reviewer — SHA-C should be requeued on SHA-B
      expect((ctx.session_manager as any).spawn).toHaveBeenCalledTimes(2);

      // SHA-B's entry should now be marked for requeue with SHA-C
      const active_after = get_active_webhook_reviews();
      const sha_b_after = active_after.find((r) => r.head_sha === "sha-bbb");
      expect(sha_b_after).toBeDefined();
      expect(sha_b_after!.needs_requeue).toBe(true);
    });
  });

  describe("spawner error paths", () => {
    it("handles token acquisition failure gracefully", async () => {
      const ctx = make_context();
      (ctx.github_app.get_token as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("token expired"),
      );

      const error_spy = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        const body = make_pr_payload("opened", 700, "test-org/lobster-farm");
        const req = make_request(body, {
          "x-github-event": "pull_request",
          "x-hub-signature-256": sign_payload(body),
        });
        const res = make_response();

        await handle_github_webhook(req, res, ctx);

        expect(res._status).toBe(200);

        await vi.waitFor(
          () => {
            expect(error_spy).toHaveBeenCalledWith(
              expect.stringContaining("Failed to get installation token"),
            );
          },
          { timeout: 2000 },
        );

        // Should not have spawned a reviewer
        expect((ctx.session_manager as any).spawn).not.toHaveBeenCalled();

        // Active review tracking should be cleaned up
        const active = get_active_webhook_reviews();
        const review = active.find((r) => r.pr_number === 700);
        expect(review).toBeUndefined();
      } finally {
        error_spy.mockRestore();
      }
    });

    it("handles session spawn failure gracefully", async () => {
      const ctx = make_context();
      (ctx.session_manager as any).spawn.mockRejectedValue(new Error("tmux not available"));

      const error_spy = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        const body = make_pr_payload("opened", 701, "test-org/lobster-farm");
        const req = make_request(body, {
          "x-github-event": "pull_request",
          "x-hub-signature-256": sign_payload(body),
        });
        const res = make_response();

        await handle_github_webhook(req, res, ctx);

        expect(res._status).toBe(200);

        await vi.waitFor(
          () => {
            expect(error_spy).toHaveBeenCalledWith(
              expect.stringContaining("Failed to spawn reviewer"),
            );
          },
          { timeout: 2000 },
        );

        // Active review tracking should be cleaned up
        const active = get_active_webhook_reviews();
        const review = active.find((r) => r.pr_number === 701);
        expect(review).toBeUndefined();
      } finally {
        error_spy.mockRestore();
      }
    });
  });

  describe("reopened PR", () => {
    it("spawns reviewer for pull_request.reopened", async () => {
      const body = make_pr_payload("reopened", 800);
      const req = make_request(body, {
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign_payload(body),
      });
      const res = make_response();
      const ctx = make_context();

      await handle_github_webhook(req, res, ctx);

      expect(res._status).toBe(200);

      await vi.waitFor(
        () => {
          expect((ctx.session_manager as any).spawn).toHaveBeenCalledTimes(1);
        },
        { timeout: 2000 },
      );

      const spawn_args = (ctx.session_manager as any).spawn.mock.calls[0]![0];
      expect(spawn_args.archetype).toBe("reviewer");
    });
  });

  describe("multi-installation support", () => {
    it("uses get_token_for_installation when payload includes installation.id", async () => {
      const body = make_pr_payload(
        "opened",
        900,
        "test-org/lobster-farm",
        {},
        {
          installation_id: 55555,
        },
      );
      const req = make_request(body, {
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign_payload(body),
      });
      const res = make_response();
      const ctx = make_context();

      await handle_github_webhook(req, res, ctx);

      await vi.waitFor(
        () => {
          expect((ctx.session_manager as any).spawn).toHaveBeenCalledTimes(1);
        },
        { timeout: 2000 },
      );

      // Should have called get_token_for_installation, not get_token
      expect(ctx.github_app.get_token_for_installation).toHaveBeenCalledWith("55555");
      expect(ctx.github_app.get_token).not.toHaveBeenCalled();

      // Spawned session should use the installation-specific token
      const spawn_args = (ctx.session_manager as any).spawn.mock.calls[0]![0];
      expect(spawn_args.env).toEqual({ GH_TOKEN: "ghs_install_55555" });
    });

    it("falls back to get_token when payload has no installation field", async () => {
      const body = make_pr_payload("opened", 901, "test-org/lobster-farm");
      const req = make_request(body, {
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign_payload(body),
      });
      const res = make_response();
      const ctx = make_context();

      await handle_github_webhook(req, res, ctx);

      await vi.waitFor(
        () => {
          expect((ctx.session_manager as any).spawn).toHaveBeenCalledTimes(1);
        },
        { timeout: 2000 },
      );

      // Should have called get_token, not get_token_for_installation
      expect(ctx.github_app.get_token).toHaveBeenCalled();
      expect(ctx.github_app.get_token_for_installation).not.toHaveBeenCalled();

      const spawn_args = (ctx.session_manager as any).spawn.mock.calls[0]![0];
      expect(spawn_args.env).toEqual({ GH_TOKEN: "ghs_mock_token" });
    });

    it("uses installation-specific token for merged PR issue closing", async () => {
      const { extract_linked_issues, close_linked_issues } = await import("../issue-utils.js");
      (extract_linked_issues as ReturnType<typeof vi.fn>).mockReturnValue([30]);
      (close_linked_issues as ReturnType<typeof vi.fn>).mockResolvedValue([
        { issue_number: 30, success: true },
      ]);
      const log_spy = vi.spyOn(console, "log").mockImplementation(() => {});

      try {
        const body = make_pr_payload(
          "closed",
          902,
          "test-org/lobster-farm",
          {
            merged: true,
          },
          {
            installation_id: 77777,
          },
        );
        const req = make_request(body, {
          "x-github-event": "pull_request",
          "x-hub-signature-256": sign_payload(body),
        });
        const res = make_response();
        const ctx = make_context();

        await handle_github_webhook(req, res, ctx);

        await vi.waitFor(
          () => {
            expect(close_linked_issues).toHaveBeenCalledWith(
              "test-org/lobster-farm",
              902,
              [30],
              "ghs_install_77777",
            );
          },
          { timeout: 2000 },
        );

        expect(ctx.github_app.get_token_for_installation).toHaveBeenCalledWith("77777");
        expect(ctx.github_app.get_token).not.toHaveBeenCalled();
      } finally {
        log_spy.mockRestore();
        (extract_linked_issues as ReturnType<typeof vi.fn>).mockReturnValue([]);
      }
    });
  });

  describe("post-review token threading", () => {
    it("passes installation token to detect_review_outcome after review completes", async () => {
      const { detect_review_outcome } = await import("../actions.js");
      const log_spy = vi.spyOn(console, "log").mockImplementation(() => {});

      try {
        // Use installation_id to test cross-account token threading
        const body = make_pr_payload(
          "opened",
          950,
          "test-org/lobster-farm",
          {},
          {
            installation_id: 88888,
          },
        );
        const req = make_request(body, {
          "x-github-event": "pull_request",
          "x-hub-signature-256": sign_payload(body),
        });
        const res = make_response();
        const ctx = make_context();

        await handle_github_webhook(req, res, ctx);

        // Wait for reviewer to be spawned
        await vi.waitFor(
          () => {
            expect((ctx.session_manager as any).spawn).toHaveBeenCalledTimes(1);
          },
          { timeout: 2000 },
        );

        // Simulate reviewer session completion
        const spawn_result = await (ctx.session_manager as any).spawn.mock.results[0].value;
        (ctx.session_manager as any).emit("session:completed", {
          session_id: spawn_result.session_id,
          exit_code: 0,
        });

        // Wait for post-review handling (resolve_token + detect_review_outcome)
        await vi.waitFor(
          () => {
            expect(detect_review_outcome).toHaveBeenCalled();
          },
          { timeout: 2000 },
        );

        // detect_review_outcome should have been called with the installation token
        // get_token_for_installation("88888") returns "ghs_install_88888"
        expect(detect_review_outcome).toHaveBeenCalledWith(
          950,
          "/tmp/test-repo",
          "ghs_install_88888",
        );
      } finally {
        log_spy.mockRestore();
      }
    });

    it("passes default token to detect_review_outcome when no installation_id", async () => {
      const { detect_review_outcome } = await import("../actions.js");
      const log_spy = vi.spyOn(console, "log").mockImplementation(() => {});

      try {
        const body = make_pr_payload("opened", 951, "test-org/lobster-farm");
        const req = make_request(body, {
          "x-github-event": "pull_request",
          "x-hub-signature-256": sign_payload(body),
        });
        const res = make_response();
        const ctx = make_context();

        await handle_github_webhook(req, res, ctx);

        await vi.waitFor(
          () => {
            expect((ctx.session_manager as any).spawn).toHaveBeenCalledTimes(1);
          },
          { timeout: 2000 },
        );

        // Simulate reviewer session completion
        const spawn_result = await (ctx.session_manager as any).spawn.mock.results[0].value;
        (ctx.session_manager as any).emit("session:completed", {
          session_id: spawn_result.session_id,
          exit_code: 0,
        });

        await vi.waitFor(
          () => {
            expect(detect_review_outcome).toHaveBeenCalled();
          },
          { timeout: 2000 },
        );

        // Default token from get_token() is "ghs_mock_token"
        expect(detect_review_outcome).toHaveBeenCalledWith(951, "/tmp/test-repo", "ghs_mock_token");
      } finally {
        log_spy.mockRestore();
      }
    });

    it("falls back gracefully when post-review token resolution fails", async () => {
      const { detect_review_outcome } = await import("../actions.js");
      const log_spy = vi.spyOn(console, "log").mockImplementation(() => {});
      const error_spy = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        const body = make_pr_payload("opened", 952, "test-org/lobster-farm");
        const req = make_request(body, {
          "x-github-event": "pull_request",
          "x-hub-signature-256": sign_payload(body),
        });
        const res = make_response();
        const ctx = make_context();

        // First two calls succeed (pre-spawn dedup check + spawn_review),
        // subsequent calls fail (for post-review token resolution)
        let call_count = 0;
        (ctx.github_app.get_token as ReturnType<typeof vi.fn>).mockImplementation(() => {
          call_count++;
          if (call_count <= 2) return Promise.resolve("ghs_mock_token");
          return Promise.reject(new Error("token expired"));
        });

        await handle_github_webhook(req, res, ctx);

        await vi.waitFor(
          () => {
            expect((ctx.session_manager as any).spawn).toHaveBeenCalledTimes(1);
          },
          { timeout: 2000 },
        );

        // Simulate reviewer session completion
        const spawn_result = await (ctx.session_manager as any).spawn.mock.results[0].value;
        (ctx.session_manager as any).emit("session:completed", {
          session_id: spawn_result.session_id,
          exit_code: 0,
        });

        // Wait for detect_review_outcome — should still be called (with undefined token)
        await vi.waitFor(
          () => {
            expect(detect_review_outcome).toHaveBeenCalled();
          },
          { timeout: 2000 },
        );

        // Token should be undefined since resolution failed
        expect(detect_review_outcome).toHaveBeenCalledWith(952, "/tmp/test-repo", undefined);
      } finally {
        log_spy.mockRestore();
        error_spy.mockRestore();
      }
    });
  });

  // Regression: reviewer deadlock on pending CI.
  // Before this fix, the prompt told the reviewer "if any required checks are
  // failing or pending, do NOT merge" and request changes. When CI hadn't
  // started yet at review time, the reviewer would post CHANGES_REQUESTED,
  // the fix loop would push a commit, the webhook would fire again, a fresh
  // reviewer would see pending CI again, and the cycle would never terminate.
  // PRs #237 and #263 had to be force-merged to break the loop.
  describe("build_reviewer_prompt CI guidance (regression: pending-CI deadlock)", () => {
    const make_pr = () => ({
      number: 42,
      title: "Test PR",
      head: { ref: "feature/test" },
      body: null,
      user: { login: "testuser" },
    });

    it("does not instruct the reviewer to block merge on pending checks", () => {
      const prompt = build_reviewer_prompt(make_pr(), "/tmp/repo", "test-org/test-repo", "");

      // The exact buggy phrase must be gone.
      expect(prompt).not.toContain("failing or pending");

      // And no variant that conflates pending with a blocker should remain.
      // We match case-insensitively on "pending" adjacent to block/merge
      // language (do NOT merge, request changes, etc.) within a small window.
      const dangerous_patterns: RegExp[] = [
        /pending[^.\n]{0,80}\bdo not merge\b/i,
        /pending[^.\n]{0,80}request changes/i,
        /\bdo not merge\b[^.\n]{0,80}pending/i,
        /request changes[^.\n]{0,80}pending/i,
      ];
      for (const pattern of dangerous_patterns) {
        expect(
          prompt,
          `Prompt still contains a blocking instruction tied to pending CI: ${String(pattern)}`,
        ).not.toMatch(pattern);
      }
    });

    it("still instructs the reviewer to block merge on failing checks", () => {
      const prompt = build_reviewer_prompt(make_pr(), "/tmp/repo", "test-org/test-repo", "");

      // Failing checks are still a blocker — this distinguishes the fix from
      // a careless "just delete anything mentioning CI" edit.
      expect(prompt.toLowerCase()).toContain("failing");
      expect(prompt).toMatch(/request changes/i);
    });
  });

  describe("dismissed review outcome", () => {
    it("defers to cron instead of spawning inline when outcome is dismissed", async () => {
      const { detect_review_outcome } = await import("../actions.js");
      vi.mocked(detect_review_outcome).mockResolvedValueOnce("dismissed" as any);

      const log_spy = vi.spyOn(console, "log").mockImplementation(() => {});

      try {
        const body = make_pr_payload("opened", 500, "test-org/lobster-farm");
        const req = make_request(body, {
          "x-github-event": "pull_request",
          "x-hub-signature-256": sign_payload(body),
        });
        const res = make_response();
        const ctx = make_context();

        await handle_github_webhook(req, res, ctx);

        // Wait for reviewer to be spawned
        await vi.waitFor(
          () => {
            expect((ctx.session_manager as any).spawn).toHaveBeenCalledTimes(1);
          },
          { timeout: 2000 },
        );

        // Simulate reviewer session completion
        const spawn_result = await (ctx.session_manager as any).spawn.mock.results[0].value;
        (ctx.session_manager as any).emit("session:completed", {
          session_id: spawn_result.session_id,
          exit_code: 0,
        });

        // Wait for post-review handling to complete
        await vi.waitFor(
          () => {
            expect(log_spy).toHaveBeenCalledWith(
              expect.stringContaining("will be re-reviewed next cycle"),
            );
          },
          { timeout: 2000 },
        );

        // Should NOT have spawned a second reviewer inline — defers to cron
        expect((ctx.session_manager as any).spawn).toHaveBeenCalledTimes(1);

        // .finally() transitions the entry to "completed" (dedup hold window).
        // It stays in the map until the TTL sweep removes it — see #258.
        const active = get_active_webhook_reviews();
        const matching = active.filter((r) => r.pr_number === 500);
        expect(matching).toHaveLength(1);
        expect(matching[0]!.state).toBe("completed");
      } finally {
        log_spy.mockRestore();
      }
    });
  });

  // Issue #287 — the static review mechanics (identity, posting rules,
  // echo-marker, verify-landing, never-dismiss) now live in the reviewer
  // agent's `initialPrompt` frontmatter at `config/claude/agents/reviewer.md`.
  // The dynamic per-PR prefix emitted by `build_reviewer_prompt` is piped via
  // stdin and is prepended by `initialPrompt` at session start. These tests
  // cover what's genuinely dynamic: the pre-existing-review dedup check
  // (which references the repo / PR number) and the PR-numbered commands in
  // the two-pass and merge sections.
  describe("reviewer prompt content (dynamic per-PR prefix)", () => {
    it("includes pre-existing review check instruction with correct API URL", async () => {
      const body = make_pr_payload("opened", 300, "test-org/lobster-farm");
      const req = make_request(body, {
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign_payload(body),
      });
      const res = make_response();
      const ctx = make_context();

      await handle_github_webhook(req, res, ctx);

      await vi.waitFor(
        () => {
          expect((ctx.session_manager as any).spawn).toHaveBeenCalledTimes(1);
        },
        { timeout: 2000 },
      );

      const spawn_args = (ctx.session_manager as any).spawn.mock.calls[0]![0];
      const prompt: string = spawn_args.prompt;

      expect(prompt).toContain("Before posting, check for any existing bot reviews");
      expect(prompt).toContain('select(.user.login | endswith("[bot]"))');
      expect(prompt).toContain("gh api repos/test-org/lobster-farm/pulls/300/reviews");
    });

    it("references the PR number in the two-pass review commands", async () => {
      const body = make_pr_payload("opened", 301, "test-org/lobster-farm");
      const req = make_request(body, {
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign_payload(body),
      });
      const res = make_response();
      const ctx = make_context();

      await handle_github_webhook(req, res, ctx);

      await vi.waitFor(
        () => {
          expect((ctx.session_manager as any).spawn).toHaveBeenCalledTimes(1);
        },
        { timeout: 2000 },
      );

      const spawn_args = (ctx.session_manager as any).spawn.mock.calls[0]![0];
      const prompt: string = spawn_args.prompt;

      // The dynamic prefix identifies the PR for the review workflow.
      expect(prompt).toContain("PR #301");
      // The prompt instructs the reviewer to use the initial-instruction
      // commands for the combined Pass 2 posting (no PR-numbered duplicates).
      expect(prompt).toContain("from your initial instructions");
    });

    it("includes merge instructions with PR number", async () => {
      const body = make_pr_payload("opened", 302, "test-org/lobster-farm");
      const req = make_request(body, {
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign_payload(body),
      });
      const res = make_response();
      const ctx = make_context();

      await handle_github_webhook(req, res, ctx);

      await vi.waitFor(
        () => {
          expect((ctx.session_manager as any).spawn).toHaveBeenCalledTimes(1);
        },
        { timeout: 2000 },
      );

      const spawn_args = (ctx.session_manager as any).spawn.mock.calls[0]![0];
      const prompt: string = spawn_args.prompt;

      expect(prompt).toContain("gh pr merge 302 --squash --delete-branch");
      expect(prompt).toContain("gh pr checks 302 --required");
    });
  });

  describe("pre-spawn dedup guard", () => {
    it("skips spawn when non-dismissed bot review already exists (opened event)", async () => {
      // Configure exec mock: gh api returns review count > 0
      execFile_mock.mockImplementation(
        (
          _cmd: string,
          _args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string, stderr: string) => void,
        ) => {
          cb(null, "1", "");
        },
      );

      const body = make_pr_payload("opened", 400, "test-org/lobster-farm");
      const req = make_request(body, {
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign_payload(body),
      });
      const res = make_response();
      const ctx = make_context();

      const log_spy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await handle_github_webhook(req, res, ctx);

        // Allow async chains to settle
        await vi.waitFor(
          () => {
            expect(log_spy).toHaveBeenCalledWith(
              expect.stringContaining("Non-dismissed bot review already exists"),
            );
          },
          { timeout: 2000 },
        );

        // Reviewer should NOT be spawned
        expect((ctx.session_manager as any).spawn).not.toHaveBeenCalled();
      } finally {
        log_spy.mockRestore();
      }
    });

    it("always spawns reviewer for synchronize events even when bot review exists", async () => {
      // Configure exec mock: gh api returns review count > 0
      execFile_mock.mockImplementation(
        (
          _cmd: string,
          _args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string, stderr: string) => void,
        ) => {
          cb(null, "1", "");
        },
      );

      const body = make_pr_payload("synchronize", 401, "test-org/lobster-farm");
      const req = make_request(body, {
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign_payload(body),
      });
      const res = make_response();
      const ctx = make_context();

      await handle_github_webhook(req, res, ctx);

      // synchronize should bypass the pre-spawn check and always spawn
      await vi.waitFor(
        () => {
          expect((ctx.session_manager as any).spawn).toHaveBeenCalledTimes(1);
        },
        { timeout: 2000 },
      );

      // The gh api call for has_existing_bot_review should NOT have been made
      expect(execFile_mock).not.toHaveBeenCalled();
    });

    it("proceeds with spawn when pre-spawn dedup check fails", async () => {
      // Default: exec mock throws (already configured in beforeEach)
      // has_existing_bot_review should catch and return false → proceed with spawn

      const body = make_pr_payload("opened", 402, "test-org/lobster-farm");
      const req = make_request(body, {
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign_payload(body),
      });
      const res = make_response();
      const ctx = make_context();

      await handle_github_webhook(req, res, ctx);

      await vi.waitFor(
        () => {
          expect((ctx.session_manager as any).spawn).toHaveBeenCalledTimes(1);
        },
        { timeout: 2000 },
      );
    });
  });

  // Issue #261 — AutoReviewer two-pass review.
  // Pass 1 (spec compliance) is a hard gate that blocks Pass 2 (code quality).
  // The prompt is a single-session instruction block — we are asserting the
  // structural elements of that block, not runtime behavior (the reviewer
  // session itself interprets the prompt).
  describe("build_reviewer_prompt two-pass structure (issue #261)", () => {
    const make_pr = () => ({
      number: 42,
      title: "Test PR",
      head: { ref: "feature/test" },
      body: null,
      user: { login: "testuser" },
    });

    const issue_context = [
      "## Acceptance Criteria",
      "- [ ] Does the thing",
      "- [ ] Does the other thing",
    ].join("\n");

    describe("with a linked issue", () => {
      const prompt = build_reviewer_prompt(
        make_pr(),
        "/tmp/repo",
        "test-org/test-repo",
        issue_context,
      );

      it("contains a Pass 1 instruction block labelled 'Pass 1 — Spec Compliance'", () => {
        expect(prompt).toContain("Pass 1 — Spec Compliance");
        // A labelled heading, not just an incidental mention.
        expect(prompt).toMatch(/### Pass 1 — Spec Compliance/);
      });

      it("contains a Pass 2 instruction block labelled 'Pass 2 — Code Quality'", () => {
        expect(prompt).toContain("Pass 2 — Code Quality");
        expect(prompt).toMatch(/### Pass 2 — Code Quality/);
      });

      it("instructs the reviewer to halt after Pass 1 failure (do NOT run Pass 2)", () => {
        // The hard-gate language must be present. Case-sensitive "NOT" is the
        // spec's emphasis convention.
        expect(prompt).toMatch(/do NOT run Pass 2/i);
        // And the stop-immediately instruction.
        expect(prompt.toLowerCase()).toContain("stop immediately");
      });

      it("instructs the reviewer to check for under-building (missing acceptance criteria)", () => {
        expect(prompt.toLowerCase()).toContain("missing");
        expect(prompt.toLowerCase()).toContain("partial");
        expect(prompt).toMatch(/acceptance criter/i);
      });

      it("instructs the reviewer to check for over-building (unrequested scope)", () => {
        expect(prompt.toLowerCase()).toContain("over-build");
        expect(prompt.toLowerCase()).toContain("out of scope");
      });

      it("defines the Pass 1 CHANGES REQUESTED marker line verbatim", () => {
        expect(prompt).toContain("## Pass 1 — Spec Compliance: CHANGES REQUESTED");
      });

      it("defines the Pass 1 PASSED marker line verbatim", () => {
        expect(prompt).toContain("## Pass 1 — Spec Compliance: PASSED");
      });

      it("defines the Pass 2 marker line verbatim", () => {
        expect(prompt).toContain("## Pass 2 — Code Quality");
      });

      it("places the linked issue context BEFORE the Pass 1 instructions", () => {
        // The reviewer must read the spec before being told what to do with
        // it — this is a spec requirement, not cosmetic.
        const issue_idx = prompt.indexOf("## Linked Issue Context");
        const pass1_idx = prompt.indexOf("### Pass 1 — Spec Compliance");
        expect(issue_idx).toBeGreaterThanOrEqual(0);
        expect(pass1_idx).toBeGreaterThan(issue_idx);
      });

      it("preserves the three-case CI handling from #268", () => {
        // Failing / pending / passing must all still be distinguished in the
        // prompt. Regression guard against accidentally reverting #268.
        expect(prompt).toContain("FAILING required checks");
        expect(prompt).toContain("PENDING required checks");
        expect(prompt).toContain("PASSING required checks");
      });
    });

    describe("with no linked issue", () => {
      const prompt = build_reviewer_prompt(make_pr(), "/tmp/repo", "test-org/test-repo", "");

      it("treats Pass 1 as a documented no-op and defines the SKIPPED marker", () => {
        expect(prompt).toContain("## Pass 1 — Spec Compliance: SKIPPED (no linked issue)");
        expect(prompt.toLowerCase()).toContain("no linked issue");
      });

      it("still includes Pass 2 (code quality runs on unlinked PRs)", () => {
        expect(prompt).toMatch(/### Pass 2 — Code Quality/);
        expect(prompt).toContain("## Pass 2 — Code Quality");
      });

      it("does not include the linked-issue context section", () => {
        expect(prompt).not.toContain("## Linked Issue Context");
      });
    });
  });

  // Regression: reviewer skips re-review after fix commits because its
  // "skip if existing review" check is SHA-agnostic. A CHANGES_REQUESTED
  // review on a superseded commit should NOT block a fresh review on the
  // current head SHA. See issue #314, PR #311 as the triggering incident.
  describe("build_reviewer_prompt SHA-aware skip logic (issue #314)", () => {
    const make_pr_with_sha = (sha: string) => ({
      number: 42,
      title: "Test PR",
      head: { ref: "feature/test", sha },
      body: null,
      user: { login: "testuser" },
    });

    it("includes the current PR head SHA in the rendered prompt", () => {
      const sha = "00a22aff1234567890abcdef1234567890abcdef";
      const prompt = build_reviewer_prompt(
        make_pr_with_sha(sha),
        "/tmp/repo",
        "test-org/test-repo",
        "",
      );

      expect(prompt).toContain(sha);
    });

    it("scopes the 'skip if review exists' instruction to the current head SHA", () => {
      const sha = "00a22aff1234567890abcdef1234567890abcdef";
      const prompt = build_reviewer_prompt(
        make_pr_with_sha(sha),
        "/tmp/repo",
        "test-org/test-repo",
        "",
      );

      // The instruction must tie the skip decision to the current head SHA.
      // Prior reviews on older commits must be treated as stale.
      expect(prompt).toMatch(/current head SHA/i);
      expect(prompt.toLowerCase()).toContain("stale");
      // The exact SHA must appear in the skip-instruction context.
      expect(prompt).toContain(sha);
    });

    it("includes commit_id in the pre-existing-review jq query", () => {
      const prompt = build_reviewer_prompt(
        make_pr_with_sha("abc123"),
        "/tmp/repo",
        "test-org/test-repo",
        "",
      );

      // The jq query must select commit_id so the reviewer can compare it
      // to the current head SHA. Without this, there's no way to tell
      // a stale review apart from a live one.
      expect(prompt).toContain("commit_id");
      // And the commit_id must appear in the reviews-API jq context, not
      // just as a stray mention elsewhere.
      expect(prompt).toMatch(/gh api repos\/[^\s]+\/reviews[^\n]*commit_id/);
    });

    it("does not instruct the reviewer to post review outcomes via `gh pr comment`", () => {
      const prompt = build_reviewer_prompt(
        make_pr_with_sha("abc123"),
        "/tmp/repo",
        "test-org/test-repo",
        "## Acceptance Criteria\n- [ ] Do thing",
      );

      // Formal review states (approve / request-changes / comment as a
      // review state) are posted via `gh pr review`. A plain `gh pr comment`
      // is a PR comment, NOT a formal review — it does not update
      // reviewDecision and does not unblock auto-merge. The #311 "Round 2
      // Approved" plain-comment anomaly must not be reintroduced.
      expect(prompt).not.toContain("gh pr comment");
    });
  });
});
