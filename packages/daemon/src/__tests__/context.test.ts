import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LobsterFarmConfig, EntityConfig } from "@lobster-farm/shared";
import { compile_context } from "../context.js";

function make_config(lobsterfarm_dir: string): LobsterFarmConfig {
  return {
    version: 1,
    paths: {
      projects_dir: "/tmp/projects",
      lobsterfarm_dir,
      claude_dir: "/tmp/.claude",
    },
    concurrency: {
      max_active_sessions: 3,
      max_queue_depth: 20,
    },
    defaults: {
      models: {
        planning: { model: "opus", think: "high" },
        design: { model: "opus", think: "standard" },
        building: { model: "opus", think: "high" },
        database: { model: "opus", think: "high" },
        review: { model: "sonnet", think: "standard" },
        operations: { model: "sonnet", think: "standard" },
        triage: { model: "sonnet", think: "standard" },
        classification: { model: "haiku", think: "none" },
      },
    },
    user: { name: "Test User" },
    machine: { name: "test-machine", hardware: "" },
    agents: {
      planner: { name: "Gary" },
      designer: { name: "Pearl" },
      builder: { name: "Bob" },
      operator: { name: "Ray" },
    },
  };
}

function make_entity_config(repo_path: string): EntityConfig {
  return {
    entity: {
      id: "test-entity",
      name: "Test Entity",
      description: "A test entity",
      status: "active",
      repo: {
        url: "https://github.com/test/test-entity",
        path: repo_path,
        structure: "monorepo",
      },
      accounts: {},
      channels: [],
      agent_mode: "hybrid",
      models: {},
      budget: {
        monthly_warning_pct: 80,
        monthly_limit: null,
      },
      memory: {
        path: "~/.lobsterfarm/entities/test-entity/MEMORY.md",
        auto_extract: true,
      },
      active_sops: ["feature-lifecycle"],
      secrets: {
        vault: "1password",
        vault_name: "test-vault",
      },
    },
  };
}

describe("compile_context", () => {
  let tmp_dir: string;
  let repo_dir: string;

  beforeEach(async () => {
    tmp_dir = await mkdtemp(join(tmpdir(), "lf-context-test-"));
    repo_dir = join(tmp_dir, "repo");
    await mkdir(repo_dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp_dir, { recursive: true, force: true });
  });

  it("returns correct paths and content when CLAUDE.md exists", async () => {
    await writeFile(join(repo_dir, "CLAUDE.md"), "# Test CLAUDE.md\nThis is the project context.");

    const lf_dir = join(tmp_dir, "lobsterfarm");
    const config = make_config(lf_dir);
    const entity_config = make_entity_config(repo_dir);

    const result = await compile_context({
      entity_id: "test-entity",
      feature_id: "feat-123",
      github_issue: 42,
      archetype: "builder",
      dna: ["coding-dna", "design-dna"],
      config,
      entity_config,
    });

    expect(result.claude_md_content).toContain("Test CLAUDE.md");
    expect(result.claude_md_content).toContain("This is the project context.");
    expect(result.archetype).toBe("builder");
    expect(result.dna).toEqual(["coding-dna", "design-dna"]);
    expect(result.memory_path).toContain("test-entity");
    expect(result.memory_path).toContain("MEMORY.md");
    expect(result.worktree_path).toBe(repo_dir);
  });

  it("computes today and yesterday daily log paths correctly", async () => {
    const lf_dir = join(tmp_dir, "lobsterfarm");
    const config = make_config(lf_dir);
    const entity_config = make_entity_config(repo_dir);

    const result = await compile_context({
      entity_id: "test-entity",
      feature_id: "feat-123",
      github_issue: 42,
      archetype: "planner",
      dna: ["planning-dna"],
      config,
      entity_config,
    });

    expect(result.daily_log_paths).toHaveLength(2);

    // Both paths should be in the entity daily dir
    for (const path of result.daily_log_paths) {
      expect(path).toContain("test-entity");
      expect(path).toContain("daily");
      expect(path).toMatch(/\d{4}-\d{2}-\d{2}\.md$/);
    }

    // First should be today, second should be yesterday
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const format_date = (d: Date): string => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${String(y)}-${m}-${day}`;
    };

    expect(result.daily_log_paths[0]).toContain(format_date(today));
    expect(result.daily_log_paths[1]).toContain(format_date(yesterday));
  });

  it("handles missing CLAUDE.md gracefully", async () => {
    // Do NOT create CLAUDE.md in repo_dir
    const lf_dir = join(tmp_dir, "lobsterfarm");
    const config = make_config(lf_dir);
    const entity_config = make_entity_config(repo_dir);

    const result = await compile_context({
      entity_id: "test-entity",
      feature_id: "feat-456",
      github_issue: 99,
      archetype: "designer",
      dna: ["design-dna"],
      config,
      entity_config,
    });

    // Should not throw, should indicate missing file
    expect(result.claude_md_content).toContain("not found");
    expect(result.claude_md_content).toContain("CLAUDE.md");
    expect(result.archetype).toBe("designer");
  });
});
