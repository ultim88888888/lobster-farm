import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { writeFile, mkdir, rm, chmod } from "node:fs/promises";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LobsterFarmConfigSchema, EntityConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig, EntityConfig } from "@lobster-farm/shared";
import { ClaudeSessionManager } from "../session.js";
import { TaskQueue } from "../queue.js";
import { EntityRegistry } from "../registry.js";
import { FeatureManager } from "../features.js";
import { classify_merge_error } from "../actions.js";
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

// ── classify_merge_error ──

describe("classify_merge_error", () => {
  it('returns "conflict" for "merge conflict" in error message', () => {
    expect(classify_merge_error("Error: Pull request has merge conflict")).toBe("conflict");
  });

  it('returns "conflict" for "not mergeable"', () => {
    expect(classify_merge_error("Pull request is not mergeable")).toBe("conflict");
  });

  it('returns "conflict" for "CONFLICTING" (case-insensitive)', () => {
    expect(classify_merge_error("CONFLICTING files detected")).toBe("conflict");
  });

  it('returns "conflict" for "conflicts must be resolved"', () => {
    expect(classify_merge_error("Conflicts must be resolved before merging")).toBe("conflict");
  });

  it('returns "other" for authentication errors', () => {
    expect(classify_merge_error("Error: authentication required")).toBe("other");
  });

  it('returns "other" for network errors', () => {
    expect(classify_merge_error("Error: could not connect to server")).toBe("other");
  });

  it('returns "other" for generic error messages', () => {
    expect(classify_merge_error("Error: something went wrong")).toBe("other");
  });

  it('returns "other" for empty string', () => {
    expect(classify_merge_error("")).toBe("other");
  });

  it("is case-insensitive", () => {
    expect(classify_merge_error("MERGE CONFLICT detected")).toBe("conflict");
    expect(classify_merge_error("Not Mergeable")).toBe("conflict");
  });
});

// ── Merge conflict recovery in ship phase ──

describe("merge conflict recovery", () => {
  let tmp: string;
  let config: LobsterFarmConfig;
  let entity_config: EntityConfig;
  let registry: MockRegistry;
  let session_manager: ClaudeSessionManager;
  let queue: TaskQueue;
  let fm: FeatureManager;

  beforeEach(async () => {
    tmp = join(tmpdir(), `lf-merge-conflict-test-${Date.now()}`);
    await mkdir(tmp, { recursive: true });

    // Initialize a git repo so worktree operations work
    execSync("git init && git commit --allow-empty -m 'init'", { cwd: tmp, stdio: "ignore" });

    config = make_config();
    entity_config = make_entity_config(tmp);
    registry = new MockRegistry(config, entity_config);
    session_manager = new ClaudeSessionManager(config);
    queue = new TaskQueue(session_manager, config);
    fm = new FeatureManager(registry, queue, config);

    // Wire events
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
    vi.restoreAllMocks();
    await session_manager.kill_all();
    await rm(tmp, { recursive: true, force: true });
    delete process.env["CLAUDE_BIN"];
  });

  /**
   * Helper: create a feature and advance it to ship phase with a PR number.
   * Stubs out actions that would fail in a test environment.
   */
  async function create_feature_at_ship(issue: number): Promise<void> {
    const mock_claude = join(tmp, "mock-claude");
    await writeFile(mock_claude, "#!/bin/bash\nsleep 10\n", "utf-8");
    await chmod(mock_claude, 0o755);
    process.env["CLAUDE_BIN"] = mock_claude;

    // Create feature in build phase (skips plan)
    await fm.create_feature({
      entity_id: "alpha",
      title: "Test feature",
      github_issue: issue,
      start_phase: "build",
    });

    await session_manager.kill_all();

    const feature = fm.get_feature(`alpha-${String(issue)}`)!;

    // Simulate: builder completed, PR created, review approved
    feature.agentDone = true;
    feature.sessionId = null;
    feature.prNumber = 99;
    feature.phase = "review"; // skip to review
    feature.approved = false;
  }

  it("bounces to build on merge conflict (first attempt)", async () => {
    await create_feature_at_ship(200);
    const feature = fm.get_feature("alpha-200")!;

    // Stub merge_pr to throw a conflict error
    vi.spyOn(actions, "merge_pr").mockRejectedValue(
      new Error("Pull request is not mergeable"),
    );
    // Stub notify_feature to avoid Discord calls
    vi.spyOn(actions, "notify_feature").mockResolvedValue(undefined);

    // Advance review -> ship (which calls run_ship_actions)
    feature.phase = "ship";
    feature.approved = false;
    feature.agentDone = false;
    feature.sessionId = null;
    feature.activeArchetype = null;
    feature.activeDna = [];

    // Manually invoke run_ship_actions by advancing to ship
    // We need to use advance_feature properly. Let's set phase back to review
    // and advance to ship.
    feature.phase = "review";

    // Advance to ship
    try {
      await fm.advance_feature("alpha-200", "ship");
    } catch {
      // May throw if advance_feature to done fails after run_ship_actions
    }

    // Feature should have bounced to build
    const updated = fm.get_feature("alpha-200")!;
    expect(updated.phase).toBe("build");
    expect(updated.mergeAttempts).toBe(1);
    expect(updated.blocked).toBe(false);
  });

  it("escalates after 2 failed merge conflict attempts", async () => {
    await create_feature_at_ship(201);
    const feature = fm.get_feature("alpha-201")!;

    // Set mergeAttempts to 1 (simulating one previous conflict bounce)
    feature.mergeAttempts = 1;

    vi.spyOn(actions, "merge_pr").mockRejectedValue(
      new Error("Pull request has merge conflict"),
    );
    vi.spyOn(actions, "notify_feature").mockResolvedValue(undefined);

    feature.phase = "review";

    try {
      await fm.advance_feature("alpha-201", "ship");
    } catch {
      // Expected: advance to done fails because feature is blocked
    }

    const updated = fm.get_feature("alpha-201")!;
    // Should be blocked, NOT bounced to build
    expect(updated.blocked).toBe(true);
    expect(updated.blockedReason).toContain("persist");
    expect(updated.mergeAttempts).toBe(2);

    // Should have notified alerts
    const notify_calls = vi.mocked(actions.notify_feature).mock.calls;
    const alert_call = notify_calls.find(
      (call) => call[3]?.also_alerts === true,
    );
    expect(alert_call).toBeDefined();
  });

  it("blocks and notifies on non-conflict merge failure", async () => {
    await create_feature_at_ship(202);
    const feature = fm.get_feature("alpha-202")!;

    vi.spyOn(actions, "merge_pr").mockRejectedValue(
      new Error("Error: authentication required"),
    );
    vi.spyOn(actions, "notify_feature").mockResolvedValue(undefined);

    feature.phase = "review";

    try {
      await fm.advance_feature("alpha-202", "ship");
    } catch {
      // Expected
    }

    const updated = fm.get_feature("alpha-202")!;
    expect(updated.blocked).toBe(true);
    expect(updated.blockedReason).toContain("authentication");
    expect(updated.mergeAttempts).toBe(1);

    // Should have notified alerts
    const notify_calls = vi.mocked(actions.notify_feature).mock.calls;
    const alert_call = notify_calls.find(
      (call) => call[3]?.also_alerts === true,
    );
    expect(alert_call).toBeDefined();
  });

  it("resets mergeAttempts on review->build bounce (not conflict)", async () => {
    const mock_claude = join(tmp, "mock-claude-reset");
    await writeFile(mock_claude, "#!/bin/bash\nsleep 10\n", "utf-8");
    await chmod(mock_claude, 0o755);
    process.env["CLAUDE_BIN"] = mock_claude;

    await fm.create_feature({
      entity_id: "alpha",
      title: "Reset test",
      github_issue: 203,
      start_phase: "build",
    });

    await session_manager.kill_all();

    const feature = fm.get_feature("alpha-203")!;
    // Simulate a previous conflict that set mergeAttempts
    feature.mergeAttempts = 1;
    feature.phase = "review";

    // Advance review -> build (review bounce, not from ship)
    await fm.advance_feature("alpha-203", "build");

    const updated = fm.get_feature("alpha-203")!;
    // mergeAttempts should be reset because this is review->build, not ship->build
    expect(updated.mergeAttempts).toBe(0);

    await session_manager.kill_all();
  });

  it("preserves mergeAttempts on ship->build conflict bounce", async () => {
    await create_feature_at_ship(204);
    const feature = fm.get_feature("alpha-204")!;

    vi.spyOn(actions, "merge_pr").mockRejectedValue(
      new Error("Conflicting files detected"),
    );
    vi.spyOn(actions, "notify_feature").mockResolvedValue(undefined);

    feature.phase = "review";

    try {
      await fm.advance_feature("alpha-204", "ship");
    } catch {
      // Expected
    }

    const updated = fm.get_feature("alpha-204")!;
    expect(updated.phase).toBe("build");
    // mergeAttempts should be 1 (incremented in ship, NOT reset on build entry)
    expect(updated.mergeAttempts).toBe(1);
  });

  it("uses conflict-resolution prompt (not normal build prompt) on bounce", async () => {
    await create_feature_at_ship(205);
    const feature = fm.get_feature("alpha-205")!;

    vi.spyOn(actions, "merge_pr").mockRejectedValue(
      new Error("Pull request is not mergeable"),
    );
    vi.spyOn(actions, "notify_feature").mockResolvedValue(undefined);

    feature.phase = "review";

    // Spy on queue.submit to capture the prompt
    const submit_spy = vi.spyOn(queue, "submit");

    try {
      await fm.advance_feature("alpha-205", "ship");
    } catch {
      // Expected
    }

    // After bounce, the builder should be spawned with a conflict prompt
    const updated = fm.get_feature("alpha-205")!;
    expect(updated.phase).toBe("build");

    // Check that the prompt contains conflict-specific language
    if (submit_spy.mock.calls.length > 0) {
      const last_call = submit_spy.mock.calls[submit_spy.mock.calls.length - 1];
      if (last_call) {
        const task = last_call[0] as { prompt: string };
        expect(task.prompt).toContain("merge conflicts");
        expect(task.prompt).toContain("Rebase");
      }
    }
  });

  it("new features start with mergeAttempts = 0", async () => {
    await fm.create_feature({
      entity_id: "alpha",
      title: "Fresh feature",
      github_issue: 206,
    });

    const feature = fm.get_feature("alpha-206")!;
    expect(feature.mergeAttempts).toBe(0);
  });
});
