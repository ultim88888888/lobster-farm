import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parse_worktree_list,
  remove_worktree,
  find_worktree_for_branch,
  cleanup_after_merge,
  sweep_stale_worktrees,
} from "../worktree-cleanup.js";

// ── Mock child_process.execFile ──

const mock_exec_file = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => {
    // The promisified version passes a callback as the last arg
    const callback = args[args.length - 1];
    if (typeof callback === "function") {
      const result = mock_exec_file(args[0], args[1], args[2]);
      if (result instanceof Error) {
        callback(result, "", result.message);
      } else {
        callback(null, { stdout: result ?? "", stderr: "" });
      }
    }
    return undefined;
  },
}));

// ── Mock fs operations ──

const mock_stat = vi.fn();
const mock_readdir = vi.fn();

vi.mock("node:fs/promises", () => ({
  stat: (...args: unknown[]) => mock_stat(...args),
  readdir: (...args: unknown[]) => mock_readdir(...args),
}));

// ── Mock sentry (no-op) ──

vi.mock("../sentry.js", () => ({
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

// ── Helpers ──

/** Build porcelain output for git worktree list. */
function make_porcelain(...entries: Array<{
  path: string;
  head?: string;
  branch?: string;
  bare?: boolean;
}>): string {
  return entries.map((e) => {
    const lines = [`worktree ${e.path}`];
    lines.push(`HEAD ${e.head ?? "abc1234567890"}`);
    if (e.branch) lines.push(`branch ${e.branch}`);
    if (e.bare) lines.push("bare");
    return lines.join("\n");
  }).join("\n\n");
}

/**
 * Configure mock_exec_file to handle specific git commands.
 * Returns a chainable builder for easy test setup.
 */
function setup_git_mocks(opts: {
  worktree_list?: string;
  worktree_remove_error?: Error;
  branch_delete_error?: Error;
  merged_branches?: string;
  fetch_error?: Error;
  rev_parse_missing?: string[]; // branches whose remote ref is gone
} = {}): void {
  mock_exec_file.mockImplementation((cmd: string, args: string[], _opts: unknown) => {
    if (cmd !== "git") return "";

    const subcmd = args[0];

    if (subcmd === "worktree") {
      if (args[1] === "list") {
        return opts.worktree_list ?? "";
      }
      if (args[1] === "remove") {
        if (opts.worktree_remove_error) throw opts.worktree_remove_error;
        return "";
      }
      if (args[1] === "prune") {
        return "";
      }
    }

    if (subcmd === "branch") {
      if (args[1] === "-d") {
        if (opts.branch_delete_error) throw opts.branch_delete_error;
        return "";
      }
      if (args[1] === "--merged") {
        return opts.merged_branches ?? "";
      }
    }

    if (subcmd === "fetch") {
      if (opts.fetch_error) throw opts.fetch_error;
      return "";
    }

    if (subcmd === "rev-parse") {
      // args: ["rev-parse", "--verify", "refs/remotes/origin/<branch>"]
      const ref = args[2] ?? "";
      const branch = ref.replace("refs/remotes/origin/", "");
      if (opts.rev_parse_missing?.includes(branch)) {
        throw new Error(`fatal: Needed a single revision`);
      }
      return "abc123";
    }

    return "";
  });
}

// ── Tests ──

beforeEach(() => {
  vi.clearAllMocks();
  mock_stat.mockResolvedValue({ isDirectory: () => true });
  mock_readdir.mockResolvedValue([]);
});

describe("parse_worktree_list", () => {
  it("parses a single main worktree", () => {
    const output = [
      "worktree /repo",
      "HEAD abc123",
      "branch refs/heads/main",
    ].join("\n");

    const entries = parse_worktree_list(output);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      path: "/repo",
      head: "abc123",
      branch: "refs/heads/main",
      bare: false,
    });
  });

  it("parses multiple worktrees including a detached head", () => {
    const output = [
      "worktree /repo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /repo/worktrees/feature-foo",
      "HEAD def456",
      "branch refs/heads/feature/foo",
      "",
      "worktree /repo/worktrees/detached",
      "HEAD 789abc",
      "detached",
    ].join("\n");

    const entries = parse_worktree_list(output);
    expect(entries).toHaveLength(3);
    expect(entries[1]!.branch).toBe("refs/heads/feature/foo");
    expect(entries[2]!.branch).toBeNull();
  });

  it("handles empty output", () => {
    expect(parse_worktree_list("")).toEqual([]);
    expect(parse_worktree_list("  ")).toEqual([]);
  });

  it("recognizes bare worktree entries", () => {
    const output = [
      "worktree /repo",
      "HEAD abc123",
      "bare",
    ].join("\n");

    const entries = parse_worktree_list(output);
    expect(entries[0]!.bare).toBe(true);
  });
});

describe("remove_worktree", () => {
  it("removes worktree and deletes branch on success", async () => {
    setup_git_mocks();

    const result = await remove_worktree("/repo", "/repo/worktrees/foo", "feature/foo");

    expect(result).toBe(true);
    // Verify git worktree remove was called
    expect(mock_exec_file).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "/repo/worktrees/foo", "--force"],
      expect.objectContaining({ cwd: "/repo" }),
    );
    // Verify git branch -d was called
    expect(mock_exec_file).toHaveBeenCalledWith(
      "git",
      ["branch", "-d", "feature/foo"],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("returns true when worktree is already gone", async () => {
    setup_git_mocks({
      worktree_remove_error: new Error("not a working tree"),
    });

    const result = await remove_worktree("/repo", "/repo/worktrees/gone", "feature/gone");

    expect(result).toBe(true);
  });

  it("returns false on unexpected worktree remove error", async () => {
    setup_git_mocks({
      worktree_remove_error: new Error("permission denied"),
    });

    const result = await remove_worktree("/repo", "/repo/worktrees/locked", "feature/locked");

    expect(result).toBe(false);
  });

  it("handles branch already deleted gracefully", async () => {
    setup_git_mocks({
      branch_delete_error: new Error("error: branch 'feature/gone' not found"),
    });

    const result = await remove_worktree("/repo", "/repo/worktrees/foo", "feature/gone");

    expect(result).toBe(true); // worktree removal succeeded
  });
});

describe("find_worktree_for_branch", () => {
  it("finds worktree matching the branch", async () => {
    const porcelain = make_porcelain(
      { path: "/repo", branch: "refs/heads/main" },
      { path: "/repo/worktrees/auto-cleanup", branch: "refs/heads/feature/134-auto-cleanup" },
    );
    setup_git_mocks({ worktree_list: porcelain });

    const result = await find_worktree_for_branch("/repo", "feature/134-auto-cleanup");

    expect(result).toBe("/repo/worktrees/auto-cleanup");
  });

  it("returns null when no worktree matches", async () => {
    const porcelain = make_porcelain(
      { path: "/repo", branch: "refs/heads/main" },
    );
    setup_git_mocks({ worktree_list: porcelain });

    const result = await find_worktree_for_branch("/repo", "feature/nonexistent");

    expect(result).toBeNull();
  });

  it("returns null on git command failure", async () => {
    mock_exec_file.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    const result = await find_worktree_for_branch("/not-a-repo", "feature/foo");

    expect(result).toBeNull();
  });
});

describe("cleanup_after_merge", () => {
  it("removes worktree and branch when found", async () => {
    const porcelain = make_porcelain(
      { path: "/repo", branch: "refs/heads/main" },
      { path: "/repo/worktrees/my-feature", branch: "refs/heads/feature/my-feature" },
    );
    setup_git_mocks({ worktree_list: porcelain });

    await cleanup_after_merge("/repo", "feature/my-feature");

    // Should have called worktree remove
    expect(mock_exec_file).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "/repo/worktrees/my-feature", "--force"],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("still tries to delete branch when no worktree is found", async () => {
    setup_git_mocks({ worktree_list: make_porcelain({ path: "/repo", branch: "refs/heads/main" }) });

    await cleanup_after_merge("/repo", "feature/orphan");

    // Should have tried to delete the branch directly
    expect(mock_exec_file).toHaveBeenCalledWith(
      "git",
      ["branch", "-d", "feature/orphan"],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("scans .claude/worktrees/ for matching agent directories", async () => {
    setup_git_mocks({ worktree_list: make_porcelain({ path: "/repo", branch: "refs/heads/main" }) });

    // Simulate .claude/worktrees/ directory with a matching entry
    mock_stat.mockResolvedValue({ isDirectory: () => true });
    mock_readdir.mockImplementation(async (dir: string) => {
      if (dir.includes(".claude/worktrees")) {
        return [
          { name: "agent-134-auto-cleanup", isDirectory: () => true },
          { name: "agent-999-other", isDirectory: () => true },
        ];
      }
      return [];
    });

    await cleanup_after_merge("/repo", "feature/134-auto-cleanup");

    // Should have tried to remove the matching .claude/worktrees/ entry
    expect(mock_exec_file).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "/repo/.claude/worktrees/agent-134-auto-cleanup", "--force"],
      expect.objectContaining({ cwd: "/repo" }),
    );

    // Should NOT have tried to remove the non-matching entry
    const remove_calls = mock_exec_file.mock.calls.filter(
      (c: unknown[]) => (c[1] as string[])[1] === "remove",
    );
    const removed_paths = remove_calls.map((c: unknown[]) => (c[1] as string[])[2]);
    expect(removed_paths).not.toContain("/repo/.claude/worktrees/agent-999-other");
  });

  it("does not throw when .claude/worktrees/ does not exist", async () => {
    setup_git_mocks({ worktree_list: make_porcelain({ path: "/repo", branch: "refs/heads/main" }) });
    mock_stat.mockImplementation(async (path: string) => {
      if (path.includes(".claude/worktrees")) throw new Error("ENOENT");
      return { isDirectory: () => true };
    });

    // Should complete without throwing
    await expect(cleanup_after_merge("/repo", "feature/foo")).resolves.toBeUndefined();
  });
});

describe("sweep_stale_worktrees", () => {
  it("cleans up worktrees whose branch is merged into main", async () => {
    const porcelain = make_porcelain(
      { path: "/repo", branch: "refs/heads/main" },
      { path: "/repo/worktrees/done", branch: "refs/heads/feature/done" },
      { path: "/repo/worktrees/active", branch: "refs/heads/feature/active" },
    );
    setup_git_mocks({
      worktree_list: porcelain,
      merged_branches: "  feature/done\n  some-other-branch\n",
      rev_parse_missing: [], // both have remote refs
    });

    const registry = {
      get_active: vi.fn().mockReturnValue([
        {
          entity: {
            id: "test-entity",
            repos: [{ path: "/repo", url: "https://github.com/test/repo.git" }],
          },
        },
      ]),
    };

    await sweep_stale_worktrees(registry as any);

    // Should remove the merged worktree
    expect(mock_exec_file).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "/repo/worktrees/done", "--force"],
      expect.objectContaining({ cwd: "/repo" }),
    );

    // Should NOT remove the active worktree
    const remove_calls = mock_exec_file.mock.calls.filter(
      (c: unknown[]) =>
        (c[0] as string) === "git" &&
        (c[1] as string[])[0] === "worktree" &&
        (c[1] as string[])[1] === "remove",
    );
    const removed_paths = remove_calls.map((c: unknown[]) => (c[1] as string[])[2]);
    expect(removed_paths).not.toContain("/repo/worktrees/active");
  });

  it("cleans up worktrees whose remote tracking ref is gone", async () => {
    const porcelain = make_porcelain(
      { path: "/repo", branch: "refs/heads/main" },
      { path: "/repo/worktrees/orphan", branch: "refs/heads/feature/orphan" },
    );
    setup_git_mocks({
      worktree_list: porcelain,
      merged_branches: "", // not merged
      rev_parse_missing: ["feature/orphan"], // remote ref gone
    });

    const registry = {
      get_active: vi.fn().mockReturnValue([
        {
          entity: {
            id: "test-entity",
            repos: [{ path: "/repo", url: "https://github.com/test/repo.git" }],
          },
        },
      ]),
    };

    await sweep_stale_worktrees(registry as any);

    // Should remove the orphaned worktree
    expect(mock_exec_file).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "/repo/worktrees/orphan", "--force"],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("skips repos that do not exist on disk", async () => {
    mock_stat.mockRejectedValue(new Error("ENOENT"));
    setup_git_mocks();

    const registry = {
      get_active: vi.fn().mockReturnValue([
        {
          entity: {
            id: "test-entity",
            repos: [{ path: "/nonexistent", url: "https://github.com/test/repo.git" }],
          },
        },
      ]),
    };

    // Should complete without error
    await expect(sweep_stale_worktrees(registry as any)).resolves.toBeUndefined();

    // Should not have called any git commands
    expect(mock_exec_file).not.toHaveBeenCalled();
  });

  it("never removes the main worktree", async () => {
    const porcelain = make_porcelain(
      { path: "/repo", branch: "refs/heads/main" },
    );
    setup_git_mocks({
      worktree_list: porcelain,
      merged_branches: "  main\n",
    });

    const registry = {
      get_active: vi.fn().mockReturnValue([
        {
          entity: {
            id: "test-entity",
            repos: [{ path: "/repo", url: "https://github.com/test/repo.git" }],
          },
        },
      ]),
    };

    await sweep_stale_worktrees(registry as any);

    // Should NOT have called worktree remove at all
    const remove_calls = mock_exec_file.mock.calls.filter(
      (c: unknown[]) =>
        (c[0] as string) === "git" &&
        (c[1] as string[])[0] === "worktree" &&
        (c[1] as string[])[1] === "remove",
    );
    expect(remove_calls).toHaveLength(0);
  });

  it("handles empty entity list gracefully", async () => {
    const registry = {
      get_active: vi.fn().mockReturnValue([]),
    };

    await expect(sweep_stale_worktrees(registry as any)).resolves.toBeUndefined();
  });
});
