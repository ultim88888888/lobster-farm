import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { ClaudeSessionManager } from "../session.js";
import { TaskQueue, QueueFullError } from "../queue.js";

function make_config(overrides?: Record<string, unknown>): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    ...overrides,
  });
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

  describe("drain event", () => {
    it("emits drain event when a task completes", async () => {
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
      queue.on("drain", () => {
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
