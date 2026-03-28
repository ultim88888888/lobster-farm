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

  get_resume_candidates(): PersistedPoolBot[] {
    return (this as unknown as { resume_candidates: PersistedPoolBot[] }).resume_candidates;
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

    // Verify the file is valid JSON with new format
    const raw = await readFile(join(temp_dir, "state", "pool-state.json"), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed).toHaveProperty("bots");
    expect(parsed).toHaveProperty("session_history");
    expect(Array.isArray(parsed["bots"])).toBe(true);
    expect(parsed["bots"]).toHaveLength(2);

    // Load it back
    const loaded = await load_pool_state(config);
    expect(loaded.bots).toHaveLength(2);
    expect(loaded.bots[0]!.id).toBe(1);
    expect(loaded.bots[0]!.state).toBe("assigned");
    expect(loaded.bots[0]!.session_id).toBe("sess-abc");
    expect(loaded.bots[1]!.id).toBe(3);
    expect(loaded.bots[1]!.state).toBe("parked");
    expect(loaded.bots[1]!.channel_type).toBe("work_room");
  });

  it("returns empty state when file does not exist", async () => {
    const config = make_config();
    const result = await load_pool_state(config);
    expect(result).toEqual({ bots: [], session_history: {}, avatar_state: {} });
  });

  it("returns empty state for malformed JSON", async () => {
    const config = make_config();
    const state_path = join(temp_dir, "state");
    await mkdir(state_path, { recursive: true });
    await writeFile(join(state_path, "pool-state.json"), "not valid json{{{", "utf-8");

    const result = await load_pool_state(config);
    expect(result).toEqual({ bots: [], session_history: {}, avatar_state: {} });
  });

  it("backward compat: loads old-format plain array as bots-only", async () => {
    const config = make_config();
    const state_path = join(temp_dir, "state");
    await mkdir(state_path, { recursive: true });
    // Old format: plain array of bots
    const old_bots = [make_persisted_bot({ id: 1, session_id: "sess-old" })];
    await writeFile(join(state_path, "pool-state.json"), JSON.stringify(old_bots), "utf-8");

    const result = await load_pool_state(config);
    expect(result.bots).toHaveLength(1);
    expect(result.bots[0]!.session_id).toBe("sess-old");
    expect(result.session_history).toEqual({});
  });

  it("creates state directory if missing", async () => {
    const nested_dir = join(temp_dir, "deep", "nested");
    const config = make_config(nested_dir);

    await save_pool_state([make_persisted_bot({ id: 1 })], config);

    const loaded = await load_pool_state(config);
    expect(loaded.bots).toHaveLength(1);
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
      const ids = saved.bots.map(b => b.id);
      expect(ids).not.toContain(2); // free bot excluded

      // Bots 1 (now assigned), 3 (assigned), 4 (parked) should be persisted
      expect(ids).toContain(1);
      expect(ids).toContain(3);
      expect(ids).toContain(4);

      // Verify no free bots leak through
      for (const bot of saved.bots) {
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
      expect(saved.bots.length).toBeGreaterThanOrEqual(1);
      const assigned = saved.bots.find(b => b.channel_id === "ch-1");
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
      const released = saved.bots.find(b => b.id === 1);
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
      vi.spyOn(pool as unknown as Record<string, unknown>, "set_bot_avatar" as never)
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
      const bot = saved.bots.find(b => b.id === 1);
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
      expect(cleaned.bots).toHaveLength(1);
      expect(cleaned.bots[0]!.id).toBe(1);
      expect(cleaned.bots[0]!.entity_id).toBe("test-entity");
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
      vi.spyOn(pool as unknown as Record<string, unknown>, "set_bot_avatar" as never)
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
      expect(saved.bots).toHaveLength(1);
      expect(saved.bots[0]!.session_id).toBe("sess-original-123");

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
      vi.spyOn(restarted_pool as unknown as Record<string, unknown>, "set_bot_avatar" as never)
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

  describe("access.json reconciliation on initialize", () => {
    it("clears access.json for free bots with stale channel configs", async () => {
      const config = make_config();

      // Create pool-60 with a stale access.json (channel from a previous assignment)
      const dir = join(temp_dir, "channels", "pool-60");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, ".env"), "DISCORD_BOT_TOKEN=fake-token-60");
      await writeFile(join(dir, "access.json"), JSON.stringify({
        dmPolicy: "allowlist",
        allowFrom: [],
        groups: { "stale-channel-id": { requireMention: false, allowFrom: [] } },
        pending: {},
        ackReaction: "👀",
        replyToMode: "first",
        textChunkLimit: 2000,
        chunkMode: "newline",
      }));

      // No persisted state — pool-60 should be free
      const pool = new TestBotPool(config);
      await pool.initialize();

      // access.json should have been rewritten with empty groups
      const access = JSON.parse(await readFile(join(dir, "access.json"), "utf-8")) as Record<string, unknown>;
      expect(access.groups).toEqual({});
    });

    it("preserves access.json channel for assigned bots only", async () => {
      const config = make_config();

      // Create pool-60 (will be parked) and pool-61 (no persisted state = free)
      for (const id of [60, 61]) {
        const dir = join(temp_dir, "channels", `pool-${String(id)}`);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, ".env"), `DISCORD_BOT_TOKEN=fake-token-${String(id)}`);
      }

      // Pool-60 was parked with a channel — its access.json should be cleared
      // because parked bots don't have live tmux sessions listening
      await save_pool_state([
        make_persisted_bot({ id: 60, state: "parked", channel_id: "ch-parked", entity_id: "e1", archetype: "planner" }),
      ], config);

      const pool = new TestBotPool(config);
      await pool.initialize();

      // Parked bot: channel preserved in memory but access.json cleared
      const bots = pool.get_bots();
      const bot60 = bots.find(b => b.id === 60)!;
      expect(bot60.state).toBe("parked");
      expect(bot60.channel_id).toBe("ch-parked"); // In-memory: preserved for resume

      const access60 = JSON.parse(await readFile(join(temp_dir, "channels", "pool-60", "access.json"), "utf-8")) as Record<string, unknown>;
      expect(access60.groups).toEqual({}); // On disk: cleared

      // Free bot: access.json also cleared
      const access61 = JSON.parse(await readFile(join(temp_dir, "channels", "pool-61", "access.json"), "utf-8")) as Record<string, unknown>;
      expect(access61.groups).toEqual({});
    });
  });

  describe("proactive resume on startup", () => {
    /** Helper: seed pool-state.json, create pool-N dirs, and initialize a fresh pool. */
    async function setup_resume_pool(
      persisted: PersistedPoolBot[],
      bot_ids: number[],
      registry_entities?: EntityConfig[],
    ): Promise<TestBotPool> {
      const cfg = make_config();
      await save_pool_state(persisted, cfg);

      for (const id of bot_ids) {
        const dir = join(temp_dir, "channels", `pool-${String(id)}`);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, ".env"), `DISCORD_BOT_TOKEN=fake-token-${String(id)}`, "utf-8");
      }

      const p = new TestBotPool(cfg);
      vi.spyOn(p as unknown as Record<string, unknown>, "is_tmux_alive" as never)
        .mockReturnValue(false);
      vi.spyOn(p as unknown as Record<string, unknown>, "kill_tmux" as never)
        .mockImplementation(() => {});
      vi.spyOn(p as unknown as Record<string, unknown>, "write_access_json" as never)
        .mockResolvedValue(undefined);
      vi.spyOn(p as unknown as Record<string, unknown>, "set_bot_nickname" as never)
        .mockResolvedValue(undefined);
      vi.spyOn(p as unknown as Record<string, unknown>, "set_bot_avatar" as never)
        .mockResolvedValue(undefined);
      vi.spyOn(p as unknown as Record<string, unknown>, "start_tmux" as never)
        .mockResolvedValue(undefined);

      const reg = registry_entities
        ? make_registry(registry_entities)
        : undefined;

      await p.initialize(reg);
      return p;
    }

    it("resumes bot saved as 'assigned' with session_id", async () => {
      const p = await setup_resume_pool(
        [
          make_persisted_bot({
            id: 1,
            state: "assigned",
            channel_id: "ch-1",
            entity_id: "test-entity",
            archetype: "builder",
            session_id: "sess-abc",
          }),
        ],
        [1],
        [make_entity_config("test-entity", ["ch-1"])],
      );

      // Should have one resume candidate
      expect(p.get_resume_candidates()).toHaveLength(1);

      // Track bot:resumed events
      const events: Array<{ bot_id: number; channel_id: string; entity_id: string }> = [];
      p.on("bot:resumed", (evt: { bot_id: number; channel_id: string; entity_id: string }) => events.push(evt));

      await p.resume_parked_bots();

      // Bot should now be assigned
      const bots = p.get_bots();
      const bot = bots.find(b => b.id === 1)!;
      expect(bot.state).toBe("assigned");
      expect(bot.channel_id).toBe("ch-1");
      expect(bot.entity_id).toBe("test-entity");

      // start_tmux called with --resume session_id
      const start_tmux_spy = p["start_tmux" as keyof typeof p] as unknown as { mock: { calls: unknown[][] } };
      const call = start_tmux_spy.mock.calls[0]!;
      expect(call[4]).toBe("sess-abc"); // resume_session_id argument

      // Event emitted
      expect(events).toHaveLength(1);
      expect(events[0]!.bot_id).toBe(1);
      expect(events[0]!.channel_id).toBe("ch-1");

      // Candidates cleared
      expect(p.get_resume_candidates()).toHaveLength(0);
    });

    it("does NOT resume bot saved as 'parked'", async () => {
      const p = await setup_resume_pool(
        [
          make_persisted_bot({
            id: 1,
            state: "parked",
            channel_id: "ch-1",
            entity_id: "test-entity",
            archetype: "builder",
            session_id: "sess-old",
          }),
        ],
        [1],
        [make_entity_config("test-entity", ["ch-1"])],
      );

      // No resume candidates — bot was already parked before shutdown
      expect(p.get_resume_candidates()).toHaveLength(0);

      const events: unknown[] = [];
      p.on("bot:resumed", (evt: unknown) => events.push(evt));

      await p.resume_parked_bots();

      // Bot stays parked
      const bots = p.get_bots();
      expect(bots[0]!.state).toBe("parked");

      // No events
      expect(events).toHaveLength(0);
    });

    it("does NOT resume bot saved as 'assigned' with null session_id", async () => {
      const p = await setup_resume_pool(
        [
          make_persisted_bot({
            id: 1,
            state: "assigned",
            channel_id: "ch-1",
            entity_id: "test-entity",
            archetype: "builder",
            session_id: null,
          }),
        ],
        [1],
        [make_entity_config("test-entity", ["ch-1"])],
      );

      // No resume candidates — can't --resume without a session_id
      expect(p.get_resume_candidates()).toHaveLength(0);

      await p.resume_parked_bots();

      // Bot stays parked (not proactively resumed)
      const bots = p.get_bots();
      expect(bots[0]!.state).toBe("parked");
    });

    it("resumes multiple candidates", async () => {
      const p = await setup_resume_pool(
        [
          make_persisted_bot({
            id: 1,
            state: "assigned",
            channel_id: "ch-1",
            entity_id: "entity-a",
            archetype: "builder",
            session_id: "sess-1",
          }),
          make_persisted_bot({
            id: 2,
            state: "assigned",
            channel_id: "ch-2",
            entity_id: "entity-b",
            archetype: "planner",
            session_id: "sess-2",
          }),
        ],
        [1, 2],
        [
          make_entity_config("entity-a", ["ch-1"]),
          make_entity_config("entity-b", ["ch-2"]),
        ],
      );

      expect(p.get_resume_candidates()).toHaveLength(2);

      const events: Array<{ bot_id: number; channel_id: string }> = [];
      p.on("bot:resumed", (evt: { bot_id: number; channel_id: string }) => events.push(evt));

      await p.resume_parked_bots();

      // Both bots should be assigned
      const bots = p.get_bots();
      expect(bots.find(b => b.id === 1)!.state).toBe("assigned");
      expect(bots.find(b => b.id === 2)!.state).toBe("assigned");

      // Two events emitted
      expect(events).toHaveLength(2);
      expect(events.map(e => e.bot_id).sort()).toEqual([1, 2]);
    });

    it("after resume, persist() reflects correct assigned state", async () => {
      const cfg = make_config();
      const p = await setup_resume_pool(
        [
          make_persisted_bot({
            id: 1,
            state: "assigned",
            channel_id: "ch-1",
            entity_id: "test-entity",
            archetype: "builder",
            session_id: "sess-abc",
          }),
        ],
        [1],
        [make_entity_config("test-entity", ["ch-1"])],
      );

      await p.resume_parked_bots();

      // Re-read persisted state from disk
      const saved = await load_pool_state(cfg);
      const bot_entry = saved.bots.find(b => b.id === 1);
      expect(bot_entry).toBeDefined();
      expect(bot_entry!.state).toBe("assigned");
      expect(bot_entry!.channel_id).toBe("ch-1");
      expect(bot_entry!.session_id).toBe("sess-abc");
    });

    it("bot:resumed event fires with correct metadata", async () => {
      const p = await setup_resume_pool(
        [
          make_persisted_bot({
            id: 3,
            state: "assigned",
            channel_id: "ch-work",
            entity_id: "ent-x",
            archetype: "designer",
            session_id: "sess-design",
            channel_type: "work_room",
          }),
        ],
        [3],
        [make_entity_config("ent-x", ["ch-work"])],
      );

      const events: Array<{ bot_id: number; channel_id: string; entity_id: string }> = [];
      p.on("bot:resumed", (evt: { bot_id: number; channel_id: string; entity_id: string }) => events.push(evt));

      await p.resume_parked_bots();

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        bot_id: 3,
        channel_id: "ch-work",
        entity_id: "ent-x",
      });
    });

    it("resume_candidates cleared after resume completes", async () => {
      const p = await setup_resume_pool(
        [
          make_persisted_bot({
            id: 1,
            state: "assigned",
            channel_id: "ch-1",
            entity_id: "test-entity",
            archetype: "builder",
            session_id: "sess-abc",
          }),
        ],
        [1],
        [make_entity_config("test-entity", ["ch-1"])],
      );

      expect(p.get_resume_candidates()).toHaveLength(1);

      await p.resume_parked_bots();

      expect(p.get_resume_candidates()).toHaveLength(0);

      // Calling again is a no-op
      const events: unknown[] = [];
      p.on("bot:resumed", (evt: unknown) => events.push(evt));
      await p.resume_parked_bots();
      expect(events).toHaveLength(0);
    });

    it("kills stale tmux and respawns when tmux survived daemon restart", async () => {
      // This is the core fix for #112: when the daemon restarts and the old tmux
      // session survives, the Claude process inside has a dead MCP connection.
      // The resume path must kill the old tmux and spawn fresh with --resume.
      const cfg = make_config();
      await save_pool_state([
        make_persisted_bot({
          id: 1,
          state: "assigned",
          channel_id: "ch-1",
          entity_id: "test-entity",
          archetype: "builder",
          session_id: "sess-stale",
        }),
      ], cfg);

      const dir = join(temp_dir, "channels", "pool-1");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, ".env"), "DISCORD_BOT_TOKEN=fake-token-1", "utf-8");

      const p = new TestBotPool(cfg);
      // tmux IS alive — the old session survived the restart
      vi.spyOn(p as unknown as Record<string, unknown>, "is_tmux_alive" as never)
        .mockReturnValue(true);
      const kill_spy = vi.spyOn(p as unknown as Record<string, unknown>, "kill_tmux" as never)
        .mockImplementation(() => {});
      vi.spyOn(p as unknown as Record<string, unknown>, "write_access_json" as never)
        .mockResolvedValue(undefined);
      vi.spyOn(p as unknown as Record<string, unknown>, "set_bot_nickname" as never)
        .mockResolvedValue(undefined);
      const start_spy = vi.spyOn(p as unknown as Record<string, unknown>, "start_tmux" as never)
        .mockResolvedValue(undefined);

      const reg = make_registry([
        make_entity_config("test-entity", ["ch-1"]),
      ]);
      await p.initialize(reg);

      // Bot is "assigned" because tmux is alive, but should be queued for resume
      const bots_before = p.get_bots();
      expect(bots_before[0]!.state).toBe("assigned");
      expect(p.get_resume_candidates()).toHaveLength(1);

      const events: Array<{ bot_id: number; channel_id: string; entity_id: string }> = [];
      p.on("bot:resumed", (evt: { bot_id: number; channel_id: string; entity_id: string }) => events.push(evt));

      await p.resume_parked_bots();

      // Old tmux was killed
      expect(kill_spy).toHaveBeenCalledWith("pool-1");

      // Fresh tmux was spawned with --resume session_id
      const start_calls = (start_spy as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      const resume_call = start_calls.find(c => c[4] === "sess-stale");
      expect(resume_call).toBeDefined();
      expect(resume_call![5]).toBe(true); // is_resume = true

      // Bot is still assigned with correct metadata
      const bots_after = p.get_bots();
      const bot = bots_after.find(b => b.id === 1)!;
      expect(bot.state).toBe("assigned");
      expect(bot.channel_id).toBe("ch-1");
      expect(bot.session_id).toBe("sess-stale");

      // assigned_at was reset (new process)
      expect(bot.assigned_at).not.toBeNull();
      const now = Date.now();
      expect(now - bot.assigned_at!.getTime()).toBeLessThan(5000);

      // Event emitted
      expect(events).toHaveLength(1);
      expect(events[0]!.bot_id).toBe(1);

      // Candidates cleared
      expect(p.get_resume_candidates()).toHaveLength(0);
    });

    it("handles gracefully when tmux is already dead by resume time", async () => {
      // Edge case: tmux was alive during initialize() but died before
      // resume_parked_bots() runs. kill_tmux is a no-op, spawn still works.
      const cfg = make_config();
      await save_pool_state([
        make_persisted_bot({
          id: 1,
          state: "assigned",
          channel_id: "ch-1",
          entity_id: "test-entity",
          archetype: "planner",
          session_id: "sess-died",
        }),
      ], cfg);

      const dir = join(temp_dir, "channels", "pool-1");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, ".env"), "DISCORD_BOT_TOKEN=fake-token-1", "utf-8");

      const p = new TestBotPool(cfg);
      // tmux alive during init, so bot gets "assigned" state
      const tmux_spy = vi.spyOn(p as unknown as Record<string, unknown>, "is_tmux_alive" as never)
        .mockReturnValue(true);
      vi.spyOn(p as unknown as Record<string, unknown>, "kill_tmux" as never)
        .mockImplementation(() => {});
      vi.spyOn(p as unknown as Record<string, unknown>, "write_access_json" as never)
        .mockResolvedValue(undefined);
      vi.spyOn(p as unknown as Record<string, unknown>, "set_bot_nickname" as never)
        .mockResolvedValue(undefined);
      vi.spyOn(p as unknown as Record<string, unknown>, "set_bot_avatar" as never)
        .mockResolvedValue(undefined);
      vi.spyOn(p as unknown as Record<string, unknown>, "start_tmux" as never)
        .mockResolvedValue(undefined);

      const reg = make_registry([
        make_entity_config("test-entity", ["ch-1"]),
      ]);
      await p.initialize(reg);

      expect(p.get_resume_candidates()).toHaveLength(1);

      // Simulate tmux dying between init and resume
      tmux_spy.mockReturnValue(false);

      // Should still succeed — kill_tmux is a no-op, start_tmux spawns fresh
      await p.resume_parked_bots();

      const bots = p.get_bots();
      expect(bots[0]!.state).toBe("assigned");
      expect(bots[0]!.session_id).toBe("sess-died");
    });

    it("existing assign-on-message flow still works for non-resumed parked bots", async () => {
      const p = await setup_resume_pool(
        [
          make_persisted_bot({
            id: 1,
            state: "parked",
            channel_id: "ch-1",
            entity_id: "test-entity",
            archetype: "planner",
            session_id: "sess-old",
          }),
        ],
        [1],
        [make_entity_config("test-entity", ["ch-1"])],
      );

      // Not a resume candidate
      expect(p.get_resume_candidates()).toHaveLength(0);

      // Simulate a message arriving — assign() should reclaim the parked bot
      const assignment = await p.assign("ch-1", "test-entity", "planner", undefined, "general");
      expect(assignment).not.toBeNull();
      expect(assignment!.bot_id).toBe(1);
      expect(assignment!.session_id).toBe("sess-old");

      // Bot is now assigned
      const bots = p.get_bots();
      expect(bots[0]!.state).toBe("assigned");
    });
  });
});
