import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handle_github_webhook, type WebhookContext } from "../webhook-handler.js";
import type { GitHubAppAuth } from "../github-app.js";
import type { EntityRegistry } from "../registry.js";
import type { ClaudeSessionManager } from "../session.js";
// ── Test helpers ──

const WEBHOOK_SECRET = "test-secret-for-webhook-tests";

function sign_payload(payload: string, secret: string = WEBHOOK_SECRET): string {
  const hmac = createHmac("sha256", secret).update(payload).digest("hex");
  return `sha256=${hmac}`;
}

function make_pr_payload(
  action: string = "opened",
  pr_number: number = 42,
  repo_full_name: string = "ultim88888888/lobster-farm",
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
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
  });
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
              url: "https://github.com/ultim88888888/lobster-farm.git",
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
    ...overrides,
  };
}

// ── Tests ──

describe("handle_github_webhook", () => {
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
      const body = make_pr_payload("closed", 300, "ultim88888888/lobster-farm", { merged: false });
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
      const fetch_spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("{}", { status: 200 }),
      );
      const log_spy = vi.spyOn(console, "log").mockImplementation(() => {});

      try {
        const body = make_pr_payload("closed", 300, "ultim88888888/lobster-farm", { merged: true });
        const req = make_request(body, {
          "x-github-event": "pull_request",
          "x-hub-signature-256": sign_payload(body),
        });
        const res = make_response();
        const ctx = make_context();

        await handle_github_webhook(req, res, ctx);

        // Give async route_event time to process
        await vi.waitFor(() => {
          // Should have called fetch for the comment + close API calls on issue #10
          expect(fetch_spy).toHaveBeenCalledWith(
            "https://api.github.com/repos/ultim88888888/lobster-farm/issues/10/comments",
            expect.objectContaining({ method: "POST" }),
          );
          expect(fetch_spy).toHaveBeenCalledWith(
            "https://api.github.com/repos/ultim88888888/lobster-farm/issues/10",
            expect.objectContaining({ method: "PATCH" }),
          );
        }, { timeout: 2000 });

        expect(res._status).toBe(200);
        // No reviewer spawned for merged PRs
        expect((ctx.session_manager as any).spawn).not.toHaveBeenCalled();
      } finally {
        fetch_spy.mockRestore();
        log_spy.mockRestore();
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
});
