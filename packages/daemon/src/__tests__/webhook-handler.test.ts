import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  handle_github_webhook,
  get_active_webhook_reviews,
  type WebhookContext,
} from "../webhook-handler.js";
import type { GitHubAppAuth } from "../github-app.js";
import type { EntityRegistry } from "../registry.js";
import type { ClaudeSessionManager } from "../session.js";

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
  action: string = "opened",
  pr_number: number = 42,
  repo_full_name: string = "test-org/lobster-farm",
  overrides: Record<string, unknown> = {},
  options: { installation_id?: number } = {},
): string {
  const payload: Record<string, unknown> = {
    action,
    pull_request: {
      number: pr_number,
      title: "Test PR",
      head: { ref: "feature/test" },
      body: "Closes #10",
      user: { login: "testuser" },
      ...overrides,
    },
    repository: { full_name: repo_full_name },
  };

  if (options.installation_id != null) {
    payload["installation"] = { id: options.installation_id };
  }

  return JSON.stringify(payload);
}

/** Create a mock IncomingMessage that emits body data. */
function make_request(
  body: string,
  headers: Record<string, string> = {},
): IncomingMessage {
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
    get_token_for_installation: vi.fn().mockImplementation(
      (id: string) => Promise.resolve(`ghs_install_${id}`),
    ),
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
    config: { paths: { lobsterfarm_dir: "/tmp/test-lf", projects_dir: "/tmp" } } as WebhookContext["config"],
    pool: null,
    pr_watches: null,
    ...overrides,
  };
}

// ── Tests ──

describe("handle_github_webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
        await vi.waitFor(() => {
          expect(close_linked_issues).toHaveBeenCalledWith(
            "test-org/lobster-farm",
            300,
            [10],
            "ghs_mock_token",
          );
        }, { timeout: 2000 });

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
      await vi.waitFor(() => {
        expect((ctx.session_manager as any).spawn).toHaveBeenCalledTimes(1);
      }, { timeout: 2000 });

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

      await vi.waitFor(() => {
        expect((ctx.session_manager as any).spawn).toHaveBeenCalledTimes(1);
      }, { timeout: 2000 });
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

        await vi.waitFor(() => {
          expect(cleanup_after_merge).toHaveBeenCalledWith(
            "/tmp/test-repo",
            "feature/55-cool",
          );
        }, { timeout: 2000 });
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

        await vi.waitFor(() => {
          expect(close_linked_issues).toHaveBeenCalledWith(
            "test-org/lobster-farm",
            77,
            [10, 20],
            "ghs_mock_token",
          );
        }, { timeout: 2000 });
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

        await vi.waitFor(() => {
          // Issue closing should NOT have been called (token failed)
          expect(close_linked_issues).not.toHaveBeenCalled();
          // But worktree cleanup should still have been called
          expect(cleanup_after_merge).toHaveBeenCalledWith(
            "/tmp/test-repo",
            "feature/88-thing",
          );
        }, { timeout: 2000 });
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
    it("marks review for requeue when synchronize arrives during active review", async () => {
      // First request: opens a review
      const body1 = make_pr_payload("opened", 600, "test-org/lobster-farm");
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
      await vi.waitFor(() => {
        expect((hanging_manager as any).spawn).toHaveBeenCalledTimes(1);
      }, { timeout: 2000 });

      // Second request: synchronize event for same PR
      const body2 = make_pr_payload("synchronize", 600, "test-org/lobster-farm");
      const req2 = make_request(body2, {
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign_payload(body2),
      });
      const res2 = make_response();

      await handle_github_webhook(req2, res2, ctx);

      // Give async processing time
      await new Promise((r) => setTimeout(r, 100));

      // Should NOT have spawned a second reviewer
      expect((hanging_manager as any).spawn).toHaveBeenCalledTimes(1);

      // The active review should be marked for requeue
      const active = get_active_webhook_reviews();
      const review = active.find(
        (r) => r.entity_id === "lobster-farm" && r.pr_number === 600,
      );
      expect(review).toBeDefined();
      expect(review!.needs_requeue).toBe(true);
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

        await vi.waitFor(() => {
          expect(error_spy).toHaveBeenCalledWith(
            expect.stringContaining("Failed to get installation token"),
          );
        }, { timeout: 2000 });

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
      (ctx.session_manager as any).spawn.mockRejectedValue(
        new Error("tmux not available"),
      );

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

        await vi.waitFor(() => {
          expect(error_spy).toHaveBeenCalledWith(
            expect.stringContaining("Failed to spawn reviewer"),
          );
        }, { timeout: 2000 });

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

      await vi.waitFor(() => {
        expect((ctx.session_manager as any).spawn).toHaveBeenCalledTimes(1);
      }, { timeout: 2000 });

      const spawn_args = (ctx.session_manager as any).spawn.mock.calls[0]![0];
      expect(spawn_args.archetype).toBe("reviewer");
    });
  });

  describe("multi-installation support", () => {
    it("uses get_token_for_installation when payload includes installation.id", async () => {
      const body = make_pr_payload("opened", 900, "test-org/lobster-farm", {}, {
        installation_id: 55555,
      });
      const req = make_request(body, {
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign_payload(body),
      });
      const res = make_response();
      const ctx = make_context();

      await handle_github_webhook(req, res, ctx);

      await vi.waitFor(() => {
        expect((ctx.session_manager as any).spawn).toHaveBeenCalledTimes(1);
      }, { timeout: 2000 });

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

      await vi.waitFor(() => {
        expect((ctx.session_manager as any).spawn).toHaveBeenCalledTimes(1);
      }, { timeout: 2000 });

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
        const body = make_pr_payload("closed", 902, "test-org/lobster-farm", {
          merged: true,
        }, {
          installation_id: 77777,
        });
        const req = make_request(body, {
          "x-github-event": "pull_request",
          "x-hub-signature-256": sign_payload(body),
        });
        const res = make_response();
        const ctx = make_context();

        await handle_github_webhook(req, res, ctx);

        await vi.waitFor(() => {
          expect(close_linked_issues).toHaveBeenCalledWith(
            "test-org/lobster-farm",
            902,
            [30],
            "ghs_install_77777",
          );
        }, { timeout: 2000 });

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
        const body = make_pr_payload("opened", 950, "test-org/lobster-farm", {}, {
          installation_id: 88888,
        });
        const req = make_request(body, {
          "x-github-event": "pull_request",
          "x-hub-signature-256": sign_payload(body),
        });
        const res = make_response();
        const ctx = make_context();

        await handle_github_webhook(req, res, ctx);

        // Wait for reviewer to be spawned
        await vi.waitFor(() => {
          expect((ctx.session_manager as any).spawn).toHaveBeenCalledTimes(1);
        }, { timeout: 2000 });

        // Simulate reviewer session completion
        const spawn_result = await (ctx.session_manager as any).spawn.mock.results[0].value;
        (ctx.session_manager as any).emit("session:completed", {
          session_id: spawn_result.session_id,
          exit_code: 0,
        });

        // Wait for post-review handling (resolve_token + detect_review_outcome)
        await vi.waitFor(() => {
          expect(detect_review_outcome).toHaveBeenCalled();
        }, { timeout: 2000 });

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

        await vi.waitFor(() => {
          expect((ctx.session_manager as any).spawn).toHaveBeenCalledTimes(1);
        }, { timeout: 2000 });

        // Simulate reviewer session completion
        const spawn_result = await (ctx.session_manager as any).spawn.mock.results[0].value;
        (ctx.session_manager as any).emit("session:completed", {
          session_id: spawn_result.session_id,
          exit_code: 0,
        });

        await vi.waitFor(() => {
          expect(detect_review_outcome).toHaveBeenCalled();
        }, { timeout: 2000 });

        // Default token from get_token() is "ghs_mock_token"
        expect(detect_review_outcome).toHaveBeenCalledWith(
          951,
          "/tmp/test-repo",
          "ghs_mock_token",
        );
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

        // First call succeeds (for spawn_review), subsequent calls fail (for post-review)
        let call_count = 0;
        (ctx.github_app.get_token as ReturnType<typeof vi.fn>).mockImplementation(() => {
          call_count++;
          if (call_count === 1) return Promise.resolve("ghs_mock_token");
          return Promise.reject(new Error("token expired"));
        });

        await handle_github_webhook(req, res, ctx);

        await vi.waitFor(() => {
          expect((ctx.session_manager as any).spawn).toHaveBeenCalledTimes(1);
        }, { timeout: 2000 });

        // Simulate reviewer session completion
        const spawn_result = await (ctx.session_manager as any).spawn.mock.results[0].value;
        (ctx.session_manager as any).emit("session:completed", {
          session_id: spawn_result.session_id,
          exit_code: 0,
        });

        // Wait for detect_review_outcome — should still be called (with undefined token)
        await vi.waitFor(() => {
          expect(detect_review_outcome).toHaveBeenCalled();
        }, { timeout: 2000 });

        // Token should be undefined since resolution failed
        expect(detect_review_outcome).toHaveBeenCalledWith(
          952,
          "/tmp/test-repo",
          undefined,
        );
      } finally {
        log_spy.mockRestore();
        error_spy.mockRestore();
      }
    });
  });
});
