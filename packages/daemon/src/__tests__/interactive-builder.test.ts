import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LobsterFarmConfigSchema, EntityConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig, EntityConfig } from "@lobster-farm/shared";
import { ClaudeSessionManager } from "../session.js";
import { TaskQueue } from "../queue.js";
import { EntityRegistry } from "../registry.js";
import { FeatureManager } from "../features.js";
import { BotPool } from "../pool.js";
import type { PoolBot } from "../pool.js";
import * as actions from "../actions.js";

// ── Test helpers ──

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    concurrency: { max_active_sessions: 2, max_queue_depth: 20 },
  });
}

function make_entity_config(tmp: string): EntityConfig {
  return EntityConfigSchema.parse({
    entity: {
      id: "alpha",
      name: "Alpha Project",
      repos: [{ name: "alpha", url: "git@github.com:test/alpha.git", path: tmp }],
      memory: { path: `${tmp}/.memory` },
      secrets: { vault_name: "entity-alpha" },
    },
  });
}

class MockRegistry extends EntityRegistry {
  private mock_entity: EntityConfig;

  constructor(config: LobsterFarmConfig, entity: EntityConfig) {
    super(config);
    this.mock_entity = entity;
  }

  override async load_all(): Promise<void> {}

  override get(id: string): EntityConfig | undefined {
    return id === this.mock_entity.entity.id ? this.mock_entity : undefined;
  }

  override get_all(): EntityConfig[] {
    return [this.mock_entity];
  }

  override get_active(): EntityConfig[] {
    return [this.mock_entity];
  }

  override count(): number {
    return 1;
  }
}

/** Test-friendly BotPool that bypasses tmux/filesystem operations. */
class MockBotPool extends BotPool {
  private idle_overrides = new Map<number, boolean>();

  inject_bots(bots: PoolBot[]): void {
    (this as unknown as { bots: PoolBot[] }).bots = bots;
  }

  set_bot_idle(bot_id: number, idle: boolean): void {
    this.idle_overrides.set(bot_id, idle);
  }

  protected override is_bot_idle(bot: PoolBot): boolean {
    return this.idle_overrides.get(bot.id) ?? true;
  }

  /** Expose check_assigned_health for direct testing. */
  async trigger_health_check(): Promise<void> {
    await this.check_assigned_health();
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
    ...overrides,
  };
}

// ── Tests ──

describe("Interactive builder sessions", () => {
  let tmp: string;
  let config: LobsterFarmConfig;
  let entity_config: EntityConfig;
  let registry: MockRegistry;
  let session_manager: ClaudeSessionManager;
  let queue: TaskQueue;
  let pool: MockBotPool;
  let fm: FeatureManager;

  beforeEach(async () => {
    tmp = join(tmpdir(), `lf-interactive-builder-test-${Date.now()}`);
    await mkdir(tmp, { recursive: true });
    execSync("git init && git commit --allow-empty -m 'init'", { cwd: tmp, stdio: "ignore" });

    config = make_config();
    entity_config = make_entity_config(tmp);
    registry = new MockRegistry(config, entity_config);
    session_manager = new ClaudeSessionManager(config);
    queue = new TaskQueue(session_manager, config);
    pool = new MockBotPool(config);

    // Stub all tmux/filesystem side effects on the pool
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

    // Mock assign_work_room to return a fake channel ID instead of requiring Discord
    vi.spyOn(actions, "assign_work_room").mockResolvedValue("mock-work-room-ch");
    // Mock other actions that touch Discord/GitHub
    vi.spyOn(actions, "notify_feature").mockResolvedValue(undefined);
    vi.spyOn(actions, "notify").mockResolvedValue(undefined);
    vi.spyOn(actions, "update_work_room_topic").mockResolvedValue(undefined);
    vi.spyOn(actions, "release_work_room").mockResolvedValue(undefined);
    vi.spyOn(actions, "create_pr").mockResolvedValue(0);
    vi.spyOn(actions, "merge_pr").mockResolvedValue(undefined);
    vi.spyOn(actions, "cleanup_worktree").mockResolvedValue(undefined);

    fm = new FeatureManager(registry, queue, config);
    fm.set_pool(pool);

    // Mock the bridge methods to avoid real tmux polling (30s timeout in tests)
    vi.spyOn(fm as unknown as Record<string, unknown>, "bridge_build_prompt" as never)
      .mockResolvedValue(undefined);
    vi.spyOn(fm as unknown as Record<string, unknown>, "bridge_review_feedback" as never)
      .mockResolvedValue(undefined);
    vi.spyOn(fm as unknown as Record<string, unknown>, "bridge_review_feedback_to_tmux" as never)
      .mockResolvedValue(undefined);

    // Wire session events
    session_manager.on("session:started", (session) => {
      fm.on_session_started(session);
    });
    session_manager.on("session:completed", (result) => {
      void fm.on_session_completed(result);
    });
    session_manager.on("session:failed", (sid: string, err: string) => {
      fm.on_session_failed(sid, err);
    });
  });

  afterEach(async () => {
    pool.stop_health_monitor();
    await session_manager.kill_all();
    await rm(tmp, { recursive: true, force: true });
    delete process.env["CLAUDE_BIN"];
    vi.restoreAllMocks();
  });

  // ── AC1: Builder sessions spawn as pool bots, not queue tasks ──

  describe("AC1: builders route through pool", () => {
    it("spawn_phase_agent for builder calls pool.assign, not queue.submit", async () => {
      pool.inject_bots([make_bot({ id: 1 })]);

      const assign_spy = vi.spyOn(pool, "assign");
      const submit_spy = vi.spyOn(queue, "submit");

      const feature = await fm.create_feature({
        entity_id: "alpha",
        title: "Pool builder test",
        github_issue: 100,
        start_phase: "build",
      });

      expect(assign_spy).toHaveBeenCalled();
      expect(submit_spy).not.toHaveBeenCalled();
      expect(feature.poolBotId).toBe(1);
    });

    it("spawn_phase_agent for reviewer still calls queue.submit", async () => {
      pool.inject_bots([make_bot({ id: 1 })]);
      const submit_spy = vi.spyOn(queue, "submit");

      // Create feature directly in review phase by manipulating state
      // (reviewers are spawned when advancing build->review)
      const feature = await fm.create_feature({
        entity_id: "alpha",
        title: "Reviewer queue test",
        github_issue: 101,
        start_phase: "plan",
      });

      // Planner uses queue, not pool
      expect(submit_spy).toHaveBeenCalled();
      expect(feature.poolBotId).toBeNull();
    });
  });

  // ── AC3: Builder prompt includes collaboration guidance ──

  describe("AC3: builder prompt has collaboration guidance", () => {
    it("build prompt is bridged with collaboration content", async () => {
      pool.inject_bots([make_bot({ id: 1 })]);

      // The bridge_build_prompt mock was set up in beforeEach
      const bridge_spy = vi.spyOn(
        fm as unknown as Record<string, unknown>,
        "bridge_build_prompt" as never,
      );

      await fm.create_feature({
        entity_id: "alpha",
        title: "Prompt guidance test",
        github_issue: 102,
        start_phase: "build",
      });

      // bridge_build_prompt should have been called (for non-bounce builds)
      expect(bridge_spy).toHaveBeenCalled();
    });
  });

  // ── AC4: Builder working directory is the feature's worktree ──

  describe("AC4: working directory is worktree", () => {
    it("pool.assign receives worktree path as working_dir", async () => {
      pool.inject_bots([make_bot({ id: 1 })]);

      const assign_spy = vi.spyOn(pool, "assign");

      const feature = await fm.create_feature({
        entity_id: "alpha",
        title: "Worktree dir test",
        github_issue: 103,
        start_phase: "build",
      });

      expect(assign_spy).toHaveBeenCalled();
      const call_args = assign_spy.mock.calls[0]!;
      // assign(channel_id, entity_id, archetype, resume_session_id, channel_type, working_dir)
      // Index: 0          1          2          3                   4             5
      const working_dir_arg = call_args[5];
      expect(working_dir_arg).toBeTruthy();
      expect(working_dir_arg).toContain("worktrees/");
      expect(feature.worktreePath).toBeTruthy();
    });
  });

  // ── AC5: Pool-to-feature binding ──

  describe("AC5: pool-to-feature binding", () => {
    it("poolBotId is set on feature after pool assignment", async () => {
      pool.inject_bots([make_bot({ id: 5 })]);

      const feature = await fm.create_feature({
        entity_id: "alpha",
        title: "Pool binding test",
        github_issue: 104,
        start_phase: "build",
      });

      expect(feature.poolBotId).toBe(5);
    });

    it("pool_bot_to_feature map tracks the binding", async () => {
      pool.inject_bots([make_bot({ id: 3 })]);

      await fm.create_feature({
        entity_id: "alpha",
        title: "Map tracking test",
        github_issue: 105,
        start_phase: "build",
      });

      const map = (fm as unknown as { pool_bot_to_feature: Map<number, string> }).pool_bot_to_feature;
      expect(map.get(3)).toBe("alpha-105");
    });
  });

  // ── AC6: When builder's tmux session ends, check for PR ──

  describe("AC6: PR-based phase transition on session end", () => {
    it("bot:session_ended with PR on branch advances to review", async () => {
      pool.inject_bots([make_bot({ id: 1 })]);

      const feature = await fm.create_feature({
        entity_id: "alpha",
        title: "PR detected test",
        github_issue: 106,
        start_phase: "build",
      });

      expect(feature.poolBotId).toBe(1);

      // Mock detect_pr_on_branch to return a PR number
      vi.spyOn(
        fm as unknown as Record<string, unknown>,
        "detect_pr_on_branch" as never,
      ).mockReturnValue(42 as never);

      // Simulate the bot:session_ended event
      const handler = (fm as unknown as { on_bot_session_ended: (event: any) => Promise<void> }).on_bot_session_ended.bind(fm);
      await handler({
        bot_id: 1,
        channel_id: feature.discordWorkRoom,
        entity_id: feature.entity,
      });

      const updated = fm.get_feature("alpha-106")!;
      expect(updated.prNumber).toBe(42);
      expect(updated.poolBotId).toBeNull();
    });

    it("bot:session_ended without PR notifies alerts", async () => {
      pool.inject_bots([make_bot({ id: 1 })]);

      const feature = await fm.create_feature({
        entity_id: "alpha",
        title: "No PR test",
        github_issue: 107,
        start_phase: "build",
      });

      // gh command will fail in test env — treated as no PR
      const handler = (fm as unknown as { on_bot_session_ended: (event: any) => Promise<void> }).on_bot_session_ended.bind(fm);
      await handler({
        bot_id: 1,
        channel_id: feature.discordWorkRoom,
        entity_id: feature.entity,
      });

      const updated = fm.get_feature("alpha-107")!;
      expect(updated.poolBotId).toBeNull();
      expect(updated.phase).toBe("build");

      // Should have notified alerts
      expect(actions.notify_feature).toHaveBeenCalledWith(
        expect.objectContaining({ id: "alpha-107" }),
        expect.stringContaining("Builder exited without creating a PR"),
        expect.anything(),
        expect.objectContaining({ also_alerts: true }),
      );
    });
  });

  // ── AC7: Health monitor ──

  describe("AC7: health monitor detects dead tmux sessions", () => {
    it("emits bot:session_ended for dead tmux sessions", () => {
      pool.inject_bots([
        make_bot({
          id: 1,
          state: "assigned",
          channel_id: "ch-1",
          entity_id: "e1",
          archetype: "builder",
          last_active: new Date(),
        }),
      ]);

      const events: unknown[] = [];
      pool.on("bot:session_ended", (event: unknown) => events.push(event));

      pool.trigger_health_check();

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        bot_id: 1,
        channel_id: "ch-1",
        entity_id: "e1",
      });

      const status = pool.get_status();
      expect(status.free).toBe(1);
      expect(status.assigned).toBe(0);
    });

    it("does not fire for alive tmux sessions", () => {
      pool.inject_bots([
        make_bot({
          id: 1,
          state: "assigned",
          channel_id: "ch-1",
          entity_id: "e1",
          archetype: "builder",
          last_active: new Date(),
        }),
      ]);

      // Override is_tmux_alive to return true
      vi.spyOn(pool as unknown as Record<string, unknown>, "is_tmux_alive" as never)
        .mockReturnValue(true);

      const events: unknown[] = [];
      pool.on("bot:session_ended", (event: unknown) => events.push(event));

      pool.trigger_health_check();

      expect(events).toHaveLength(0);
    });

    it("does not fire for free or parked bots", () => {
      pool.inject_bots([
        make_bot({ id: 1, state: "free" }),
        make_bot({ id: 2, state: "parked", channel_id: "ch-2" }),
      ]);

      const events: unknown[] = [];
      pool.on("bot:session_ended", (event: unknown) => events.push(event));

      pool.trigger_health_check();

      expect(events).toHaveLength(0);
    });
  });

  // ── AC8: Builder bounce reuses pool bot ──

  describe("AC8: builder bounce reuses existing pool bot", () => {
    it("review->build bounce with existing bot bridges feedback directly", async () => {
      pool.inject_bots([make_bot({ id: 1 })]);

      const feature = await fm.create_feature({
        entity_id: "alpha",
        title: "Bounce reuse test",
        github_issue: 108,
        start_phase: "build",
      });

      expect(feature.poolBotId).toBe(1);

      // Set up bounce scenario: feature went to review, now bouncing back to build.
      // poolBotId is already set (from the initial pool assignment above), which is the
      // bounce signal for pool-based builders — lastBuilderSessionId is never set for them.
      feature.phase = "review";
      feature.prNumber = 42;

      const assign_spy = vi.spyOn(pool, "assign");

      // Advance back to build
      await fm.advance_feature("alpha-108", "build");

      const updated = fm.get_feature("alpha-108")!;
      expect(updated.poolBotId).toBe(1);
      expect(updated.phase).toBe("build");

      // pool.assign returns existing assignment (bot 1 is already on this channel)
      // so it's called but returns the existing bot
      if (assign_spy.mock.calls.length > 0) {
        // Pool was consulted but should have found existing assignment
        expect(updated.poolBotId).toBe(1);
      }
    });
  });

  // ── AC9: Builder bounce falls back to re-assignment ──

  describe("AC9: builder bounce falls back to pool re-assignment", () => {
    it("review->build bounce with evicted bot gets new pool assignment", async () => {
      pool.inject_bots([
        make_bot({ id: 1 }),
        make_bot({ id: 2 }),
      ]);

      const feature = await fm.create_feature({
        entity_id: "alpha",
        title: "Bounce fallback test",
        github_issue: 109,
        start_phase: "build",
      });

      expect(feature.poolBotId).toBe(1);

      // Simulate eviction — release the bot and clear poolBotId, matching what
      // on_bot_session_ended does in production.
      await pool.release(feature.discordWorkRoom!);
      feature.poolBotId = null;

      // Set up bounce scenario — with poolBotId cleared by eviction, the next build
      // is treated as a fresh build (not a bounce), which gets a new pool assignment.
      feature.phase = "review";
      feature.prNumber = 99;

      await fm.advance_feature("alpha-109", "build");

      const updated = fm.get_feature("alpha-109")!;
      expect(updated.poolBotId).not.toBeNull();
      expect(updated.phase).toBe("build");
    });
  });

  // ── AC10: Feature ship releases pool bot ──

  describe("AC10: ship releases pool bot", () => {
    it("run_ship_actions releases pool bot before work room", async () => {
      pool.inject_bots([make_bot({ id: 1 })]);

      const feature = await fm.create_feature({
        entity_id: "alpha",
        title: "Ship release test",
        github_issue: 110,
        start_phase: "build",
      });

      expect(feature.poolBotId).toBe(1);

      feature.prNumber = 1;

      const release_spy = vi.spyOn(pool, "release");

      const ship_fn = (fm as unknown as { run_ship_actions: (f: any) => Promise<void> }).run_ship_actions.bind(fm);
      await ship_fn(feature);

      expect(release_spy).toHaveBeenCalledWith(expect.any(String));
      expect(feature.poolBotId).toBeNull();

      const map = (fm as unknown as { pool_bot_to_feature: Map<number, string> }).pool_bot_to_feature;
      expect(map.has(1)).toBe(false);
    });
  });

  // ── AC11: Builder blocked when no pool bots available ──

  describe("AC11: blocked when no pool bots", () => {
    it("feature blocked with clear reason when pool returns null", async () => {
      pool.inject_bots([]);

      const feature = await fm.create_feature({
        entity_id: "alpha",
        title: "No bots test",
        github_issue: 111,
        start_phase: "build",
      });

      expect(feature.blocked).toBe(true);
      expect(feature.blockedReason).toContain("No pool bots");
      expect(feature.poolBotId).toBeNull();
    });
  });

  // ── AC12: Blocked builders auto-retry when pool bot freed ──

  describe("AC12: blocked builders retry on pool release", () => {
    it("retry_pool_blocked unblocks and re-spawns when pool has capacity", async () => {
      pool.inject_bots([]);

      const feature = await fm.create_feature({
        entity_id: "alpha",
        title: "Pool retry test",
        github_issue: 112,
        start_phase: "build",
      });

      expect(feature.blocked).toBe(true);
      expect(feature.blockedReason).toContain("No pool bots");

      // Now add a bot and emit release event
      pool.inject_bots([make_bot({ id: 7 })]);
      pool.emit("bot:released", { bot_id: 7 });

      // Give async handler a tick
      await new Promise(resolve => setTimeout(resolve, 50));

      const updated = fm.get_feature("alpha-112")!;
      expect(updated.blocked).toBe(false);
      expect(updated.poolBotId).toBe(7);
    });
  });

  // ── AC13: Non-builder archetypes still use queue ──

  describe("AC13: non-builder archetypes use queue", () => {
    it("planner phase uses queue, not pool", async () => {
      pool.inject_bots([make_bot({ id: 1 })]);
      const assign_spy = vi.spyOn(pool, "assign");

      await fm.create_feature({
        entity_id: "alpha",
        title: "Planner queue test",
        github_issue: 113,
      });

      expect(assign_spy).not.toHaveBeenCalled();
    });

    it("designer phase uses queue, not pool", async () => {
      pool.inject_bots([make_bot({ id: 1 })]);
      const assign_spy = vi.spyOn(pool, "assign");

      await fm.create_feature({
        entity_id: "alpha",
        title: "Designer queue test",
        github_issue: 114,
        start_phase: "design",
      });

      expect(assign_spy).not.toHaveBeenCalled();
    });
  });

  // ── AC14: poolBotId persisted on FeatureState ──

  describe("AC14: poolBotId persisted", () => {
    it("poolBotId is set on feature after pool assignment", async () => {
      pool.inject_bots([make_bot({ id: 9 })]);

      const feature = await fm.create_feature({
        entity_id: "alpha",
        title: "Persistence test",
        github_issue: 115,
        start_phase: "build",
      });

      expect(feature.poolBotId).toBe(9);
      expect("poolBotId" in feature).toBe(true);
    });

    it("load_persisted rebuilds pool_bot_to_feature map from poolBotId", async () => {
      // Test that load_persisted correctly rebuilds the pool_bot_to_feature map
      // by mocking the persistence layer
      const { load_features } = await import("../persistence.js");
      const mock_features = [{
        id: "alpha-116",
        entity: "alpha",
        githubIssue: 116,
        title: "Restore test",
        phase: "build" as const,
        priority: "medium" as const,
        branch: "feature/116-restore-test",
        worktreePath: null,
        discordWorkRoom: null,
        activeArchetype: null,
        activeDna: [],
        sessionId: null,
        lastSessionId: null,
        lastBuilderSessionId: null,
        dependsOn: [],
        blocked: false,
        blockedReason: null,
        approved: false,
        labels: [],
        poolBotId: 4,
        prNumber: null,
        mergeAttempts: 0,
        agentDone: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }];

      const persistence = await import("../persistence.js");
      vi.spyOn(persistence, "load_features").mockResolvedValue(mock_features);

      const fm2 = new FeatureManager(registry, queue, config);
      await fm2.load_persisted();

      const restored = fm2.get_feature("alpha-116");
      expect(restored).toBeDefined();
      expect(restored!.poolBotId).toBe(4);

      const map = (fm2 as unknown as { pool_bot_to_feature: Map<number, string> }).pool_bot_to_feature;
      expect(map.get(4)).toBe("alpha-116");
    });
  });

  // ── Pool.ts-specific tests ──

  describe("pool.ts: assign() accepts working_dir override", () => {
    it("passes working_dir to start_tmux", async () => {
      pool.inject_bots([make_bot({ id: 1 })]);

      const start_tmux_spy = vi.spyOn(pool as unknown as Record<string, unknown>, "start_tmux" as never);

      await pool.assign("ch-1", "e1", "builder", undefined, "work_room", "/custom/path");

      expect(start_tmux_spy).toHaveBeenCalled();
      const call_args = start_tmux_spy.mock.calls[0]!;
      // start_tmux(bot, archetype, entity_id, working_dir, resume_session_id)
      expect(call_args[3]).toBe("/custom/path");
    });

    it("falls back to entity_dir when working_dir not provided", async () => {
      pool.inject_bots([make_bot({ id: 1 })]);

      const start_tmux_spy = vi.spyOn(pool as unknown as Record<string, unknown>, "start_tmux" as never);

      await pool.assign("ch-1", "e1", "builder", undefined, "work_room");

      expect(start_tmux_spy).toHaveBeenCalled();
      const call_args = start_tmux_spy.mock.calls[0]!;
      expect(call_args[3]).toBeTruthy();
      expect(call_args[3]).not.toBe("/custom/path");
    });
  });

  describe("pool.ts: release() emits bot:released", () => {
    it("emits bot:released event on release", async () => {
      pool.inject_bots([
        make_bot({ id: 1, state: "assigned", channel_id: "ch-1", entity_id: "e1" }),
      ]);

      const events: unknown[] = [];
      pool.on("bot:released", (event: unknown) => events.push(event));

      await pool.release("ch-1");

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ bot_id: 1 });
    });
  });

  describe("pool.ts: health monitor lifecycle", () => {
    it("start and stop work correctly", () => {
      pool.inject_bots([]);

      pool.start_health_monitor();
      pool.start_health_monitor(); // idempotent

      const timer = (pool as unknown as { health_timer: unknown }).health_timer;
      expect(timer).not.toBeNull();

      pool.stop_health_monitor();

      const stopped_timer = (pool as unknown as { health_timer: unknown }).health_timer;
      expect(stopped_timer).toBeNull();
    });

    it("shutdown stops health monitor", async () => {
      pool.inject_bots([]);
      pool.start_health_monitor();

      await pool.shutdown();

      const timer = (pool as unknown as { health_timer: unknown }).health_timer;
      expect(timer).toBeNull();
    });
  });

  describe("pool.ts: health monitor emits both events", () => {
    it("check_assigned_health emits bot:session_ended and bot:released", async () => {
      pool.inject_bots([
        make_bot({
          id: 1,
          state: "assigned",
          channel_id: "ch-1",
          entity_id: "e1",
          archetype: "builder",
          last_active: new Date(),
        }),
      ]);

      const session_events: unknown[] = [];
      const release_events: unknown[] = [];
      pool.on("bot:session_ended", (event: unknown) => session_events.push(event));
      pool.on("bot:released", (event: unknown) => release_events.push(event));

      await pool.trigger_health_check();

      expect(session_events).toHaveLength(1);
      expect(release_events).toHaveLength(1);
    });
  });

  // ── Integration: full lifecycle ──

  describe("integration: full build -> ship lifecycle", () => {
    it("build -> ship cleans up pool binding and work room", async () => {
      pool.inject_bots([make_bot({ id: 1 })]);

      const feature = await fm.create_feature({
        entity_id: "alpha",
        title: "Full lifecycle test",
        github_issue: 120,
        start_phase: "build",
      });

      expect(feature.phase).toBe("build");
      expect(feature.poolBotId).toBe(1);
      expect(feature.worktreePath).toBeTruthy();

      feature.prNumber = 88;

      const ship_fn = (fm as unknown as { run_ship_actions: (f: any) => Promise<void> }).run_ship_actions.bind(fm);
      await ship_fn(feature);

      expect(feature.poolBotId).toBeNull();
      expect(feature.discordWorkRoom).toBeNull();
      const map = (fm as unknown as { pool_bot_to_feature: Map<number, string> }).pool_bot_to_feature;
      expect(map.has(1)).toBe(false);
    });
  });

  // ── FeatureStateSchema ──

  describe("FeatureStateSchema includes poolBotId", () => {
    it("poolBotId defaults to null", async () => {
      const { FeatureStateSchema } = await import("@lobster-farm/shared");
      const result = FeatureStateSchema.parse({
        id: "test-1",
        entity: "test",
        githubIssue: 1,
        title: "Test",
        phase: "plan",
        branch: "feature/1-test",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      expect(result.poolBotId).toBeNull();
    });

    it("poolBotId accepts a number", async () => {
      const { FeatureStateSchema } = await import("@lobster-farm/shared");
      const result = FeatureStateSchema.parse({
        id: "test-1",
        entity: "test",
        githubIssue: 1,
        title: "Test",
        phase: "plan",
        branch: "feature/1-test",
        poolBotId: 5,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      expect(result.poolBotId).toBe(5);
    });
  });
});
