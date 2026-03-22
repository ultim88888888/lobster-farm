import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  expand_home,
  lobsterfarm_dir,
  claude_dir,
  projects_dir,
  entity_dir,
  entity_memory_path,
  entity_daily_dir,
  entity_repo_path,
  entity_worktree_path,
  pid_file_path,
  agents_dir,
  skills_dir,
  sop_dir,
} from "../paths.js";

const home = homedir();

describe("expand_home", () => {
  it("expands ~ to home directory", () => {
    expect(expand_home("~/projects")).toBe(join(home, "projects"));
  });

  it("expands bare ~", () => {
    expect(expand_home("~")).toBe(home);
  });

  it("leaves absolute paths unchanged", () => {
    expect(expand_home("/usr/local/bin")).toBe("/usr/local/bin");
  });
});

describe("global paths with defaults", () => {
  it("returns default lobsterfarm dir", () => {
    expect(lobsterfarm_dir()).toBe(join(home, ".lobsterfarm"));
  });

  it("returns default claude dir", () => {
    expect(claude_dir()).toBe(join(home, ".claude"));
  });

  it("returns default projects dir", () => {
    expect(projects_dir()).toBe(join(home, "projects"));
  });
});

describe("global paths with custom config", () => {
  const custom = {
    projects_dir: "/data/projects",
    lobsterfarm_dir: "/data/lobsterfarm",
    claude_dir: "/data/claude",
  };

  it("respects custom lobsterfarm dir", () => {
    expect(lobsterfarm_dir(custom)).toBe("/data/lobsterfarm");
  });

  it("respects custom projects dir", () => {
    expect(projects_dir(custom)).toBe("/data/projects");
  });
});

describe("entity paths", () => {
  it("computes entity directory", () => {
    expect(entity_dir(undefined, "alpha")).toBe(
      join(home, ".lobsterfarm", "entities", "alpha"),
    );
  });

  it("computes entity memory path", () => {
    expect(entity_memory_path(undefined, "alpha")).toBe(
      join(home, ".lobsterfarm", "entities", "alpha", "MEMORY.md"),
    );
  });

  it("computes entity daily dir", () => {
    expect(entity_daily_dir(undefined, "alpha")).toBe(
      join(home, ".lobsterfarm", "entities", "alpha", "daily"),
    );
  });

  it("computes entity repo path", () => {
    expect(entity_repo_path(undefined, "alpha", "alpha-platform")).toBe(
      join(home, "projects", "alpha", "alpha-platform"),
    );
  });

  it("computes entity worktree path", () => {
    expect(
      entity_worktree_path(undefined, "alpha", "alpha-platform", "42-chart"),
    ).toBe(
      join(home, "projects", "alpha", "alpha-platform", "worktrees", "42-chart"),
    );
  });
});

describe("claude paths", () => {
  it("computes agents dir", () => {
    expect(agents_dir()).toBe(join(home, ".claude", "agents"));
  });

  it("computes skills dir", () => {
    expect(skills_dir()).toBe(join(home, ".claude", "skills"));
  });
});

describe("daemon paths", () => {
  it("computes PID file path", () => {
    expect(pid_file_path()).toBe(join(home, ".lobsterfarm", "lobsterfarm.pid"));
  });

  it("computes SOP dir", () => {
    expect(sop_dir()).toBe(join(home, ".lobsterfarm", "sops"));
  });
});
