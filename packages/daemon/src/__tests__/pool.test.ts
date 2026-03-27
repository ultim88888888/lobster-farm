import { describe, expect, it, beforeEach, vi } from "vitest";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { BotPool } from "../pool.js";
import type { PoolBot } from "../pool.js";

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
  });
}

/**
 * Test-friendly subclass of BotPool that exposes internals for unit testing.
 * Overrides tmux/filesystem operations to avoid real side effects.
 */
class TestBotPool extends BotPool {
  // Override the tmux-dependent methods to make tests deterministic.
  // The real pool checks tmux pane output; we control what is_bot_idle returns
  // by mapping bot IDs to idle status.
  private idle_overrides = new Map<number, boolean>();

  /** Inject test bots directly into the pool without filesystem/tmux. */
  inject_bots(bots: PoolBot[]): void {
    // Access private field via bracket notation for testing
    (this as unknown as { bots: PoolBot[] }).bots = bots;
  }

  /** Set whether a bot is idle at its tmux prompt (true) or working (false). */
  set_bot_idle(bot_id: number, idle: boolean): void {
    this.idle_overrides.set(bot_id, idle);
  }

  /**
   * Override is_bot_idle to use our test overrides instead of real tmux.
   * This is the single point of tmux dependency — overriding it makes both
   * compute_activity_state() and has_active_work() work in tests.
   */
  protected override is_bot_idle(bot: PoolBot): boolean {
    return this.idle_overrides.get(bot.id) ?? true;
  }
}

/** Create a PoolBot with sensible defaults for testing. */
function make_bot(overrides: Partial<PoolBot> & { id: number }): PoolBot {
  return {
    state: "free",
    channel_id: null,
    entity_id: null,
    archetype: null,
    channel_type: null,
    session_id: null,
    tmux_session: `pool-${String(overrides.id)}`,
    last_active: null,
    state_dir: `/tmp/test-pool-${String(overrides.id)}`,
    ...overrides,
  };
}

/** Minutes ago as a Date. */
function minutes_ago(n: number): Date {
  return new Date(Date.now() - n * 60_000);
}

describe("BotPool", () => {
  let config: LobsterFarmConfig;
  let pool: TestBotPool;

  beforeEach(() => {
    config = make_config();
    pool = new TestBotPool(config);

    // Stub out assign's side effects (tmux start, access.json, nickname)
    // by mocking the private methods via prototype
    vi.spyOn(pool as unknown as { kill_tmux: (s: string) => void }, "kill_tmux" as never)
      .mockImplementation(() => {});
    vi.spyOn(pool as unknown as { write_access_json: (d: string, c: string | null) => Promise<void> }, "write_access_json" as never)
      .mockResolvedValue(undefined);
    vi.spyOn(pool as unknown as { set_bot_nickname: (d: string, a: string) => Promise<void> }, "set_bot_nickname" as never)
      .mockResolvedValue(undefined);
    vi.spyOn(pool as unknown as { start_tmux: (...args: unknown[]) => Promise<void> }, "start_tmux" as never)
      .mockResolvedValue(undefined);
    vi.spyOn(pool as unknown as { is_tmux_alive: (s: string) => boolean }, "is_tmux_alive" as never)
      .mockReturnValue(false);
    vi.spyOn(pool as unknown as { park_bot: (b: PoolBot) => Promise<void> }, "park_bot" as never)
      .mockImplementation(async (bot: PoolBot) => {
        bot.state = "parked";
      });
  });

  describe("compute_activity_state", () => {
    it("returns 'idle' for non-assigned bots", () => {
      const bot = make_bot({ id: 1, state: "free" });
      expect(pool.compute_activity_state(bot)).toBe("idle");
    });

    it("returns 'idle' for parked bots", () => {
      const bot = make_bot({ id: 1, state: "parked" });
      expect(pool.compute_activity_state(bot)).toBe("idle");
    });

    it("returns 'working' when tmux pane has no prompt", () => {
      const bot = make_bot({
        id: 1,
        state: "assigned",
        last_active: new Date(),
      });
      pool.set_bot_idle(1, false);
      expect(pool.compute_activity_state(bot)).toBe("working");
    });

    it("returns 'active_conversation' when last_active < 3 min ago", () => {
      const bot = make_bot({
        id: 1,
        state: "assigned",
        last_active: minutes_ago(1),
      });
      pool.set_bot_idle(1, true);
      expect(pool.compute_activity_state(bot)).toBe("active_conversation");
    });

    it("returns 'waiting_for_human' when last_active 3-30 min ago", () => {
      const bot = make_bot({
        id: 1,
        state: "assigned",
        last_active: minutes_ago(10),
      });
      pool.set_bot_idle(1, true);
      expect(pool.compute_activity_state(bot)).toBe("waiting_for_human");
    });

    it("returns 'idle' when last_active > 30 min ago", () => {
      const bot = make_bot({
        id: 1,
        state: "assigned",
        last_active: minutes_ago(45),
      });
      pool.set_bot_idle(1, true);
      expect(pool.compute_activity_state(bot)).toBe("idle");
    });

    it("returns 'idle' when last_active is null", () => {
      const bot = make_bot({
        id: 1,
        state: "assigned",
        last_active: null,
      });
      pool.set_bot_idle(1, true);
      expect(pool.compute_activity_state(bot)).toBe("idle");
    });

    it("returns 'waiting_for_human' at exactly 3 min boundary", () => {
      const bot = make_bot({
        id: 1,
        state: "assigned",
        last_active: minutes_ago(3),
      });
      pool.set_bot_idle(1, true);
      // At exactly 3 min, idle_minutes >= 3 so it should be waiting_for_human
      expect(pool.compute_activity_state(bot)).toBe("waiting_for_human");
    });

    it("returns 'idle' at exactly 30 min boundary", () => {
      const bot = make_bot({
        id: 1,
        state: "assigned",
        last_active: minutes_ago(30),
      });
      pool.set_bot_idle(1, true);
      // At exactly 30 min, idle_minutes >= 30 so it should be idle
      expect(pool.compute_activity_state(bot)).toBe("idle");
    });
  });

  describe("eviction priority in assign()", () => {
    it("assigns a free bot without eviction", async () => {
      pool.inject_bots([
        make_bot({ id: 1, state: "free" }),
        make_bot({ id: 2, state: "assigned", channel_id: "ch-x", entity_id: "e1", last_active: minutes_ago(5) }),
      ]);

      const result = await pool.assign("ch-new", "e1", "planner", undefined, "general");
      expect(result).not.toBeNull();
      expect(result!.bot_id).toBe(1);
    });

    it("evicts parked bot before idle assigned", async () => {
      pool.inject_bots([
        make_bot({ id: 1, state: "parked", channel_id: "ch-1", entity_id: "e1", last_active: minutes_ago(60), channel_type: "general" }),
        make_bot({ id: 2, state: "assigned", channel_id: "ch-2", entity_id: "e1", last_active: minutes_ago(60), channel_type: "general" }),
      ]);
      pool.set_bot_idle(2, true);

      const result = await pool.assign("ch-new", "e1", "planner", undefined, "general");
      expect(result).not.toBeNull();
      expect(result!.bot_id).toBe(1);
    });

    it("evicts idle assigned before waiting_for_human", async () => {
      pool.inject_bots([
        make_bot({ id: 1, state: "assigned", channel_id: "ch-1", entity_id: "e1", last_active: minutes_ago(45), channel_type: "general" }),
        make_bot({ id: 2, state: "assigned", channel_id: "ch-2", entity_id: "e1", last_active: minutes_ago(10), channel_type: "general" }),
      ]);
      pool.set_bot_idle(1, true); // idle (>30 min)
      pool.set_bot_idle(2, true); // waiting_for_human (3-30 min)

      const result = await pool.assign("ch-new", "e1", "planner", undefined, "general");
      expect(result).not.toBeNull();
      expect(result!.bot_id).toBe(1); // idle evicted first
    });

    it("evicts waiting_for_human when no idle bots remain", async () => {
      pool.inject_bots([
        make_bot({ id: 1, state: "assigned", channel_id: "ch-1", entity_id: "e1", last_active: minutes_ago(10), channel_type: "general" }),
        make_bot({ id: 2, state: "assigned", channel_id: "ch-2", entity_id: "e1", last_active: new Date(), channel_type: "general" }),
      ]);
      pool.set_bot_idle(1, true); // waiting_for_human
      pool.set_bot_idle(2, false); // working

      const result = await pool.assign("ch-new", "e1", "planner", undefined, "general");
      expect(result).not.toBeNull();
      expect(result!.bot_id).toBe(1);
    });

    it("hits floor when all bots are working — returns null", async () => {
      pool.inject_bots([
        make_bot({ id: 1, state: "assigned", channel_id: "ch-1", entity_id: "e1", last_active: new Date() }),
        make_bot({ id: 2, state: "assigned", channel_id: "ch-2", entity_id: "e1", last_active: new Date() }),
      ]);
      pool.set_bot_idle(1, false); // working
      pool.set_bot_idle(2, false); // working

      const result = await pool.assign("ch-new", "e1", "planner", undefined, "general");
      expect(result).toBeNull();
    });

    it("hits floor when all bots are in active_conversation — returns null", async () => {
      pool.inject_bots([
        make_bot({ id: 1, state: "assigned", channel_id: "ch-1", entity_id: "e1", last_active: minutes_ago(1) }),
        make_bot({ id: 2, state: "assigned", channel_id: "ch-2", entity_id: "e1", last_active: minutes_ago(2) }),
      ]);
      pool.set_bot_idle(1, true); // active_conversation
      pool.set_bot_idle(2, true); // active_conversation

      const result = await pool.assign("ch-new", "e1", "planner", undefined, "general");
      expect(result).toBeNull();
    });

    it("idle general evicted before idle work_room", async () => {
      pool.inject_bots([
        make_bot({ id: 1, state: "assigned", channel_id: "ch-1", entity_id: "e1", last_active: minutes_ago(45), channel_type: "work_room" }),
        make_bot({ id: 2, state: "assigned", channel_id: "ch-2", entity_id: "e1", last_active: minutes_ago(45), channel_type: "general" }),
      ]);
      pool.set_bot_idle(1, true);
      pool.set_bot_idle(2, true);

      const result = await pool.assign("ch-new", "e1", "planner", undefined, "general");
      expect(result).not.toBeNull();
      expect(result!.bot_id).toBe(2); // general evicted first
    });

    it("within same tier and channel type, LRU ordering applies", async () => {
      pool.inject_bots([
        make_bot({ id: 1, state: "assigned", channel_id: "ch-1", entity_id: "e1", last_active: minutes_ago(60), channel_type: "general" }),
        make_bot({ id: 2, state: "assigned", channel_id: "ch-2", entity_id: "e1", last_active: minutes_ago(45), channel_type: "general" }),
      ]);
      pool.set_bot_idle(1, true);
      pool.set_bot_idle(2, true);

      const result = await pool.assign("ch-new", "e1", "planner", undefined, "general");
      expect(result).not.toBeNull();
      expect(result!.bot_id).toBe(1); // older last_active evicted first
    });

    it("emits bot:parked_with_context when waiting_for_human bot is evicted", async () => {
      pool.inject_bots([
        make_bot({ id: 1, state: "assigned", channel_id: "ch-1", entity_id: "e1", last_active: minutes_ago(10), channel_type: "general" }),
      ]);
      pool.set_bot_idle(1, true); // waiting_for_human

      const events: unknown[] = [];
      pool.on("bot:parked_with_context", (info: unknown) => events.push(info));

      await pool.assign("ch-new", "e2", "planner", undefined, "general");

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        bot_id: 1,
        channel_id: "ch-1",
        entity_id: "e1",
      });
    });

    it("does NOT emit bot:parked_with_context for idle assigned eviction", async () => {
      pool.inject_bots([
        make_bot({ id: 1, state: "assigned", channel_id: "ch-1", entity_id: "e1", last_active: minutes_ago(45), channel_type: "general" }),
      ]);
      pool.set_bot_idle(1, true); // idle

      const events: unknown[] = [];
      pool.on("bot:parked_with_context", (info: unknown) => events.push(info));

      await pool.assign("ch-new", "e2", "planner", undefined, "general");

      expect(events).toHaveLength(0);
    });

    it("does NOT emit bot:parked_with_context for parked bot eviction", async () => {
      pool.inject_bots([
        make_bot({ id: 1, state: "parked", channel_id: "ch-1", entity_id: "e1", last_active: minutes_ago(60), channel_type: "general" }),
      ]);

      const events: unknown[] = [];
      pool.on("bot:parked_with_context", (info: unknown) => events.push(info));

      await pool.assign("ch-new", "e2", "planner", undefined, "general");

      expect(events).toHaveLength(0);
    });
  });

  describe("has_active_work() with is_bot_idle() extraction", () => {
    it("returns active: false when no bots are assigned", () => {
      pool.inject_bots([
        make_bot({ id: 1, state: "free" }),
        make_bot({ id: 2, state: "parked" }),
      ]);

      const result = pool.has_active_work();
      expect(result.active).toBe(false);
      expect(result.working_bots).toHaveLength(0);
    });

    it("returns active: true when an assigned bot is not idle", () => {
      const bot = make_bot({
        id: 1,
        state: "assigned",
        channel_id: "ch-1",
        archetype: "builder",
        last_active: new Date(),
      });
      pool.inject_bots([bot]);
      pool.set_bot_idle(1, false);

      const result = pool.has_active_work();
      expect(result.active).toBe(true);
      expect(result.working_bots).toHaveLength(1);
      expect(result.working_bots[0]!.id).toBe(1);
      expect(result.working_bots[0]!.archetype).toBe("builder");
    });

    it("returns active: false when all assigned bots are idle", () => {
      pool.inject_bots([
        make_bot({ id: 1, state: "assigned", channel_id: "ch-1", last_active: new Date() }),
        make_bot({ id: 2, state: "assigned", channel_id: "ch-2", last_active: new Date() }),
      ]);
      pool.set_bot_idle(1, true);
      pool.set_bot_idle(2, true);

      const result = pool.has_active_work();
      expect(result.active).toBe(false);
    });
  });

  describe("pre_assign_generals removed", () => {
    it("BotPool does not have pre_assign_generals method", () => {
      // Verify the method was removed
      expect((pool as unknown as Record<string, unknown>)["pre_assign_generals"]).toBeUndefined();
    });
  });

  describe("eviction with mixed scenarios", () => {
    it("full pool: 10 idle generals + new feature request evicts oldest general", async () => {
      const bots = Array.from({ length: 10 }, (_, i) =>
        make_bot({
          id: i + 1,
          state: "assigned",
          channel_id: `ch-${String(i + 1)}`,
          entity_id: `e${String(i + 1)}`,
          last_active: minutes_ago(60 - i), // bot 1 is oldest, bot 10 is newest
          channel_type: "general",
          archetype: "planner",
        }),
      );
      pool.inject_bots(bots);
      for (let i = 1; i <= 10; i++) {
        pool.set_bot_idle(i, true); // all idle
      }

      const result = await pool.assign("ch-new", "e-new", "builder", undefined, "work_room");
      expect(result).not.toBeNull();
      expect(result!.bot_id).toBe(1); // oldest idle general
    });

    it("mixed states: working + active_conversation + waiting + idle — evicts idle", async () => {
      pool.inject_bots([
        make_bot({ id: 1, state: "assigned", channel_id: "ch-1", entity_id: "e1", last_active: new Date(), channel_type: "general" }),       // working
        make_bot({ id: 2, state: "assigned", channel_id: "ch-2", entity_id: "e1", last_active: minutes_ago(1), channel_type: "general" }),   // active_conversation
        make_bot({ id: 3, state: "assigned", channel_id: "ch-3", entity_id: "e1", last_active: minutes_ago(10), channel_type: "general" }),  // waiting_for_human
        make_bot({ id: 4, state: "assigned", channel_id: "ch-4", entity_id: "e1", last_active: minutes_ago(45), channel_type: "general" }),  // idle
      ]);
      pool.set_bot_idle(1, false); // working
      pool.set_bot_idle(2, true);  // active_conversation
      pool.set_bot_idle(3, true);  // waiting_for_human
      pool.set_bot_idle(4, true);  // idle

      const result = await pool.assign("ch-new", "e1", "planner", undefined, "general");
      expect(result).not.toBeNull();
      expect(result!.bot_id).toBe(4); // idle evicted
    });

    it("auto-resumes returning parked bot for same channel", async () => {
      pool.inject_bots([
        make_bot({
          id: 1,
          state: "parked",
          channel_id: "ch-returning",
          entity_id: "e1",
          session_id: "sess-abc123",
          channel_type: "general",
          last_active: minutes_ago(10),
        }),
        make_bot({ id: 2, state: "free" }),
      ]);

      const result = await pool.assign("ch-returning", "e1", "planner", undefined, "general");
      expect(result).not.toBeNull();
      expect(result!.bot_id).toBe(1); // returning parked bot, not the free one
    });
  });

  describe("concurrent assign() race condition", () => {
    it("second concurrent assign for same channel returns null, not a duplicate bot", async () => {
      pool.inject_bots([
        make_bot({ id: 1, state: "free" }),
        make_bot({ id: 2, state: "free" }),
      ]);

      // Slow down start_tmux to simulate an async gap where the race occurs
      vi.spyOn(pool as unknown as { start_tmux: (...args: unknown[]) => Promise<void> }, "start_tmux" as never)
        .mockImplementation(() => new Promise(resolve => setTimeout(resolve, 50)));

      // Fire two assigns concurrently for the same channel
      const [result_a, result_b] = await Promise.all([
        pool.assign("ch-race", "e1", "builder", undefined, "work_room"),
        pool.assign("ch-race", "e1", "builder", undefined, "work_room"),
      ]);

      // Exactly one should succeed, the other should get null (in-flight lock)
      const results = [result_a, result_b];
      const successes = results.filter(r => r !== null);
      const nulls = results.filter(r => r === null);

      expect(successes).toHaveLength(1);
      expect(nulls).toHaveLength(1);
      expect(successes[0]!.channel_id).toBe("ch-race");
    });

    it("in-flight lock is released after assign completes, allowing re-assignment", async () => {
      pool.inject_bots([
        make_bot({ id: 1, state: "free" }),
      ]);

      // First assign succeeds
      const first = await pool.assign("ch-seq", "e1", "builder", undefined, "work_room");
      expect(first).not.toBeNull();

      // Second assign for same channel sees it as already assigned (not locked)
      const second = await pool.assign("ch-seq", "e1", "builder", undefined, "work_room");
      expect(second).not.toBeNull();
      expect(second!.bot_id).toBe(first!.bot_id); // returns existing assignment
    });

    it("in-flight lock is released even if assign throws", async () => {
      pool.inject_bots([
        make_bot({ id: 1, state: "free" }),
        make_bot({ id: 2, state: "free" }),
      ]);

      // Make start_tmux throw on first call, succeed on second
      let call_count = 0;
      vi.spyOn(pool as unknown as { start_tmux: (...args: unknown[]) => Promise<void> }, "start_tmux" as never)
        .mockImplementation(async () => {
          call_count++;
          if (call_count === 1) throw new Error("tmux failed");
        });

      // First assign should throw
      await expect(pool.assign("ch-err", "e1", "builder", undefined, "work_room"))
        .rejects.toThrow("tmux failed");

      // Lock should be released — second assign should proceed (not return null from lock)
      const result = await pool.assign("ch-err", "e1", "builder", undefined, "work_room");
      expect(result).not.toBeNull();
    });
  });

  describe("concurrent release() race condition", () => {
    it("second concurrent release for same channel is a no-op", async () => {
      pool.inject_bots([
        make_bot({ id: 1, state: "assigned", channel_id: "ch-rel", entity_id: "e1", archetype: "builder" }),
      ]);

      // Slow down write_access_json to create an async gap
      vi.spyOn(pool as unknown as { write_access_json: (d: string, c: string | null) => Promise<void> }, "write_access_json" as never)
        .mockImplementation(() => new Promise(resolve => setTimeout(resolve, 50)));

      const events: unknown[] = [];
      pool.on("bot:released", (info: unknown) => events.push(info));

      // Fire two releases concurrently for the same channel
      await Promise.all([
        pool.release("ch-rel"),
        pool.release("ch-rel"),
      ]);

      // Only one bot:released event should fire (not two)
      expect(events).toHaveLength(1);
    });
  });
});
