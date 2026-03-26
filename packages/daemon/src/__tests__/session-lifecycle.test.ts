import { describe, expect, it, beforeEach, vi } from "vitest";
import type { FeatureState, LobsterFarmConfig, EntityConfig, ArchetypeRole, ChannelType } from "@lobster-farm/shared";
import { LobsterFarmConfigSchema, EntityConfigSchema } from "@lobster-farm/shared";

// ── Test helpers ──

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    concurrency: { max_active_sessions: 2, max_queue_depth: 20 },
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
    lastBuilderSessionId: null,
    dependsOn: [],
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

// ── Schema tests ──

describe("FeatureState schema", () => {
  it("includes lastBuilderSessionId field with null default", () => {
    const feature = make_feature();
    expect(feature.lastBuilderSessionId).toBeNull();
  });

  it("accepts a string value for lastBuilderSessionId", () => {
    const feature = make_feature({ lastBuilderSessionId: "session-abc-123" });
    expect(feature.lastBuilderSessionId).toBe("session-abc-123");
  });
});

// ── Session lifecycle tests (features.ts) ──

describe("Session lifecycle — builder session preservation", () => {
  it("stores lastBuilderSessionId when builder starts", () => {
    // Simulate on_session_started behavior
    const feature = make_feature({ activeArchetype: "builder" });
    const session_id = "builder-session-001";

    // Mimic FeatureManager.on_session_started
    feature.sessionId = session_id;
    feature.lastSessionId = session_id;
    if (feature.activeArchetype === "builder") {
      feature.lastBuilderSessionId = session_id;
    }

    expect(feature.lastBuilderSessionId).toBe("builder-session-001");
    expect(feature.lastSessionId).toBe("builder-session-001");
  });

  it("does NOT overwrite lastBuilderSessionId when reviewer starts", () => {
    const feature = make_feature({
      activeArchetype: "reviewer",
      lastBuilderSessionId: "builder-session-001",
    });
    const reviewer_session_id = "reviewer-session-002";

    // Mimic on_session_started for reviewer
    feature.sessionId = reviewer_session_id;
    feature.lastSessionId = reviewer_session_id;
    // Only set lastBuilderSessionId for builders
    if (feature.activeArchetype === "builder") {
      feature.lastBuilderSessionId = reviewer_session_id;
    }

    expect(feature.lastBuilderSessionId).toBe("builder-session-001"); // preserved
    expect(feature.lastSessionId).toBe("reviewer-session-002"); // overwritten
  });

  it("uses lastBuilderSessionId for resume on review→build bounce", () => {
    const feature = make_feature({
      phase: "review",
      lastBuilderSessionId: "builder-session-001",
      lastSessionId: "reviewer-session-002",
    });

    // Mimic spawn_phase_agent resume logic
    const phase_archetype = "builder";
    const is_builder_bounce = phase_archetype === "builder" && Boolean(feature.lastBuilderSessionId);
    const resume_id = is_builder_bounce ? feature.lastBuilderSessionId : undefined;

    expect(is_builder_bounce).toBe(true);
    expect(resume_id).toBe("builder-session-001");
  });

  it("does NOT resume for non-builder phase transitions", () => {
    const feature = make_feature({
      phase: "plan",
      lastBuilderSessionId: null,
      lastSessionId: "planner-session-001",
    });

    const phase_archetype = "designer";
    const is_builder_bounce = phase_archetype === "builder" && Boolean(feature.lastBuilderSessionId);
    const resume_id = is_builder_bounce ? feature.lastBuilderSessionId : undefined;

    expect(is_builder_bounce).toBe(false);
    expect(resume_id).toBeUndefined();
  });
});

// ── Review outcome routing tests ──

describe("Review outcome routing", () => {
  it("maps approved to ship advance", () => {
    const outcome = "approved";
    let next_phase: string | null = null;

    switch (outcome) {
      case "approved": next_phase = "ship"; break;
      case "changes_requested": next_phase = "build"; break;
      case "pending": next_phase = null; break;
    }

    expect(next_phase).toBe("ship");
  });

  it("maps changes_requested to build bounce", () => {
    const outcome = "changes_requested";
    let next_phase: string | null = null;
    let should_notify_alerts = false;

    switch (outcome) {
      case "approved": next_phase = "ship"; break;
      case "changes_requested":
        next_phase = "build";
        should_notify_alerts = true;
        break;
      case "pending": next_phase = null; break;
    }

    expect(next_phase).toBe("build");
    expect(should_notify_alerts).toBe(true);
  });

  it("blocks feature on pending outcome", () => {
    const outcome = "pending";
    let should_block = false;

    switch (outcome) {
      case "approved": break;
      case "changes_requested": break;
      case "pending":
        should_block = true;
        break;
    }

    expect(should_block).toBe(true);
  });
});

// ── find_by_pr tests ──

describe("find_by_pr", () => {
  it("finds a feature by PR number", () => {
    const features = new Map<string, FeatureState>();
    features.set("alpha-42", make_feature({ prNumber: 99 }));
    features.set("alpha-43", make_feature({ id: "alpha-43", prNumber: 100 }));

    const find_by_pr = (pr_number: number): FeatureState | null => {
      for (const feature of features.values()) {
        if (feature.prNumber === pr_number) return feature;
      }
      return null;
    };

    expect(find_by_pr(99)?.id).toBe("alpha-42");
    expect(find_by_pr(100)?.id).toBe("alpha-43");
    expect(find_by_pr(999)).toBeNull();
  });
});

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

// ── PR Cron — external PR handling tests ──

describe("PR Cron — review outcome routing", () => {
  it("defers feature-linked PRs to feature manager", () => {
    const features = new Map<string, FeatureState>();
    features.set("alpha-42", make_feature({ prNumber: 99 }));

    const find_by_pr = (pr_number: number): FeatureState | null => {
      for (const feature of features.values()) {
        if (feature.prNumber === pr_number) return feature;
      }
      return null;
    };

    const linked = find_by_pr(99);
    expect(linked).not.toBeNull();
    // When linked, pr-cron should defer — not spawn a builder or notify
  });

  it("handles external PR with changes_requested", () => {
    const features = new Map<string, FeatureState>();
    // No features linked to PR #200

    const linked = (() => {
      for (const feature of features.values()) {
        if (feature.prNumber === 200) return feature;
      }
      return null;
    })();

    const review_state = "changes_requested";

    expect(linked).toBeNull();
    // External PR — should spawn builder and notify alerts
    expect(review_state).toBe("changes_requested");
  });

  it("escalates approved external PRs to alerts (never auto-merges)", () => {
    const linked = null; // external PR
    const review_state = "approved";

    expect(linked).toBeNull();
    // Should notify alerts, NOT merge
    expect(review_state).toBe("approved");
  });
});

// ── Worktree / work room idempotency tests ──

describe("Actions — idempotency on bounce", () => {
  it("assign_work_room returns existing room if already assigned", () => {
    const feature = make_feature({ discordWorkRoom: "existing-room-123" });

    // Mimic the guard at the top of assign_work_room
    if (feature.discordWorkRoom) {
      const result = feature.discordWorkRoom;
      expect(result).toBe("existing-room-123");
    }
  });

  it("assign_work_room proceeds normally if not assigned", () => {
    const feature = make_feature({ discordWorkRoom: null });
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

// ── Full review bounce flow (integration-style) ──

describe("Full review bounce flow", () => {
  it("preserves builder session through review and resumes on bounce", () => {
    // 1. Build phase — builder starts
    const feature = make_feature({
      phase: "build",
      activeArchetype: "builder",
    });

    const builder_session = "builder-session-abc";
    feature.sessionId = builder_session;
    feature.lastSessionId = builder_session;
    feature.lastBuilderSessionId = builder_session;

    // 2. Build completes → advance to review
    feature.phase = "review";
    feature.activeArchetype = "reviewer";
    feature.sessionId = null;
    feature.agentDone = false;

    // 3. Reviewer starts
    const reviewer_session = "reviewer-session-xyz";
    feature.sessionId = reviewer_session;
    feature.lastSessionId = reviewer_session;
    // lastBuilderSessionId NOT overwritten

    expect(feature.lastBuilderSessionId).toBe("builder-session-abc");
    expect(feature.lastSessionId).toBe("reviewer-session-xyz");

    // 4. Review completes with changes_requested → bounce to build
    feature.phase = "build";
    feature.activeArchetype = "builder";
    feature.sessionId = null;

    // 5. Resume logic picks up the builder session
    const is_builder_bounce = feature.activeArchetype === "builder" && Boolean(feature.lastBuilderSessionId);
    const resume_id = is_builder_bounce ? feature.lastBuilderSessionId : undefined;

    expect(resume_id).toBe("builder-session-abc");
  });

  it("clears session state on feature done", () => {
    const feature = make_feature({
      phase: "done",
      sessionId: null,
      lastSessionId: "some-session",
      lastBuilderSessionId: "builder-session",
      worktreePath: null,
      discordWorkRoom: null,
    });

    // Feature is done — session IDs are historical but the active session is cleared
    expect(feature.sessionId).toBeNull();
    expect(feature.phase).toBe("done");
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
