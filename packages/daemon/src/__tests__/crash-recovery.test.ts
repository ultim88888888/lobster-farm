import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolBot } from "../pool.js";
import { BotPoolTestBase } from "./helpers/test-bot-pool-base.js";

// Mock actions.ts — notify is imported by pool.ts for alerting
vi.mock("../actions.js", () => ({
  notify: vi.fn().mockResolvedValue(undefined),
}));

// Mock persistence to avoid filesystem side effects
vi.mock("../persistence.js", () => ({
  save_pool_state: vi.fn().mockResolvedValue(undefined),
  load_pool_state: vi.fn().mockResolvedValue({
    bots: [],
    session_history: {},
    avatar_state: {},
  }),
}));

// Mock sentry
vi.mock("../sentry.js", () => ({
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

// ── Test helpers ──

let temp_dir: string;

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    paths: { lobsterfarm_dir: temp_dir },
  });
}

function make_bot(overrides: Partial<PoolBot> & { id: number }): PoolBot {
  return {
    state: "free",
    channel_id: null,
    entity_id: null,
    archetype: null,
    channel_type: null,
    session_id: null,
    session_confirmed: true,
    tmux_session: `pool-${String(overrides.id)}`,
    last_active: null,
    assigned_at: null,
    state_dir: `/tmp/test-pool-${String(overrides.id)}`,
    model: null,
    effort: null,
    last_avatar_archetype: null,
    last_avatar_set_at: null,
    ...overrides,
  };
}

/**
 * Test-friendly subclass that stubs tmux/filesystem operations and
 * exposes internals needed for crash recovery assertions.
 */
class TestBotPool extends BotPoolTestBase {
  inject_bots(bots: PoolBot[]): void {
    (this as unknown as { bots: PoolBot[] }).bots = bots;
  }

  get_bots(): PoolBot[] {
    return (this as unknown as { bots: PoolBot[] }).bots;
  }

  get_crash_history(): Map<number, number[]> {
    return (this as unknown as { crash_history: Map<number, number[]> }).crash_history;
  }

  get_session_history(): Map<string, string> {
    return (this as unknown as { session_history: Map<string, string> }).session_history;
  }

  /** Expose check_assigned_health for direct invocation in tests. */
  async run_health_check(): Promise<void> {
    await this.check_assigned_health();
  }

  /** Override is_bot_idle — not relevant for crash recovery tests. */
  protected override is_bot_idle(): boolean {
    return true;
  }
}

// ── Tests ──

describe("crash recovery (issue #157)", () => {
  let config: LobsterFarmConfig;
  let pool: TestBotPool;
  let mock_start_tmux: ReturnType<typeof vi.fn>;
  let mock_is_tmux_alive: ReturnType<typeof vi.fn>;
  let mock_notify: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    temp_dir = await mkdtemp(join(tmpdir(), "crash-recovery-test-"));
    config = make_config();
    pool = new TestBotPool(config);

    // Get the module-level mock and clear accumulated calls between tests.
    // vi.mock() at the top replaces actions.notify with a vi.fn() — cast it.
    const actions = await import("../actions.js");
    mock_notify = actions.notify as unknown as ReturnType<typeof vi.fn>;
    mock_notify.mockClear();

    // Stub side effects
    vi.spyOn(pool as unknown as Record<string, unknown>, "kill_tmux" as never).mockImplementation(
      () => {},
    );
    vi.spyOn(
      pool as unknown as Record<string, unknown>,
      "write_access_json" as never,
    ).mockResolvedValue(undefined);
    vi.spyOn(
      pool as unknown as Record<string, unknown>,
      "set_bot_nickname" as never,
    ).mockResolvedValue(undefined);
    vi.spyOn(
      pool as unknown as Record<string, unknown>,
      "set_bot_avatar" as never,
    ).mockResolvedValue(undefined);
    mock_start_tmux = vi
      .spyOn(pool as unknown as Record<string, unknown>, "start_tmux" as never)
      .mockResolvedValue(undefined) as unknown as ReturnType<typeof vi.fn>;

    // Default: tmux is dead for all sessions (crash scenario)
    mock_is_tmux_alive = vi
      .spyOn(pool as unknown as Record<string, unknown>, "is_tmux_alive" as never)
      .mockReturnValue(false) as unknown as ReturnType<typeof vi.fn>;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(temp_dir, { recursive: true, force: true });
  });

  // ── Single crash → restart ──

  describe("single crash detection and restart", () => {
    it("detects dead tmux and attempts restart", async () => {
      const bot = make_bot({
        id: 2,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "test-entity",
        archetype: "planner",
        session_id: "sess-abc-123",
        channel_type: "work_room",
      });
      pool.inject_bots([bot]);

      await pool.run_health_check();

      // start_tmux should have been called to restart
      expect(mock_start_tmux).toHaveBeenCalledTimes(1);
    });

    it("uses --resume with existing session_id", async () => {
      const bot = make_bot({
        id: 2,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "test-entity",
        archetype: "planner",
        session_id: "sess-abc-123",
      });
      pool.inject_bots([bot]);

      await pool.run_health_check();

      // start_tmux args: bot, archetype, entity_id, working_dir, session_id, is_resume, extra_env
      const call_args = mock_start_tmux.mock.calls[0] as unknown[];
      expect(call_args[4]).toBe("sess-abc-123"); // session_id preserved
      expect(call_args[5]).toBe(true); // is_resume = true
    });

    it("generates fresh session_id when none exists", async () => {
      const bot = make_bot({
        id: 2,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "test-entity",
        archetype: "planner",
        session_id: null, // no session to resume
      });
      pool.inject_bots([bot]);

      await pool.run_health_check();

      const call_args = mock_start_tmux.mock.calls[0] as unknown[];
      expect(call_args[4]).toBeTruthy(); // a UUID was generated
      expect(call_args[5]).toBe(false); // is_resume = false
    });

    it("posts alert to #alerts on crash", async () => {
      const bot = make_bot({
        id: 2,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "test-entity",
        archetype: "planner",
        session_id: "sess-abc-123",
      });
      pool.inject_bots([bot]);

      await pool.run_health_check();

      expect(mock_notify).toHaveBeenCalledTimes(1);
      const [channel_type, message] = mock_notify.mock.calls[0] as [string, string];
      expect(channel_type).toBe("alerts");
      expect(message).toContain("Pool bot 2");
      expect(message).toContain("planner");
      expect(message).toContain("auto-restarted");
      expect(message).toContain("test-entity");
    });

    it("keeps bot in assigned state after successful restart", async () => {
      const bot = make_bot({
        id: 2,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "test-entity",
        archetype: "planner",
        session_id: "sess-abc-123",
      });
      pool.inject_bots([bot]);

      await pool.run_health_check();

      const bots = pool.get_bots();
      expect(bots[0].state).toBe("assigned");
      expect(bots[0].channel_id).toBe("ch-1");
      expect(bots[0].entity_id).toBe("test-entity");
      expect(bots[0].archetype).toBe("planner");
    });

    it("emits bot:crash_restarted event on successful restart", async () => {
      const bot = make_bot({
        id: 2,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "test-entity",
        archetype: "planner",
        session_id: "sess-abc-123",
      });
      pool.inject_bots([bot]);

      const events: unknown[] = [];
      pool.on("bot:crash_restarted", (data) => events.push(data));

      await pool.run_health_check();

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        bot_id: 2,
        channel_id: "ch-1",
        entity_id: "test-entity",
        resumed: true,
      });
    });

    it("falls back to free state when restart fails", async () => {
      mock_start_tmux.mockRejectedValue(new Error("tmux launch failed"));

      const bot = make_bot({
        id: 2,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "test-entity",
        archetype: "planner",
        session_id: "sess-abc-123",
      });
      pool.inject_bots([bot]);

      const events: unknown[] = [];
      pool.on("bot:session_ended", (data) => events.push(data));
      pool.on("bot:released", (data) => events.push(data));

      await pool.run_health_check();

      const bots = pool.get_bots();
      expect(bots[0].state).toBe("free");
      expect(bots[0].channel_id).toBeNull();
      expect(events).toHaveLength(2); // session_ended + released
    });

    it("stashes session history when restart fails", async () => {
      mock_start_tmux.mockRejectedValue(new Error("tmux launch failed"));

      const bot = make_bot({
        id: 2,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "test-entity",
        archetype: "planner",
        session_id: "sess-abc-123",
      });
      pool.inject_bots([bot]);

      await pool.run_health_check();

      const history = pool.get_session_history();
      expect(history.get("test-entity:ch-1")).toBe("sess-abc-123");
    });
  });

  // ── Crash loop detection ──

  describe("crash loop detection", () => {
    it("does not trigger crash loop with 3 total crashes (2 prior + 1 new)", async () => {
      const bot = make_bot({
        id: 3,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "test-entity",
        archetype: "builder",
        session_id: "sess-loop-1",
      });
      pool.inject_bots([bot]);

      // Simulate 2 prior crashes within the last hour — health check
      // records a 3rd. Total = 3, which does NOT exceed the >3 threshold.
      const now = Date.now();
      pool.get_crash_history().set(3, [now - 30 * 60_000, now - 10 * 60_000]);

      await pool.run_health_check();

      // Bot should be restarted (not released) — crash loop not triggered
      const bots = pool.get_bots();
      expect(bots[0].state).toBe("assigned");
      expect(mock_start_tmux).toHaveBeenCalledTimes(1);
    });

    it("triggers crash loop on 4th crash in 1 hour (3 prior + 1 new)", async () => {
      const bot = make_bot({
        id: 3,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "test-entity",
        archetype: "builder",
        session_id: "sess-loop-1",
      });
      pool.inject_bots([bot]);

      // Pre-populate with 3 recent crashes (within the hour)
      const now = Date.now();
      pool.get_crash_history().set(3, [now - 45 * 60_000, now - 20 * 60_000, now - 5 * 60_000]);

      await pool.run_health_check();

      // After the 4th crash is recorded, >3 in 1 hour → crash loop
      const bots = pool.get_bots();
      expect(bots[0].state).toBe("free");
      expect(bots[0].channel_id).toBeNull();

      // start_tmux should NOT have been called (crash loop bypasses restart)
      expect(mock_start_tmux).not.toHaveBeenCalled();
    });

    it("posts crash loop alert to #alerts", async () => {
      const bot = make_bot({
        id: 3,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "test-entity",
        archetype: "builder",
        session_id: "sess-loop-1",
      });
      pool.inject_bots([bot]);

      // Pre-populate with 3 recent crashes
      const now = Date.now();
      pool.get_crash_history().set(3, [now - 45 * 60_000, now - 20 * 60_000, now - 5 * 60_000]);

      await pool.run_health_check();

      expect(mock_notify).toHaveBeenCalledTimes(1);
      const [channel_type, message] = mock_notify.mock.calls[0] as [string, string];
      expect(channel_type).toBe("alerts");
      expect(message).toContain("crash loop");
      expect(message).toContain("Pool bot 3");
    });

    it("emits bot:crash_loop event", async () => {
      const bot = make_bot({
        id: 3,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "test-entity",
        archetype: "builder",
        session_id: "sess-loop-1",
      });
      pool.inject_bots([bot]);

      const now = Date.now();
      pool.get_crash_history().set(3, [now - 45 * 60_000, now - 20 * 60_000, now - 5 * 60_000]);

      const events: unknown[] = [];
      pool.on("bot:crash_loop", (data) => events.push(data));

      await pool.run_health_check();

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        bot_id: 3,
        channel_id: "ch-1",
        entity_id: "test-entity",
        archetype: "builder",
      });
    });

    it("stashes session history on crash loop release", async () => {
      const bot = make_bot({
        id: 3,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "test-entity",
        archetype: "builder",
        session_id: "sess-loop-1",
      });
      pool.inject_bots([bot]);

      const now = Date.now();
      pool.get_crash_history().set(3, [now - 45 * 60_000, now - 20 * 60_000, now - 5 * 60_000]);

      await pool.run_health_check();

      const history = pool.get_session_history();
      expect(history.get("test-entity:ch-1")).toBe("sess-loop-1");
    });
  });

  // ── Crash history cleanup ──

  describe("crash history cleanup", () => {
    it("removes entries older than 1 hour", async () => {
      // Pre-populate with old + recent crashes
      const now = Date.now();
      pool.get_crash_history().set(5, [
        now - 2 * 60 * 60_000, // 2 hours ago — should be removed
        now - 90 * 60_000, // 90 min ago — should be removed
        now - 30 * 60_000, // 30 min ago — should be kept
      ]);

      // Inject a bot that's NOT assigned (so health check doesn't trigger restart)
      pool.inject_bots([make_bot({ id: 5, state: "free" })]);

      // Running health check triggers cleanup_crash_history
      await pool.run_health_check();

      const history = pool.get_crash_history();
      const timestamps = history.get(5);
      expect(timestamps).toHaveLength(1);
      expect(timestamps![0]).toBe(now - 30 * 60_000);
    });

    it("deletes crash history entry entirely when all timestamps are old", async () => {
      const now = Date.now();
      pool.get_crash_history().set(7, [
        now - 2 * 60 * 60_000, // 2 hours ago
        now - 90 * 60_000, // 90 min ago
      ]);

      pool.inject_bots([make_bot({ id: 7, state: "free" })]);

      await pool.run_health_check();

      const history = pool.get_crash_history();
      expect(history.has(7)).toBe(false);
    });

    it("does not remove crashes within 3-crash threshold when they are recent", async () => {
      // 3 crashes within the last hour — not a crash loop yet, but should persist
      const now = Date.now();
      pool.get_crash_history().set(4, [now - 40 * 60_000, now - 20 * 60_000, now - 5 * 60_000]);

      pool.inject_bots([make_bot({ id: 4, state: "free" })]);

      await pool.run_health_check();

      const history = pool.get_crash_history();
      expect(history.get(4)).toHaveLength(3);
    });
  });

  // ── Skips non-assigned bots ──

  describe("health check scope", () => {
    it("skips free bots", async () => {
      pool.inject_bots([make_bot({ id: 1, state: "free" })]);

      await pool.run_health_check();

      expect(mock_start_tmux).not.toHaveBeenCalled();
      expect(mock_notify).not.toHaveBeenCalled();
    });

    it("skips parked bots", async () => {
      pool.inject_bots([
        make_bot({
          id: 1,
          state: "parked",
          channel_id: "ch-1",
          entity_id: "e1",
          archetype: "planner",
          session_id: "sess-1",
        }),
      ]);

      await pool.run_health_check();

      expect(mock_start_tmux).not.toHaveBeenCalled();
      expect(mock_notify).not.toHaveBeenCalled();
    });

    it("skips assigned bots with alive tmux", async () => {
      mock_is_tmux_alive.mockReturnValue(true);

      pool.inject_bots([
        make_bot({
          id: 1,
          state: "assigned",
          channel_id: "ch-1",
          entity_id: "e1",
          archetype: "planner",
          session_id: "sess-1",
        }),
      ]);

      await pool.run_health_check();

      expect(mock_start_tmux).not.toHaveBeenCalled();
      expect(mock_notify).not.toHaveBeenCalled();
    });

    it("skips health check entirely when draining", async () => {
      pool.drain();

      pool.inject_bots([
        make_bot({
          id: 1,
          state: "assigned",
          channel_id: "ch-1",
          entity_id: "e1",
          archetype: "planner",
          session_id: "sess-1",
        }),
      ]);

      await pool.run_health_check();

      expect(mock_start_tmux).not.toHaveBeenCalled();
    });
  });

  // ── Concurrent health check serialization ──

  describe("concurrent health check guard", () => {
    it("serializes overlapping health checks — second call is a no-op", async () => {
      // Use a deferred promise so start_tmux blocks until we resolve it
      let resolve_start!: () => void;
      const blocking_promise = new Promise<void>((r) => {
        resolve_start = r;
      });
      mock_start_tmux.mockReturnValue(blocking_promise);

      const bot = make_bot({
        id: 1,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "test-entity",
        archetype: "planner",
        session_id: "sess-1",
      });
      pool.inject_bots([bot]);

      // Fire two health checks without awaiting the first
      const first = pool.run_health_check();
      const second = pool.run_health_check();

      // Let start_tmux complete
      resolve_start();
      await first;
      await second;

      // start_tmux should have been called exactly once — the second
      // health check returned early because the first was still running
      expect(mock_start_tmux).toHaveBeenCalledTimes(1);
    });
  });

  // ── Null-guard force-free ──

  describe("null-guard force-free", () => {
    it("force-frees bot when entity_id is null in restart path", async () => {
      const bot = make_bot({
        id: 4,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: null, // missing — triggers null guard
        archetype: "planner",
        session_id: "sess-1",
      });
      pool.inject_bots([bot]);

      const events: unknown[] = [];
      pool.on("bot:released", (data) => events.push(data));

      await pool.run_health_check();

      const bots = pool.get_bots();
      expect(bots[0].state).toBe("free");
      expect(bots[0].channel_id).toBeNull();
      expect(bots[0].entity_id).toBeNull();
      expect(bots[0].archetype).toBeNull();
      expect(bots[0].session_id).toBeNull();
      expect(mock_start_tmux).not.toHaveBeenCalled();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ bot_id: 4 });
    });

    it("force-frees bot when archetype is null in restart path", async () => {
      const bot = make_bot({
        id: 5,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "test-entity",
        archetype: null, // missing — triggers null guard
        session_id: "sess-1",
      });
      pool.inject_bots([bot]);

      const events: unknown[] = [];
      pool.on("bot:released", (data) => events.push(data));

      await pool.run_health_check();

      const bots = pool.get_bots();
      expect(bots[0].state).toBe("free");
      expect(mock_start_tmux).not.toHaveBeenCalled();
      expect(events).toHaveLength(1);
    });

    it("force-frees bot when channel_id is null in crash loop path", async () => {
      const bot = make_bot({
        id: 6,
        state: "assigned",
        channel_id: null, // missing — release() can't work
        entity_id: "test-entity",
        archetype: "builder",
        session_id: "sess-loop-1",
      });
      pool.inject_bots([bot]);

      // Pre-populate with 3 recent crashes to trigger crash loop on the 4th
      const now = Date.now();
      pool.get_crash_history().set(6, [now - 45 * 60_000, now - 20 * 60_000, now - 5 * 60_000]);

      const events: unknown[] = [];
      pool.on("bot:released", (data) => events.push(data));
      pool.on("bot:crash_loop", (data) => events.push(data));

      await pool.run_health_check();

      const bots = pool.get_bots();
      expect(bots[0].state).toBe("free");
      expect(bots[0].channel_id).toBeNull();
      expect(bots[0].entity_id).toBeNull();
      expect(bots[0].session_id).toBeNull();
      expect(mock_start_tmux).not.toHaveBeenCalled();
      // Should have both bot:released (from force-free) and bot:crash_loop
      const released = events.filter(
        (e: unknown) =>
          (e as Record<string, unknown>).bot_id === 6 &&
          !("archetype" in (e as Record<string, unknown>)),
      );
      const crash_loop = events.filter(
        (e: unknown) => (e as Record<string, unknown>).archetype === "builder",
      );
      expect(released).toHaveLength(1);
      expect(crash_loop).toHaveLength(1);
    });
  });

  // ── notify() failure isolation ──

  describe("notify failure does not undo successful restart", () => {
    it("keeps bot assigned when notify throws after successful restart", async () => {
      mock_notify.mockRejectedValue(new Error("Discord API down"));

      const bot = make_bot({
        id: 7,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "test-entity",
        archetype: "planner",
        session_id: "sess-notify-1",
      });
      pool.inject_bots([bot]);

      const restarted_events: unknown[] = [];
      const released_events: unknown[] = [];
      pool.on("bot:crash_restarted", (data) => restarted_events.push(data));
      pool.on("bot:released", (data) => released_events.push(data));

      await pool.run_health_check();

      // Bot should still be assigned — notify failure must not trigger
      // the catch block that frees the bot
      const bots = pool.get_bots();
      expect(bots[0].state).toBe("assigned");
      expect(bots[0].channel_id).toBe("ch-1");
      expect(bots[0].entity_id).toBe("test-entity");
      expect(bots[0].session_id).toBe("sess-notify-1");

      // start_tmux was called exactly once (the restart succeeded)
      expect(mock_start_tmux).toHaveBeenCalledTimes(1);

      // crash_restarted event should still have fired (it's before notify)
      expect(restarted_events).toHaveLength(1);

      // bot:released must NOT have fired — the bot is still running
      expect(released_events).toHaveLength(0);
    });

    it("still emits bot:crash_loop when notify throws in crash loop path", async () => {
      mock_notify.mockRejectedValue(new Error("Discord API down"));

      const bot = make_bot({
        id: 8,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "test-entity",
        archetype: "builder",
        session_id: "sess-notify-2",
      });
      pool.inject_bots([bot]);

      // Pre-populate with 3 recent crashes to trigger crash loop on the 4th
      const now = Date.now();
      pool.get_crash_history().set(8, [now - 45 * 60_000, now - 20 * 60_000, now - 5 * 60_000]);

      const events: unknown[] = [];
      pool.on("bot:crash_loop", (data) => events.push(data));

      await pool.run_health_check();

      // crash_loop event should still have fired despite notify() throwing
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        bot_id: 8,
        entity_id: "test-entity",
        archetype: "builder",
      });
    });
  });

  // ── Alert channel label resolution ──

  describe("alert shows entity/channel-purpose format", () => {
    /** Inject a mock registry so pool can resolve channel purpose from config. */
    function inject_registry(
      pool_instance: TestBotPool,
      entity_id: string,
      channels: Array<{ type: string; id: string; purpose?: string }>,
    ): void {
      const fake_registry = {
        get: (eid: string) =>
          eid === entity_id
            ? {
                entity: {
                  id: entity_id,
                  channels: { category_id: "", list: channels },
                  secrets: {},
                  repos: [{ path: `/tmp/test-${entity_id}` }],
                },
              }
            : undefined,
      };
      (pool_instance as unknown as { registry: unknown }).registry = fake_registry;
    }

    it("restart alert shows entity/purpose when channel has purpose", async () => {
      const bot = make_bot({
        id: 5,
        state: "assigned",
        channel_id: "ch-workflows",
        entity_id: "canal-street",
        archetype: "planner",
        session_id: "sess-1",
      });
      pool.inject_bots([bot]);
      inject_registry(pool, "canal-street", [
        { type: "work_room", id: "ch-workflows", purpose: "workflows" },
      ]);

      await pool.run_health_check();

      const [, message] = mock_notify.mock.calls[0] as [string, string];
      expect(message).toContain("canal-street/workflows");
    });

    it("restart alert falls back to channel_id when no purpose", async () => {
      const bot = make_bot({
        id: 5,
        state: "assigned",
        channel_id: "ch-unknown-123",
        entity_id: "canal-street",
        archetype: "planner",
        session_id: "sess-1",
      });
      pool.inject_bots([bot]);
      inject_registry(pool, "canal-street", [
        { type: "work_room", id: "ch-unknown-123" }, // no purpose
      ]);

      await pool.run_health_check();

      const [, message] = mock_notify.mock.calls[0] as [string, string];
      expect(message).toContain("canal-street/ch-unknown-123");
    });

    it("restart alert falls back to channel_id when channel not in config", async () => {
      const bot = make_bot({
        id: 5,
        state: "assigned",
        channel_id: "ch-orphan",
        entity_id: "canal-street",
        archetype: "planner",
        session_id: "sess-1",
      });
      pool.inject_bots([bot]);
      inject_registry(pool, "canal-street", []); // empty channel list

      await pool.run_health_check();

      const [, message] = mock_notify.mock.calls[0] as [string, string];
      expect(message).toContain("canal-street/ch-orphan");
    });

    it("crash-loop alert shows entity/purpose", async () => {
      const bot = make_bot({
        id: 6,
        state: "assigned",
        channel_id: "ch-ar-site",
        entity_id: "canal-street",
        archetype: "planner",
        session_id: "sess-loop-1",
      });
      pool.inject_bots([bot]);
      inject_registry(pool, "canal-street", [
        { type: "work_room", id: "ch-ar-site", purpose: "ar-site" },
      ]);

      // Pre-populate with 3 recent crashes to trigger crash loop
      const now = Date.now();
      pool.get_crash_history().set(6, [now - 45 * 60_000, now - 20 * 60_000, now - 5 * 60_000]);

      await pool.run_health_check();

      const [, message] = mock_notify.mock.calls[0] as [string, string];
      expect(message).toContain("crash loop");
      expect(message).toContain("canal-street/ar-site");
    });

    it("crash-loop alert falls back to channel_id when no purpose", async () => {
      const bot = make_bot({
        id: 6,
        state: "assigned",
        channel_id: "ch-mystery",
        entity_id: "canal-street",
        archetype: "planner",
        session_id: "sess-loop-2",
      });
      pool.inject_bots([bot]);
      inject_registry(pool, "canal-street", []); // no matching channel

      const now = Date.now();
      pool.get_crash_history().set(6, [now - 45 * 60_000, now - 20 * 60_000, now - 5 * 60_000]);

      await pool.run_health_check();

      const [, message] = mock_notify.mock.calls[0] as [string, string];
      expect(message).toContain("crash loop");
      expect(message).toContain("canal-street/ch-mystery");
    });
  });
});
