import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig, EntityConfig } from "@lobster-farm/shared";
import { BotPool } from "../pool.js";
import type { PoolBot } from "../pool.js";
import {
  save_pool_state,
  load_pool_state,
} from "../persistence.js";
import type { PersistedPoolBot } from "../persistence.js";

// ── Test helpers ──

let temp_dir: string;

function make_config(lobsterfarm_dir_override?: string): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    paths: {
      lobsterfarm_dir: lobsterfarm_dir_override ?? temp_dir,
    },
  });
}

function make_persisted_bot(overrides: Partial<PersistedPoolBot> & { id: number }): PersistedPoolBot {
  return {
    state: "assigned",
    channel_id: "ch-100",
    entity_id: "test-entity",
    archetype: "builder",
    channel_type: null,
    session_id: null,
    last_active: null,
    ...overrides,
  };
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
    ...overrides,
  };
}

function make_entity_config(
  entity_id: string,
  channel_ids: string[],
): EntityConfig {
  return {
    entity: {
      id: entity_id,
      name: `Test ${entity_id}`,
      description: "",
      status: "active",
      repos: [],
      accounts: {},
      channels: {
        category_id: "",
        list: channel_ids.map(id => ({
          type: "general" as const,
          id,
        })),
      },
      memory: { path: "/tmp/memory", auto_extract: true },
      secrets: { vault: "1password", vault_name: `entity-${entity_id}` },
    },
  };
}

/**
 * Test-friendly BotPool subclass that stubs tmux/filesystem/persistence side effects.
 */
class TestBotPool extends BotPool {
  private idle_overrides = new Map<number, boolean>();

  inject_bots(bots: PoolBot[]): void {
    (this as unknown as { bots: PoolBot[] }).bots = bots;
  }

  get_bots(): PoolBot[] {
    return (this as unknown as { bots: PoolBot[] }).bots;
  }

  get_session_history(): Map<string, string> {
    return (this as unknown as { session_history: Map<string, string> }).session_history;
  }

  set_bot_idle(bot_id: number, idle: boolean): void {
    this.idle_overrides.set(bot_id, idle);
  }

  protected override is_bot_idle(bot: PoolBot): boolean {
    return this.idle_overrides.get(bot.id) ?? true;
  }
}

// ── Tests ──

describe("session history preservation", () => {
  let config: LobsterFarmConfig;
  let pool: TestBotPool;

  beforeEach(async () => {
    temp_dir = await mkdtemp(join(tmpdir(), "session-history-test-"));
    config = make_config();
    pool = new TestBotPool(config);

    // Stub out side effects
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
    vi.spyOn(pool as unknown as Record<string, unknown>, "is_tmux_alive" as never)
      .mockReturnValue(false);
    vi.spyOn(pool as unknown as Record<string, unknown>, "park_bot" as never)
      .mockImplementation(async (bot: PoolBot) => {
        bot.state = "parked";
      });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(temp_dir, { recursive: true, force: true });
  });

  describe("eviction stashes session history", () => {
    it("stashes session_id when evicting a parked bot for a different channel", async () => {
      pool.inject_bots([
        make_bot({
          id: 1,
          state: "parked",
          channel_id: "ch-old",
          entity_id: "e1",
          archetype: "planner",
          session_id: "sess-old-abc",
          channel_type: "general",
          last_active: new Date(Date.now() - 3600_000),
        }),
      ]);

      // Assign to a different channel -- evicts the parked bot
      await pool.assign("ch-new", "e2", "builder", undefined, "general");

      // Session history should have the evicted bot's old session
      const history = pool.get_session_history();
      expect(history.get("e1:ch-old")).toBe("sess-old-abc");
    });

    it("stashes session_id when evicting an idle assigned bot", async () => {
      // Restore mocks for this test since we need real park_bot to be mocked
      pool.inject_bots([
        make_bot({
          id: 1,
          state: "assigned",
          channel_id: "ch-busy",
          entity_id: "e1",
          archetype: "builder",
          session_id: "sess-busy-123",
          channel_type: "work_room",
          last_active: new Date(Date.now() - 3600_000), // 1 hour ago = idle
        }),
      ]);

      pool.set_bot_idle(1, true); // Mark as idle at prompt

      await pool.assign("ch-new", "e2", "planner", undefined, "general");

      const history = pool.get_session_history();
      expect(history.get("e1:ch-busy")).toBe("sess-busy-123");
    });

    it("stashes session_id when evicting a waiting_for_human bot", async () => {
      pool.inject_bots([
        make_bot({
          id: 1,
          state: "assigned",
          channel_id: "ch-waiting",
          entity_id: "e1",
          archetype: "designer",
          session_id: "sess-waiting-456",
          channel_type: "general",
          last_active: new Date(Date.now() - 600_000), // 10 min ago = waiting_for_human
        }),
      ]);

      pool.set_bot_idle(1, true);

      await pool.assign("ch-new", "e2", "planner", undefined, "general");

      const history = pool.get_session_history();
      expect(history.get("e1:ch-waiting")).toBe("sess-waiting-456");
    });

    it("does NOT stash when a parked bot reclaims its own channel", async () => {
      pool.inject_bots([
        make_bot({
          id: 1,
          state: "parked",
          channel_id: "ch-same",
          entity_id: "e1",
          archetype: "planner",
          session_id: "sess-same",
          channel_type: "general",
        }),
      ]);

      // Assign to the SAME channel -- this is a reclaim, not an eviction
      await pool.assign("ch-same", "e1", "planner", undefined, "general");

      const history = pool.get_session_history();
      expect(history.size).toBe(0);
    });

    it("does NOT stash for free bots (no prior channel)", async () => {
      pool.inject_bots([make_bot({ id: 1, state: "free" })]);

      await pool.assign("ch-new", "e1", "builder", undefined, "general");

      const history = pool.get_session_history();
      expect(history.size).toBe(0);
    });
  });

  describe("session history is consumed on reassignment", () => {
    it("uses history entry as resume_session_id when channel gets a new bot", async () => {
      pool.inject_bots([
        make_bot({ id: 1, state: "free" }),
        make_bot({ id: 2, state: "free" }),
      ]);

      // Manually seed session history (as if an eviction happened earlier)
      pool.get_session_history().set("e1:ch-returning", "sess-history-789");

      // Assign bot to the channel with history
      const result = await pool.assign("ch-returning", "e1", "builder", undefined, "general");
      expect(result).not.toBeNull();

      // The session should use the history entry
      expect(result!.session_id).toBe("sess-history-789");

      // History entry should be consumed
      const history = pool.get_session_history();
      expect(history.has("e1:ch-returning")).toBe(false);
    });

    it("explicit resume_session_id takes precedence over history", async () => {
      pool.inject_bots([make_bot({ id: 1, state: "free" })]);

      pool.get_session_history().set("e1:ch-1", "sess-from-history");

      const result = await pool.assign("ch-1", "e1", "builder", "sess-explicit", "general");
      expect(result).not.toBeNull();
      expect(result!.session_id).toBe("sess-explicit");

      // History entry still consumed on successful assignment
      expect(pool.get_session_history().has("e1:ch-1")).toBe(false);
    });

    it("parked bot's session_id takes precedence over history", async () => {
      pool.inject_bots([
        make_bot({
          id: 1,
          state: "parked",
          channel_id: "ch-1",
          entity_id: "e1",
          archetype: "builder",
          session_id: "sess-parked",
          channel_type: "general",
        }),
      ]);

      // Seed history for the same channel (stale entry)
      pool.get_session_history().set("e1:ch-1", "sess-stale-history");

      const result = await pool.assign("ch-1", "e1", "builder", undefined, "general");
      expect(result).not.toBeNull();
      // Parked bot's session wins
      expect(result!.session_id).toBe("sess-parked");

      // History entry consumed
      expect(pool.get_session_history().has("e1:ch-1")).toBe(false);
    });
  });

  describe("session history survives daemon restart (persistence)", () => {
    it("persists and restores session_history through pool-state.json", async () => {
      pool.inject_bots([
        make_bot({
          id: 1,
          state: "parked",
          channel_id: "ch-old",
          entity_id: "e1",
          archetype: "planner",
          session_id: "sess-evicted",
          channel_type: "general",
          last_active: new Date(Date.now() - 3600_000),
        }),
      ]);

      // Evict bot 1 by assigning to different channel -- stashes history
      await pool.assign("ch-new", "e2", "builder", undefined, "general");

      // Verify session history was stashed
      expect(pool.get_session_history().get("e1:ch-old")).toBe("sess-evicted");

      // Read the persisted file
      const state = await load_pool_state(config);
      expect(state.session_history["e1:ch-old"]).toBe("sess-evicted");

      // Simulate daemon restart: create fresh pool, seed pool-bot directories
      const channels_dir = join(temp_dir, "channels", "pool-1");
      await mkdir(channels_dir, { recursive: true });
      await writeFile(join(channels_dir, ".env"), "DISCORD_BOT_TOKEN=fake-token", "utf-8");

      const fresh_pool = new TestBotPool(config);
      vi.spyOn(fresh_pool as unknown as Record<string, unknown>, "is_tmux_alive" as never)
        .mockReturnValue(false);
      vi.spyOn(fresh_pool as unknown as Record<string, unknown>, "kill_tmux" as never)
        .mockImplementation(() => {});
      vi.spyOn(fresh_pool as unknown as Record<string, unknown>, "write_access_json" as never)
        .mockResolvedValue(undefined);

      const registry = {
        get: (id: string) => id === "e1" ? make_entity_config("e1", ["ch-old", "ch-new"]) :
          id === "e2" ? make_entity_config("e2", ["ch-new"]) : undefined,
        get_all: () => [],
        get_active: () => [],
        count: () => 2,
      } as unknown as import("../registry.js").EntityRegistry;

      await fresh_pool.initialize(registry);

      // Session history should be restored from disk
      expect(fresh_pool.get_session_history().get("e1:ch-old")).toBe("sess-evicted");
    });
  });

  describe("backward compatibility: old pool-state.json format", () => {
    it("loads plain array format as bots-only with empty session_history", async () => {
      const state_path = join(temp_dir, "state");
      await mkdir(state_path, { recursive: true });

      // Write old-format file: plain array of bots
      const old_format = [
        make_persisted_bot({ id: 1, session_id: "sess-old-format" }),
      ];
      await writeFile(join(state_path, "pool-state.json"), JSON.stringify(old_format), "utf-8");

      const result = await load_pool_state(config);
      expect(result.bots).toHaveLength(1);
      expect(result.bots[0]!.session_id).toBe("sess-old-format");
      expect(result.session_history).toEqual({});
    });

    it("loads new format with session_history correctly", async () => {
      const state_path = join(temp_dir, "state");
      await mkdir(state_path, { recursive: true });

      const new_format = {
        bots: [make_persisted_bot({ id: 1, session_id: "sess-new" })],
        session_history: { "e1:ch-1": "sess-abc" },
      };
      await writeFile(join(state_path, "pool-state.json"), JSON.stringify(new_format), "utf-8");

      const result = await load_pool_state(config);
      expect(result.bots).toHaveLength(1);
      expect(result.session_history["e1:ch-1"]).toBe("sess-abc");
    });
  });

  describe("clear_session_history (used by !reset and feature completion)", () => {
    it("clears the history entry for a specific channel", () => {
      pool.get_session_history().set("e1:ch-1", "sess-a");
      pool.get_session_history().set("e1:ch-2", "sess-b");

      pool.clear_session_history("e1", "ch-1");

      expect(pool.get_session_history().has("e1:ch-1")).toBe(false);
      // Other entries unaffected
      expect(pool.get_session_history().get("e1:ch-2")).toBe("sess-b");
    });

    it("is a no-op when no history exists for the channel", () => {
      // Should not throw
      pool.clear_session_history("e1", "ch-nonexistent");
      expect(pool.get_session_history().size).toBe(0);
    });
  });

  describe("end-to-end: evict -> reassign with history", () => {
    it("full cycle: assign -> evict -> reassign resumes old session", async () => {
      pool.inject_bots([
        make_bot({ id: 1, state: "free" }),
      ]);

      // Step 1: Assign bot 1 to channel A
      const first = await pool.assign("ch-A", "e1", "builder", "sess-first", "work_room");
      expect(first).not.toBeNull();
      expect(first!.session_id).toBe("sess-first");

      // Step 2: Bot finishes working, becomes parked (simulated)
      const bot1 = pool.get_bots().find(b => b.id === 1)!;
      bot1.state = "parked";

      // Step 3: Channel B needs a bot -- evicts bot 1 from channel A
      const second = await pool.assign("ch-B", "e2", "planner", undefined, "general");
      expect(second).not.toBeNull();
      expect(second!.bot_id).toBe(1);

      // Session history should have channel A's session
      expect(pool.get_session_history().get("e1:ch-A")).toBe("sess-first");

      // Step 4: Bot finishes on channel B, becomes parked again
      bot1.state = "parked";
      bot1.channel_id = "ch-B";
      bot1.entity_id = "e2";

      // Step 5: Channel A needs a bot again -- should use session history
      // Need to clear the bot's current state first (eviction from ch-B)
      const third = await pool.assign("ch-A", "e1", "builder", undefined, "work_room");
      expect(third).not.toBeNull();
      // Should resume with the original session from channel A
      expect(third!.session_id).toBe("sess-first");

      // History entry consumed
      expect(pool.get_session_history().has("e1:ch-A")).toBe(false);

      // Verify start_tmux was called with is_resume=true for the last assignment
      const start_tmux_spy = pool["start_tmux" as keyof typeof pool] as unknown as { mock: { calls: unknown[][] } };
      const last_call = start_tmux_spy.mock.calls[start_tmux_spy.mock.calls.length - 1]!;
      // session_id arg (index 4) should be the history session
      expect(last_call[4]).toBe("sess-first");
      // is_resume arg (index 5) should be true
      expect(last_call[5]).toBe(true);
    });
  });
});
