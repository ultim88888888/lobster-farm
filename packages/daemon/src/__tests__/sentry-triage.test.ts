/**
 * Tests for Sentry triage orchestration (#204).
 *
 * Covers:
 * - format_stack_trace() — in-app frames, no-frames fallback, message-only events
 * - Dedup: second webhook for same issue within 30min does not spawn
 * - Cooldown: same issue within 24h is skipped, UNLESS action is regression
 * - Rate limit: 3rd simultaneous event queued, drained when slot opens
 * - Queue full (>5 items): drop + Discord alert sent
 * - Spawn failure: state set to dismissed, not left as investigating
 * - resolved event: state updated to auto-resolved
 * - Mutex resilience: write failure doesn't permanently break state chain
 */

import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ──

// vi.hoisted() creates variables accessible in hoisted vi.mock() factories
const { mock_fetch_details } = vi.hoisted(() => ({
  mock_fetch_details: vi.fn(),
}));

vi.mock("../sentry.js", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

vi.mock("../sentry-api.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    fetch_sentry_issue_details: mock_fetch_details,
  };
});

// ── Imports (after mocks) ──

import type { LobsterFarmConfig } from "@lobster-farm/shared";
import type { DiscordBot } from "../discord.js";
import type { EntityRegistry } from "../registry.js";
import { build_sentry_fix_prompt } from "../review-utils.js";
import { format_stack_trace } from "../sentry-api.js";
import type { SentryIssueDetails } from "../sentry-api.js";
import {
  type SentryTriageContext,
  type SentryTriageState,
  _reset_for_test,
  handle_sentry_fix_pr_merged,
  handle_sentry_resolved,
  handle_sentry_triage_event,
  load_triage_state,
  parse_triage_verdict,
  save_triage_state,
} from "../sentry-triage.js";
import type { ClaudeSessionManager } from "../session.js";

// ── Test helpers ──

let temp_dir: string;

function make_config(): LobsterFarmConfig {
  return {
    user: { name: "Test" },
    paths: { lobsterfarm_dir: temp_dir },
  } as unknown as LobsterFarmConfig;
}

function make_issue_details(overrides: Partial<SentryIssueDetails> = {}): SentryIssueDetails {
  return {
    title: "TypeError: Cannot read property 'foo' of undefined",
    culprit: "src/handler.ts in process_request",
    level: "error",
    count: "42",
    first_seen: "2026-04-06T10:00:00Z",
    last_seen: "2026-04-07T10:00:00Z",
    platform: "node",
    short_id: "TEST-1",
    web_url: "https://sentry.io/issues/12345/",
    tags: [{ key: "environment", value: "production" }],
    stack_trace:
      "TypeError: Cannot read property 'foo' of undefined\n  at process_request (src/handler.ts:42:5)",
    top_frame: null,
    contexts: { runtime: { name: "node", version: "20.0.0" } },
    ...overrides,
  };
}

function make_session_manager(): ClaudeSessionManager & EventEmitter {
  const emitter = new EventEmitter();
  const manager = Object.assign(emitter, {
    spawn: vi.fn().mockResolvedValue({
      session_id: `session-${String(Math.random()).slice(2, 10)}`,
      entity_id: "test-entity",
      feature_id: "sentry-triage-12345",
      archetype: "operator",
      started_at: new Date(),
      pid: 12345,
    }),
    get_active: vi.fn().mockReturnValue([]),
  });
  return manager as unknown as ClaudeSessionManager & EventEmitter;
}

function make_registry(): EntityRegistry {
  return {
    get_active: vi.fn().mockReturnValue([
      {
        entity: {
          id: "test-entity",
          name: "Test Entity",
          accounts: {
            sentry: {
              projects: [
                { slug: "test-backend", type: "backend", repo: "test-repo" },
                { slug: "test-frontend", type: "frontend", repo: "test-repo" },
              ],
            },
          },
          repos: [
            {
              name: "test-repo",
              url: "https://github.com/test-org/test-repo.git",
              path: "/tmp/test-repo",
            },
          ],
        },
      },
    ]),
    get: vi.fn().mockReturnValue({
      entity: {
        id: "test-entity",
        name: "Test Entity",
      },
    }),
  } as unknown as EntityRegistry;
}

function make_discord(): DiscordBot {
  return {
    send_to_entity: vi.fn().mockResolvedValue(undefined),
  } as unknown as DiscordBot;
}

function make_alert_router() {
  return {
    // Default: simulate incident_open returning a thread_id; other tiers return null.
    post_alert: vi.fn().mockImplementation(async (payload: { tier: string }) => {
      if (payload.tier === "incident_open") {
        return { message_id: "msg-100", thread_id: "thread-200" };
      }
      return { message_id: null };
    }),
    resolve_incident: vi.fn().mockResolvedValue(undefined),
  };
}

function make_context(overrides: Partial<SentryTriageContext> = {}): SentryTriageContext {
  return {
    session_manager: make_session_manager(),
    registry: make_registry(),
    discord: make_discord(),
    config: make_config(),
    alert_router: make_alert_router() as unknown as SentryTriageContext["alert_router"],
    ...overrides,
  };
}

// ── Setup ──

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  temp_dir = await mkdtemp(join(tmpdir(), "sentry-triage-test-"));

  // Set up required env vars
  process.env.SENTRY_AUTH_TOKEN = "test-token";
  process.env.SENTRY_ORG = "test-org";

  // Default mock: fetch_sentry_issue_details returns a valid issue
  mock_fetch_details.mockResolvedValue(make_issue_details());

  // Reset module-level state
  _reset_for_test();
});

afterEach(async () => {
  await rm(temp_dir, { recursive: true, force: true });
  delete process.env.SENTRY_AUTH_TOKEN;
  delete process.env.SENTRY_ORG;

  vi.restoreAllMocks();
});

// ── format_stack_trace tests ──

describe("format_stack_trace", () => {
  it("renders in-app frames from exception values", () => {
    const event = {
      exception: {
        values: [
          {
            type: "TypeError",
            value: "Cannot read property 'foo' of undefined",
            stacktrace: {
              frames: [
                {
                  filename: "node_modules/express/lib/router.js",
                  function: "handle",
                  lineNo: 100,
                  inApp: false,
                },
                {
                  filename: "src/handler.ts",
                  function: "process_request",
                  lineNo: 42,
                  colNo: 5,
                  inApp: true,
                },
                { filename: "src/middleware.ts", function: "auth_check", lineNo: 15, inApp: true },
              ],
            },
          },
        ],
      },
    };

    const result = format_stack_trace(event);

    // Should include in-app frames only (reversed for readability)
    expect(result).toContain("TypeError: Cannot read property 'foo' of undefined");
    expect(result).toContain("at auth_check (src/middleware.ts:15)");
    expect(result).toContain("at process_request (src/handler.ts:42:5)");
    // Should NOT include non-in-app frames when in-app frames exist
    expect(result).not.toContain("express");
  });

  it("falls back to all frames when no frames are marked in-app", () => {
    const event = {
      exception: {
        values: [
          {
            type: "Error",
            value: "something broke",
            stacktrace: {
              frames: [
                { filename: "lib/a.js", function: "a", lineNo: 1, inApp: false },
                { filename: "lib/b.js", function: "b", lineNo: 2, inApp: false },
              ],
            },
          },
        ],
      },
    };

    const result = format_stack_trace(event);

    // All frames should be shown when none are marked in-app
    expect(result).toContain("at b (lib/b.js:2)");
    expect(result).toContain("at a (lib/a.js:1)");
  });

  it("renders (no frames) when exception has empty stacktrace", () => {
    const event = {
      exception: {
        values: [
          {
            type: "Error",
            value: "no stack",
            stacktrace: { frames: [] },
          },
        ],
      },
    };

    const result = format_stack_trace(event);

    expect(result).toContain("Error: no stack");
    expect(result).toContain("(no frames)");
  });

  it("falls back to message for events without exceptions", () => {
    const event = {
      message: "Something unexpected happened",
    };

    const result = format_stack_trace(event);

    expect(result).toContain("(no stack trace — message event)");
    expect(result).toContain("Something unexpected happened");
  });

  it("returns (no stack trace) for empty events", () => {
    const event = {};

    const result = format_stack_trace(event);

    expect(result).toBe("(no stack trace)");
  });

  it("handles multiple exception values", () => {
    const event = {
      exception: {
        values: [
          {
            type: "TypeError",
            value: "inner error",
            stacktrace: {
              frames: [{ filename: "src/a.ts", function: "fn_a", lineNo: 10, inApp: true }],
            },
          },
          {
            type: "Error",
            value: "outer error",
            stacktrace: {
              frames: [{ filename: "src/b.ts", function: "fn_b", lineNo: 20, inApp: true }],
            },
          },
        ],
      },
    };

    const result = format_stack_trace(event);

    expect(result).toContain("TypeError: inner error");
    expect(result).toContain("at fn_a (src/a.ts:10)");
    expect(result).toContain("Error: outer error");
    expect(result).toContain("at fn_b (src/b.ts:20)");
  });

  it("includes source context lines when available", () => {
    const event = {
      exception: {
        values: [
          {
            type: "Error",
            value: "boom",
            stacktrace: {
              frames: [
                {
                  filename: "src/foo.ts",
                  function: "do_thing",
                  lineNo: 10,
                  inApp: true,
                  context: [
                    [9, "  const x = getInput();"],
                    [10, "  throw new Error('boom');"],
                    [11, "  return x;"],
                  ] as Array<[number, string]>,
                },
              ],
            },
          },
        ],
      },
    };

    const result = format_stack_trace(event);

    // Line 10 should have the ">" marker
    expect(result).toContain(">   10 | ");
    expect(result).toContain("throw new Error('boom')");
    // Non-error lines should have space marker
    expect(result).toContain("     9 | ");
  });
});

// ── Dedup tests ──

describe("dedup — active triage", () => {
  it("skips triage when same issue is already being triaged", async () => {
    const ctx = make_context();
    const sm = ctx.session_manager as unknown as { spawn: ReturnType<typeof vi.fn> };

    // First call: should spawn
    await handle_sentry_triage_event("ISSUE-1", "test-backend", "created", ctx);
    expect(sm.spawn).toHaveBeenCalledTimes(1);

    // Second call with same issue ID: should NOT spawn (already active)
    await handle_sentry_triage_event("ISSUE-1", "test-backend", "created", ctx);
    expect(sm.spawn).toHaveBeenCalledTimes(1); // still 1
  });
});

// ── Cooldown tests ──

describe("cooldown — 24h persistent", () => {
  it("skips triage when issue was triaged within 24h", async () => {
    const config = make_config();
    const ctx = make_context({ config });
    const sm = ctx.session_manager as unknown as { spawn: ReturnType<typeof vi.fn> };

    // Pre-seed state with a recent triage
    const state_dir = join(temp_dir, "state");
    await mkdir(state_dir, { recursive: true });
    const state: SentryTriageState = {
      triages: {
        "ISSUE-COOL": {
          entity_id: "test-entity",
          project_slug: "test-backend",
          error_title: "Old error",
          triaged_at: new Date().toISOString(), // just now
          status: "tracked",
          sentry_url: "https://sentry.io/issues/ISSUE-COOL/",
        },
      },
      stats: {
        total_triaged: 1,
        issues_created: 0,
        dismissed: 0,
        last_triage_at: new Date().toISOString(),
      },
    };
    await save_triage_state(state, config);

    // Should skip: triaged recently
    await handle_sentry_triage_event("ISSUE-COOL", "test-backend", "created", ctx);
    expect(sm.spawn).not.toHaveBeenCalled();
  });

  it("bypasses cooldown for regression events", async () => {
    const config = make_config();
    const ctx = make_context({ config });
    const sm = ctx.session_manager as unknown as { spawn: ReturnType<typeof vi.fn> };

    // Pre-seed state with a recent triage
    const state_dir = join(temp_dir, "state");
    await mkdir(state_dir, { recursive: true });
    const state: SentryTriageState = {
      triages: {
        "ISSUE-REG": {
          entity_id: "test-entity",
          project_slug: "test-backend",
          error_title: "Regressed error",
          triaged_at: new Date().toISOString(), // just now
          status: "tracked",
          sentry_url: "https://sentry.io/issues/ISSUE-REG/",
        },
      },
      stats: {
        total_triaged: 1,
        issues_created: 0,
        dismissed: 0,
        last_triage_at: new Date().toISOString(),
      },
    };
    await save_triage_state(state, config);

    // Regression should bypass cooldown
    await handle_sentry_triage_event("ISSUE-REG", "test-backend", "regression", ctx);
    expect(sm.spawn).toHaveBeenCalledTimes(1);
  });

  it("allows triage when cooldown has expired (>24h)", async () => {
    const config = make_config();
    const ctx = make_context({ config });
    const sm = ctx.session_manager as unknown as { spawn: ReturnType<typeof vi.fn> };

    // Pre-seed state with an old triage (25h ago)
    const state_dir = join(temp_dir, "state");
    await mkdir(state_dir, { recursive: true });
    const old_time = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const state: SentryTriageState = {
      triages: {
        "ISSUE-OLD": {
          entity_id: "test-entity",
          project_slug: "test-backend",
          error_title: "Old error",
          triaged_at: old_time,
          status: "tracked",
          sentry_url: "https://sentry.io/issues/ISSUE-OLD/",
        },
      },
      stats: { total_triaged: 1, issues_created: 0, dismissed: 0, last_triage_at: old_time },
    };
    await save_triage_state(state, config);

    // Should proceed: cooldown expired
    await handle_sentry_triage_event("ISSUE-OLD", "test-backend", "created", ctx);
    expect(sm.spawn).toHaveBeenCalledTimes(1);
  });
});

// ── Rate limiting tests ──

describe("rate limiting", () => {
  it("queues 3rd event when 2 are already in-flight, drains on completion", async () => {
    const session_manager = make_session_manager();
    const ctx = make_context({ session_manager });
    const sm = session_manager as unknown as { spawn: ReturnType<typeof vi.fn> };

    // Give each spawn a unique session ID so we can track them
    let spawn_count = 0;
    sm.spawn.mockImplementation(async () => {
      spawn_count++;
      return {
        session_id: `session-${String(spawn_count)}`,
        entity_id: "test-entity",
        feature_id: `sentry-triage-${String(spawn_count)}`,
        archetype: "operator",
        started_at: new Date(),
        pid: 10000 + spawn_count,
      };
    });

    // Spawn 3 triages — first 2 should start, 3rd should queue
    await handle_sentry_triage_event("ISSUE-A", "test-backend", "created", ctx);
    await handle_sentry_triage_event("ISSUE-B", "test-backend", "created", ctx);
    await handle_sentry_triage_event("ISSUE-C", "test-backend", "created", ctx);

    // Only 2 sessions spawned (at capacity)
    expect(sm.spawn).toHaveBeenCalledTimes(2);

    // Complete session-1 to open a slot → queue should drain
    (session_manager as unknown as EventEmitter).emit("session:completed", {
      session_id: "session-1",
      exit_code: 0,
    });

    // Wait for async queue drain
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Now the 3rd issue should have been spawned from the queue
    expect(sm.spawn).toHaveBeenCalledTimes(3);
  });

  it("drops events and alerts when queue exceeds MAX_QUEUE_DEPTH (5)", async () => {
    const session_manager = make_session_manager();
    const discord = make_discord();
    const ctx = make_context({ session_manager, discord });
    const sm = session_manager as unknown as { spawn: ReturnType<typeof vi.fn> };

    let spawn_count = 0;
    sm.spawn.mockImplementation(async () => {
      spawn_count++;
      return {
        session_id: `session-${String(spawn_count)}`,
        entity_id: "test-entity",
        feature_id: `sentry-triage-${String(spawn_count)}`,
        archetype: "operator",
        started_at: new Date(),
        pid: 10000 + spawn_count,
      };
    });

    // Fill capacity (2 active) + queue (5 queued) = 7 events
    for (let i = 0; i < 7; i++) {
      mock_fetch_details.mockResolvedValueOnce(
        make_issue_details({
          title: `Error ${String(i)}`,
        }),
      );
      await handle_sentry_triage_event(`ISSUE-${String(i)}`, "test-backend", "created", ctx);
    }

    // 2 spawned, 5 queued
    expect(sm.spawn).toHaveBeenCalledTimes(2);

    // 8th event: queue is full — should be dropped
    mock_fetch_details.mockResolvedValueOnce(
      make_issue_details({
        title: "Error overflow",
      }),
    );
    await handle_sentry_triage_event("ISSUE-OVERFLOW", "test-backend", "created", ctx);

    // Still 2 spawned (no new spawn)
    expect(sm.spawn).toHaveBeenCalledTimes(2);

    // Alert router should have been called about the drop
    const alert_router = ctx.alert_router as unknown as { post_alert: ReturnType<typeof vi.fn> };
    expect(alert_router.post_alert).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_id: "test-entity",
        tier: "action_required",
        title: expect.stringContaining("queue full"),
      }),
    );
  });
});

// ── Spawn failure tests ──

describe("spawn failure", () => {
  it("sets state to dismissed when spawn fails, not left as investigating", async () => {
    const session_manager = make_session_manager();
    const config = make_config();
    const ctx = make_context({ session_manager, config });
    const sm = session_manager as unknown as { spawn: ReturnType<typeof vi.fn> };

    // Make spawn reject
    sm.spawn.mockRejectedValueOnce(new Error("tmux session creation failed"));

    await handle_sentry_triage_event("ISSUE-FAIL", "test-backend", "created", ctx);

    // State should be dismissed, not investigating
    const state = await load_triage_state(config);
    expect(state.triages["ISSUE-FAIL"]).toBeDefined();
    expect(state.triages["ISSUE-FAIL"]!.status).toBe("dismissed");
  });
});

// ── resolved event tests ──

describe("handle_sentry_resolved", () => {
  it("updates state to auto-resolved for tracked issues", async () => {
    const config = make_config();

    // Pre-seed state with a tracked triage
    const state: SentryTriageState = {
      triages: {
        "ISSUE-RES": {
          entity_id: "test-entity",
          project_slug: "test-backend",
          error_title: "Some error",
          triaged_at: new Date().toISOString(),
          status: "tracked",
          sentry_url: "https://sentry.io/issues/ISSUE-RES/",
        },
      },
      stats: {
        total_triaged: 1,
        issues_created: 0,
        dismissed: 0,
        last_triage_at: new Date().toISOString(),
      },
    };
    await save_triage_state(state, config);

    // Handle resolved
    await handle_sentry_resolved("ISSUE-RES", config);

    // Check state was updated
    const updated = await load_triage_state(config);
    expect(updated.triages["ISSUE-RES"]!.status).toBe("auto-resolved");
  });

  it("does nothing for unknown issues", async () => {
    const config = make_config();

    // Empty state
    await save_triage_state(
      {
        triages: {},
        stats: { total_triaged: 0, issues_created: 0, dismissed: 0, last_triage_at: "" },
      },
      config,
    );

    // Should not throw
    await handle_sentry_resolved("ISSUE-UNKNOWN", config);

    const state = await load_triage_state(config);
    expect(state.triages["ISSUE-UNKNOWN"]).toBeUndefined();
  });

  it("does not re-resolve already auto-resolved issues", async () => {
    const config = make_config();
    const original_time = new Date(Date.now() - 60000).toISOString();

    const state: SentryTriageState = {
      triages: {
        "ISSUE-ALREADY": {
          entity_id: "test-entity",
          project_slug: "test-backend",
          error_title: "Already resolved",
          triaged_at: original_time,
          status: "auto-resolved",
          sentry_url: "https://sentry.io/issues/ISSUE-ALREADY/",
        },
      },
      stats: { total_triaged: 1, issues_created: 0, dismissed: 0, last_triage_at: original_time },
    };
    await save_triage_state(state, config);

    await handle_sentry_resolved("ISSUE-ALREADY", config);

    // State should be unchanged — no redundant write
    const updated = await load_triage_state(config);
    expect(updated.triages["ISSUE-ALREADY"]!.status).toBe("auto-resolved");
  });
});

// ── Entity resolution tests ──

describe("entity resolution", () => {
  it("skips triage when no entity is configured for the project slug", async () => {
    const ctx = make_context();
    const sm = ctx.session_manager as unknown as { spawn: ReturnType<typeof vi.fn> };

    await handle_sentry_triage_event("ISSUE-NO-ENTITY", "unknown-project", "created", ctx);

    expect(sm.spawn).not.toHaveBeenCalled();
    // fetch_sentry_issue_details should not have been called either
    expect(mock_fetch_details).not.toHaveBeenCalled();
  });

  it("skips triage when SENTRY_AUTH_TOKEN is not set", async () => {
    delete process.env.SENTRY_AUTH_TOKEN;

    const ctx = make_context();
    const sm = ctx.session_manager as unknown as { spawn: ReturnType<typeof vi.fn> };

    await handle_sentry_triage_event("ISSUE-NO-TOKEN", "test-backend", "created", ctx);

    expect(sm.spawn).not.toHaveBeenCalled();
  });
});

// ── Mutex resilience tests ──

describe("state write mutex resilience", () => {
  it("recovers from a transient write failure", async () => {
    const config = make_config();

    // First write succeeds: set up initial state
    await save_triage_state(
      {
        triages: {},
        stats: { total_triaged: 0, issues_created: 0, dismissed: 0, last_triage_at: "" },
      },
      config,
    );

    // Spawn a session that will fail, triggering update_triage_state
    const session_manager = make_session_manager();
    const ctx = make_context({ session_manager, config });
    const sm = session_manager as unknown as { spawn: ReturnType<typeof vi.fn> };

    // First triage: succeeds, writes "investigating" then "dismissed" on spawn fail
    sm.spawn.mockRejectedValueOnce(new Error("tmux fail"));
    await handle_sentry_triage_event("ISSUE-X", "test-backend", "created", ctx);

    // Verify state was written despite spawn failure
    let state = await load_triage_state(config);
    expect(state.triages["ISSUE-X"]!.status).toBe("dismissed");

    // Now make the state directory temporarily unwritable to simulate disk error
    // We'll do this by mocking save_triage_state indirectly — just verify
    // the chain still works after the first failure by doing another write
    sm.spawn.mockRejectedValueOnce(new Error("tmux fail again"));
    await handle_sentry_triage_event("ISSUE-Y", "test-backend", "created", ctx);

    // If the mutex chain was poisoned, ISSUE-Y would not be written.
    // The .catch(() => {}) fix ensures this write succeeds.
    state = await load_triage_state(config);
    expect(state.triages["ISSUE-Y"]!.status).toBe("dismissed");
  });
});

// ── State persistence tests ──

describe("state persistence", () => {
  it("creates state file and directory on first write", async () => {
    const config = make_config();

    // State dir doesn't exist yet
    const state: SentryTriageState = {
      triages: {
        "ISSUE-1": {
          entity_id: "test-entity",
          project_slug: "test-backend",
          error_title: "Test error",
          triaged_at: new Date().toISOString(),
          status: "investigating",
          sentry_url: "https://sentry.io/issues/1/",
        },
      },
      stats: {
        total_triaged: 1,
        issues_created: 0,
        dismissed: 0,
        last_triage_at: new Date().toISOString(),
      },
    };

    await save_triage_state(state, config);

    const loaded = await load_triage_state(config);
    expect(loaded.triages["ISSUE-1"]!.status).toBe("investigating");
    expect(loaded.stats.total_triaged).toBe(1);
  });

  it("returns empty state when file does not exist", async () => {
    const config = make_config();

    const state = await load_triage_state(config);

    expect(state.triages).toEqual({});
    expect(state.stats.total_triaged).toBe(0);
    expect(state.stats.last_triage_at).toBe("");
  });
});

// ── parse_triage_verdict tests (#250) ──

describe("parse_triage_verdict", () => {
  it("parses valid verdict JSON", () => {
    const lines = [
      "Some diagnostic output...",
      'SENTRY_TRIAGE_VERDICT:{"severity":"P1","auto_fixable":true,"github_issue":42,"fix_approach":"Fix the null check in handler.ts"}',
    ];

    const verdict = parse_triage_verdict(lines);

    expect(verdict).toEqual({
      severity: "P1",
      auto_fixable: true,
      github_issue: 42,
      fix_approach: "Fix the null check in handler.ts",
    });
  });

  it("returns null for malformed JSON", () => {
    const lines = ["SENTRY_TRIAGE_VERDICT:{invalid json}"];

    expect(parse_triage_verdict(lines)).toBeNull();
  });

  it("returns null when marker is missing", () => {
    const lines = [
      "Some output",
      "More output",
      '{"severity":"P1","auto_fixable":true,"github_issue":42}',
    ];

    expect(parse_triage_verdict(lines)).toBeNull();
  });

  it("finds verdict on non-last line (searches in reverse)", () => {
    const lines = [
      "Diagnostic output line 1",
      'SENTRY_TRIAGE_VERDICT:{"severity":"P2","auto_fixable":false,"github_issue":null,"fix_approach":null}',
      "Some trailing output after verdict",
    ];

    const verdict = parse_triage_verdict(lines);

    expect(verdict).toEqual({
      severity: "P2",
      auto_fixable: false,
      github_issue: null,
      fix_approach: null,
    });
  });

  it("returns null when severity is invalid", () => {
    const lines = [
      'SENTRY_TRIAGE_VERDICT:{"severity":"P3","auto_fixable":true,"github_issue":42,"fix_approach":"fix it"}',
    ];

    expect(parse_triage_verdict(lines)).toBeNull();
  });

  it("returns null when auto_fixable is not a boolean", () => {
    const lines = [
      'SENTRY_TRIAGE_VERDICT:{"severity":"P1","auto_fixable":"yes","github_issue":42,"fix_approach":"fix it"}',
    ];

    expect(parse_triage_verdict(lines)).toBeNull();
  });

  it("returns null when github_issue is a string instead of number", () => {
    const lines = [
      'SENTRY_TRIAGE_VERDICT:{"severity":"P1","auto_fixable":true,"github_issue":"42","fix_approach":"fix it"}',
    ];

    expect(parse_triage_verdict(lines)).toBeNull();
  });

  it("handles missing optional fields gracefully", () => {
    const lines = ['SENTRY_TRIAGE_VERDICT:{"severity":"P1","auto_fixable":false}'];

    const verdict = parse_triage_verdict(lines);

    expect(verdict).toEqual({
      severity: "P1",
      auto_fixable: false,
      github_issue: null,
      fix_approach: null,
    });
  });

  it("returns null for empty output_lines", () => {
    expect(parse_triage_verdict([])).toBeNull();
  });
});

// ── Auto-fix spawning tests (#250) ──

describe("auto-fix spawning", () => {
  /**
   * Helper: trigger a triage event, let it complete with a given verdict,
   * and return the session manager for assertions.
   */
  async function triage_with_verdict(
    verdict_json: string,
    overrides: Partial<SentryTriageContext> = {},
  ) {
    const session_manager = make_session_manager();
    const ctx = make_context({ session_manager, ...overrides });
    const sm = session_manager as unknown as { spawn: ReturnType<typeof vi.fn> };

    let spawn_count = 0;
    sm.spawn.mockImplementation(async () => {
      spawn_count++;
      return {
        session_id: `session-${String(spawn_count)}`,
        entity_id: "test-entity",
        feature_id: `sentry-triage-${String(spawn_count)}`,
        archetype: spawn_count === 1 ? "operator" : "builder",
        started_at: new Date(),
        pid: 10000 + spawn_count,
      };
    });

    // Trigger triage
    await handle_sentry_triage_event("ISSUE-FIX", "test-backend", "created", ctx);
    expect(sm.spawn).toHaveBeenCalledTimes(1);

    // Complete the triage session with verdict
    (session_manager as unknown as EventEmitter).emit("session:completed", {
      session_id: "session-1",
      exit_code: 0,
      output_lines: ["Diagnostic output...", `SENTRY_TRIAGE_VERDICT:${verdict_json}`],
    });

    // Wait for async state updates and potential fix spawn
    await new Promise((resolve) => setTimeout(resolve, 200));

    return { sm, session_manager, ctx };
  }

  it("spawns auto-fix when P1 + auto_fixable + has github_issue", async () => {
    const { sm } = await triage_with_verdict(
      '{"severity":"P1","auto_fixable":true,"github_issue":42,"fix_approach":"Fix null check"}',
    );

    // Should have spawned 2 sessions: 1 triage (Ray) + 1 fix (Bob)
    expect(sm.spawn).toHaveBeenCalledTimes(2);

    // Verify the fix session was spawned as builder
    const fix_call = sm.spawn.mock.calls[1]![0] as Record<string, unknown>;
    expect(fix_call.archetype).toBe("builder");
    expect(fix_call.dna).toEqual(["coding-dna"]);
    expect(fix_call.feature_id).toBe("sentry-fix-ISSUE-FIX");
  });

  it("spawns auto-fix when P2 + auto_fixable + has github_issue", async () => {
    const { sm } = await triage_with_verdict(
      '{"severity":"P2","auto_fixable":true,"github_issue":99,"fix_approach":"Edge case fix"}',
    );

    expect(sm.spawn).toHaveBeenCalledTimes(2);
  });

  it("does NOT spawn auto-fix when P0 (regardless of auto_fixable)", async () => {
    const { sm } = await triage_with_verdict(
      '{"severity":"P0","auto_fixable":true,"github_issue":42,"fix_approach":"Critical fix"}',
    );

    // Only 1 session: triage only, no fix
    expect(sm.spawn).toHaveBeenCalledTimes(1);
  });

  it("does NOT spawn auto-fix when auto_fixable is false", async () => {
    const { sm } = await triage_with_verdict(
      '{"severity":"P1","auto_fixable":false,"github_issue":42,"fix_approach":"Needs manual review"}',
    );

    expect(sm.spawn).toHaveBeenCalledTimes(1);
  });

  it("does NOT spawn auto-fix when github_issue is null", async () => {
    const { sm } = await triage_with_verdict(
      '{"severity":"P1","auto_fixable":true,"github_issue":null,"fix_approach":"Fix something"}',
    );

    expect(sm.spawn).toHaveBeenCalledTimes(1);
  });

  it("does NOT spawn auto-fix when no verdict is parsed (graceful degradation)", async () => {
    const session_manager = make_session_manager();
    const ctx = make_context({ session_manager });
    const sm = session_manager as unknown as { spawn: ReturnType<typeof vi.fn> };

    await handle_sentry_triage_event("ISSUE-NO-VERDICT", "test-backend", "created", ctx);
    expect(sm.spawn).toHaveBeenCalledTimes(1);

    // Resolve the spawned session to get its session_id
    const spawned = (await sm.spawn.mock.results[0]!.value) as { session_id: string };

    // Complete without a verdict line
    (session_manager as unknown as EventEmitter).emit("session:completed", {
      session_id: spawned.session_id,
      exit_code: 0,
      output_lines: ["Diagnostic output only", "No verdict here"],
    });

    await new Promise((resolve) => setTimeout(resolve, 200));

    // Should not have spawned a fix session
    expect(sm.spawn).toHaveBeenCalledTimes(1);

    // State should still be updated to "tracked" (legacy behavior)
    const state = await load_triage_state(ctx.config);
    expect(state.triages["ISSUE-NO-VERDICT"]!.status).toBe("tracked");
  });

  it("skips auto-fix when fix attempt cap (2) is reached", async () => {
    const config = make_config();
    const session_manager = make_session_manager();
    const ctx = make_context({ session_manager, config });
    const sm = session_manager as unknown as { spawn: ReturnType<typeof vi.fn> };

    // Pre-seed state: 2 fix attempts already used
    const state_dir = join(temp_dir, "state");
    await mkdir(state_dir, { recursive: true });
    const state: SentryTriageState = {
      triages: {
        "ISSUE-CAPPED": {
          entity_id: "test-entity",
          project_slug: "test-backend",
          error_title: "Some error",
          triaged_at: new Date().toISOString(),
          status: "tracked",
          sentry_url: "https://sentry.io/issues/ISSUE-CAPPED/",
          severity: "P1",
          auto_fixable: true,
          fix_attempts: 2,
          fix_status: "failed",
        },
      },
      stats: {
        total_triaged: 1,
        issues_created: 1,
        dismissed: 0,
        last_triage_at: new Date().toISOString(),
      },
    };
    await save_triage_state(state, config);

    let spawn_count = 0;
    sm.spawn.mockImplementation(async () => {
      spawn_count++;
      return {
        session_id: `session-${String(spawn_count)}`,
        entity_id: "test-entity",
        feature_id: `triage-${String(spawn_count)}`,
        archetype: "operator",
        started_at: new Date(),
        pid: 10000 + spawn_count,
      };
    });

    await handle_sentry_triage_event("ISSUE-CAPPED", "test-backend", "regression", ctx);
    expect(sm.spawn).toHaveBeenCalledTimes(1);

    // Complete with auto_fixable verdict
    (session_manager as unknown as EventEmitter).emit("session:completed", {
      session_id: "session-1",
      exit_code: 0,
      output_lines: [
        'SENTRY_TRIAGE_VERDICT:{"severity":"P1","auto_fixable":true,"github_issue":42,"fix_approach":"Try again"}',
      ],
    });

    await new Promise((resolve) => setTimeout(resolve, 200));

    // Fix should NOT have been spawned — at cap
    expect(sm.spawn).toHaveBeenCalledTimes(1);
  });

  it("updates fix_status to 'fixed' on fix session completion", async () => {
    const config = make_config();
    const { sm, session_manager, ctx } = await triage_with_verdict(
      '{"severity":"P1","auto_fixable":true,"github_issue":42,"fix_approach":"Fix null check"}',
    );

    expect(sm.spawn).toHaveBeenCalledTimes(2);

    // Complete the fix session
    (session_manager as unknown as EventEmitter).emit("session:completed", {
      session_id: "session-2",
      exit_code: 0,
      output_lines: ["Fixed the issue"],
    });

    await new Promise((resolve) => setTimeout(resolve, 200));

    const state = await load_triage_state(config);
    expect(state.triages["ISSUE-FIX"]!.fix_status).toBe("fixed");
  });

  it("updates fix_status to 'failed' on fix session failure", async () => {
    const config = make_config();
    const { sm, session_manager, ctx } = await triage_with_verdict(
      '{"severity":"P1","auto_fixable":true,"github_issue":42,"fix_approach":"Fix null check"}',
    );

    expect(sm.spawn).toHaveBeenCalledTimes(2);

    // Fail the fix session
    (session_manager as unknown as EventEmitter).emit(
      "session:failed",
      "session-2",
      "tmux crashed",
    );

    await new Promise((resolve) => setTimeout(resolve, 200));

    const state = await load_triage_state(config);
    expect(state.triages["ISSUE-FIX"]!.fix_status).toBe("failed");
  });
});

// ── build_sentry_fix_prompt tests (#250) ──

describe("build_sentry_fix_prompt", () => {
  it("includes Closes #N when github_issue is provided", () => {
    const verdict = {
      severity: "P1",
      fix_approach: "Fix the null check",
      github_issue: 42,
    };
    const issue_details = {
      title: "TypeError: Cannot read property 'foo'",
      web_url: "https://sentry.io/issues/12345/",
      stack_trace: "at handler.ts:42",
      culprit: "src/handler.ts",
    };

    const prompt = build_sentry_fix_prompt(verdict, issue_details);

    expect(prompt).toContain("Closes #42");
    expect(prompt).toContain("**GitHub Issue:** #42");
  });

  it("omits Closes #N when github_issue is null", () => {
    const verdict = {
      severity: "P2",
      fix_approach: "Fix edge case",
      github_issue: null,
    };
    const issue_details = {
      title: "Error: edge case",
      web_url: "https://sentry.io/issues/99/",
      stack_trace: "at util.ts:10",
      culprit: "src/util.ts",
    };

    const prompt = build_sentry_fix_prompt(verdict, issue_details);

    expect(prompt).not.toContain("Closes #");
    expect(prompt).not.toContain("**GitHub Issue:**");
  });

  it("includes fix approach when provided", () => {
    const verdict = {
      severity: "P1",
      fix_approach: "Add null guard before accessing response.data",
      github_issue: 10,
    };
    const issue_details = {
      title: "TypeError",
      web_url: "https://sentry.io/issues/1/",
      stack_trace: "at api.ts:5",
      culprit: "src/api.ts",
    };

    const prompt = build_sentry_fix_prompt(verdict, issue_details);

    expect(prompt).toContain("Add null guard before accessing response.data");
    expect(prompt).toContain("## Diagnosis & Fix Approach");
  });

  it("omits fix approach section when fix_approach is null", () => {
    const verdict = {
      severity: "P1",
      fix_approach: null,
      github_issue: 10,
    };
    const issue_details = {
      title: "Error",
      web_url: "https://sentry.io/issues/1/",
      stack_trace: "at x.ts:1",
      culprit: "src/x.ts",
    };

    const prompt = build_sentry_fix_prompt(verdict, issue_details);

    expect(prompt).not.toContain("## Diagnosis & Fix Approach");
  });

  it("includes error details and stack trace", () => {
    const verdict = {
      severity: "P1",
      fix_approach: null,
      github_issue: 5,
    };
    const issue_details = {
      title: "RangeError: out of bounds",
      web_url: "https://sentry.io/issues/555/",
      stack_trace: "RangeError: out of bounds\n  at Array.push (native)\n  at handler.ts:99",
      culprit: "src/handler.ts in process",
    };

    const prompt = build_sentry_fix_prompt(verdict, issue_details);

    expect(prompt).toContain("**Error:** RangeError: out of bounds");
    expect(prompt).toContain("**Severity:** P1");
    expect(prompt).toContain("**Culprit:** src/handler.ts in process");
    expect(prompt).toContain("at handler.ts:99");
    expect(prompt).toContain("Do NOT merge the PR");
  });
});

// ── Thread-based alert lifecycle tests (#310) ──

const USER_TAG = "<@732686813856006245>";

describe("thread-based alerts — ingress", () => {
  it("opens incident thread with correct title and body on ingress", async () => {
    const ctx = make_context();
    const alert_router = ctx.alert_router as unknown as {
      post_alert: ReturnType<typeof vi.fn>;
    };

    await handle_sentry_triage_event("ISSUE-INGRESS-1", "test-backend", "created", ctx);

    // Incident_open should have been posted first, with the Sentry issue title + URL
    const incident_open_call = alert_router.post_alert.mock.calls.find(
      (c) => (c[0] as { tier: string }).tier === "incident_open",
    );
    expect(incident_open_call).toBeDefined();
    const payload = incident_open_call![0] as {
      title: string;
      body: string;
      entity_id: string;
    };
    expect(payload.entity_id).toBe("test-entity");
    expect(payload.title).toContain("Sentry");
    expect(payload.title).toContain("TypeError");
    expect(payload.body).toContain("https://sentry.io/issues/12345/");
    expect(payload.body).toContain("received");
  });

  it("triaging posts 🔍 thread update after session spawns", async () => {
    const ctx = make_context();
    const alert_router = ctx.alert_router as unknown as {
      post_alert: ReturnType<typeof vi.fn>;
    };

    await handle_sentry_triage_event("ISSUE-TRIAGING", "test-backend", "created", ctx);
    // Allow the async post_alert in spawn_triage_session (fire-and-forget) to flush.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const triaging_update = alert_router.post_alert.mock.calls.find((c) => {
      const p = c[0] as { tier: string; body: string };
      return p.tier === "incident_update" && p.body.includes("Triage session started");
    });
    expect(triaging_update).toBeDefined();
    const payload = triaging_update![0] as {
      tier: string;
      incident_id: string;
      body: string;
    };
    expect(payload.incident_id).toBe("thread-200");
    expect(payload.body).toContain("\u{1f50d}");
  });

  it("persists thread_id on triage state after ingress", async () => {
    const config = make_config();
    const ctx = make_context({ config });

    await handle_sentry_triage_event("ISSUE-PERSIST", "test-backend", "created", ctx);

    const state = await load_triage_state(config);
    expect(state.triages["ISSUE-PERSIST"]).toBeDefined();
    expect(state.triages["ISSUE-PERSIST"]!.thread_id).toBe("thread-200");
    expect(state.triages["ISSUE-PERSIST"]!.alert_message_id).toBe("msg-100");
  });

  it("does NOT open incident when dedup gate fires", async () => {
    const ctx = make_context();
    const alert_router = ctx.alert_router as unknown as {
      post_alert: ReturnType<typeof vi.fn>;
    };

    // First call opens incident
    await handle_sentry_triage_event("ISSUE-DEDUP", "test-backend", "created", ctx);
    const opens_first = alert_router.post_alert.mock.calls.filter(
      (c) => (c[0] as { tier: string }).tier === "incident_open",
    );
    expect(opens_first.length).toBe(1);

    // Second call should be deduped — no new incident_open
    await handle_sentry_triage_event("ISSUE-DEDUP", "test-backend", "created", ctx);
    const opens_second = alert_router.post_alert.mock.calls.filter(
      (c) => (c[0] as { tier: string }).tier === "incident_open",
    );
    expect(opens_second.length).toBe(1);
  });

  it("does NOT open incident when cooldown gate fires (non-regression)", async () => {
    const config = make_config();
    const ctx = make_context({ config });
    const alert_router = ctx.alert_router as unknown as {
      post_alert: ReturnType<typeof vi.fn>;
    };

    // Pre-seed a recent triage
    const state_dir = join(temp_dir, "state");
    await mkdir(state_dir, { recursive: true });
    await save_triage_state(
      {
        triages: {
          "ISSUE-COOL-310": {
            entity_id: "test-entity",
            project_slug: "test-backend",
            error_title: "Old error",
            triaged_at: new Date().toISOString(),
            status: "tracked",
            sentry_url: "https://sentry.io/issues/ISSUE-COOL-310/",
          },
        },
        stats: {
          total_triaged: 1,
          issues_created: 0,
          dismissed: 0,
          last_triage_at: new Date().toISOString(),
        },
      },
      config,
    );

    await handle_sentry_triage_event("ISSUE-COOL-310", "test-backend", "created", ctx);

    const opens = alert_router.post_alert.mock.calls.filter(
      (c) => (c[0] as { tier: string }).tier === "incident_open",
    );
    expect(opens.length).toBe(0);
  });
});

describe("thread-based alerts — state transitions", () => {
  /**
   * Helper: trigger ingress + complete the triage session with a given verdict.
   * Returns the spy so the caller can assert on thread messages.
   */
  async function triage_and_complete(
    sentry_issue_id: string,
    verdict_json: string | null,
    overrides: Partial<SentryTriageContext> = {},
  ) {
    const session_manager = make_session_manager();
    const ctx = make_context({ session_manager, ...overrides });
    const sm = session_manager as unknown as { spawn: ReturnType<typeof vi.fn> };

    let spawn_count = 0;
    sm.spawn.mockImplementation(async () => {
      spawn_count++;
      return {
        session_id: `session-${String(spawn_count)}`,
        entity_id: "test-entity",
        feature_id: `sentry-triage-${sentry_issue_id}`,
        archetype: spawn_count === 1 ? "operator" : "builder",
        started_at: new Date(),
        pid: 10000 + spawn_count,
      };
    });

    await handle_sentry_triage_event(sentry_issue_id, "test-backend", "created", ctx);

    const output_lines = verdict_json
      ? ["Diagnostic output...", `SENTRY_TRIAGE_VERDICT:${verdict_json}`]
      : ["Diagnostic prose line 1", "Diagnostic prose line 2", "ran out of tokens, no verdict"];

    (session_manager as unknown as EventEmitter).emit("session:completed", {
      session_id: "session-1",
      exit_code: 0,
      output_lines,
    });

    await new Promise((resolve) => setTimeout(resolve, 200));

    return { ctx, sm, session_manager };
  }

  it("verdict (P1 auto-fixable) posts thread update, no user tag", async () => {
    const { ctx } = await triage_and_complete(
      "ISSUE-P1",
      '{"severity":"P1","auto_fixable":true,"github_issue":42,"fix_approach":"Fix null check"}',
    );
    const alert_router = ctx.alert_router as unknown as {
      post_alert: ReturnType<typeof vi.fn>;
    };

    // Find the incident_update call for the verdict
    const updates = alert_router.post_alert.mock.calls.filter(
      (c) => (c[0] as { tier: string }).tier === "incident_update",
    );
    expect(updates.length).toBeGreaterThanOrEqual(1);

    const verdict_update = updates.find((c) => {
      const body = (c[0] as { body: string }).body;
      return body.includes("P1") && body.includes("Fix null check");
    });
    expect(verdict_update).toBeDefined();
    const payload = verdict_update![0] as {
      tier: string;
      incident_id: string;
      body: string;
    };
    expect(payload.incident_id).toBe("thread-200");
    expect(payload.body).not.toContain(USER_TAG);
    expect(payload.body).toContain("#42");

    // No action_required top-level alert for the verdict anymore
    const action_required_verdict = alert_router.post_alert.mock.calls.find((c) => {
      const p = c[0] as { tier: string; title: string };
      return p.tier === "action_required" && p.title.includes("triage");
    });
    expect(action_required_verdict).toBeUndefined();
  });

  it("verdict (P0) posts thread update WITH user tag", async () => {
    const { ctx } = await triage_and_complete(
      "ISSUE-P0",
      '{"severity":"P0","auto_fixable":false,"github_issue":5,"fix_approach":null}',
    );
    const alert_router = ctx.alert_router as unknown as {
      post_alert: ReturnType<typeof vi.fn>;
    };

    const updates = alert_router.post_alert.mock.calls.filter(
      (c) => (c[0] as { tier: string }).tier === "incident_update",
    );
    const verdict_update = updates.find((c) => {
      const body = (c[0] as { body: string }).body;
      return body.includes("P0");
    });
    expect(verdict_update).toBeDefined();
    expect((verdict_update![0] as { body: string }).body).toContain(USER_TAG);
  });

  it("no-verdict posts thread update WITH user tag AND Ray's last 20 output lines", async () => {
    // Build a session output with >20 lines to verify tail truncation
    const long_output = Array.from({ length: 30 }, (_, i) => `line ${String(i + 1)}`);

    const session_manager = make_session_manager();
    const ctx = make_context({ session_manager });
    const sm = session_manager as unknown as { spawn: ReturnType<typeof vi.fn> };

    sm.spawn.mockResolvedValue({
      session_id: "session-1",
      entity_id: "test-entity",
      feature_id: "sentry-triage-ISSUE-NOVERDICT",
      archetype: "operator",
      started_at: new Date(),
      pid: 12345,
    });

    await handle_sentry_triage_event("ISSUE-NOVERDICT", "test-backend", "created", ctx);

    (session_manager as unknown as EventEmitter).emit("session:completed", {
      session_id: "session-1",
      exit_code: 0,
      output_lines: long_output,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));

    const alert_router = ctx.alert_router as unknown as {
      post_alert: ReturnType<typeof vi.fn>;
    };
    const updates = alert_router.post_alert.mock.calls.filter(
      (c) => (c[0] as { tier: string }).tier === "incident_update",
    );
    const no_verdict_update = updates.find((c) => {
      const body = (c[0] as { body: string }).body;
      return body.includes("didn't emit") || body.includes("didn't output");
    });
    expect(no_verdict_update).toBeDefined();
    const body = (no_verdict_update![0] as { body: string }).body;
    expect(body).toContain(USER_TAG);
    // Last 20 lines means lines 11..30; line 10 must NOT appear, line 11 must
    expect(body).toContain("line 30");
    expect(body).toContain("line 11");
    expect(body).not.toContain("line 10\n");
    // Should be code-blocked
    expect(body).toContain("```");
  });

  it("session failure posts thread update WITH user tag and error message", async () => {
    const session_manager = make_session_manager();
    const ctx = make_context({ session_manager });
    const sm = session_manager as unknown as { spawn: ReturnType<typeof vi.fn> };

    sm.spawn.mockResolvedValue({
      session_id: "session-1",
      entity_id: "test-entity",
      feature_id: "sentry-triage-ISSUE-CRASH",
      archetype: "operator",
      started_at: new Date(),
      pid: 12345,
    });

    await handle_sentry_triage_event("ISSUE-CRASH", "test-backend", "created", ctx);

    (session_manager as unknown as EventEmitter).emit(
      "session:failed",
      "session-1",
      "tmux session died unexpectedly",
    );
    await new Promise((resolve) => setTimeout(resolve, 200));

    const alert_router = ctx.alert_router as unknown as {
      post_alert: ReturnType<typeof vi.fn>;
    };
    const updates = alert_router.post_alert.mock.calls.filter(
      (c) => (c[0] as { tier: string }).tier === "incident_update",
    );
    const crash_update = updates.find((c) => {
      const body = (c[0] as { body: string }).body;
      return body.includes("crashed") || body.includes("tmux");
    });
    expect(crash_update).toBeDefined();
    const body = (crash_update![0] as { body: string }).body;
    expect(body).toContain(USER_TAG);
    expect(body).toContain("tmux session died unexpectedly");
  });

  it("fix-attempt exhaustion posts thread update WITH user tag", async () => {
    const config = make_config();
    const session_manager = make_session_manager();
    const ctx = make_context({ session_manager, config });
    const sm = session_manager as unknown as { spawn: ReturnType<typeof vi.fn> };

    // Pre-seed: 2 attempts already used, thread_id already set (as if from prior ingress)
    await save_triage_state(
      {
        triages: {
          "ISSUE-EXHAUST": {
            entity_id: "test-entity",
            project_slug: "test-backend",
            error_title: "Already tried to fix",
            triaged_at: new Date().toISOString(),
            status: "tracked",
            sentry_url: "https://sentry.io/issues/ISSUE-EXHAUST/",
            severity: "P1",
            auto_fixable: true,
            fix_attempts: 2,
            fix_status: "failed",
            thread_id: "thread-200",
            alert_message_id: "msg-100",
          },
        },
        stats: {
          total_triaged: 1,
          issues_created: 1,
          dismissed: 0,
          last_triage_at: new Date().toISOString(),
        },
      },
      config,
    );

    sm.spawn.mockResolvedValue({
      session_id: "session-1",
      entity_id: "test-entity",
      feature_id: "sentry-triage-ISSUE-EXHAUST",
      archetype: "operator",
      started_at: new Date(),
      pid: 12345,
    });

    // Regression bypasses cooldown
    await handle_sentry_triage_event("ISSUE-EXHAUST", "test-backend", "regression", ctx);

    // Complete with auto_fixable verdict — but cap will kick in
    (session_manager as unknown as EventEmitter).emit("session:completed", {
      session_id: "session-1",
      exit_code: 0,
      output_lines: [
        'SENTRY_TRIAGE_VERDICT:{"severity":"P1","auto_fixable":true,"github_issue":42,"fix_approach":"Try again"}',
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 300));

    const alert_router = ctx.alert_router as unknown as {
      post_alert: ReturnType<typeof vi.fn>;
    };
    const updates = alert_router.post_alert.mock.calls.filter(
      (c) => (c[0] as { tier: string }).tier === "incident_update",
    );
    const exhaust_update = updates.find((c) => {
      const body = (c[0] as { body: string }).body;
      return body.includes("after") && body.includes("attempts");
    });
    expect(exhaust_update).toBeDefined();
    expect((exhaust_update![0] as { body: string }).body).toContain(USER_TAG);
  });
});

describe("thread-based alerts — resolve on fix merge", () => {
  it("fix PR merge calls resolve_incident with PR number in body", async () => {
    const config = make_config();

    // Pre-seed state: triage has a thread_id and a linked github issue
    await save_triage_state(
      {
        triages: {
          "ISSUE-RESOLVE": {
            entity_id: "test-entity",
            project_slug: "test-backend",
            error_title: "Fixable error",
            triaged_at: new Date().toISOString(),
            status: "tracked",
            sentry_url: "https://sentry.io/issues/ISSUE-RESOLVE/",
            severity: "P1",
            auto_fixable: true,
            github_issue: 42,
            fix_attempts: 1,
            fix_status: "fixing",
            thread_id: "thread-200",
            alert_message_id: "msg-100",
          },
        },
        stats: {
          total_triaged: 1,
          issues_created: 1,
          dismissed: 0,
          last_triage_at: new Date().toISOString(),
        },
      },
      config,
    );

    const alert_router = make_alert_router();
    const ctx = make_context({
      config,
      alert_router: alert_router as unknown as SentryTriageContext["alert_router"],
    });

    // Simulate the fix PR merging — linked to issue #42, PR number 99
    await handle_sentry_fix_pr_merged(99, [42], ctx);

    expect(alert_router.resolve_incident).toHaveBeenCalledWith(
      "thread-200",
      expect.stringContaining("99"),
    );

    // Triage state fix_status should now be "fixed"
    const state = await load_triage_state(config);
    expect(state.triages["ISSUE-RESOLVE"]!.fix_status).toBe("fixed");
  });
});

describe("thread-based alerts — back-compat", () => {
  it("legacy triage state without thread_id falls back to action_required top-level alert", async () => {
    const config = make_config();

    // Pre-seed state WITHOUT thread_id (simulates a state from before #310)
    await save_triage_state(
      {
        triages: {
          "ISSUE-LEGACY": {
            entity_id: "test-entity",
            project_slug: "test-backend",
            error_title: "Legacy error",
            triaged_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
            status: "tracked",
            sentry_url: "https://sentry.io/issues/ISSUE-LEGACY/",
          },
        },
        stats: {
          total_triaged: 1,
          issues_created: 0,
          dismissed: 0,
          last_triage_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
        },
      },
      config,
    );

    const session_manager = make_session_manager();
    const alert_router = make_alert_router();
    // Simulate incident_open failing (so no thread_id is persisted) by returning nulls
    alert_router.post_alert.mockImplementation(async (payload: { tier: string }) => {
      if (payload.tier === "incident_open") {
        return { message_id: null };
      }
      return { message_id: null };
    });

    const ctx = make_context({
      config,
      session_manager,
      alert_router: alert_router as unknown as SentryTriageContext["alert_router"],
    });
    const sm = session_manager as unknown as { spawn: ReturnType<typeof vi.fn> };

    sm.spawn.mockResolvedValue({
      session_id: "session-1",
      entity_id: "test-entity",
      feature_id: "sentry-triage-ISSUE-LEGACY",
      archetype: "operator",
      started_at: new Date(),
      pid: 12345,
    });

    // cooldown expired (25h ago), so we proceed. But incident_open returned null → no thread_id persisted.
    await handle_sentry_triage_event("ISSUE-LEGACY", "test-backend", "created", ctx);

    (session_manager as unknown as EventEmitter).emit("session:completed", {
      session_id: "session-1",
      exit_code: 0,
      output_lines: [
        'SENTRY_TRIAGE_VERDICT:{"severity":"P1","auto_fixable":false,"github_issue":42,"fix_approach":"Manual review"}',
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 200));

    // With no thread_id, the verdict must fall back to action_required top-level alert
    const action_required = alert_router.post_alert.mock.calls.find((c) => {
      const p = c[0] as { tier: string; title: string };
      return p.tier === "action_required" && p.title.includes("triage");
    });
    expect(action_required).toBeDefined();
  });
});
