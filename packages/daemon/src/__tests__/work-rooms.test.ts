import { describe, expect, it, beforeEach, vi } from "vitest";
import { EntityConfigSchema, LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type {
  LobsterFarmConfig,
  EntityConfig,
  ChannelMapping,
} from "@lobster-farm/shared";
import type { FeatureData } from "../actions.js";
import * as actions from "../actions.js";

// ── Helpers ──

// Fake snowflake IDs for testing. These pass the is_discord_snowflake check
// (17-20 digit numeric strings) so they exercise the same code paths as real IDs.
const GEN_ID = "10000000000000001";
const WR_IDS = ["10000000000000010", "10000000000000020", "10000000000000030"] as const;
const DYN_WR = "10000000000000040"; // Returned by mock create_channel for dynamic rooms
const AL_ID  = "10000000000000099";
const CAT_ID = "10000000000000100";

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    concurrency: { max_active_sessions: 2, max_queue_depth: 20 },
  });
}

function make_entity_config(channels: ChannelMapping[] = []): EntityConfig {
  return EntityConfigSchema.parse({
    entity: {
      id: "alpha",
      name: "Alpha Project",
      repos: [{ name: "alpha", url: "git@github.com:test/alpha.git", path: "/tmp/test-repo" }],
      channels: {
        category_id: CAT_ID,
        list: channels,
      },
      memory: { path: "/tmp/.memory" },
      secrets: { vault_name: "entity-alpha" },
    },
  });
}

function make_feature(overrides: Partial<FeatureData> = {}): FeatureData {
  return {
    id: "alpha-42",
    entity: "alpha",
    githubIssue: 42,
    title: "Test Feature",
    branch: "feature/42-test-feature",
    worktreePath: "/tmp/worktree",
    discordWorkRoom: null,
    activeArchetype: "builder",
    prNumber: null,
    ...overrides,
  };
}

/** Create channel list with N static work rooms (default 0 — dynamic-only).
 * Also includes general and alerts. Uses valid snowflake IDs. */
function make_static_work_rooms(count = 0): ChannelMapping[] {
  const channels: ChannelMapping[] = [
    { type: "general", id: GEN_ID },
  ];
  for (let i = 1; i <= count; i++) {
    channels.push({
      type: "work_room",
      id: WR_IDS[i - 1]!,
      purpose: `Work room ${String(i)}`,
    });
  }
  channels.push({ type: "alerts", id: AL_ID });
  return channels;
}

// ── Mock Discord Bot ──

function make_mock_discord() {
  return {
    send: vi.fn().mockResolvedValue(undefined),
    send_as_agent: vi.fn().mockResolvedValue(undefined),
    send_to_entity: vi.fn().mockResolvedValue(undefined),
    set_channel_topic: vi.fn().mockResolvedValue(undefined),
    create_channel: vi.fn().mockResolvedValue(DYN_WR),
    delete_channel: vi.fn().mockResolvedValue(true),
    build_channel_map: vi.fn(),
    is_connected: vi.fn().mockReturnValue(true),
  };
}

// ── Mock Bot Pool ──

/**
 * Create a mock pool where `assigned_channels` maps channel IDs to a pool bot stub.
 * Channels not in the map return undefined from get_assignment().
 */
function make_mock_pool(assigned_channels: Record<string, { id: number; archetype: string }> = {}) {
  return {
    get_assignment: vi.fn((channel_id: string) => {
      const entry = assigned_channels[channel_id];
      if (!entry) return undefined;
      return { id: entry.id, state: "assigned", channel_id, archetype: entry.archetype };
    }),
  };
}

// ── Tests ──

describe("Work Room Assignment", () => {
  let discord: ReturnType<typeof make_mock_discord>;

  beforeEach(() => {
    discord = make_mock_discord();
    // @ts-expect-error — mock does not implement full DiscordBot interface
    actions.set_discord_bot(discord);
    // Reset pool to null so tests without pool awareness are unaffected
    actions.set_pool(null);
  });

  describe("assign_work_room", () => {
    it("assigns a free static room when one is available", async () => {
      const feature = make_feature();
      const entity = make_entity_config(make_static_work_rooms(3));

      const room_id = await actions.assign_work_room(feature, entity);

      expect(room_id).toBe(WR_IDS[0]);
      // Verify assigned_feature was set on the channel entry
      const wr1 = entity.entity.channels.list.find(c => c.id === WR_IDS[0]);
      expect(wr1?.assigned_feature).toBe("alpha-42");
    });

    it("skips rooms occupied by active pool bot assignments", async () => {
      const feature = make_feature({ id: "alpha-42" });
      const entity = make_entity_config(make_static_work_rooms(3));
      // Pool has a bot assigned to wr-1
      // @ts-expect-error — mock pool
      actions.set_pool(make_mock_pool({ [WR_IDS[0]]: { id: 0, archetype: "builder" } }));

      const room_id = await actions.assign_work_room(feature, entity);

      expect(room_id).toBe(WR_IDS[1]);
    });

    it("skips rooms occupied by multiple pool bot assignments", async () => {
      const feature = make_feature({ id: "alpha-42" });
      const entity = make_entity_config(make_static_work_rooms(3));
      // Pool has bots in wr-1 and wr-2
      // @ts-expect-error — mock pool
      actions.set_pool(make_mock_pool({
        [WR_IDS[0]]: { id: 0, archetype: "builder" },
        [WR_IDS[1]]: { id: 1, archetype: "planner" },
      }));

      const room_id = await actions.assign_work_room(feature, entity);

      expect(room_id).toBe(WR_IDS[2]);
    });

    it("creates a dynamic room when all static rooms are pool-assigned", async () => {
      const feature = make_feature({ id: "alpha-42" });
      const entity = make_entity_config(make_static_work_rooms(3));
      // All three rooms have pool bots
      // @ts-expect-error — mock pool
      actions.set_pool(make_mock_pool({
        [WR_IDS[0]]: { id: 0, archetype: "planner" },
        [WR_IDS[1]]: { id: 1, archetype: "builder" },
        [WR_IDS[2]]: { id: 2, archetype: "planner" },
      }));

      const room_id = await actions.assign_work_room(feature, entity);

      expect(room_id).toBe(DYN_WR);
      expect(discord.create_channel).toHaveBeenCalledWith(
        CAT_ID,
        "work-room-4",
        "Overflow for alpha-42",
      );
    });

    it("tags dynamic room with dynamic: true in entity config", async () => {
      const feature = make_feature({ id: "alpha-42" });
      const entity = make_entity_config(make_static_work_rooms(3));
      // All rooms occupied by pool bots
      // @ts-expect-error — mock pool
      actions.set_pool(make_mock_pool({
        [WR_IDS[0]]: { id: 0, archetype: "builder" },
        [WR_IDS[1]]: { id: 1, archetype: "builder" },
        [WR_IDS[2]]: { id: 2, archetype: "builder" },
      }));

      await actions.assign_work_room(feature, entity);

      const dynamic_entry = entity.entity.channels.list.find(c => c.id === DYN_WR);
      expect(dynamic_entry).toBeDefined();
      expect(dynamic_entry?.dynamic).toBe(true);
      expect(dynamic_entry?.type).toBe("work_room");
      expect(dynamic_entry?.assigned_feature).toBe("alpha-42");
    });

    it("sets channel topic with title on assignment", async () => {
      const feature = make_feature();
      const entity = make_entity_config(make_static_work_rooms(3));

      await actions.assign_work_room(feature, entity);

      expect(discord.set_channel_topic).toHaveBeenCalledWith(
        WR_IDS[0],
        "\u{1F528} #42: Test Feature",
      );
    });

    it("truncates long title in channel topic on assignment", async () => {
      const long_title = "A".repeat(80);
      const feature = make_feature({ title: long_title });
      const entity = make_entity_config(make_static_work_rooms(3));

      await actions.assign_work_room(feature, entity);

      const expected_title = "A".repeat(57) + "...";
      expect(discord.set_channel_topic).toHaveBeenCalledWith(
        WR_IDS[0],
        `\u{1F528} #42: ${expected_title}`,
      );
    });

    it("rebuilds channel map after assignment", async () => {
      const feature = make_feature();
      const entity = make_entity_config(make_static_work_rooms(3));

      await actions.assign_work_room(feature, entity);

      expect(discord.build_channel_map).toHaveBeenCalled();
    });

    it("returns null when no discord bot is available for dynamic room creation", async () => {
      const feature = make_feature({ id: "alpha-42" });
      const entity = make_entity_config(make_static_work_rooms(3));
      // All rooms occupied by pool
      // @ts-expect-error — mock pool
      actions.set_pool(make_mock_pool({
        [WR_IDS[0]]: { id: 0, archetype: "planner" },
        [WR_IDS[1]]: { id: 1, archetype: "builder" },
        [WR_IDS[2]]: { id: 2, archetype: "planner" },
      }));
      actions.set_discord_bot(null);

      const room_id = await actions.assign_work_room(feature, entity);

      expect(room_id).toBeNull();
    });

    it("skips rooms with active pool bot assignments", async () => {
      const feature = make_feature({ id: "alpha-42" });
      const entity = make_entity_config(make_static_work_rooms(3));
      // Pool has a bot assigned to wr-1 (e.g., manual planner session)
      // @ts-expect-error — mock pool
      actions.set_pool(make_mock_pool({ [WR_IDS[0]]: { id: 0, archetype: "planner" } }));

      const room_id = await actions.assign_work_room(feature, entity);

      expect(room_id).toBe(WR_IDS[1]);
    });

    it("does not check non-work-room channels for pool assignments", async () => {
      const feature = make_feature({ id: "alpha-42" });
      const entity = make_entity_config(make_static_work_rooms(3));
      // Pool has a bot in the general channel — should not affect work room assignment
      const pool = make_mock_pool({ [GEN_ID]: { id: 0, archetype: "planner" } });
      // @ts-expect-error — mock pool
      actions.set_pool(pool);

      const room_id = await actions.assign_work_room(feature, entity);

      // Should still get wr-1 (general channel pool assignment is irrelevant)
      expect(room_id).toBe(WR_IDS[0]);
      // get_assignment should only have been called for work_room channels
      expect(pool.get_assignment).not.toHaveBeenCalledWith(GEN_ID);
    });

    it("does not block rooms when pool is null", async () => {
      const feature = make_feature({ id: "alpha-42" });
      const entity = make_entity_config(make_static_work_rooms(3));
      actions.set_pool(null);

      const room_id = await actions.assign_work_room(feature, entity);

      expect(room_id).toBe(WR_IDS[0]);
    });
  });

  describe("assign_work_room — 0 static rooms (dynamic-only)", () => {
    it("creates a dynamic room when no static rooms exist", async () => {
      const feature = make_feature({ id: "alpha-42" });
      const entity = make_entity_config(make_static_work_rooms(0));

      const room_id = await actions.assign_work_room(feature, entity);

      expect(room_id).toBe(DYN_WR);
      expect(discord.create_channel).toHaveBeenCalledWith(
        CAT_ID,
        "work-room-1",
        "Overflow for alpha-42",
      );
    });

    it("tags dynamic room with dynamic: true when no static rooms exist", async () => {
      const feature = make_feature({ id: "alpha-42" });
      const entity = make_entity_config(make_static_work_rooms(0));

      await actions.assign_work_room(feature, entity);

      const dynamic_entry = entity.entity.channels.list.find(c => c.id === DYN_WR);
      expect(dynamic_entry).toBeDefined();
      expect(dynamic_entry?.dynamic).toBe(true);
      expect(dynamic_entry?.type).toBe("work_room");
    });

    it("returns null when no discord bot and no static rooms", async () => {
      const feature = make_feature({ id: "alpha-42" });
      const entity = make_entity_config(make_static_work_rooms(0));
      actions.set_discord_bot(null);

      const room_id = await actions.assign_work_room(feature, entity);

      expect(room_id).toBeNull();
    });
  });

  describe("release_work_room", () => {
    it("resets static room topic to Available", async () => {
      const feature = make_feature({ discordWorkRoom: WR_IDS[0] });
      const channels = make_static_work_rooms(3);
      channels[1]!.assigned_feature = "alpha-42";
      const entity = make_entity_config(channels);

      await actions.release_work_room(feature, entity);

      expect(discord.set_channel_topic).toHaveBeenCalledWith(WR_IDS[0], "\u{1F7E2} Available");
    });

    it("clears assigned_feature on static room", async () => {
      const feature = make_feature({ discordWorkRoom: WR_IDS[0] });
      const channels = make_static_work_rooms(3);
      channels[1]!.assigned_feature = "alpha-42";
      const entity = make_entity_config(channels);

      await actions.release_work_room(feature, entity);

      const wr1 = entity.entity.channels.list.find(c => c.id === WR_IDS[0]);
      expect(wr1?.assigned_feature).toBeNull();
    });

    it("sends farewell message in static room", async () => {
      const feature = make_feature({ discordWorkRoom: WR_IDS[0] });
      const entity = make_entity_config(make_static_work_rooms(3));

      await actions.release_work_room(feature, entity);

      expect(discord.send).toHaveBeenCalledWith(
        WR_IDS[0],
        "Feature alpha-42 complete. This work room is now available.",
      );
    });

    it("deletes dynamic room", async () => {
      const feature = make_feature({ discordWorkRoom: DYN_WR });
      const channels = make_static_work_rooms(3);
      channels.push({
        type: "work_room",
        id: DYN_WR,
        purpose: "Dynamic workspace",
        assigned_feature: "alpha-42",
        dynamic: true,
      });
      const entity = make_entity_config(channels);

      await actions.release_work_room(feature, entity);

      expect(discord.delete_channel).toHaveBeenCalledWith(DYN_WR);
    });

    it("removes dynamic room from entity config", async () => {
      const feature = make_feature({ discordWorkRoom: DYN_WR });
      const channels = make_static_work_rooms(3);
      channels.push({
        type: "work_room",
        id: DYN_WR,
        purpose: "Dynamic workspace",
        assigned_feature: "alpha-42",
        dynamic: true,
      });
      const entity = make_entity_config(channels);

      await actions.release_work_room(feature, entity);

      const remaining = entity.entity.channels.list.find(c => c.id === DYN_WR);
      expect(remaining).toBeUndefined();
    });

    it("sends farewell message before deleting dynamic room", async () => {
      const feature = make_feature({ discordWorkRoom: DYN_WR });
      const channels = make_static_work_rooms(3);
      channels.push({
        type: "work_room",
        id: DYN_WR,
        dynamic: true,
        assigned_feature: "alpha-42",
      });
      const entity = make_entity_config(channels);

      await actions.release_work_room(feature, entity);

      // send should be called before delete_channel
      const send_order = discord.send.mock.invocationCallOrder[0];
      const delete_order = discord.delete_channel.mock.invocationCallOrder[0];
      expect(send_order).toBeLessThan(delete_order!);
    });

    it("rebuilds channel map after release", async () => {
      const feature = make_feature({ discordWorkRoom: WR_IDS[0] });
      const entity = make_entity_config(make_static_work_rooms(3));

      await actions.release_work_room(feature, entity);

      expect(discord.build_channel_map).toHaveBeenCalled();
    });

    it("is a no-op when feature has no work room", async () => {
      const feature = make_feature({ discordWorkRoom: null });
      const entity = make_entity_config(make_static_work_rooms(3));

      await actions.release_work_room(feature, entity);

      expect(discord.send).not.toHaveBeenCalled();
      expect(discord.set_channel_topic).not.toHaveBeenCalled();
      expect(discord.delete_channel).not.toHaveBeenCalled();
    });

    it("does not keep static room in list after release", async () => {
      const feature = make_feature({ discordWorkRoom: WR_IDS[1] });
      const entity = make_entity_config(make_static_work_rooms(3));

      await actions.release_work_room(feature, entity);

      // Static room should still be in the list
      const wr2 = entity.entity.channels.list.find(c => c.id === WR_IDS[1]);
      expect(wr2).toBeDefined();
      expect(wr2?.type).toBe("work_room");
    });
  });
});

describe("Channel Topic Updates", () => {
  let discord: ReturnType<typeof make_mock_discord>;

  beforeEach(() => {
    discord = make_mock_discord();
    // @ts-expect-error — mock does not implement full DiscordBot interface
    actions.set_discord_bot(discord);
  });

  describe("update_work_room_topic", () => {
    it("updates topic when work room is assigned", async () => {
      const feature = make_feature({ discordWorkRoom: WR_IDS[0] });

      await actions.update_work_room_topic(feature, "\u{1F7E3} alpha-42 \u2014 #42 \u2014 In Review");

      expect(discord.set_channel_topic).toHaveBeenCalledWith(
        WR_IDS[0],
        "\u{1F7E3} alpha-42 \u2014 #42 \u2014 In Review",
      );
    });

    it("is a no-op when no work room is assigned", async () => {
      const feature = make_feature({ discordWorkRoom: null });

      await actions.update_work_room_topic(feature, "some topic");

      expect(discord.set_channel_topic).not.toHaveBeenCalled();
    });

    it("is a no-op when no discord bot is available", async () => {
      actions.set_discord_bot(null);
      const feature = make_feature({ discordWorkRoom: WR_IDS[0] });

      await actions.update_work_room_topic(feature, "some topic");

      // No error thrown, function returns silently
    });
  });
});

describe("Startup Topic Reset", () => {
  let discord: ReturnType<typeof make_mock_discord>;

  beforeEach(() => {
    discord = make_mock_discord();
    // @ts-expect-error — mock does not implement full DiscordBot interface
    actions.set_discord_bot(discord);
    actions.set_pool(null);
  });

  it("resets all work rooms to Available when no pool assignments", async () => {
    const entity = make_entity_config(make_static_work_rooms(3));
    const registry = {
      get_active: vi.fn().mockReturnValue([entity]),
    };

    // @ts-expect-error — mock registry
    await actions.reset_idle_work_room_topics(registry);

    // All 3 work rooms should be reset
    expect(discord.set_channel_topic).toHaveBeenCalledWith(WR_IDS[0], "\u{1F7E2} Available");
    expect(discord.set_channel_topic).toHaveBeenCalledWith(WR_IDS[1], "\u{1F7E2} Available");
    expect(discord.set_channel_topic).toHaveBeenCalledWith(WR_IDS[2], "\u{1F7E2} Available");
    expect(discord.set_channel_topic).toHaveBeenCalledTimes(3);
  });

  it("preserves topic on work rooms with active pool assignments", async () => {
    const entity = make_entity_config(make_static_work_rooms(3));
    // Pool has a bot assigned to wr-1
    // @ts-expect-error — mock pool
    actions.set_pool(make_mock_pool({ [WR_IDS[0]]: { id: 0, archetype: "builder" } }));

    const registry = {
      get_active: vi.fn().mockReturnValue([entity]),
    };

    // @ts-expect-error — mock registry
    await actions.reset_idle_work_room_topics(registry);

    // wr-1 has an active pool assignment — should NOT be reset
    expect(discord.set_channel_topic).not.toHaveBeenCalledWith(WR_IDS[0], "\u{1F7E2} Available");
    // wr-2 and wr-3 should be reset
    expect(discord.set_channel_topic).toHaveBeenCalledWith(WR_IDS[1], "\u{1F7E2} Available");
    expect(discord.set_channel_topic).toHaveBeenCalledWith(WR_IDS[2], "\u{1F7E2} Available");
    expect(discord.set_channel_topic).toHaveBeenCalledTimes(2);
  });

  it("is a no-op when no discord bot is available", async () => {
    actions.set_discord_bot(null);

    const registry = {
      get_active: vi.fn().mockReturnValue([]),
    };

    // Should not throw
    // @ts-expect-error — mock registry
    await actions.reset_idle_work_room_topics(registry);

    expect(registry.get_active).not.toHaveBeenCalled();
  });

  it("only touches work_room channels, not general or alerts", async () => {
    const entity = make_entity_config(make_static_work_rooms(3));
    const registry = {
      get_active: vi.fn().mockReturnValue([entity]),
    };

    // @ts-expect-error — mock registry
    await actions.reset_idle_work_room_topics(registry);

    // Should not be called for gen-1 or al-1
    expect(discord.set_channel_topic).not.toHaveBeenCalledWith(GEN_ID, expect.anything());
    expect(discord.set_channel_topic).not.toHaveBeenCalledWith(AL_ID, expect.anything());
  });

  it("is a no-op with 0 static work rooms", async () => {
    const entity = make_entity_config(make_static_work_rooms(0));
    const registry = {
      get_active: vi.fn().mockReturnValue([entity]),
    };

    // @ts-expect-error — mock registry
    await actions.reset_idle_work_room_topics(registry);

    // No work rooms -> no topics to reset
    expect(discord.set_channel_topic).not.toHaveBeenCalled();
  });
});

describe("Schema — ChannelMapping", () => {
  it("accepts dynamic: true", () => {
    const entity = make_entity_config([
      { type: "work_room", id: WR_IDS[0], dynamic: true },
    ]);
    const wr = entity.entity.channels.list[0];
    expect(wr?.dynamic).toBe(true);
  });

  it("accepts dynamic: false", () => {
    const entity = make_entity_config([
      { type: "work_room", id: WR_IDS[0], dynamic: false },
    ]);
    const wr = entity.entity.channels.list[0];
    expect(wr?.dynamic).toBe(false);
  });

  it("defaults to undefined when dynamic is omitted", () => {
    const entity = make_entity_config([
      { type: "work_room", id: WR_IDS[0] },
    ]);
    const wr = entity.entity.channels.list[0];
    expect(wr?.dynamic).toBeUndefined();
  });
});
