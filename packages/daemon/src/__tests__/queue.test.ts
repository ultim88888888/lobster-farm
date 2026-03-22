import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { ClaudeSessionManager } from "../session.js";
import { TaskQueue } from "../queue.js";

function make_config(overrides?: Record<string, unknown>): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    ...overrides,
  });
}

describe("TaskQueue", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = join(tmpdir(), `lf-queue-test-${Date.now()}`);
    await mkdir(tmp, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
    delete process.env["CLAUDE_BIN"];
  });

  it("submits a task and returns an ID", () => {
    const config = make_config();
    const mgr = new ClaudeSessionManager(config);
    const queue = new TaskQueue(mgr, config);

    const id = queue.submit({
      entity_id: "alpha",
      feature_id: "alpha-42",
      archetype: "builder",
      dna: ["coding-dna"],
      model: { model: "opus", think: "high" },
      prompt: "Build it",
      interactive: false,
      worktree_path: tmp,
    });

    expect(id).toBeTruthy();
    expect(id.length).toBe(36); // UUID
  });

  it("tracks queue statistics", async () => {
    const mock_claude = join(tmp, "mock-claude");
    await writeFile(mock_claude, "#!/bin/bash\necho done\nexit 0\n", "utf-8");
    await chmod(mock_claude, 0o755);
    process.env["CLAUDE_BIN"] = mock_claude;

    const config = make_config();
    const mgr = new ClaudeSessionManager(config);
    const queue = new TaskQueue(mgr, config);

    const stats_before = queue.get_stats();
    expect(stats_before.pending).toBe(0);
    expect(stats_before.active).toBe(0);

    queue.submit({
      entity_id: "alpha",
      feature_id: "alpha-1",
      archetype: "builder",
      dna: [],
      model: { model: "opus", think: "high" },
      prompt: "test",
      interactive: false,
      worktree_path: tmp,
    });

    // Give it a moment to spawn
    await new Promise((r) => setTimeout(r, 50));

    // Task should be active (mock claude runs quickly but let's check)
    const stats = queue.get_stats();
    // Either active or already completed (mock exits fast)
    expect(stats.pending).toBe(0);
  });

  it("respects concurrency limits", async () => {
    const mock_claude = join(tmp, "mock-claude-slow");
    await writeFile(mock_claude, "#!/bin/bash\nsleep 10\n", "utf-8");
    await chmod(mock_claude, 0o755);
    process.env["CLAUDE_BIN"] = mock_claude;

    const config = make_config({
      concurrency: { max_active_sessions: 2, max_queue_depth: 20 },
    });
    const mgr = new ClaudeSessionManager(config);
    const queue = new TaskQueue(mgr, config);

    // Submit 4 tasks
    for (let i = 0; i < 4; i++) {
      queue.submit({
        entity_id: "alpha",
        feature_id: `alpha-${String(i)}`,
        archetype: "builder",
        dna: [],
        model: { model: "opus", think: "high" },
        prompt: `task ${String(i)}`,
        interactive: false,
        worktree_path: tmp,
      });
    }

    // Give spawning a moment
    await new Promise((r) => setTimeout(r, 100));

    const stats = queue.get_stats();
    // Only 2 should be active, 2 should be pending
    expect(stats.active).toBe(2);
    expect(stats.pending).toBe(2);

    // Clean up
    await mgr.kill_all();
  });

  it("processes queued tasks when slots open", async () => {
    const mock_claude = join(tmp, "mock-claude-fast");
    await writeFile(
      mock_claude,
      '#!/bin/bash\necho \'{"done":true}\'\nexit 0\n',
      "utf-8",
    );
    await chmod(mock_claude, 0o755);
    process.env["CLAUDE_BIN"] = mock_claude;

    const config = make_config({
      concurrency: { max_active_sessions: 1, max_queue_depth: 20 },
    });
    const mgr = new ClaudeSessionManager(config);
    const queue = new TaskQueue(mgr, config);

    // Track completions
    let completed = 0;
    mgr.on("session:completed", () => {
      completed++;
    });

    // Submit 3 tasks (only 1 can run at a time)
    for (let i = 0; i < 3; i++) {
      queue.submit({
        entity_id: "alpha",
        feature_id: `alpha-${String(i)}`,
        archetype: "builder",
        dna: [],
        model: { model: "opus", think: "high" },
        prompt: `task ${String(i)}`,
        interactive: false,
        worktree_path: tmp,
      });
    }

    // Wait for all 3 to complete (mock exits immediately, queue chains them)
    await new Promise((r) => setTimeout(r, 1000));

    expect(completed).toBe(3);
    expect(queue.get_stats().active).toBe(0);
    expect(queue.get_stats().pending).toBe(0);
    expect(queue.get_stats().completed_total).toBe(3);
  });

  it("cancels a pending task", async () => {
    const mock_claude = join(tmp, "mock-claude-slow");
    await writeFile(mock_claude, "#!/bin/bash\nsleep 10\n", "utf-8");
    await chmod(mock_claude, 0o755);
    process.env["CLAUDE_BIN"] = mock_claude;

    const config = make_config({
      concurrency: { max_active_sessions: 1, max_queue_depth: 20 },
    });
    const mgr = new ClaudeSessionManager(config);
    const queue = new TaskQueue(mgr, config);

    // First task takes a slot
    queue.submit({
      entity_id: "alpha",
      feature_id: "alpha-1",
      archetype: "builder",
      dna: [],
      model: { model: "opus", think: "high" },
      prompt: "slow task",
      interactive: false,
      worktree_path: tmp,
    });

    // Second task should queue
    const task2_id = queue.submit({
      entity_id: "alpha",
      feature_id: "alpha-2",
      archetype: "builder",
      dna: [],
      model: { model: "opus", think: "high" },
      prompt: "queued task",
      interactive: false,
      worktree_path: tmp,
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(queue.get_stats().pending).toBe(1);

    // Cancel the queued task
    const cancelled = queue.cancel(task2_id);
    expect(cancelled).toBe(true);
    expect(queue.get_stats().pending).toBe(0);

    // Can't cancel an active task via cancel()
    const active_tasks = queue.get_active();
    expect(active_tasks.length).toBe(1);
    const cancel_active = queue.cancel(active_tasks[0]!.id);
    expect(cancel_active).toBe(false);

    await mgr.kill_all();
  });

  it("sorts by priority", async () => {
    const mock_claude = join(tmp, "mock-claude-slow");
    await writeFile(mock_claude, "#!/bin/bash\nsleep 10\n", "utf-8");
    await chmod(mock_claude, 0o755);
    process.env["CLAUDE_BIN"] = mock_claude;

    const config = make_config({
      concurrency: { max_active_sessions: 1, max_queue_depth: 20 },
    });
    const mgr = new ClaudeSessionManager(config);
    const queue = new TaskQueue(mgr, config);

    // First task takes the only slot
    queue.submit({
      entity_id: "alpha",
      feature_id: "blocker",
      archetype: "builder",
      dna: [],
      model: { model: "opus", think: "high" },
      prompt: "blocker",
      interactive: false,
      worktree_path: tmp,
    });

    await new Promise((r) => setTimeout(r, 50));

    // These 3 will queue (slot is full)
    queue.submit({
      entity_id: "alpha",
      feature_id: "low-1",
      archetype: "builder",
      dna: [],
      model: { model: "opus", think: "high" },
      prompt: "low",
      interactive: false,
      priority: "low",
      worktree_path: tmp,
    });

    queue.submit({
      entity_id: "alpha",
      feature_id: "critical-1",
      archetype: "builder",
      dna: [],
      model: { model: "opus", think: "high" },
      prompt: "critical",
      interactive: false,
      priority: "critical",
      worktree_path: tmp,
    });

    queue.submit({
      entity_id: "alpha",
      feature_id: "high-1",
      archetype: "builder",
      dna: [],
      model: { model: "opus", think: "high" },
      prompt: "high",
      interactive: false,
      priority: "high",
      worktree_path: tmp,
    });

    const pending = queue.get_pending();
    expect(pending).toHaveLength(3);
    expect(pending[0]!.priority).toBe("critical");
    expect(pending[1]!.priority).toBe("high");
    expect(pending[2]!.priority).toBe("low");

    await mgr.kill_all();
  });
});
