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
import { EntityRegistry } from "../registry.js";

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

/**
 * Test-friendly subclass that stubs tmux/filesystem/persistence side effects.
 * Mirrors TestBotPool from pool.test.ts but adds persistence visibility.
 */
class TestBotPool extends BotPool {
  private idle_overrides = new Map<number, boolean>();

  /** Track persist() calls for assertions. */
  persist_calls = 0;

  inject_bots(bots: PoolBot[]): void {
    (this as unknown as { bots: PoolBot[] }).bots = bots;
  }

  get_bots(): PoolBot[] {
    return (this as unknown as { bots: PoolBot[] }).bots;
  }

  set_bot_idle(bot_id: number, idle: boolean): void {
    this.idle_overrides.set(bot_id, idle);
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
    state_dir: `/tmp/test-pool-${String(overrides.id)}`,
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

/** Create a mock EntityRegistry that returns the given configs. */
function make_registry(entities: EntityConfig[]): EntityRegistry {
  const map = new Map<string, EntityConfig>();
  for (const e of entities) {
    map.set(e.entity.id, e);
  }
  return {
    get: (id: string) => map.get(id),
    get_all: () => [...map.values()],
    get_active: () => [...map.values()].filter(e => e.entity.status === "active"),
    count: () => map.size,
  } as unknown as EntityRegistry;
}

// ── Persistence layer tests ──

describe("save_pool_state / load_pool_state", () => {
  beforeEach(async () => {
    temp_dir = await mkdtemp(join(tmpdir(), "pool-persist-test-"));
  });

  afterEach(async () => {
    await rm(temp_dir, { recursive: true, force: true });
  });

  it("writes valid JSON and reads it back", async () => {
    const config = make_config();
    const bots: PersistedPoolBot[] = [
      make_persisted_bot({ id: 1, state: "assigned", session_id: "sess-abc", last_active: "2026-03-26T10:00:00.000Z" }),
      make_persisted_bot({ id: 3, state: "parked", channel_id: "ch-200", channel_type: "work_room" }),
    ];

    await save_pool_state(bots, config);

    // Verify the file is valid JSON
    const raw = await readFile(join(temp_dir, "state", "pool-state.json"), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);

    // Load it back
    const loaded = await load_pool_state(config);
    expect(loaded).toHaveLength(2);
    expect(loaded[0]!.id).toBe(1);
    expect(loaded[0]!.state).toBe("assigned");
    expect(loaded[0]!.session_id).toBe("sess-abc");
    expect(loaded[1]!.id).toBe(3);
    expect(loaded[1]!.state).toBe("parked");
    expect(loaded[1]!.channel_type).toBe("work_room");
  });

  it("returns empty array when file does not exist", async () => {
    const config = make_config();
    const result = await load_pool_state(config);
    expect(result).toEqual([]);
  });

  it("returns empty array for malformed JSON", async () => {
    const config = make_config();
    const state_path = join(temp_dir, "state");
    await mkdir(state_path, { recursive: true });
    await writeFile(join(state_path, "pool-state.json"), "not valid json{{{", "utf-8");

    const result = await load_pool_state(config);
    expect(result).toEqual([]);
  });

  it("returns empty array when file contains a non-array JSON value", async () => {
    const config = make_config();
    const state_path = join(temp_dir, "state");
    await mkdir(state_path, { recursive: true });
    await writeFile(join(state_path, "pool-state.json"), '{"not": "array"}', "utf-8");

    const result = await load_pool_state(config);
    expect(result).toEqual([]);
  });

  it("creates state directory if missing", async () => {
    const nested_dir = join(temp_dir, "deep", "nested");
    const config = make_config(nested_dir);

    await save_pool_state([make_persisted_bot({ id: 1 })], config);

    const loaded = await load_pool_state(config);
    expect(loaded).toHaveLength(1);
  });
});

// ── BotPool persistence integration tests ──

describe("BotPool persistence", () => {
  let config: LobsterFarmConfig;
  let pool: TestBotPool;

  beforeEach(async () => {
    temp_dir = await mkdtemp(join(tmpdir(), "pool-persist-test-"));
    config = make_config();
    pool = new TestBotPool(config);

    // Stub out side effects
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
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(temp_dir, { recursive: true, force: true });
  });

  describe("persist() writes correct state", () => {
    it("persists assigned and parked bots, excludes free bots", async () => {
      pool.inject_bots([
        make_bot({ id: 1, state: "free" }),
        make_bot({ id: 2, state: "free" }),
        make_bot({ id: 3, state: "assigned", channel_id: "ch-1", entity_id: "e1", archetype: "builder", channel_type: "general", session_id: "sess-1", last_active: new Date("2026-03-26T10:00:00Z") }),
        make_bot({ id: 4, state: "parked", channel_id: "ch-2", entity_id: "e2", archetype: "planner", channel_type: "work_room", session_id: "sess-2", last_active: new Date("2026-03-26T09:00:00Z") }),
      ]);

      // Trigger a persist by assigning — bot 1 (first free) gets assigned
      await pool.assign("ch-new", "e1", "designer", undefined, "general");

      const saved = await load_pool_state(config);
      // Bot 2 is still free — should NOT appear in persisted state
      const ids = saved.map(b => b.id);
      expect(ids).not.toContain(2); // free bot excluded

      // Bots 1 (now assigned), 3 (assigned), 4 (parked) should be persisted
      expect(ids).toContain(1);
      expect(ids).toContain(3);
      expect(ids).toContain(4);

      // Verify no free bots leak through
      for (const bot of saved) {
        expect(bot.state).not.toBe("free");
        expect(bot.channel_id).toBeTruthy();
        expect(bot.entity_id).toBeTruthy();
        expect(bot.archetype).toBeTruthy();
      }
    });

    it("assign() triggers persist", async () => {
      pool.inject_bots([make_bot({ id: 1, state: "free" })]);

      await pool.assign("ch-1", "e1", "builder", undefined, "general");

      // Verify state was written to disk
      const saved = await load_pool_state(config);
      expect(saved.length).toBeGreaterThanOrEqual(1);
      const assigned = saved.find(b => b.channel_id === "ch-1");
      expect(assigned).toBeDefined();
      expect(assigned!.state).toBe("assigned");
      expect(assigned!.entity_id).toBe("e1");
      expect(assigned!.archetype).toBe("builder");
    });

    it("release() triggers persist", async () => {
      pool.inject_bots([
        make_bot({ id: 1, state: "assigned", channel_id: "ch-1", entity_id: "e1", archetype: "builder" }),
      ]);

      // Release the bot — park_bot is mocked so we need to use the real release
      vi.restoreAllMocks();
      vi.spyOn(pool as unknown as Record<string, unknown>, "kill_tmux" as never)
        .mockImplementation(() => {});
      vi.spyOn(pool as unknown as Record<string, unknown>, "write_access_json" as never)
        .mockResolvedValue(undefined);

      await pool.release("ch-1");

      const saved = await load_pool_state(config);
      // After release, bot should be free — not in persisted state
      const released = saved.find(b => b.id === 1);
      expect(released).toBeUndefined();
    });

    it("park_bot() triggers persist (via eviction in assign)", async () => {
      // Use real park_bot for this test
      vi.restoreAllMocks();
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

      pool.inject_bots([
        make_bot({
          id: 1,
          state: "parked",
          channel_id: "ch-1",
          entity_id: "e1",
          archetype: "planner",
          session_id: "sess-old",
          channel_type: "general",
          last_active: new Date(Date.now() - 3600_000),
        }),
      ]);

      // Assign to a different channel — will evict the parked bot
      await pool.assign("ch-new", "e2", "builder", undefined, "general");

      const saved = await load_pool_state(config);
      // The bot should now be assigned to ch-new
      const bot = saved.find(b => b.id === 1);
      expect(bot).toBeDefined();
      expect(bot!.channel_id).toBe("ch-new");
      expect(bot!.state).toBe("assigned");
    });
  });

  describe("initialize() restores persisted state", () => {
    it("restores assigned bots as parked when tmux is dead", async () => {
      // Pre-seed persisted state
      await save_pool_state([
        make_persisted_bot({
          id: 1,
          state: "assigned",
          channel_id: "ch-1",
          entity_id: "test-entity",
          archetype: "builder",
          session_id: "sess-abc123",
          channel_type: "general",
          last_active: "2026-03-26T10:00:00.000Z",
        }),
      ], config);

      // Set up pool bot directories so initialize() discovers them
      const channels_dir = join(temp_dir, "channels", "pool-1");
      await mkdir(channels_dir, { recursive: true });
      await writeFile(join(channels_dir, ".env"), "DISCORD_BOT_TOKEN=fake-token", "utf-8");

      const fresh_pool = new TestBotPool(config);
      // tmux is dead (default mock returns false)
      vi.spyOn(fresh_pool as unknown as Record<string, unknown>, "is_tmux_alive" as never)
        .mockReturnValue(false);

      const registry = make_registry([
        make_entity_config("test-entity", ["ch-1"]),
      ]);

      await fresh_pool.initialize(registry);

      const bots = fresh_pool.get_bots();
      expect(bots).toHaveLength(1);
      expect(bots[0]!.state).toBe("parked"); // tmux dead -> parked
      expect(bots[0]!.channel_id).toBe("ch-1");
      expect(bots[0]!.entity_id).toBe("test-entity");
      expect(bots[0]!.archetype).toBe("builder");
      expect(bots[0]!.session_id).toBe("sess-abc123");
      expect(bots[0]!.channel_type).toBe("general");
    });

    it("restores assigned bots with running tmux as assigned", async () => {
      await save_pool_state([
        make_persisted_bot({
          id: 1,
          state: "assigned",
          channel_id: "ch-1",
          entity_id: "test-entity",
          archetype: "designer",
          session_id: "sess-live",
          last_active: "2026-03-26T12:00:00.000Z",
        }),
      ], config);

      const channels_dir = join(temp_dir, "channels", "pool-1");
      await mkdir(channels_dir, { recursive: true });
      await writeFile(join(channels_dir, ".env"), "DISCORD_BOT_TOKEN=fake-token", "utf-8");

      const fresh_pool = new TestBotPool(config);
      // tmux IS alive (survived restart)
      vi.spyOn(fresh_pool as unknown as Record<string, unknown>, "is_tmux_alive" as never)
        .mockReturnValue(true);

      const registry = make_registry([
        make_entity_config("test-entity", ["ch-1"]),
      ]);

      await fresh_pool.initialize(registry);

      const bots = fresh_pool.get_bots();
      expect(bots).toHaveLength(1);
      expect(bots[0]!.state).toBe("assigned"); // tmux alive -> stays assigned
      expect(bots[0]!.channel_id).toBe("ch-1");
      expect(bots[0]!.archetype).toBe("designer");
      expect(bots[0]!.session_id).toBe("sess-live");
    });

    it("skips entries for removed entities", async () => {
      await save_pool_state([
        make_persisted_bot({
          id: 1,
          state: "assigned",
          channel_id: "ch-1",
          entity_id: "deleted-entity",
          archetype: "builder",
        }),
      ], config);

      const channels_dir = join(temp_dir, "channels", "pool-1");
      await mkdir(channels_dir, { recursive: true });
      await writeFile(join(channels_dir, ".env"), "DISCORD_BOT_TOKEN=fake-token", "utf-8");

      const fresh_pool = new TestBotPool(config);
      vi.spyOn(fresh_pool as unknown as Record<string, unknown>, "is_tmux_alive" as never)
        .mockReturnValue(false);

      // Registry does NOT have "deleted-entity"
      const registry = make_registry([
        make_entity_config("other-entity", ["ch-99"]),
      ]);

      await fresh_pool.initialize(registry);

      const bots = fresh_pool.get_bots();
      expect(bots).toHaveLength(1);
      expect(bots[0]!.state).toBe("free"); // Not restored — entity gone
      expect(bots[0]!.channel_id).toBeNull();
    });

    it("skips entries for removed channels", async () => {
      await save_pool_state([
        make_persisted_bot({
          id: 1,
          state: "assigned",
          channel_id: "ch-deleted",
          entity_id: "test-entity",
          archetype: "builder",
        }),
      ], config);

      const channels_dir = join(temp_dir, "channels", "pool-1");
      await mkdir(channels_dir, { recursive: true });
      await writeFile(join(channels_dir, ".env"), "DISCORD_BOT_TOKEN=fake-token", "utf-8");

      const fresh_pool = new TestBotPool(config);
      vi.spyOn(fresh_pool as unknown as Record<string, unknown>, "is_tmux_alive" as never)
        .mockReturnValue(false);

      // Entity exists but does NOT have "ch-deleted"
      const registry = make_registry([
        make_entity_config("test-entity", ["ch-other"]),
      ]);

      await fresh_pool.initialize(registry);

      const bots = fresh_pool.get_bots();
      expect(bots).toHaveLength(1);
      expect(bots[0]!.state).toBe("free"); // Not restored — channel gone
    });

    it("skips entries for bot IDs that no longer have directories", async () => {
      await save_pool_state([
        make_persisted_bot({ id: 99, channel_id: "ch-1", entity_id: "test-entity" }),
      ], config);

      // Only create pool-1 directory, not pool-99
      const channels_dir = join(temp_dir, "channels", "pool-1");
      await mkdir(channels_dir, { recursive: true });
      await writeFile(join(channels_dir, ".env"), "DISCORD_BOT_TOKEN=fake-token", "utf-8");

      const fresh_pool = new TestBotPool(config);
      vi.spyOn(fresh_pool as unknown as Record<string, unknown>, "is_tmux_alive" as never)
        .mockReturnValue(false);

      const registry = make_registry([
        make_entity_config("test-entity", ["ch-1"]),
      ]);

      await fresh_pool.initialize(registry);

      const bots = fresh_pool.get_bots();
      expect(bots).toHaveLength(1);
      expect(bots[0]!.id).toBe(1);
      expect(bots[0]!.state).toBe("free"); // pool-99 entry ignored, pool-1 is free
    });

    it("works without registry (skips validation)", async () => {
      await save_pool_state([
        make_persisted_bot({
          id: 1,
          state: "assigned",
          channel_id: "ch-1",
          entity_id: "any-entity",
          archetype: "builder",
          session_id: "sess-123",
        }),
      ], config);

      const channels_dir = join(temp_dir, "channels", "pool-1");
      await mkdir(channels_dir, { recursive: true });
      await writeFile(join(channels_dir, ".env"), "DISCORD_BOT_TOKEN=fake-token", "utf-8");

      const fresh_pool = new TestBotPool(config);
      vi.spyOn(fresh_pool as unknown as Record<string, unknown>, "is_tmux_alive" as never)
        .mockReturnValue(false);

      // No registry passed — validation skipped
      await fresh_pool.initialize();

      const bots = fresh_pool.get_bots();
      expect(bots).toHaveLength(1);
      expect(bots[0]!.state).toBe("parked"); // Restored without validation
      expect(bots[0]!.session_id).toBe("sess-123");
    });

    it("cleans up persisted state after restore (removes stale entries)", async () => {
      // Save two entries — one valid, one stale
      await save_pool_state([
        make_persisted_bot({ id: 1, channel_id: "ch-1", entity_id: "test-entity" }),
        make_persisted_bot({ id: 2, channel_id: "ch-2", entity_id: "deleted-entity" }),
      ], config);

      // Create directories for both bots
      for (const id of [1, 2]) {
        const dir = join(temp_dir, "channels", `pool-${String(id)}`);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, ".env"), "DISCORD_BOT_TOKEN=fake-token", "utf-8");
      }

      const fresh_pool = new TestBotPool(config);
      vi.spyOn(fresh_pool as unknown as Record<string, unknown>, "is_tmux_alive" as never)
        .mockReturnValue(false);

      const registry = make_registry([
        make_entity_config("test-entity", ["ch-1"]),
      ]);

      await fresh_pool.initialize(registry);

      // Re-read persisted state — should only contain the valid entry
      const cleaned = await load_pool_state(config);
      expect(cleaned).toHaveLength(1);
      expect(cleaned[0]!.id).toBe(1);
      expect(cleaned[0]!.entity_id).toBe("test-entity");
    });
  });

  describe("full cycle: assign -> persist -> reinitialize -> auto-resume", () => {
    it("session ID survives restart and enables auto-resume", async () => {
      // Phase 1: Assign a bot with a session ID
      vi.restoreAllMocks();
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

      pool.inject_bots([make_bot({ id: 1, state: "free" })]);

      const assignment = await pool.assign("ch-1", "test-entity", "builder", "sess-original-123", "general");
      expect(assignment).not.toBeNull();
      expect(assignment!.session_id).toBe("sess-original-123");

      // Verify persisted state
      const saved = await load_pool_state(config);
      expect(saved).toHaveLength(1);
      expect(saved[0]!.session_id).toBe("sess-original-123");

      // Phase 2: Simulate daemon restart — create fresh pool, restore state
      const channels_dir = join(temp_dir, "channels", "pool-1");
      await mkdir(channels_dir, { recursive: true });
      await writeFile(join(channels_dir, ".env"), "DISCORD_BOT_TOKEN=fake-token", "utf-8");

      const restarted_pool = new TestBotPool(config);
      vi.spyOn(restarted_pool as unknown as Record<string, unknown>, "is_tmux_alive" as never)
        .mockReturnValue(false); // tmux is dead after restart
      vi.spyOn(restarted_pool as unknown as Record<string, unknown>, "kill_tmux" as never)
        .mockImplementation(() => {});
      vi.spyOn(restarted_pool as unknown as Record<string, unknown>, "write_access_json" as never)
        .mockResolvedValue(undefined);
      vi.spyOn(restarted_pool as unknown as Record<string, unknown>, "set_bot_nickname" as never)
        .mockResolvedValue(undefined);
      vi.spyOn(restarted_pool as unknown as Record<string, unknown>, "start_tmux" as never)
        .mockResolvedValue(undefined);

      const registry = make_registry([
        make_entity_config("test-entity", ["ch-1"]),
      ]);

      await restarted_pool.initialize(registry);

      // Bot should be parked with preserved session ID
      const bots = restarted_pool.get_bots();
      expect(bots).toHaveLength(1);
      expect(bots[0]!.state).toBe("parked");
      expect(bots[0]!.session_id).toBe("sess-original-123");
      expect(bots[0]!.channel_id).toBe("ch-1");

      // Phase 3: New message to the same channel — should auto-resume
      const resumed = await restarted_pool.assign("ch-1", "test-entity", "builder", undefined, "general");
      expect(resumed).not.toBeNull();
      expect(resumed!.bot_id).toBe(1);
      // The session_id should be preserved from the parked bot
      expect(resumed!.session_id).toBe("sess-original-123");

      // Verify start_tmux was called with the resume session ID
      const start_tmux_spy = restarted_pool["start_tmux" as keyof typeof restarted_pool] as unknown as { mock: { calls: unknown[][] } };
      const last_call = start_tmux_spy.mock.calls[start_tmux_spy.mock.calls.length - 1]!;
      // resume_session_id is the 5th argument (index 4)
      expect(last_call[4]).toBe("sess-original-123");
    });
  });

  describe("multiple bots with mixed states", () => {
    it("correctly persists and restores a multi-bot pool", async () => {
      // Create directories for 3 bots
      for (const id of [1, 2, 3]) {
        const dir = join(temp_dir, "channels", `pool-${String(id)}`);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, ".env"), "DISCORD_BOT_TOKEN=fake-token", "utf-8");
      }

      // Seed persisted state: 1 assigned, 1 parked, (bot 3 was free — not persisted)
      await save_pool_state([
        make_persisted_bot({
          id: 1,
          state: "assigned",
          channel_id: "ch-1",
          entity_id: "entity-a",
          archetype: "builder",
          session_id: "sess-1",
          channel_type: "work_room",
          last_active: "2026-03-26T10:00:00.000Z",
        }),
        make_persisted_bot({
          id: 2,
          state: "parked",
          channel_id: "ch-2",
          entity_id: "entity-b",
          archetype: "planner",
          session_id: "sess-2",
          channel_type: "general",
          last_active: "2026-03-26T09:00:00.000Z",
        }),
      ], config);

      const fresh_pool = new TestBotPool(config);
      vi.spyOn(fresh_pool as unknown as Record<string, unknown>, "is_tmux_alive" as never)
        .mockReturnValue(false);

      const registry = make_registry([
        make_entity_config("entity-a", ["ch-1"]),
        make_entity_config("entity-b", ["ch-2"]),
      ]);

      await fresh_pool.initialize(registry);

      const bots = fresh_pool.get_bots();
      expect(bots).toHaveLength(3);

      // Bot 1: was assigned, tmux dead -> parked
      const bot1 = bots.find(b => b.id === 1)!;
      expect(bot1.state).toBe("parked");
      expect(bot1.channel_id).toBe("ch-1");
      expect(bot1.session_id).toBe("sess-1");
      expect(bot1.channel_type).toBe("work_room");

      // Bot 2: was parked, stays parked
      const bot2 = bots.find(b => b.id === 2)!;
      expect(bot2.state).toBe("parked");
      expect(bot2.channel_id).toBe("ch-2");
      expect(bot2.session_id).toBe("sess-2");

      // Bot 3: no persisted state -> free
      const bot3 = bots.find(b => b.id === 3)!;
      expect(bot3.state).toBe("free");
      expect(bot3.channel_id).toBeNull();
    });
  });

  describe("channel deduplication on initialize", () => {
    // Use high pool IDs (50+) to avoid collisions with real tmux sessions on the host
    it("frees duplicate parked bots claiming the same channel", async () => {
      const config = make_config();

      for (const id of [50, 51, 52]) {
        const dir = join(temp_dir, "channels", `pool-${String(id)}`);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, ".env"), `DISCORD_BOT_TOKEN=fake-token-${String(id)}`);
      }

      // Persist state: pool-50 and pool-51 both claim the same channel (from a prior race)
      await save_pool_state([
        make_persisted_bot({ id: 50, state: "parked", channel_id: "ch-duped", entity_id: "e1", archetype: "planner" }),
        make_persisted_bot({ id: 51, state: "parked", channel_id: "ch-duped", entity_id: "e1", archetype: "planner" }),
      ], config);

      const pool = new TestBotPool(config);
      await pool.initialize();

      const bots = pool.get_bots();

      // Pool-50 (lower ID, seen first) keeps the channel
      const bot0 = bots.find(b => b.id === 50)!;
      expect(bot0.state).toBe("parked");
      expect(bot0.channel_id).toBe("ch-duped");

      // Pool-51 (duplicate) is freed
      const bot1 = bots.find(b => b.id === 51)!;
      expect(bot1.state).toBe("free");
      expect(bot1.channel_id).toBeNull();
    });

    it("keeps non-duplicate bots on different channels", async () => {
      const config = make_config();

      for (const id of [50, 51]) {
        const dir = join(temp_dir, "channels", `pool-${String(id)}`);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, ".env"), `DISCORD_BOT_TOKEN=fake-token-${String(id)}`);
      }

      await save_pool_state([
        make_persisted_bot({ id: 50, state: "parked", channel_id: "ch-a", entity_id: "e1", archetype: "planner" }),
        make_persisted_bot({ id: 51, state: "parked", channel_id: "ch-b", entity_id: "e1", archetype: "builder" }),
      ], config);

      const pool = new TestBotPool(config);
      await pool.initialize();

      const bots = pool.get_bots();
      expect(bots.find(b => b.id === 50)!.state).toBe("parked");
      expect(bots.find(b => b.id === 50)!.channel_id).toBe("ch-a");
      expect(bots.find(b => b.id === 51)!.state).toBe("parked");
      expect(bots.find(b => b.id === 51)!.channel_id).toBe("ch-b");
    });
  });
});
