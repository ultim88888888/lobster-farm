import { describe, expect, it, beforeEach, afterEach } from "vitest";
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

/** Create a mock registry with one entity. */
class MockRegistry extends EntityRegistry {
  private mock_entity: EntityConfig;

  constructor(config: LobsterFarmConfig, entity: EntityConfig) {
    super(config);
    this.mock_entity = entity;
  }

  override async load_all(): Promise<void> {
    // no-op
  }

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

describe("FeatureManager", () => {
  let tmp: string;
  let config: LobsterFarmConfig;
  let entity_config: EntityConfig;
  let registry: MockRegistry;
  let session_manager: ClaudeSessionManager;
  let queue: TaskQueue;
  let fm: FeatureManager;

  beforeEach(async () => {
    tmp = join(tmpdir(), `lf-features-test-${Date.now()}`);
    await mkdir(tmp, { recursive: true });

    // Initialize a git repo so worktree operations work
    execSync("git init && git commit --allow-empty -m 'init'", { cwd: tmp, stdio: "ignore" });

    config = make_config();
    entity_config = make_entity_config(tmp);
    registry = new MockRegistry(config, entity_config);
    session_manager = new ClaudeSessionManager(config);
    queue = new TaskQueue(session_manager, config);
    fm = new FeatureManager(registry, queue, config);

    // Wire events (same as daemon index.ts)
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
    await session_manager.kill_all();
    await rm(tmp, { recursive: true, force: true });
    delete process.env["CLAUDE_BIN"];
  });

  describe("create_feature", () => {
    it("creates a feature in plan phase", () => {
      const feature = fm.create_feature({
        entity_id: "alpha",
        title: "Custom Charts",
        github_issue: 42,
      });

      expect(feature.id).toBe("alpha-42");
      expect(feature.phase).toBe("plan");
      expect(feature.entity).toBe("alpha");
      expect(feature.branch).toBe("feature/42-custom-charts");
      expect(feature.approved).toBe(false);
      expect(feature.agentDone).toBe(false);
    });

    it("rejects unknown entity", () => {
      expect(() =>
        fm.create_feature({
          entity_id: "unknown",
          title: "Test",
          github_issue: 1,
        }),
      ).toThrow('Entity "unknown" not found');
    });
  });

  describe("approve_phase", () => {
    it("approves a gated phase", () => {
      fm.create_feature({ entity_id: "alpha", title: "Test", github_issue: 1 });
      const approved = fm.approve_phase("alpha-1");
      expect(approved.approved).toBe(true);
    });

    it("rejects approval on non-gated phase", async () => {
      const mock_claude = join(tmp, "mock-claude");
      await writeFile(mock_claude, "#!/bin/bash\nsleep 10\n", "utf-8");
      await chmod(mock_claude, 0o755);
      process.env["CLAUDE_BIN"] = mock_claude;

      fm.create_feature({ entity_id: "alpha", title: "Test", github_issue: 2 });
      fm.approve_phase("alpha-2");
      await fm.advance_feature("alpha-2"); // plan → build

      expect(() => fm.approve_phase("alpha-2")).toThrow("does not require approval");

      await session_manager.kill_all();
    });
  });

  describe("advance_feature", () => {
    it("requires approval before advancing from plan", async () => {
      fm.create_feature({ entity_id: "alpha", title: "Test", github_issue: 3 });

      await expect(fm.advance_feature("alpha-3")).rejects.toThrow(
        "requires approval",
      );
    });

    it("advances from plan to build (skipping design when no UI labels)", async () => {
      const mock_claude = join(tmp, "mock-claude");
      await writeFile(mock_claude, "#!/bin/bash\nsleep 10\n", "utf-8");
      await chmod(mock_claude, 0o755);
      process.env["CLAUDE_BIN"] = mock_claude;

      fm.create_feature({ entity_id: "alpha", title: "API endpoint", github_issue: 4 });
      fm.approve_phase("alpha-4");

      const feature = await fm.advance_feature("alpha-4");
      expect(feature.phase).toBe("build");
      expect(feature.approved).toBe(false); // reset for new phase
      expect(feature.activeArchetype).toBe("builder");

      await session_manager.kill_all();
    });

    it("advances from plan to design when UI labels present", async () => {
      const mock_claude = join(tmp, "mock-claude");
      await writeFile(mock_claude, "#!/bin/bash\nsleep 10\n", "utf-8");
      await chmod(mock_claude, 0o755);
      process.env["CLAUDE_BIN"] = mock_claude;

      fm.create_feature({
        entity_id: "alpha",
        title: "Dashboard UI",
        github_issue: 5,
        labels: ["frontend", "ui"],
      });
      fm.approve_phase("alpha-5");

      const feature = await fm.advance_feature("alpha-5");
      expect(feature.phase).toBe("design");
      expect(feature.activeArchetype).toBe("designer");

      await session_manager.kill_all();
    });

    it("rejects invalid transitions", async () => {
      fm.create_feature({ entity_id: "alpha", title: "Test", github_issue: 6 });
      fm.approve_phase("alpha-6");

      await expect(
        fm.advance_feature("alpha-6", "ship"),
      ).rejects.toThrow("Invalid transition: plan → ship");
    });

    it("rejects advancing a blocked feature", async () => {
      fm.create_feature({ entity_id: "alpha", title: "Test", github_issue: 7 });
      fm.approve_phase("alpha-7");

      const feature = fm.get_feature("alpha-7")!;
      feature.blocked = true;
      feature.blockedReason = "tests failed";

      await expect(fm.advance_feature("alpha-7")).rejects.toThrow("blocked");
    });
  });

  describe("session lifecycle integration", () => {
    it("auto-advances build→review when session completes", async () => {
      const mock_claude = join(tmp, "mock-claude-fast");
      await writeFile(
        mock_claude,
        '#!/bin/bash\necho \'{"done":true}\'\nexit 0\n',
        "utf-8",
      );
      await chmod(mock_claude, 0o755);
      process.env["CLAUDE_BIN"] = mock_claude;

      fm.create_feature({ entity_id: "alpha", title: "Fast feature", github_issue: 8 });
      fm.approve_phase("alpha-8");
      await fm.advance_feature("alpha-8"); // → build, spawns agent

      // Wait for session to complete and auto-advance
      // Use a longer timeout and poll to see the actual state
      let advanced = false;
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const f = fm.get_feature("alpha-8")!;
        if (f.phase !== "build") {
          advanced = true;
          break;
        }
      }

      const feature = fm.get_feature("alpha-8")!;
      // Build phase has no approval gate, so on session completion
      // it should auto-advance past build.
      expect(advanced).toBe(true);
      expect(feature.phase).not.toBe("build");
    });

    it("blocks feature on session failure", async () => {
      const mock_claude = join(tmp, "mock-claude-fail");
      await writeFile(mock_claude, "#!/bin/bash\nexit 1\n", "utf-8");
      await chmod(mock_claude, 0o755);
      process.env["CLAUDE_BIN"] = mock_claude;

      fm.create_feature({ entity_id: "alpha", title: "Failing feature", github_issue: 9 });
      fm.approve_phase("alpha-9");
      await fm.advance_feature("alpha-9"); // → build, spawns agent

      // Wait for session failure
      await new Promise((r) => setTimeout(r, 500));

      const feature = fm.get_feature("alpha-9")!;
      expect(feature.blocked).toBe(true);
      expect(feature.blockedReason).toContain("exited with code 1");
    });
  });

  describe("queries", () => {
    it("lists features by entity", () => {
      fm.create_feature({ entity_id: "alpha", title: "A", github_issue: 10 });
      fm.create_feature({ entity_id: "alpha", title: "B", github_issue: 11 });

      expect(fm.get_features_by_entity("alpha")).toHaveLength(2);
      expect(fm.get_features_by_entity("beta")).toHaveLength(0);
    });

    it("lists all features", () => {
      fm.create_feature({ entity_id: "alpha", title: "A", github_issue: 12 });
      expect(fm.list_features()).toHaveLength(1);
    });

    it("gets feature by ID", () => {
      fm.create_feature({ entity_id: "alpha", title: "Lookup", github_issue: 13 });
      expect(fm.get_feature("alpha-13")).toBeTruthy();
      expect(fm.get_feature("alpha-999")).toBeUndefined();
    });
  });

  describe("unblock_feature", () => {
    it("clears blocked state", () => {
      fm.create_feature({ entity_id: "alpha", title: "Stuck", github_issue: 14 });
      const feature = fm.get_feature("alpha-14")!;
      feature.blocked = true;
      feature.blockedReason = "test failure";

      const unblocked = fm.unblock_feature("alpha-14");
      expect(unblocked.blocked).toBe(false);
      expect(unblocked.blockedReason).toBeNull();
    });
  });
});
