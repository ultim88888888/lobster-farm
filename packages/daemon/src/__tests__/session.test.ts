import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import { ClaudeSessionManager } from "../session.js";
import { build_model_flags } from "../models.js";

function make_config(overrides?: Partial<LobsterFarmConfig>): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    ...overrides,
  });
}

describe("build_model_flags", () => {
  it("maps opus/high to correct flags", () => {
    const flags = build_model_flags({ model: "opus", think: "high" });
    expect(flags).toContain("--model");
    expect(flags).toContain("claude-opus-4-6");
    expect(flags).toContain("--effort");
    expect(flags).toContain("high");
  });

  it("maps sonnet/standard to correct flags", () => {
    const flags = build_model_flags({ model: "sonnet", think: "standard" });
    expect(flags).toContain("claude-sonnet-4-6");
    expect(flags).toContain("medium");
  });

  it("maps haiku/none to model only", () => {
    const flags = build_model_flags({ model: "haiku", think: "none" });
    expect(flags).toContain("claude-haiku-4-5-20251001");
    expect(flags).toContain("--effort");
    expect(flags).toContain("low");
  });
});

describe("ClaudeSessionManager", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = join(tmpdir(), `lf-session-test-${Date.now()}`);
    await mkdir(tmp, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  describe("build_command", () => {
    it("builds correct CLI arguments for autonomous mode", () => {
      const config = make_config();
      const mgr = new ClaudeSessionManager(config);

      const { args } = mgr.build_command({
        entity_id: "alpha",
        feature_id: "alpha-42",
        archetype: "builder",
        dna: ["coding-dna"],
        model: { model: "opus", think: "high" },
        worktree_path: "/repos/alpha",
        prompt: "Build feature #42",
        interactive: false,
      });

      expect(args).toContain("-p");
      expect(args).toContain("--output-format");
      expect(args).toContain("stream-json");
      expect(args).toContain("--agent");
      expect(args).toContain("bob"); // default builder name
      expect(args).toContain("--model");
      expect(args).toContain("claude-opus-4-6");
      expect(args).toContain("--permission-mode");
      expect(args).toContain("bypassPermissions");
      expect(args).toContain("--session-id");
      expect(args).toContain("--append-system-prompt");
      expect(args).toContain("--add-dir");
      expect(args).toContain("Build feature #42");
    });

    it("uses custom agent names from config", () => {
      const config = make_config({
        agents: {
          planner: { name: "Planny" },
          designer: { name: "Desi" },
          builder: { name: "Buildo" },
          operator: { name: "Opsy" },
        },
      });
      const mgr = new ClaudeSessionManager(config);

      const { args: planner_args } = mgr.build_command({
        entity_id: "alpha",
        feature_id: "alpha-1",
        archetype: "planner",
        dna: ["planning-dna"],
        model: { model: "opus", think: "high" },
        worktree_path: "/repos/alpha",
        prompt: "Plan feature #1",
        interactive: false,
      });

      const agent_idx = planner_args.indexOf("--agent");
      expect(planner_args[agent_idx + 1]).toBe("planny");

      const { args: builder_args } = mgr.build_command({
        entity_id: "alpha",
        feature_id: "alpha-2",
        archetype: "builder",
        dna: ["coding-dna"],
        model: { model: "opus", think: "high" },
        worktree_path: "/repos/alpha",
        prompt: "Build feature #2",
        interactive: false,
      });

      const builder_agent_idx = builder_args.indexOf("--agent");
      expect(builder_args[builder_agent_idx + 1]).toBe("buildo");
    });

    it("always uses 'reviewer' name for reviewer archetype", () => {
      const config = make_config();
      const mgr = new ClaudeSessionManager(config);

      const { args } = mgr.build_command({
        entity_id: "alpha",
        feature_id: "alpha-1",
        archetype: "reviewer",
        dna: ["review-dna"],
        model: { model: "sonnet", think: "standard" },
        worktree_path: "/repos/alpha",
        prompt: "Review PR #1",
        interactive: false,
      });

      const agent_idx = args.indexOf("--agent");
      expect(args[agent_idx + 1]).toBe("reviewer");
    });
  });

  describe("spawn with mock binary", () => {
    it("spawns a process and tracks it", async () => {
      // Create a mock "claude" script that just echoes and exits
      const mock_claude = join(tmp, "mock-claude");
      await writeFile(
        mock_claude,
        '#!/bin/bash\necho \'{"type":"result","content":"done"}\'\nexit 0\n',
        "utf-8",
      );
      await chmod(mock_claude, 0o755);

      const config = make_config();
      const mgr = new ClaudeSessionManager(config);

      // Override the claude binary via env
      process.env["CLAUDE_BIN"] = mock_claude;

      const completed = new Promise<void>((resolve) => {
        mgr.on("session:completed", () => resolve());
      });

      const session = await mgr.spawn({
        entity_id: "alpha",
        feature_id: "alpha-42",
        archetype: "builder",
        dna: ["coding-dna"],
        model: { model: "opus", think: "high" },
        worktree_path: tmp,
        prompt: "test prompt",
        interactive: false,
      });

      expect(session.session_id).toBeTruthy();
      expect(session.entity_id).toBe("alpha");
      expect(session.pid).toBeGreaterThan(0);

      // Wait for completion
      await completed;

      // After completion, session should be cleaned up
      expect(mgr.get_active()).toHaveLength(0);

      delete process.env["CLAUDE_BIN"];
    });

    it("rejects interactive mode", async () => {
      const config = make_config();
      const mgr = new ClaudeSessionManager(config);

      await expect(
        mgr.spawn({
          entity_id: "alpha",
          feature_id: "alpha-42",
          archetype: "builder",
          dna: [],
          model: { model: "opus", think: "high" },
          worktree_path: tmp,
          prompt: "test",
          interactive: true,
        }),
      ).rejects.toThrow("Interactive sessions are not yet implemented");
    });

    it("emits session:failed on non-zero exit", async () => {
      const mock_claude = join(tmp, "mock-claude-fail");
      await writeFile(mock_claude, "#!/bin/bash\nexit 1\n", "utf-8");
      await chmod(mock_claude, 0o755);

      const config = make_config();
      const mgr = new ClaudeSessionManager(config);
      process.env["CLAUDE_BIN"] = mock_claude;

      const failed = new Promise<string>((resolve) => {
        mgr.on("session:failed", (_id: string, error: string) => resolve(error));
      });

      await mgr.spawn({
        entity_id: "alpha",
        feature_id: "alpha-42",
        archetype: "builder",
        dna: [],
        model: { model: "opus", think: "high" },
        worktree_path: tmp,
        prompt: "test",
        interactive: false,
      });

      const error = await failed;
      expect(error).toContain("exited with code 1");
      expect(mgr.get_active()).toHaveLength(0);

      delete process.env["CLAUDE_BIN"];
    });
  });

  describe("session queries", () => {
    it("get_by_entity and get_by_feature work", async () => {
      const mock_claude = join(tmp, "mock-claude-slow");
      // This script sleeps so the session stays active
      await writeFile(mock_claude, "#!/bin/bash\nsleep 10\n", "utf-8");
      await chmod(mock_claude, 0o755);

      const config = make_config();
      const mgr = new ClaudeSessionManager(config);
      process.env["CLAUDE_BIN"] = mock_claude;

      const session = await mgr.spawn({
        entity_id: "alpha",
        feature_id: "alpha-42",
        archetype: "builder",
        dna: [],
        model: { model: "opus", think: "high" },
        worktree_path: tmp,
        prompt: "test",
        interactive: false,
      });

      expect(mgr.get_active()).toHaveLength(1);
      expect(mgr.get_by_entity("alpha")).toHaveLength(1);
      expect(mgr.get_by_entity("beta")).toHaveLength(0);
      expect(mgr.get_by_feature("alpha-42")).toBeTruthy();
      expect(mgr.get_by_feature("alpha-99")).toBeNull();

      // Clean up
      await mgr.kill(session.session_id);
      expect(mgr.get_active()).toHaveLength(0);

      delete process.env["CLAUDE_BIN"];
    });
  });
});
