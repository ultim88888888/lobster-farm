import { describe, expect, it, beforeEach, vi } from "vitest";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { BotPool } from "../pool.js";
import type { PoolBot } from "../pool.js";

// ── Test helpers ──

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
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
    tmux_session: `pool-${String(overrides.id)}`,
    last_active: null,
    assigned_at: null,
    state_dir: `/tmp/test-pool-${String(overrides.id)}`,
    model: null,
    effort: null,
    last_avatar_archetype: null,
    last_avatar_set_at: null,
    cached_context: null,
    cached_subscription: null,
    cache_updated_at: null,
    ...overrides,
  };
}

/**
 * Test-friendly BotPool subclass that stubs tmux/filesystem side effects and
 * exposes internals for assertion. Follows the same pattern as existing test files.
 */
class TestBotPool extends BotPool {
  private tmux_alive_overrides = new Map<string, boolean>();

  inject_bots(bots: PoolBot[]): void {
    (this as unknown as { bots: PoolBot[] }).bots = bots;
  }

  get_bots(): PoolBot[] {
    return (this as unknown as { bots: PoolBot[] }).bots;
  }

  get_session_history(): Map<string, string> {
    return (this as unknown as { session_history: Map<string, string> }).session_history;
  }

  /** Control whether is_tmux_alive returns true/false per session name. */
  set_tmux_alive(session_name: string, alive: boolean): void {
    this.tmux_alive_overrides.set(session_name, alive);
  }

  /** Override is_bot_idle for activity state checks (not the focus of these tests). */
  protected override is_bot_idle(_bot: PoolBot): boolean {
    return true;
  }

  /** Expose check_assigned_health for direct invocation in tests. */
  async run_health_check(): Promise<void> {
    await this.check_assigned_health();
  }
}

// ── Tests ──

describe("lazy session resume (issue #72)", () => {
  let config: LobsterFarmConfig;
  let pool: TestBotPool;

  beforeEach(() => {
    config = make_config();
    pool = new TestBotPool(config);

    // Stub out side effects that touch the filesystem and tmux
    vi.spyOn(pool as unknown as Record<string, unknown>, "kill_tmux" as never)
      .mockImplementation(() => {});
    vi.spyOn(pool as unknown as Record<string, unknown>, "write_access_json" as never)
      .mockResolvedValue(undefined);
    vi.spyOn(pool as unknown as Record<string, unknown>, "set_bot_nickname" as never)
      .mockResolvedValue(undefined);
    vi.spyOn(pool as unknown as Record<string, unknown>, "set_bot_avatar" as never)
      .mockResolvedValue(undefined);
    vi.spyOn(pool as unknown as Record<string, unknown>, "start_tmux" as never)
      .mockResolvedValue(undefined);
    vi.spyOn(pool as unknown as Record<string, unknown>, "park_bot" as never)
      .mockImplementation(async (bot: PoolBot) => {
        bot.state = "parked";
      });

    // Default: tmux is dead (individual tests override per-session as needed)
    vi.spyOn(pool as unknown as Record<string, unknown>, "is_tmux_alive" as never)
      .mockImplementation((session_name: string) => {
        return pool["tmux_alive_overrides" as keyof typeof pool]
          ? (pool as unknown as { tmux_alive_overrides: Map<string, boolean> })
              .tmux_alive_overrides.get(session_name) ?? false
          : false;
      });
  });

  // ── is_session_alive() ──

  describe("is_session_alive()", () => {
    it("returns true when bot is assigned and tmux is alive", () => {
      const bot = make_bot({
        id: 1,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "e1",
        archetype: "planner",
        session_id: "sess-alive",
      });
      pool.inject_bots([bot]);
      pool.set_tmux_alive("pool-1", true);

      expect(pool.is_session_alive(1)).toBe(true);
    });

    it("returns false when bot is assigned but tmux is dead", () => {
      const bot = make_bot({
        id: 1,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "e1",
        archetype: "planner",
        session_id: "sess-dead",
      });
      pool.inject_bots([bot]);
      pool.set_tmux_alive("pool-1", false);

      expect(pool.is_session_alive(1)).toBe(false);
    });

    it("returns false when bot is not assigned (free)", () => {
      pool.inject_bots([make_bot({ id: 1, state: "free" })]);

      expect(pool.is_session_alive(1)).toBe(false);
    });

    it("returns false when bot is parked", () => {
      pool.inject_bots([
        make_bot({ id: 1, state: "parked", channel_id: "ch-1", entity_id: "e1" }),
      ]);

      expect(pool.is_session_alive(1)).toBe(false);
    });

    it("returns false for a bot_id that does not exist", () => {
      pool.inject_bots([]);

      expect(pool.is_session_alive(999)).toBe(false);
    });
  });

  // ── release_with_history() ──

  describe("release_with_history()", () => {
    it("stashes session_id in history before releasing", async () => {
      const bot = make_bot({
        id: 1,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "e1",
        archetype: "builder",
        session_id: "sess-stash-me",
      });
      pool.inject_bots([bot]);

      await pool.release_with_history(1);

      // Session should be in history
      expect(pool.get_session_history().get("e1:ch-1")).toBe("sess-stash-me");

      // Bot should be freed (release was called)
      const released_bot = pool.get_bots().find(b => b.id === 1)!;
      expect(released_bot.state).toBe("free");
      expect(released_bot.session_id).toBeNull();
      expect(released_bot.channel_id).toBeNull();
    });

    it("does not stash if bot has no session_id", async () => {
      const bot = make_bot({
        id: 1,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "e1",
        archetype: "planner",
        session_id: null,
      });
      pool.inject_bots([bot]);

      await pool.release_with_history(1);

      expect(pool.get_session_history().size).toBe(0);

      // Bot should still be released
      const released_bot = pool.get_bots().find(b => b.id === 1)!;
      expect(released_bot.state).toBe("free");
    });

    it("is a no-op for a bot_id that does not exist", async () => {
      pool.inject_bots([]);

      // Should not throw
      await pool.release_with_history(999);

      expect(pool.get_session_history().size).toBe(0);
    });

    it("is a no-op for a bot with null channel_id", async () => {
      const bot = make_bot({
        id: 1,
        state: "free",
        channel_id: null,
      });
      pool.inject_bots([bot]);

      await pool.release_with_history(1);

      expect(pool.get_session_history().size).toBe(0);
    });
  });

  // ── check_assigned_health() preserves session_id ──

  describe("check_assigned_health() preserves session_id", () => {
    it("stashes session_id in history when tmux dies", async () => {
      const bot = make_bot({
        id: 1,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "e1",
        archetype: "builder",
        session_id: "sess-health-check",
      });
      pool.inject_bots([bot]);
      pool.set_tmux_alive("pool-1", false);

      await pool.run_health_check();

      // Session should be stashed before cleanup
      expect(pool.get_session_history().get("e1:ch-1")).toBe("sess-health-check");

      // Bot should be freed
      const cleaned_bot = pool.get_bots().find(b => b.id === 1)!;
      expect(cleaned_bot.state).toBe("free");
      expect(cleaned_bot.session_id).toBeNull();
    });

    it("does not stash for bots with no session_id", async () => {
      const bot = make_bot({
        id: 1,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "e1",
        archetype: "planner",
        session_id: null,
      });
      pool.inject_bots([bot]);
      pool.set_tmux_alive("pool-1", false);

      await pool.run_health_check();

      expect(pool.get_session_history().size).toBe(0);
    });

    it("leaves alive bots untouched", async () => {
      const bot = make_bot({
        id: 1,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "e1",
        archetype: "builder",
        session_id: "sess-alive",
      });
      pool.inject_bots([bot]);
      pool.set_tmux_alive("pool-1", true);

      await pool.run_health_check();

      // No history stashed — bot is fine
      expect(pool.get_session_history().size).toBe(0);

      // Bot stays assigned
      const alive_bot = pool.get_bots().find(b => b.id === 1)!;
      expect(alive_bot.state).toBe("assigned");
      expect(alive_bot.session_id).toBe("sess-alive");
    });

    it("emits bot:session_ended for dead bots", async () => {
      const bot = make_bot({
        id: 1,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "e1",
        archetype: "builder",
        session_id: "sess-ended",
      });
      pool.inject_bots([bot]);
      pool.set_tmux_alive("pool-1", false);

      const events: unknown[] = [];
      pool.on("bot:session_ended", (info: unknown) => events.push(info));

      await pool.run_health_check();

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        bot_id: 1,
        channel_id: "ch-1",
        entity_id: "e1",
      });
    });
  });

  // ── End-to-end: dead tmux -> release_with_history -> reassign resumes ──

  describe("end-to-end: dead tmux -> release_with_history -> reassign resumes", () => {
    it("release_with_history followed by assign picks up stashed session", async () => {
      pool.inject_bots([
        make_bot({
          id: 1,
          state: "assigned",
          channel_id: "ch-1",
          entity_id: "e1",
          archetype: "builder",
          session_id: "sess-original",
        }),
      ]);

      // Step 1: tmux dies, discord.ts calls release_with_history
      await pool.release_with_history(1);

      // Session stashed
      expect(pool.get_session_history().get("e1:ch-1")).toBe("sess-original");

      // Bot is now free
      expect(pool.get_bots().find(b => b.id === 1)!.state).toBe("free");

      // Step 2: discord.ts re-assigns (like the auto-assign branch)
      const result = await pool.assign("ch-1", "e1", "builder", undefined, "general");

      expect(result).not.toBeNull();
      // Session should be the stashed one (resume)
      expect(result!.session_id).toBe("sess-original");

      // History consumed
      expect(pool.get_session_history().has("e1:ch-1")).toBe(false);

      // start_tmux should have been called with is_resume=true
      const start_tmux_spy = pool["start_tmux" as keyof typeof pool] as unknown as {
        mock: { calls: unknown[][] };
      };
      const last_call = start_tmux_spy.mock.calls[start_tmux_spy.mock.calls.length - 1]!;
      expect(last_call[4]).toBe("sess-original"); // session_id arg
      expect(last_call[5]).toBe(true); // is_resume arg
    });

    it("health monitor stash followed by assign also resumes", async () => {
      const bot = make_bot({
        id: 1,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "e1",
        archetype: "planner",
        session_id: "sess-health-resume",
      });
      pool.inject_bots([bot]);
      pool.set_tmux_alive("pool-1", false);

      // Step 1: Health monitor fires, detects dead tmux
      await pool.run_health_check();

      expect(pool.get_session_history().get("e1:ch-1")).toBe("sess-health-resume");
      expect(pool.get_bots().find(b => b.id === 1)!.state).toBe("free");

      // Step 2: Next message triggers assign
      const result = await pool.assign("ch-1", "e1", "planner", undefined, "general");

      expect(result).not.toBeNull();
      expect(result!.session_id).toBe("sess-health-resume");
      expect(pool.get_session_history().has("e1:ch-1")).toBe(false);
    });
  });

  // ── Race condition: health monitor + message arrive at same time ──

  describe("race: health monitor + message at same time", () => {
    it("both paths stash the same session_id — no conflict", async () => {
      const bot = make_bot({
        id: 1,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "e1",
        archetype: "builder",
        session_id: "sess-race",
      });
      pool.inject_bots([bot]);
      pool.set_tmux_alive("pool-1", false);

      // Simulate: release_with_history called first (message path)
      await pool.release_with_history(1);

      expect(pool.get_session_history().get("e1:ch-1")).toBe("sess-race");
      expect(pool.get_bots().find(b => b.id === 1)!.state).toBe("free");

      // Then health check runs — bot is already free, so it skips it
      await pool.run_health_check();

      // History should still be intact (health check didn't clobber it)
      expect(pool.get_session_history().get("e1:ch-1")).toBe("sess-race");
    });

    it("health monitor fires first, then message triggers assign with resume", async () => {
      const bot = make_bot({
        id: 1,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "e1",
        archetype: "builder",
        session_id: "sess-monitor-first",
      });
      pool.inject_bots([bot]);
      pool.set_tmux_alive("pool-1", false);

      // Health monitor fires first
      await pool.run_health_check();

      expect(pool.get_session_history().get("e1:ch-1")).toBe("sess-monitor-first");

      // Message arrives — get_assignment returns undefined (bot was freed).
      // In discord.ts, this means assignment is falsy and we go to auto-assign.
      const assignment = pool.get_assignment("ch-1");
      expect(assignment).toBeUndefined();

      // Auto-assign picks up history
      const result = await pool.assign("ch-1", "e1", "builder", undefined, "general");
      expect(result).not.toBeNull();
      expect(result!.session_id).toBe("sess-monitor-first");
    });
  });
});
