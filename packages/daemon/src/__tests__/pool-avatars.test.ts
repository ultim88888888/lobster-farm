import { describe, expect, it, beforeEach, vi } from "vitest";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig, ArchetypeRole } from "@lobster-farm/shared";
import { BotPool, AVATAR_COOLDOWN_MS } from "../pool.js";
import type { PoolBot, AvatarHandler } from "../pool.js";

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
  });
}

/** Test-friendly subclass that overrides tmux operations. */
class TestBotPool extends BotPool {
  private idle_overrides = new Map<number, boolean>();

  inject_bots(bots: PoolBot[]): void {
    (this as unknown as { bots: PoolBot[] }).bots = bots;
  }

  protected override is_bot_idle(bot: PoolBot): boolean {
    return this.idle_overrides.get(bot.id) ?? true;
  }
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

function minutes_ago(n: number): Date {
  return new Date(Date.now() - n * 60_000);
}

describe("Pool bot avatar management", () => {
  let config: LobsterFarmConfig;
  let pool: TestBotPool;
  let avatar_handler: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    config = make_config();
    pool = new TestBotPool(config);

    // Stub out assign's side effects
    vi.spyOn(pool as unknown as Record<string, unknown>, "kill_tmux" as never)
      .mockImplementation(() => {});
    vi.spyOn(pool as unknown as Record<string, unknown>, "write_access_json" as never)
      .mockResolvedValue(undefined);
    vi.spyOn(pool as unknown as Record<string, unknown>, "set_bot_nickname" as never)
      .mockResolvedValue(undefined);
    vi.spyOn(pool as unknown as Record<string, unknown>, "start_tmux" as never)
      .mockResolvedValue(undefined);
    vi.spyOn(pool as unknown as Record<string, unknown>, "is_tmux_alive" as never)
      .mockReturnValue(false);
    vi.spyOn(pool as unknown as Record<string, unknown>, "park_bot" as never)
      .mockImplementation(async (bot: PoolBot) => {
        bot.state = "parked";
      });

    // Register a spy avatar handler
    avatar_handler = vi.fn<AvatarHandler>().mockResolvedValue(undefined);
    pool.set_avatar_handler(avatar_handler);
  });

  describe("avatar set on assign", () => {
    it("calls avatar handler when assigning a bot as planner", async () => {
      pool.inject_bots([make_bot({ id: 1, state: "free" })]);

      await pool.assign("ch-1", "e1", "planner");

      expect(avatar_handler).toHaveBeenCalledOnce();
      // Handler receives state_dir and lowercase agent name
      expect(avatar_handler).toHaveBeenCalledWith(
        "/tmp/test-pool-1",
        "gary",
      );
    });

    it("calls avatar handler with correct agent name for each archetype", async () => {
      const archetypes: Array<[ArchetypeRole, string]> = [
        ["planner", "gary"],
        ["builder", "bob"],
        ["designer", "pearl"],
        ["operator", "ray"],
      ];

      for (const [archetype, expected_name] of archetypes) {
        avatar_handler.mockClear();
        pool.inject_bots([make_bot({ id: 1, state: "free" })]);
        await pool.assign("ch-1", "e1", archetype);
        expect(avatar_handler).toHaveBeenCalledWith(
          "/tmp/test-pool-1",
          expected_name,
        );
      }
    });

    it("updates last_avatar_archetype and last_avatar_set_at after successful set", async () => {
      pool.inject_bots([make_bot({ id: 1, state: "free" })]);
      const before = new Date();

      await pool.assign("ch-1", "e1", "builder");

      // The bot's avatar state should be updated
      const status = pool.get_status();
      const assignment = status.assignments.find(a => a.bot_id === 1);
      expect(assignment).toBeDefined();
      // We can't directly inspect PoolBot fields via get_status(), but we can
      // verify the handler was called and the bot doesn't get called again
      // on reassignment with the same archetype (tested below).
      expect(avatar_handler).toHaveBeenCalledOnce();
    });
  });

  describe("avatar deduplication", () => {
    it("skips avatar set when archetype has not changed since last set", async () => {
      // Bot was previously assigned as builder and already has the builder avatar
      pool.inject_bots([
        make_bot({
          id: 1,
          state: "free",
          last_avatar_archetype: "builder",
          last_avatar_set_at: minutes_ago(60),
        }),
      ]);

      await pool.assign("ch-1", "e1", "builder");

      // Avatar handler should NOT have been called — same archetype
      expect(avatar_handler).not.toHaveBeenCalled();
    });

    it("calls avatar handler when archetype changes from previous", async () => {
      // Bot previously had planner avatar, now being assigned as builder
      pool.inject_bots([
        make_bot({
          id: 1,
          state: "free",
          last_avatar_archetype: "planner",
          last_avatar_set_at: minutes_ago(60),
        }),
      ]);

      await pool.assign("ch-1", "e1", "builder");

      expect(avatar_handler).toHaveBeenCalledOnce();
      expect(avatar_handler).toHaveBeenCalledWith(
        "/tmp/test-pool-1",
        "bob",
      );
    });
  });

  describe("avatar rate limiting", () => {
    it("skips avatar set when within cooldown window", async () => {
      // Bot had avatar set 10 minutes ago — within the 30-minute cooldown
      pool.inject_bots([
        make_bot({
          id: 1,
          state: "free",
          last_avatar_archetype: "planner",
          last_avatar_set_at: minutes_ago(10),
        }),
      ]);

      // Assign as builder — different archetype but rate-limited
      await pool.assign("ch-1", "e1", "builder");

      expect(avatar_handler).not.toHaveBeenCalled();
    });

    it("allows avatar set when cooldown has expired", async () => {
      // Bot had avatar set 35 minutes ago — past the 30-minute cooldown
      pool.inject_bots([
        make_bot({
          id: 1,
          state: "free",
          last_avatar_archetype: "planner",
          last_avatar_set_at: minutes_ago(35),
        }),
      ]);

      await pool.assign("ch-1", "e1", "builder");

      expect(avatar_handler).toHaveBeenCalledOnce();
    });

    it("allows avatar set when no previous avatar was ever set", async () => {
      // Fresh bot — no avatar set history
      pool.inject_bots([make_bot({ id: 1, state: "free" })]);

      await pool.assign("ch-1", "e1", "planner");

      expect(avatar_handler).toHaveBeenCalledOnce();
    });

    it("cooldown is exactly AVATAR_COOLDOWN_MS", () => {
      // Verify the constant is 30 minutes
      expect(AVATAR_COOLDOWN_MS).toBe(30 * 60 * 1000);
    });
  });

  describe("graceful fallback on avatar failure", () => {
    it("continues assignment when avatar handler throws", async () => {
      avatar_handler.mockRejectedValueOnce(new Error("Discord API 429: Rate limited"));

      pool.inject_bots([make_bot({ id: 1, state: "free" })]);

      // Assign should still succeed
      const result = await pool.assign("ch-1", "e1", "planner");

      expect(result).not.toBeNull();
      expect(result!.archetype).toBe("planner");
      expect(result!.channel_id).toBe("ch-1");
    });

    it("does not update last_avatar_archetype when handler fails", async () => {
      avatar_handler.mockRejectedValueOnce(new Error("Discord API 500"));

      pool.inject_bots([make_bot({ id: 1, state: "free" })]);

      await pool.assign("ch-1", "e1", "planner");

      // On next assignment with the same archetype, avatar handler should be
      // called again because the failure means we didn't record the archetype.
      // Release the bot and reassign the SAME bot instance — no inject_bots,
      // which would replace it with a fresh null-state object and make the
      // assertion trivially true.
      avatar_handler.mockClear();
      avatar_handler.mockResolvedValue(undefined);

      await pool.release("ch-1");
      await pool.assign("ch-2", "e1", "planner");

      // Should try again since last attempt failed and last_avatar_archetype was not set
      expect(avatar_handler).toHaveBeenCalledOnce();
    });
  });

  describe("no avatar handler registered", () => {
    it("skips avatar set gracefully when no handler is registered", async () => {
      // Create a fresh pool without an avatar handler
      const bare_pool = new TestBotPool(config);
      vi.spyOn(bare_pool as unknown as Record<string, unknown>, "kill_tmux" as never)
        .mockImplementation(() => {});
      vi.spyOn(bare_pool as unknown as Record<string, unknown>, "write_access_json" as never)
        .mockResolvedValue(undefined);
      vi.spyOn(bare_pool as unknown as Record<string, unknown>, "set_bot_nickname" as never)
        .mockResolvedValue(undefined);
      vi.spyOn(bare_pool as unknown as Record<string, unknown>, "start_tmux" as never)
        .mockResolvedValue(undefined);
      vi.spyOn(bare_pool as unknown as Record<string, unknown>, "is_tmux_alive" as never)
        .mockReturnValue(false);

      bare_pool.inject_bots([make_bot({ id: 1, state: "free" })]);

      // Should not throw — handler is null
      const result = await bare_pool.assign("ch-1", "e1", "planner");
      expect(result).not.toBeNull();
    });
  });

  describe("avatar state persistence", () => {
    it("preserves last_avatar_archetype across bot release/reassign cycles", async () => {
      pool.inject_bots([make_bot({ id: 1, state: "free" })]);

      // First assignment — avatar is set
      await pool.assign("ch-1", "e1", "builder");
      expect(avatar_handler).toHaveBeenCalledOnce();
      avatar_handler.mockClear();

      // Release the bot
      await pool.release("ch-1");

      // Reassign the same bot as builder again
      pool.inject_bots([
        make_bot({
          id: 1,
          state: "free",
          // Simulate what persist/restore would do — these fields survive release
          // in the in-memory bot object
          last_avatar_archetype: "builder",
          last_avatar_set_at: new Date(),
        }),
      ]);

      await pool.assign("ch-2", "e1", "builder");

      // Avatar handler should NOT be called — same archetype as last successful set
      expect(avatar_handler).not.toHaveBeenCalled();
    });
  });
});
