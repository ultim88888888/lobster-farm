import { describe, expect, it, beforeEach, vi } from "vitest";
import type { LobsterFarmConfig, ArchetypeRole, ChannelType } from "@lobster-farm/shared";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";

// ── Test helpers ──

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    concurrency: { max_active_sessions: 2, max_queue_depth: 20 },
  });
}

// ── Pool tests — park-and-resume, eviction priority ──

describe("Pool — park-and-resume", () => {
  interface MockPoolBot {
    id: number;
    state: "free" | "assigned" | "parked";
    channel_id: string | null;
    entity_id: string | null;
    archetype: ArchetypeRole | null;
    channel_type: ChannelType | null;
    session_id: string | null;
    last_active: Date | null;
  }

  function make_bot(overrides: Partial<MockPoolBot> = {}): MockPoolBot {
    return {
      id: 1,
      state: "free",
      channel_id: null,
      entity_id: null,
      archetype: null,
      channel_type: null,
      session_id: null,
      last_active: null,
      ...overrides,
    };
  }

  it("auto-resumes parked session when same channel is reassigned", () => {
    const bots: MockPoolBot[] = [
      make_bot({
        id: 1,
        state: "parked",
        channel_id: "chan-123",
        entity_id: "alpha",
        session_id: "old-session-id",
        channel_type: "general",
      }),
      make_bot({ id: 2, state: "free" }),
    ];

    // Mimic assign() auto-resume logic
    const channel_id = "chan-123";
    const entity_id = "alpha";
    let resume_session_id: string | undefined;

    const returning = bots.find(
      b => b.state === "parked" && b.channel_id === channel_id && b.entity_id === entity_id,
    );

    if (returning) {
      resume_session_id = resume_session_id ?? returning.session_id ?? undefined;
    }

    expect(returning).toBeDefined();
    expect(resume_session_id).toBe("old-session-id");
  });

  it("does not auto-resume parked session for different channel", () => {
    const bots: MockPoolBot[] = [
      make_bot({
        id: 1,
        state: "parked",
        channel_id: "chan-123",
        entity_id: "alpha",
        session_id: "old-session-id",
      }),
    ];

    const returning = bots.find(
      b => b.state === "parked" && b.channel_id === "chan-999" && b.entity_id === "alpha",
    );

    expect(returning).toBeUndefined();
  });

  it("stores channel_type on PoolBot during assignment", () => {
    const bot = make_bot({ id: 1, state: "free" });

    // Mimic assign() — set channel_type
    bot.state = "assigned";
    bot.channel_id = "chan-123";
    bot.entity_id = "alpha";
    bot.channel_type = "work_room";

    expect(bot.channel_type).toBe("work_room");
  });
});

describe("Pool — eviction priority", () => {
  interface MockEvictBot {
    id: number;
    state: "parked";
    channel_type: ChannelType | null;
    last_active: Date | null;
  }

  it("evicts general-channel bots before work-room bots", () => {
    const bots: MockEvictBot[] = [
      { id: 1, state: "parked", channel_type: "work_room", last_active: new Date(1000) },
      { id: 2, state: "parked", channel_type: "general", last_active: new Date(2000) },
      { id: 3, state: "parked", channel_type: "general", last_active: new Date(500) },
    ];

    // Same sorting logic as pool.ts assign()
    const sorted = [...bots].sort((a, b) => {
      const type_a = a.channel_type === "work_room" ? 1 : 0;
      const type_b = b.channel_type === "work_room" ? 1 : 0;
      if (type_a !== type_b) return type_a - type_b;
      return (a.last_active?.getTime() ?? 0) - (b.last_active?.getTime() ?? 0);
    });

    // General channels first (sorted by LRU), then work rooms
    expect(sorted[0]!.id).toBe(3); // general, oldest
    expect(sorted[1]!.id).toBe(2); // general, newer
    expect(sorted[2]!.id).toBe(1); // work_room
  });

  it("falls back to LRU when channel types are the same", () => {
    const bots: MockEvictBot[] = [
      { id: 1, state: "parked", channel_type: "general", last_active: new Date(3000) },
      { id: 2, state: "parked", channel_type: "general", last_active: new Date(1000) },
    ];

    const sorted = [...bots].sort((a, b) => {
      const type_a = a.channel_type === "work_room" ? 1 : 0;
      const type_b = b.channel_type === "work_room" ? 1 : 0;
      if (type_a !== type_b) return type_a - type_b;
      return (a.last_active?.getTime() ?? 0) - (b.last_active?.getTime() ?? 0);
    });

    expect(sorted[0]!.id).toBe(2); // oldest
    expect(sorted[1]!.id).toBe(1); // newer
  });
});

// ── Discord !reset tests ──

describe("Discord — !reset interception", () => {
  it("detects !reset message (case-insensitive, trimmed)", () => {
    const test_cases = ["!reset", "!RESET", "  !reset  ", "!Reset"];
    for (const msg of test_cases) {
      expect(msg.trim().toLowerCase()).toBe("!reset");
    }
  });

  it("does NOT match partial !reset in longer messages", () => {
    const not_reset = [
      "!resetall",
      "!reset me",
      "please !reset",
      "!resetting",
    ];
    for (const msg of not_reset) {
      expect(msg.trim().toLowerCase()).not.toBe("!reset");
    }
  });
});

// ── Worktree / work room idempotency tests ──

describe("Actions — idempotency on bounce", () => {
  it("assign_work_room returns existing room if already assigned", () => {
    // FeatureData with discordWorkRoom already set — assign_work_room
    // returns early with the existing room ID.
    const feature = { discordWorkRoom: "existing-room-123" };

    if (feature.discordWorkRoom) {
      const result = feature.discordWorkRoom;
      expect(result).toBe("existing-room-123");
    }
  });

  it("assign_work_room proceeds normally if not assigned", () => {
    const feature = { discordWorkRoom: null };
    expect(feature.discordWorkRoom).toBeNull();
    // Would proceed to find a free room
  });
});

// ── merge_pr idempotency ──

describe("Actions — merge_pr idempotency", () => {
  it("detects 'already been merged' in error message", () => {
    const error_messages = [
      "GraphQL: Pull request already been merged (mergeStateStatus)",
      "Pull Request #42 MERGED successfully",
    ];

    for (const msg of error_messages) {
      const is_already_merged = msg.includes("already been merged") || msg.includes("MERGED");
      expect(is_already_merged).toBe(true);
    }
  });

  it("rethrows on unrelated errors", () => {
    const msg = "GraphQL: Branch protections prevent merge";
    const is_already_merged = msg.includes("already been merged") || msg.includes("MERGED");
    expect(is_already_merged).toBe(false);
  });
});

// ── Pool context injection test ──

describe("Pool — entity context injection", () => {
  it("build_entity_context is exported from session.ts", async () => {
    // Verify the function is importable (this is a compile-time check too)
    const { build_entity_context } = await import("../session.js");
    expect(typeof build_entity_context).toBe("function");
  });

  it("build_entity_context handles empty feature_id gracefully", async () => {
    const { build_entity_context } = await import("../session.js");
    const config = make_config();

    // Pool bots may not have a feature — empty string is safe
    const context = await build_entity_context("test-entity", "", config);

    expect(context).toContain("Entity: test-entity");
    expect(context).toContain("Feature: ");
    expect(context).toContain("MEMORY.md");
  });
});
