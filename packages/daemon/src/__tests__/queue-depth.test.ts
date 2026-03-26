import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm, chmod } from "node:fs/promises";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LobsterFarmConfigSchema, EntityConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig, EntityConfig } from "@lobster-farm/shared";
import { ClaudeSessionManager } from "../session.js";
import { TaskQueue, QueueFullError } from "../queue.js";
import { EntityRegistry } from "../registry.js";
import { FeatureManager } from "../features.js";

function make_config(overrides?: Record<string, unknown>): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    ...overrides,
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

describe("Queue depth enforcement", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = join(tmpdir(), `lf-qdepth-test-${Date.now()}`);
    await mkdir(tmp, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
    delete process.env["CLAUDE_BIN"];
  });

  describe("TaskQueue.submit() with max_queue_depth", () => {
    it("throws QueueFullError when pending queue is at max_queue_depth", async () => {
      const mock_claude = join(tmp, "mock-claude-slow");
      await writeFile(mock_claude, "#!/bin/bash\nsleep 30\n", "utf-8");
      await chmod(mock_claude, 0o755);
      process.env["CLAUDE_BIN"] = mock_claude;

      // max_active=1, max_queue_depth=2: first task goes active, next 2 can queue, 4th should fail
      const config = make_config({
        concurrency: { max_active_sessions: 1, max_queue_depth: 2 },
      });
      const mgr = new ClaudeSessionManager(config);
      const queue = new TaskQueue(mgr, config);

      const make_submission = (i: number) => ({
        entity_id: "alpha",
        feature_id: `alpha-${String(i)}`,
        archetype: "builder" as const,
        dna: [],
        model: { model: "opus" as const, think: "high" as const },
        prompt: `task ${String(i)}`,
        interactive: false,
        worktree_path: tmp,
      });

      // Task 1: goes active (slot available)
      queue.submit(make_submission(1));
      await new Promise((r) => setTimeout(r, 50));
      expect(queue.get_stats().active).toBe(1);
      expect(queue.get_stats().pending).toBe(0);

      // Task 2: queues (1/2 pending slots)
      queue.submit(make_submission(2));
      expect(queue.get_stats().pending).toBe(1);

      // Task 3: queues (2/2 pending slots)
      queue.submit(make_submission(3));
      expect(queue.get_stats().pending).toBe(2);

      // Task 4: should throw QueueFullError
      expect(() => queue.submit(make_submission(4))).toThrow(QueueFullError);
      expect(() => queue.submit(make_submission(4))).toThrow(/max_queue_depth: 2/);

      // Pending count unchanged
      expect(queue.get_stats().pending).toBe(2);

      await mgr.kill_all();
    });

    it("QueueFullError has correct properties", () => {
      const err = new QueueFullError(5);
      expect(err.name).toBe("QueueFullError");
      expect(err.code).toBe("QUEUE_FULL");
      expect(err.message).toContain("max_queue_depth: 5");
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(QueueFullError);
    });

    it("allows submissions again after queue drains", async () => {
      const mock_claude = join(tmp, "mock-claude-fast");
      await writeFile(mock_claude, "#!/bin/bash\nexit 0\n", "utf-8");
      await chmod(mock_claude, 0o755);
      process.env["CLAUDE_BIN"] = mock_claude;

      const config = make_config({
        concurrency: { max_active_sessions: 1, max_queue_depth: 1 },
      });
      const mgr = new ClaudeSessionManager(config);
      const queue = new TaskQueue(mgr, config);

      const make_submission = (i: number) => ({
        entity_id: "alpha",
        feature_id: `alpha-${String(i)}`,
        archetype: "builder" as const,
        dna: [],
        model: { model: "opus" as const, think: "high" as const },
        prompt: `task ${String(i)}`,
        interactive: false,
        worktree_path: tmp,
      });

      // Submit first task (goes active), second queues (1/1 pending), third should fail
      queue.submit(make_submission(1));
      await new Promise((r) => setTimeout(r, 50));

      queue.submit(make_submission(2));
      expect(() => queue.submit(make_submission(3))).toThrow(QueueFullError);

      // Wait for tasks to complete
      await new Promise((r) => setTimeout(r, 1000));

      // Queue should be empty now — new submissions should work
      expect(queue.get_stats().pending).toBe(0);
      expect(() => queue.submit(make_submission(4))).not.toThrow();
    });

    it("pending_count getter reflects current queue length", async () => {
      const mock_claude = join(tmp, "mock-claude-slow");
      await writeFile(mock_claude, "#!/bin/bash\nsleep 30\n", "utf-8");
      await chmod(mock_claude, 0o755);
      process.env["CLAUDE_BIN"] = mock_claude;

      const config = make_config({
        concurrency: { max_active_sessions: 1, max_queue_depth: 10 },
      });
      const mgr = new ClaudeSessionManager(config);
      const queue = new TaskQueue(mgr, config);

      expect(queue.pending_count).toBe(0);

      queue.submit({
        entity_id: "alpha",
        feature_id: "alpha-1",
        archetype: "builder",
        dna: [],
        model: { model: "opus", think: "high" },
        prompt: "task",
        interactive: false,
        worktree_path: tmp,
      });

      await new Promise((r) => setTimeout(r, 50));
      // First task should go active
      expect(queue.pending_count).toBe(0);

      queue.submit({
        entity_id: "alpha",
        feature_id: "alpha-2",
        archetype: "builder",
        dna: [],
        model: { model: "opus", think: "high" },
        prompt: "task",
        interactive: false,
        worktree_path: tmp,
      });

      expect(queue.pending_count).toBe(1);

      await mgr.kill_all();
    });
  });

  describe("FeatureManager blocks on QueueFullError", () => {
    it("feature creation succeeds but marks feature blocked when queue is full", async () => {
      const mock_claude = join(tmp, "mock-claude-slow");
      await writeFile(mock_claude, "#!/bin/bash\nsleep 30\n", "utf-8");
      await chmod(mock_claude, 0o755);
      process.env["CLAUDE_BIN"] = mock_claude;

      // max_active=1, max_queue_depth=1: first feature goes active, second queues, third blocks
      const config = make_config({
        concurrency: { max_active_sessions: 1, max_queue_depth: 1 },
      });

      execSync("git init && git commit --allow-empty -m 'init'", { cwd: tmp, stdio: "ignore" });

      const entity_config = make_entity_config(tmp);
      const registry = new MockRegistry(config, entity_config);
      const session_manager = new ClaudeSessionManager(config);
      const queue = new TaskQueue(session_manager, config);
      const fm = new FeatureManager(registry, queue, config);

      // Feature 1: planner goes active
      const f1 = await fm.create_feature({
        entity_id: "alpha",
        title: "Feature One",
        github_issue: 1,
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(f1.blocked).toBe(false);

      // Feature 2: queues (1/1 pending slot)
      const f2 = await fm.create_feature({
        entity_id: "alpha",
        title: "Feature Two",
        github_issue: 2,
      });
      expect(f2.blocked).toBe(false);

      // Feature 3: queue is full — feature should be created but blocked
      await fm.create_feature({
        entity_id: "alpha",
        title: "Feature Three",
        github_issue: 3,
      });

      // Wait for the async spawn_phase_agent to complete and block
      await new Promise((r) => setTimeout(r, 100));

      const f3_state = fm.get_feature("alpha-3")!;
      expect(f3_state).toBeTruthy();
      expect(f3_state.phase).toBe("plan"); // Feature exists and is in plan phase
      expect(f3_state.blocked).toBe(true);
      expect(f3_state.blockedReason).toContain("Queue full");

      await session_manager.kill_all();
    }, 15_000);
  });

  describe("on_drain callback", () => {
    it("calls the registered drain callback when a task completes", async () => {
      const mock_claude = join(tmp, "mock-claude-fast");
      await writeFile(mock_claude, "#!/bin/bash\nexit 0\n", "utf-8");
      await chmod(mock_claude, 0o755);
      process.env["CLAUDE_BIN"] = mock_claude;

      const config = make_config({
        concurrency: { max_active_sessions: 1, max_queue_depth: 10 },
      });
      const mgr = new ClaudeSessionManager(config);
      const queue = new TaskQueue(mgr, config);

      let drain_called = 0;
      queue.on_drain(() => {
        drain_called++;
      });

      queue.submit({
        entity_id: "alpha",
        feature_id: "alpha-1",
        archetype: "builder",
        dna: [],
        model: { model: "opus", think: "high" },
        prompt: "task",
        interactive: false,
        worktree_path: tmp,
      });

      // Wait for the fast mock to complete
      await new Promise((r) => setTimeout(r, 500));

      expect(drain_called).toBeGreaterThanOrEqual(1);
    });
  });
});
