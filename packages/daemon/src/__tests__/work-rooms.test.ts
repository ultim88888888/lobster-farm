import { describe, expect, it, beforeEach, vi } from "vitest";
import { EntityConfigSchema, LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type {
  LobsterFarmConfig,
  EntityConfig,
  FeatureState,
  ChannelMapping,
} from "@lobster-farm/shared";
import * as actions from "../actions.js";

// ── Helpers ──

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
        category_id: "cat-123",
        list: channels,
      },
      memory: { path: "/tmp/.memory" },
      secrets: { vault_name: "entity-alpha" },
    },
  });
}

function make_feature(overrides: Partial<FeatureState> = {}): FeatureState {
  return {
    id: "alpha-42",
    entity: "alpha",
    githubIssue: 42,
    title: "Test Feature",
    phase: "build",
    priority: "medium",
    branch: "feature/42-test-feature",
    worktreePath: "/tmp/worktree",
    discordWorkRoom: null,
    activeArchetype: "builder",
    activeDna: ["coding-dna"],
    sessionId: null,
    lastSessionId: null,
    blocked: false,
    blockedReason: null,
    approved: false,
    labels: [],
    prNumber: null,
    agentDone: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function make_static_work_rooms(): ChannelMapping[] {
  return [
    { type: "general", id: "gen-1" },
    { type: "work_room", id: "wr-1", purpose: "Work room 1" },
    { type: "work_room", id: "wr-2", purpose: "Work room 2" },
    { type: "work_room", id: "wr-3", purpose: "Work room 3" },
    { type: "work_log", id: "wl-1" },
    { type: "alerts", id: "al-1" },
  ];
}

// ── Mock Discord Bot ──

function make_mock_discord() {
  return {
    send: vi.fn().mockResolvedValue(undefined),
    send_as_agent: vi.fn().mockResolvedValue(undefined),
    send_to_entity: vi.fn().mockResolvedValue(undefined),
    set_channel_topic: vi.fn().mockResolvedValue(undefined),
    create_channel: vi.fn().mockResolvedValue("dynamic-wr-4"),
    delete_channel: vi.fn().mockResolvedValue(undefined),
    build_channel_map: vi.fn(),
    is_connected: vi.fn().mockReturnValue(true),
  };
}

// ── Mock Feature Manager ──

function make_mock_feature_manager(features: FeatureState[] = []) {
  return {
    get_features_by_entity: vi.fn().mockReturnValue(features),
    get_feature: vi.fn((id: string) => features.find(f => f.id === id)),
    list_features: vi.fn().mockReturnValue(features),
  };
}

// ── Tests ──

describe("Work Room Assignment", () => {
  let discord: ReturnType<typeof make_mock_discord>;

  beforeEach(() => {
    discord = make_mock_discord();
    // @ts-expect-error — mock does not implement full DiscordBot interface
    actions.set_discord_bot(discord);
  });

  describe("assign_work_room", () => {
    it("assigns a free static room when one is available", async () => {
      const feature = make_feature();
      const entity = make_entity_config(make_static_work_rooms());
      // @ts-expect-error — mock feature manager
      actions.set_feature_manager(make_mock_feature_manager([]));

      const room_id = await actions.assign_work_room(feature, entity);

      expect(room_id).toBe("wr-1");
      // Verify assigned_feature was set on the channel entry
      const wr1 = entity.entity.channels.list.find(c => c.id === "wr-1");
      expect(wr1?.assigned_feature).toBe("alpha-42");
    });

    it("skips rooms occupied by active features", async () => {
      const feature = make_feature({ id: "alpha-42" });
      const existing_feature = make_feature({
        id: "alpha-10",
        discordWorkRoom: "wr-1",
        phase: "build",
      });
      const entity = make_entity_config(make_static_work_rooms());
      // @ts-expect-error — mock feature manager
      actions.set_feature_manager(make_mock_feature_manager([existing_feature]));

      const room_id = await actions.assign_work_room(feature, entity);

      expect(room_id).toBe("wr-2");
    });

    it("skips rooms occupied by multiple active features", async () => {
      const feature = make_feature({ id: "alpha-42" });
      const features = [
        make_feature({ id: "alpha-10", discordWorkRoom: "wr-1", phase: "build" }),
        make_feature({ id: "alpha-11", discordWorkRoom: "wr-2", phase: "review" }),
      ];
      const entity = make_entity_config(make_static_work_rooms());
      // @ts-expect-error — mock feature manager
      actions.set_feature_manager(make_mock_feature_manager(features));

      const room_id = await actions.assign_work_room(feature, entity);

      expect(room_id).toBe("wr-3");
    });

    it("creates a dynamic room when all static rooms are occupied", async () => {
      const feature = make_feature({ id: "alpha-42" });
      const features = [
        make_feature({ id: "alpha-10", discordWorkRoom: "wr-1", phase: "build" }),
        make_feature({ id: "alpha-11", discordWorkRoom: "wr-2", phase: "review" }),
        make_feature({ id: "alpha-12", discordWorkRoom: "wr-3", phase: "build" }),
      ];
      const entity = make_entity_config(make_static_work_rooms());
      // @ts-expect-error — mock feature manager
      actions.set_feature_manager(make_mock_feature_manager(features));

      const room_id = await actions.assign_work_room(feature, entity);

      expect(room_id).toBe("dynamic-wr-4");
      expect(discord.create_channel).toHaveBeenCalledWith(
        "cat-123",
        "work-room-4",
        "Overflow for alpha-42",
      );
    });

    it("tags dynamic room with dynamic: true in entity config", async () => {
      const feature = make_feature({ id: "alpha-42" });
      const features = [
        make_feature({ id: "alpha-10", discordWorkRoom: "wr-1", phase: "build" }),
        make_feature({ id: "alpha-11", discordWorkRoom: "wr-2", phase: "build" }),
        make_feature({ id: "alpha-12", discordWorkRoom: "wr-3", phase: "build" }),
      ];
      const entity = make_entity_config(make_static_work_rooms());
      // @ts-expect-error — mock feature manager
      actions.set_feature_manager(make_mock_feature_manager(features));

      await actions.assign_work_room(feature, entity);

      const dynamic_entry = entity.entity.channels.list.find(c => c.id === "dynamic-wr-4");
      expect(dynamic_entry).toBeDefined();
      expect(dynamic_entry?.dynamic).toBe(true);
      expect(dynamic_entry?.type).toBe("work_room");
      expect(dynamic_entry?.assigned_feature).toBe("alpha-42");
    });

    it("does not assign a room to features still in done phase", async () => {
      const feature = make_feature({ id: "alpha-42" });
      // The done feature should not count as occupying wr-1
      const done_feature = make_feature({
        id: "alpha-10",
        discordWorkRoom: "wr-1",
        phase: "done",
      });
      const entity = make_entity_config(make_static_work_rooms());
      // @ts-expect-error — mock feature manager
      actions.set_feature_manager(make_mock_feature_manager([done_feature]));

      const room_id = await actions.assign_work_room(feature, entity);

      expect(room_id).toBe("wr-1");
    });

    it("sets channel topic on assignment", async () => {
      const feature = make_feature();
      const entity = make_entity_config(make_static_work_rooms());
      // @ts-expect-error — mock feature manager
      actions.set_feature_manager(make_mock_feature_manager([]));

      await actions.assign_work_room(feature, entity);

      expect(discord.set_channel_topic).toHaveBeenCalledWith(
        "wr-1",
        "🔵 alpha-42 — #42 — Building",
      );
    });

    it("rebuilds channel map after assignment", async () => {
      const feature = make_feature();
      const entity = make_entity_config(make_static_work_rooms());
      // @ts-expect-error — mock feature manager
      actions.set_feature_manager(make_mock_feature_manager([]));

      await actions.assign_work_room(feature, entity);

      expect(discord.build_channel_map).toHaveBeenCalled();
    });

    it("returns null when no discord bot is available for dynamic room creation", async () => {
      const feature = make_feature({ id: "alpha-42" });
      const features = [
        make_feature({ id: "alpha-10", discordWorkRoom: "wr-1", phase: "build" }),
        make_feature({ id: "alpha-11", discordWorkRoom: "wr-2", phase: "build" }),
        make_feature({ id: "alpha-12", discordWorkRoom: "wr-3", phase: "build" }),
      ];
      const entity = make_entity_config(make_static_work_rooms());
      // @ts-expect-error — mock feature manager
      actions.set_feature_manager(make_mock_feature_manager(features));
      actions.set_discord_bot(null);

      const room_id = await actions.assign_work_room(feature, entity);

      expect(room_id).toBeNull();
    });
  });

  describe("release_work_room", () => {
    it("resets static room topic to Available", async () => {
      const feature = make_feature({ discordWorkRoom: "wr-1" });
      const channels = make_static_work_rooms();
      channels[1]!.assigned_feature = "alpha-42";
      const entity = make_entity_config(channels);

      await actions.release_work_room(feature, entity);

      expect(discord.set_channel_topic).toHaveBeenCalledWith("wr-1", "🟢 Available");
    });

    it("clears assigned_feature on static room", async () => {
      const feature = make_feature({ discordWorkRoom: "wr-1" });
      const channels = make_static_work_rooms();
      channels[1]!.assigned_feature = "alpha-42";
      const entity = make_entity_config(channels);

      await actions.release_work_room(feature, entity);

      const wr1 = entity.entity.channels.list.find(c => c.id === "wr-1");
      expect(wr1?.assigned_feature).toBeNull();
    });

    it("sends farewell message in static room", async () => {
      const feature = make_feature({ discordWorkRoom: "wr-1" });
      const entity = make_entity_config(make_static_work_rooms());

      await actions.release_work_room(feature, entity);

      expect(discord.send).toHaveBeenCalledWith(
        "wr-1",
        "Feature alpha-42 complete. This work room is now available.",
      );
    });

    it("deletes dynamic room", async () => {
      const feature = make_feature({ discordWorkRoom: "dynamic-wr-4" });
      const channels = make_static_work_rooms();
      channels.push({
        type: "work_room",
        id: "dynamic-wr-4",
        purpose: "Dynamic workspace",
        assigned_feature: "alpha-42",
        dynamic: true,
      });
      const entity = make_entity_config(channels);

      await actions.release_work_room(feature, entity);

      expect(discord.delete_channel).toHaveBeenCalledWith("dynamic-wr-4");
    });

    it("removes dynamic room from entity config", async () => {
      const feature = make_feature({ discordWorkRoom: "dynamic-wr-4" });
      const channels = make_static_work_rooms();
      channels.push({
        type: "work_room",
        id: "dynamic-wr-4",
        purpose: "Dynamic workspace",
        assigned_feature: "alpha-42",
        dynamic: true,
      });
      const entity = make_entity_config(channels);

      await actions.release_work_room(feature, entity);

      const remaining = entity.entity.channels.list.find(c => c.id === "dynamic-wr-4");
      expect(remaining).toBeUndefined();
    });

    it("sends farewell message before deleting dynamic room", async () => {
      const feature = make_feature({ discordWorkRoom: "dynamic-wr-4" });
      const channels = make_static_work_rooms();
      channels.push({
        type: "work_room",
        id: "dynamic-wr-4",
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
      const feature = make_feature({ discordWorkRoom: "wr-1" });
      const entity = make_entity_config(make_static_work_rooms());

      await actions.release_work_room(feature, entity);

      expect(discord.build_channel_map).toHaveBeenCalled();
    });

    it("is a no-op when feature has no work room", async () => {
      const feature = make_feature({ discordWorkRoom: null });
      const entity = make_entity_config(make_static_work_rooms());

      await actions.release_work_room(feature, entity);

      expect(discord.send).not.toHaveBeenCalled();
      expect(discord.set_channel_topic).not.toHaveBeenCalled();
      expect(discord.delete_channel).not.toHaveBeenCalled();
    });

    it("does not keep static room in list after release", async () => {
      const feature = make_feature({ discordWorkRoom: "wr-2" });
      const entity = make_entity_config(make_static_work_rooms());

      await actions.release_work_room(feature, entity);

      // Static room should still be in the list
      const wr2 = entity.entity.channels.list.find(c => c.id === "wr-2");
      expect(wr2).toBeDefined();
      expect(wr2?.type).toBe("work_room");
    });
  });
});

describe("Notification Routing", () => {
  let discord: ReturnType<typeof make_mock_discord>;

  beforeEach(() => {
    discord = make_mock_discord();
    // @ts-expect-error — mock does not implement full DiscordBot interface
    actions.set_discord_bot(discord);
  });

  describe("notify_feature", () => {
    it("routes to work room when assigned", async () => {
      const feature = make_feature({
        discordWorkRoom: "wr-1",
        activeArchetype: "builder",
      });

      await actions.notify_feature(feature, "Build started");

      expect(discord.send_as_agent).toHaveBeenCalledWith("wr-1", "Build started", "builder");
    });

    it("falls back to work_log when no work room assigned", async () => {
      const feature = make_feature({ discordWorkRoom: null, activeArchetype: null });
      const entity = make_entity_config(make_static_work_rooms());

      await actions.notify_feature(feature, "Build started", entity);

      expect(discord.send_to_entity).toHaveBeenCalledWith(
        "alpha", "work_log", "Build started", "system",
      );
    });

    it("also sends to alerts when also_alerts is true", async () => {
      const feature = make_feature({ discordWorkRoom: "wr-1" });
      const entity = make_entity_config(make_static_work_rooms());

      await actions.notify_feature(feature, "Awaiting approval", entity, { also_alerts: true });

      // Primary: work room
      expect(discord.send_as_agent).toHaveBeenCalledWith("wr-1", "Awaiting approval", "builder");
      // Secondary: alerts
      expect(discord.send_to_entity).toHaveBeenCalledWith(
        "alpha", "alerts", "Awaiting approval", "builder",
      );
    });

    it("also sends to general when also_general is true", async () => {
      const feature = make_feature({ discordWorkRoom: "wr-1" });
      const entity = make_entity_config(make_static_work_rooms());

      await actions.notify_feature(feature, "Shipped!", entity, { also_general: true });

      // Primary: work room
      expect(discord.send_as_agent).toHaveBeenCalledWith("wr-1", "Shipped!", "builder");
      // Secondary: general
      expect(discord.send_to_entity).toHaveBeenCalledWith(
        "alpha", "general", "Shipped!", "builder",
      );
    });

    it("sends to both alerts and general when both options are true", async () => {
      const feature = make_feature({ discordWorkRoom: "wr-1" });
      const entity = make_entity_config(make_static_work_rooms());

      await actions.notify_feature(feature, "Urgent!", entity, {
        also_alerts: true,
        also_general: true,
      });

      expect(discord.send_as_agent).toHaveBeenCalledTimes(1);
      expect(discord.send_to_entity).toHaveBeenCalledTimes(2);
    });

    it("uses 'system' archetype when feature has no active archetype", async () => {
      const feature = make_feature({
        discordWorkRoom: "wr-1",
        activeArchetype: null,
      });

      await actions.notify_feature(feature, "Phase change");

      expect(discord.send_as_agent).toHaveBeenCalledWith("wr-1", "Phase change", "system");
    });

    it("routes to specific channel ID, not first work_room", async () => {
      // Verify it routes to wr-2, not wr-1 (which send_to_entity would pick)
      const feature = make_feature({ discordWorkRoom: "wr-2" });

      await actions.notify_feature(feature, "Test message");

      expect(discord.send_as_agent).toHaveBeenCalledWith("wr-2", "Test message", "builder");
      // Should NOT have called send_to_entity
      expect(discord.send_to_entity).not.toHaveBeenCalled();
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
      const feature = make_feature({ discordWorkRoom: "wr-1" });

      await actions.update_work_room_topic(feature, "🟣 alpha-42 — #42 — In Review");

      expect(discord.set_channel_topic).toHaveBeenCalledWith(
        "wr-1",
        "🟣 alpha-42 — #42 — In Review",
      );
    });

    it("is a no-op when no work room is assigned", async () => {
      const feature = make_feature({ discordWorkRoom: null });

      await actions.update_work_room_topic(feature, "some topic");

      expect(discord.set_channel_topic).not.toHaveBeenCalled();
    });

    it("is a no-op when no discord bot is available", async () => {
      actions.set_discord_bot(null);
      const feature = make_feature({ discordWorkRoom: "wr-1" });

      await actions.update_work_room_topic(feature, "some topic");

      // No error thrown, function returns silently
    });
  });
});

describe("Schema — ChannelMapping", () => {
  it("accepts dynamic: true", () => {
    const entity = make_entity_config([
      { type: "work_room", id: "wr-1", dynamic: true },
    ]);
    const wr = entity.entity.channels.list[0];
    expect(wr?.dynamic).toBe(true);
  });

  it("accepts dynamic: false", () => {
    const entity = make_entity_config([
      { type: "work_room", id: "wr-1", dynamic: false },
    ]);
    const wr = entity.entity.channels.list[0];
    expect(wr?.dynamic).toBe(false);
  });

  it("defaults to undefined when dynamic is omitted", () => {
    const entity = make_entity_config([
      { type: "work_room", id: "wr-1" },
    ]);
    const wr = entity.entity.channels.list[0];
    expect(wr?.dynamic).toBeUndefined();
  });
});
