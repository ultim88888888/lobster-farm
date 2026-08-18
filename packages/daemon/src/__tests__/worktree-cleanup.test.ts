import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup_after_merge,
  find_worktree_for_branch,
  parse_worktree_list,
  relocate_sessions_from_path,
  remove_worktree,
  sweep_stale_worktrees,
} from "../worktree-cleanup.js";

// ── Mock child_process.execFile and execFileSync ──

const mock_exec_file = vi.fn();
const mock_exec_file_sync = vi.fn();

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
  execFileSync: (...args: unknown[]) => {
    return mock_exec_file_sync(args[0], args[1], args[2]);
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
function make_porcelain(
  ...entries: Array<{
    path: string;
    head?: string;
    branch?: string;
    bare?: boolean;
    locked?: boolean;
    locked_reason?: string;
  }>
): string {
  return entries
    .map((e) => {
      const lines = [`worktree ${e.path}`];
      lines.push(`HEAD ${e.head ?? "abc1234567890"}`);
      if (e.branch) lines.push(`branch ${e.branch}`);
      if (e.bare) lines.push("bare");
      if (e.locked_reason) lines.push(`locked ${e.locked_reason}`);
      else if (e.locked) lines.push("locked");
      return lines.join("\n");
    })
    .join("\n\n");
}

/**
 * An execFile-style failure: git exited non-zero, and `code` carries the exit
 * status. The sweep distinguishes git's documented "no, and here is a clean
 * exit code" answers from "the command blew up", so mocks have to as well.
 */
function git_exit(code: number, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** Timestamps old enough that the sweep's grace period has lapsed. */
const OLD_MTIME = Date.now() - 24 * 60 * 60 * 1000;

/**
 * State of an individual worktree directory, keyed by path in `trees`.
 * Drives the git commands the protection guard runs with `cwd: <worktree>`.
 */
interface TreeState {
  /** `git status --porcelain` output. Non-empty means a dirty working tree. */
  status?: string;
  /** Upstream ref name, or undefined for "no upstream configured". */
  upstream?: string;
  /** Count returned by `git rev-list --count <base>..HEAD`. */
  unpushed?: number;
  /** `git rev-parse --show-prefix` output. Non-empty means not a worktree root. */
  prefix?: string;
  /** If set, every git command run inside this worktree throws it. */
  error?: Error;
  /** If set, only `git status --porcelain` throws it. */
  status_error?: Error;
}

/**
 * Configure mock_exec_file to handle specific git commands.
 *
 * Commands are dispatched on the subcommand plus `opts.cwd` — the guard runs
 * its checks inside the worktree directory, so per-worktree state comes from
 * `trees[cwd]`. Defaults describe a clean, fully-pushed worktree.
 */
function setup_git_mocks(
  opts: {
    worktree_list?: string;
    worktree_remove_error?: Error;
    branch_delete_error?: Error;
    merged_branches?: string;
    fetch_error?: Error;
    rev_parse_missing?: string[]; // branches whose remote ref is gone
    /**
     * Branches with no `branch.<name>.remote` config — i.e. never pushed.
     * Every other branch is treated as having been pushed at some point,
     * which is what "the remote ref is gone" is supposed to mean.
     */
    never_pushed_branches?: string[];
    /** Branches git does not consider an ancestor of main / origin/main. */
    unmerged_branches?: string[];
    /** Refs that resolve for the `origin/main` / `main` base-ref probe. */
    existing_refs?: string[];
    /** Per-worktree state, keyed by absolute worktree path. */
    trees?: Record<string, TreeState>;
  } = {},
): void {
  const existing_refs = opts.existing_refs ?? ["origin/main", "main"];

  mock_exec_file.mockImplementation((cmd: string, args: string[], exec_opts: unknown) => {
    if (cmd !== "git") return "";

    const cwd = (exec_opts as { cwd?: string } | undefined)?.cwd ?? "";
    const tree = opts.trees?.[cwd];
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

    // ── "Has this branch ever been pushed?" — `git config --get branch.X.remote` ──

    if (subcmd === "config") {
      const key = args[args.length - 1] ?? "";
      const branch = key.replace(/^branch\./, "").replace(/\.remote$/, "");
      if (opts.never_pushed_branches?.includes(branch)) {
        throw git_exit(1, "");
      }
      return "origin\n";
    }

    // ── "Is this branch fully merged?" — `git merge-base --is-ancestor` ──

    if (subcmd === "merge-base") {
      const branch = (args[2] ?? "").replace("refs/heads/", "");
      if (opts.unmerged_branches?.includes(branch)) {
        throw git_exit(1, "");
      }
      return "";
    }

    // ── Guard checks: always run with cwd set to the worktree directory ──

    if (subcmd === "status") {
      if (tree?.error) throw tree.error;
      if (tree?.status_error) throw tree.status_error;
      return tree?.status ?? "";
    }

    if (subcmd === "rev-list") {
      if (tree?.error) throw tree.error;
      return `${String(tree?.unpushed ?? 0)}\n`;
    }

    if (subcmd === "rev-parse") {
      if (args.includes("--show-prefix")) {
        if (tree?.error) throw tree.error;
        return tree?.prefix ?? "";
      }

      if (args.includes("@{u}")) {
        if (tree?.error) throw tree.error;
        if (!tree?.upstream) throw new Error("fatal: no upstream configured for branch");
        return `${tree.upstream}\n`;
      }

      // Base-ref probe: ["rev-parse", "--verify", "--quiet", "<ref>^{commit}"]
      if (args[1] === "--verify" && args[2] === "--quiet") {
        if (tree?.error) throw tree.error;
        const ref = (args[3] ?? "").replace("^{commit}", "");
        if (!existing_refs.includes(ref)) throw git_exit(1, "");
        return "abc123";
      }

      // Remote-branch probe: ["rev-parse", "--verify", "refs/remotes/origin/<branch>"]
      const ref = args[2] ?? "";
      const branch = ref.replace("refs/remotes/origin/", "");
      if (opts.rev_parse_missing?.includes(branch)) {
        // `git rev-parse --verify` on a missing ref is a fatal, exit 128.
        throw git_exit(128, "fatal: Needed a single revision");
      }
      return "abc123";
    }

    return "";
  });
}

/** Argument arrays of every `git worktree remove` call. */
function removed_worktree_calls(): string[][] {
  return mock_exec_file.mock.calls
    .filter(
      (c: unknown[]) =>
        (c[0] as string) === "git" &&
        (c[1] as string[])[0] === "worktree" &&
        (c[1] as string[])[1] === "remove",
    )
    .map((c: unknown[]) => c[1] as string[]);
}

/** Paths passed to `git worktree remove` across all mock calls. */
function removed_worktree_paths(): string[] {
  return removed_worktree_calls().map((args) => args[2] as string);
}

/** Argument arrays of every `git branch` call. */
function branch_calls(): string[][] {
  return mock_exec_file.mock.calls
    .filter((c: unknown[]) => (c[0] as string) === "git" && (c[1] as string[])[0] === "branch")
    .map((c: unknown[]) => c[1] as string[]);
}

/** A registry stub exposing a single repo at `/repo`. */
function single_repo_registry() {
  return {
    get_active: vi.fn().mockReturnValue([
      {
        entity: {
          id: "test-entity",
          repos: [{ path: "/repo", url: "https://github.com/test/repo.git" }],
        },
      },
    ]),
  };
}

// ── Tests ──

beforeEach(() => {
  vi.clearAllMocks();
  // Default worktrees are old enough that the sweep's grace period has
  // lapsed — tests that care about the grace period set their own mtime.
  mock_stat.mockResolvedValue({ isDirectory: () => true, mtimeMs: OLD_MTIME });
  mock_readdir.mockResolvedValue([]);
  // Default: tmux not running (execFileSync throws)
  mock_exec_file_sync.mockImplementation(() => {
    throw new Error("no server running on /tmp/tmux-501/default");
  });
});

describe("relocate_sessions_from_path", () => {
  it("returns 0 and does not throw when tmux is not running", async () => {
    // Default mock throws (tmux not running)
    const result = relocate_sessions_from_path("/some/worktree", "/repo");
    expect(result).toBe(0);
  });

  it("returns 0 when no panes have a matching cwd", async () => {
    mock_exec_file_sync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "list-panes") {
        return "session1 %0 /other/path\nsession2 %1 /another/path\n";
      }
      return "";
    });

    const result = relocate_sessions_from_path("/target/worktree", "/repo");
    expect(result).toBe(0);

    // Should not have sent any cd commands
    const send_keys_calls = mock_exec_file_sync.mock.calls.filter(
      (c: unknown[]) => (c[0] as string) === "tmux" && (c[1] as string[])[0] === "send-keys",
    );
    expect(send_keys_calls).toHaveLength(0);
  });

  it("relocates a pane whose cwd is exactly the target path", async () => {
    mock_exec_file_sync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "list-panes") {
        return "session1 %0 /target/worktree\nsession2 %1 /other/path\n";
      }
      return "";
    });

    const result = relocate_sessions_from_path("/target/worktree", "/repo");
    expect(result).toBe(1);

    // Should have sent cd to the matching pane using its pane ID
    expect(mock_exec_file_sync).toHaveBeenCalledWith(
      "tmux",
      ["send-keys", "-t", "%0", expect.stringContaining("cd"), "Enter"],
      expect.objectContaining({ timeout: 2000 }),
    );
  });

  it("relocates panes inside a subdirectory of the target path", async () => {
    mock_exec_file_sync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "list-panes") {
        return "session1 %0 /target/worktree/src/deep/dir\n";
      }
      return "";
    });

    const result = relocate_sessions_from_path("/target/worktree", "/repo");
    expect(result).toBe(1);
  });

  it("does NOT relocate a pane whose path is a prefix but not inside the target", async () => {
    // /foo/bar-baz should NOT match target /foo/bar (trailing-slash guard)
    mock_exec_file_sync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "list-panes") {
        return "session1 %0 /foo/bar-baz\n";
      }
      return "";
    });

    const result = relocate_sessions_from_path("/foo/bar", "/repo");
    expect(result).toBe(0);
  });

  it("handles multiple matching panes across sessions", async () => {
    mock_exec_file_sync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "list-panes") {
        return [
          "gary %0 /worktree/path",
          "bob %1 /worktree/path/src",
          "other %2 /different/path",
          "bob %3 /worktree/path",
        ].join("\n");
      }
      return "";
    });

    const result = relocate_sessions_from_path("/worktree/path", "/repo");
    expect(result).toBe(3);
  });

  it("continues relocating other panes when one send-keys fails", async () => {
    let send_keys_count = 0;
    mock_exec_file_sync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "list-panes") {
        return "s1 %0 /wt/path\ns2 %1 /wt/path\n";
      }
      if (cmd === "tmux" && args[0] === "send-keys") {
        send_keys_count++;
        if (send_keys_count === 1) {
          throw new Error("session not found");
        }
        return "";
      }
      return "";
    });

    const result = relocate_sessions_from_path("/wt/path", "/repo");
    // First pane fails, second succeeds — only 1 relocated
    expect(result).toBe(1);
  });
});

describe("parse_worktree_list", () => {
  it("parses a single main worktree", () => {
    const output = ["worktree /repo", "HEAD abc123", "branch refs/heads/main"].join("\n");

    const entries = parse_worktree_list(output);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      path: "/repo",
      head: "abc123",
      branch: "refs/heads/main",
      bare: false,
      locked: false,
      locked_reason: null,
    });
  });

  it("parses a bare `locked` line with no reason", () => {
    const output = [
      "worktree /repo/worktrees/held",
      "HEAD abc123",
      "branch refs/heads/feature/held",
      "locked",
    ].join("\n");

    const entries = parse_worktree_list(output);
    expect(entries[0]!.locked).toBe(true);
    expect(entries[0]!.locked_reason).toBeNull();
  });

  it("parses a `locked <reason>` line and keeps the reason", () => {
    const output = [
      "worktree /repo/worktrees/held",
      "HEAD abc123",
      "branch refs/heads/feature/held",
      "locked agent session running",
    ].join("\n");

    const entries = parse_worktree_list(output);
    expect(entries[0]!.locked).toBe(true);
    expect(entries[0]!.locked_reason).toBe("agent session running");
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
    const output = ["worktree /repo", "HEAD abc123", "bare"].join("\n");

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
    const porcelain = make_porcelain({ path: "/repo", branch: "refs/heads/main" });
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
    setup_git_mocks({
      worktree_list: make_porcelain({ path: "/repo", branch: "refs/heads/main" }),
    });

    await cleanup_after_merge("/repo", "feature/orphan");

    // Should have tried to delete the branch directly
    expect(mock_exec_file).toHaveBeenCalledWith(
      "git",
      ["branch", "-d", "feature/orphan"],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("scans .claude/worktrees/ for matching agent directories", async () => {
    setup_git_mocks({
      worktree_list: make_porcelain({ path: "/repo", branch: "refs/heads/main" }),
    });

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

  it("relocates sessions before removing worktree", async () => {
    const porcelain = make_porcelain(
      { path: "/repo", branch: "refs/heads/main" },
      { path: "/repo/worktrees/my-feature", branch: "refs/heads/feature/my-feature" },
    );
    setup_git_mocks({ worktree_list: porcelain });

    // Track call order: relocation (execFileSync for list-panes) must happen
    // before worktree removal (execFile for git worktree remove).
    const call_order: string[] = [];

    mock_exec_file_sync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "list-panes") {
        call_order.push("tmux:list-panes");
        return "session1 %0 /repo/worktrees/my-feature/src\n";
      }
      if (cmd === "tmux" && args[0] === "send-keys") {
        call_order.push("tmux:send-keys");
        return "";
      }
      return "";
    });

    const original_impl = mock_exec_file.getMockImplementation()!;
    mock_exec_file.mockImplementation((cmd: string, args: string[], opts: unknown) => {
      if (cmd === "git" && args[0] === "worktree" && args[1] === "remove") {
        call_order.push("git:worktree-remove");
      }
      return original_impl(cmd, args, opts);
    });

    await cleanup_after_merge("/repo", "feature/my-feature");

    // Relocation must precede removal
    const relocation_idx = call_order.indexOf("tmux:list-panes");
    const removal_idx = call_order.indexOf("git:worktree-remove");
    expect(relocation_idx).toBeGreaterThanOrEqual(0);
    expect(removal_idx).toBeGreaterThanOrEqual(0);
    expect(relocation_idx).toBeLessThan(removal_idx);
  });

  it("does not throw when .claude/worktrees/ does not exist", async () => {
    setup_git_mocks({
      worktree_list: make_porcelain({ path: "/repo", branch: "refs/heads/main" }),
    });
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

    // Should remove the merged worktree — unforced, so the removal still
    // respects locks and a dirty tree (issue #357).
    expect(mock_exec_file).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "/repo/worktrees/done"],
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
      ["worktree", "remove", "/repo/worktrees/orphan"],
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
    const porcelain = make_porcelain({ path: "/repo", branch: "refs/heads/main" });
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

// ── Issue #351: the sweep must never delete a worktree that still holds work ──

describe("sweep_stale_worktrees — unpushed/dirty guard", () => {
  const WT = "/repo/worktrees/active";
  let log_spy: ReturnType<typeof vi.spyOn>;

  /** Porcelain listing with main plus one feature worktree at `WT`. */
  function listing(extra?: { locked?: boolean; locked_reason?: string }): string {
    return make_porcelain(
      { path: "/repo", branch: "refs/heads/main" },
      { path: WT, branch: "refs/heads/feature/active", ...extra },
    );
  }

  /** All `[worktree-cleanup] Skipping ...` lines emitted during the test. */
  function skip_logs(): string[] {
    return log_spy.mock.calls.map((c) => String(c[0])).filter((line) => line.includes("Skipping"));
  }

  beforeEach(() => {
    log_spy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("does not remove a worktree with uncommitted changes", async () => {
    setup_git_mocks({
      worktree_list: listing(),
      merged_branches: "",
      rev_parse_missing: ["feature/active"], // remote gone → old code would delete
      trees: { [WT]: { status: "?? new-file.ts\n M src/index.ts" } },
    });

    await sweep_stale_worktrees(single_repo_registry() as any);

    expect(removed_worktree_paths()).not.toContain(WT);
    expect(skip_logs().join("\n")).toContain("uncommitted changes");
  });

  it("does not remove a never-pushed worktree holding commits not in main", async () => {
    // The exact reported bug: builder creates a worktree, commits, has not
    // pushed yet, so there is no refs/remotes/origin/<branch>.
    setup_git_mocks({
      worktree_list: listing(),
      merged_branches: "",
      rev_parse_missing: ["feature/active"],
      trees: { [WT]: { status: "", upstream: undefined, unpushed: 3 } },
    });

    await sweep_stale_worktrees(single_repo_registry() as any);

    expect(removed_worktree_paths()).not.toContain(WT);
    expect(skip_logs().join("\n")).toContain("3 unpushed commit(s)");
  });

  it("does not remove a merged branch carrying newer unpushed commits", async () => {
    // Case 1 needs the guard too — `git branch --merged` is a snapshot, and a
    // commit can land on top of a merged branch at any time.
    setup_git_mocks({
      worktree_list: listing(),
      merged_branches: "  feature/active\n",
      rev_parse_missing: [],
      trees: { [WT]: { status: "", upstream: "origin/feature/active", unpushed: 1 } },
    });

    await sweep_stale_worktrees(single_repo_registry() as any);

    expect(removed_worktree_paths()).not.toContain(WT);
    expect(skip_logs().join("\n")).toContain("1 unpushed commit(s)");
  });

  it("skips a locked worktree without ever attempting removal", async () => {
    // Previously this produced a `Failed to remove worktree` error line.
    setup_git_mocks({
      worktree_list: listing({ locked_reason: "agent session running" }),
      merged_branches: "  feature/active\n",
      rev_parse_missing: [],
    });

    await sweep_stale_worktrees(single_repo_registry() as any);

    expect(removed_worktree_paths()).toHaveLength(0);
    expect(skip_logs().join("\n")).toContain("agent session running");
  });

  it("still removes a genuinely stale worktree: merged, clean, nothing unpushed", async () => {
    setup_git_mocks({
      worktree_list: listing(),
      merged_branches: "  feature/active\n",
      rev_parse_missing: [],
      trees: { [WT]: { status: "", upstream: "origin/feature/active", unpushed: 0 } },
    });

    await sweep_stale_worktrees(single_repo_registry() as any);

    expect(removed_worktree_paths()).toContain(WT);
  });

  it("still removes a stale worktree whose remote branch is gone and work is pushed", async () => {
    // Not listed by `git branch --merged main` — this clone's local main is
    // behind — but the branch is an ancestor of origin/main, so the merge
    // gate clears it. Case 2 is the only path that can clean this up.
    setup_git_mocks({
      worktree_list: listing(),
      merged_branches: "",
      rev_parse_missing: ["feature/active"],
      trees: { [WT]: { status: "", upstream: undefined, unpushed: 0 } },
    });

    await sweep_stale_worktrees(single_repo_registry() as any);

    expect(removed_worktree_paths()).toContain(WT);
  });

  it("prefers the branch upstream over main, so a pushed branch ahead of main is still cleaned", async () => {
    // Without upstream preference every feature branch looks "ahead of main"
    // and the sweep would never clean anything again.
    setup_git_mocks({
      worktree_list: listing(),
      merged_branches: "  feature/active\n",
      rev_parse_missing: [],
      // Ahead of main, but fully pushed to its own upstream.
      trees: { [WT]: { status: "", upstream: "origin/feature/active", unpushed: 0 } },
    });

    await sweep_stale_worktrees(single_repo_registry() as any);

    expect(removed_worktree_paths()).toContain(WT);
    // The count must have been taken against the upstream, not main.
    const rev_list = mock_exec_file.mock.calls.find(
      (c: unknown[]) => (c[1] as string[])[0] === "rev-list",
    );
    expect((rev_list?.[1] as string[])[2]).toBe("origin/feature/active..HEAD");
  });

  it("skips the worktree when a git check errors (fail-safe)", async () => {
    setup_git_mocks({
      worktree_list: listing(),
      merged_branches: "  feature/active\n",
      trees: { [WT]: { error: new Error("fatal: unable to read tree") } },
    });

    await sweep_stale_worktrees(single_repo_registry() as any);

    expect(removed_worktree_paths()).not.toContain(WT);
    expect(skip_logs().join("\n")).toContain("check failed");
  });

  it("skips the worktree when the dirty-tree check times out (fail-safe)", async () => {
    setup_git_mocks({
      worktree_list: listing(),
      merged_branches: "  feature/active\n",
      trees: { [WT]: { status_error: new Error("Command failed: ETIMEDOUT") } },
    });

    await sweep_stale_worktrees(single_repo_registry() as any);

    expect(removed_worktree_paths()).not.toContain(WT);
    expect(skip_logs().join("\n")).toContain("ETIMEDOUT");
  });

  it("skips when there is no upstream and no base ref to compare against (fail-safe)", async () => {
    setup_git_mocks({
      worktree_list: listing(),
      merged_branches: "  feature/active\n",
      existing_refs: [], // neither origin/main nor main resolves
      trees: { [WT]: { status: "", upstream: undefined } },
    });

    await sweep_stale_worktrees(single_repo_registry() as any);

    expect(removed_worktree_paths()).not.toContain(WT);
    expect(skip_logs().join("\n")).toContain("no upstream");
  });

  it("skips a path git does not resolve as a worktree root (fail-safe)", async () => {
    setup_git_mocks({
      worktree_list: listing(),
      merged_branches: "  feature/active\n",
      trees: { [WT]: { prefix: "worktrees/active/\n" } },
    });

    await sweep_stale_worktrees(single_repo_registry() as any);

    expect(removed_worktree_paths()).not.toContain(WT);
    expect(skip_logs().join("\n")).toContain("not a worktree root");
  });

  it("logs the skip with the worktree path and branch so the sweep is auditable", async () => {
    setup_git_mocks({
      worktree_list: listing(),
      merged_branches: "",
      rev_parse_missing: ["feature/active"],
      trees: { [WT]: { status: "?? scratch.md" } },
    });

    await sweep_stale_worktrees(single_repo_registry() as any);

    const line = skip_logs()[0] ?? "";
    expect(line).toContain(WT);
    expect(line).toContain("feature/active");
    expect(line).toContain("uncommitted changes");
  });

  it("still removes a worktree whose directory no longer exists on disk", async () => {
    // Nothing to lose, and leaving it registered leaks a stale entry forever.
    setup_git_mocks({
      worktree_list: listing(),
      merged_branches: "  feature/active\n",
    });
    mock_stat.mockImplementation(async (path: string) => {
      if (path === WT) throw new Error("ENOENT");
      return { isDirectory: () => true };
    });

    await sweep_stale_worktrees(single_repo_registry() as any);

    expect(removed_worktree_paths()).toContain(WT);
  });

  it("does not emit a stale-worktree removal log line for a protected worktree", async () => {
    setup_git_mocks({
      worktree_list: listing(),
      merged_branches: "",
      rev_parse_missing: ["feature/active"],
      trees: { [WT]: { status: "?? scratch.md" } },
    });

    await sweep_stale_worktrees(single_repo_registry() as any);

    const stale_lines = log_spy.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.includes("Stale worktree"));
    expect(stale_lines).toHaveLength(0);
  });
});

describe("sweep_stale_worktrees — .claude/worktrees/ guard", () => {
  const CLAUDE_WT = "/repo/.claude/worktrees/agent-done";
  let log_spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    log_spy = vi.spyOn(console, "log").mockImplementation(() => {});
    mock_readdir.mockImplementation(async (dir: string) => {
      if (dir.includes(".claude/worktrees")) {
        return [{ name: "agent-done", isDirectory: () => true }];
      }
      return [];
    });
  });

  it("does not remove a .claude/ worktree with uncommitted changes", async () => {
    setup_git_mocks({
      worktree_list: make_porcelain({ path: "/repo", branch: "refs/heads/main" }),
      merged_branches: "  feature/done\n",
      trees: { [CLAUDE_WT]: { status: "?? in-progress.ts" } },
    });

    await sweep_stale_worktrees(single_repo_registry() as any);

    expect(removed_worktree_paths()).not.toContain(CLAUDE_WT);
    expect(
      log_spy.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes("Skipping"))
        .join("\n"),
    ).toContain("uncommitted changes");
  });

  it("does not remove a .claude/ worktree with unpushed commits", async () => {
    setup_git_mocks({
      worktree_list: make_porcelain({ path: "/repo", branch: "refs/heads/main" }),
      merged_branches: "  feature/done\n",
      trees: { [CLAUDE_WT]: { status: "", upstream: undefined, unpushed: 2 } },
    });

    await sweep_stale_worktrees(single_repo_registry() as any);

    expect(removed_worktree_paths()).not.toContain(CLAUDE_WT);
  });

  it("still removes a clean, fully-pushed .claude/ worktree", async () => {
    setup_git_mocks({
      worktree_list: make_porcelain({ path: "/repo", branch: "refs/heads/main" }),
      merged_branches: "  feature/done\n",
      trees: { [CLAUDE_WT]: { status: "", upstream: "origin/feature/done", unpushed: 0 } },
    });

    await sweep_stale_worktrees(single_repo_registry() as any);

    expect(removed_worktree_paths()).toContain(CLAUDE_WT);
  });

  it("skips a locked .claude/ worktree instead of failing to remove it", async () => {
    setup_git_mocks({
      worktree_list: make_porcelain(
        { path: "/repo", branch: "refs/heads/main" },
        {
          path: CLAUDE_WT,
          branch: "refs/heads/feature/done",
          locked_reason: "builder running",
        },
      ),
      // Not merged and remote still present, so the entry loop leaves it alone;
      // the .claude/ sweep is what must respect the lock.
      merged_branches: "  feature/done\n",
      trees: { [CLAUDE_WT]: { status: "", upstream: "origin/feature/done", unpushed: 0 } },
    });

    await sweep_stale_worktrees(single_repo_registry() as any);

    expect(removed_worktree_paths()).not.toContain(CLAUDE_WT);
    expect(
      log_spy.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes("Skipping"))
        .join("\n"),
    ).toContain("builder running");
  });
});

// ── Issue #357: "no remote ref" is not evidence a branch is finished ──

describe("sweep_stale_worktrees — never-pushed branches", () => {
  const WT = "/repo/worktrees/fresh";
  let log_spy: ReturnType<typeof vi.spyOn>;

  function listing(): string {
    return make_porcelain(
      { path: "/repo", branch: "refs/heads/main" },
      { path: WT, branch: "refs/heads/feature/fresh" },
    );
  }

  function skip_logs(): string {
    return log_spy.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.includes("Skipping"))
      .join("\n");
  }

  beforeEach(() => {
    log_spy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("never sweeps a branch with no upstream ever configured", async () => {
    // The root cause: a branch that has never been pushed has no
    // refs/remotes/origin/<branch> either, so the old code called it "remote
    // gone" and destroyed it.
    setup_git_mocks({
      worktree_list: listing(),
      merged_branches: "",
      rev_parse_missing: ["feature/fresh"],
      never_pushed_branches: ["feature/fresh"],
      trees: { [WT]: { status: "", upstream: undefined, unpushed: 0 } },
    });

    await sweep_stale_worktrees(single_repo_registry() as any);

    expect(removed_worktree_paths()).not.toContain(WT);
    expect(skip_logs()).toContain("never been pushed");
  });

  it("never sweeps a never-pushed branch even when it is merged and clean", async () => {
    // Nothing about the branch says "in use": it sits on main, the tree is
    // clean, there is nothing unpushed. It is still off-limits, because that
    // is also what a worktree looks like the second an agent is handed it.
    setup_git_mocks({
      worktree_list: listing(),
      merged_branches: "  feature/fresh\n",
      rev_parse_missing: ["feature/fresh"],
      never_pushed_branches: ["feature/fresh"],
      trees: { [WT]: { status: "", upstream: undefined, unpushed: 0 } },
    });

    await sweep_stale_worktrees(single_repo_registry() as any);

    expect(removed_worktree_paths()).not.toContain(WT);
  });

  it("never sweeps a never-pushed branch no matter how old the worktree is", async () => {
    // "at any age" — the grace period is a second line of defence, not this one.
    mock_stat.mockResolvedValue({ isDirectory: () => true, mtimeMs: 0 });
    setup_git_mocks({
      worktree_list: listing(),
      merged_branches: "  feature/fresh\n",
      rev_parse_missing: ["feature/fresh"],
      never_pushed_branches: ["feature/fresh"],
      trees: { [WT]: { status: "", upstream: undefined, unpushed: 0 } },
    });

    await sweep_stale_worktrees(single_repo_registry() as any);

    expect(removed_worktree_paths()).not.toContain(WT);
  });

  it("never deletes the branch of a never-pushed worktree", async () => {
    setup_git_mocks({
      worktree_list: listing(),
      merged_branches: "  feature/fresh\n",
      rev_parse_missing: ["feature/fresh"],
      never_pushed_branches: ["feature/fresh"],
    });

    await sweep_stale_worktrees(single_repo_registry() as any);

    expect(branch_calls().filter((args) => args[1] === "-d" || args[1] === "-D")).toEqual([]);
  });

  it("logs the never-pushed skip with the worktree path and branch", async () => {
    setup_git_mocks({
      worktree_list: listing(),
      merged_branches: "  feature/fresh\n",
      rev_parse_missing: ["feature/fresh"],
      never_pushed_branches: ["feature/fresh"],
    });

    await sweep_stale_worktrees(single_repo_registry() as any);

    expect(skip_logs()).toContain(WT);
    expect(skip_logs()).toContain("feature/fresh");
  });

  it("skips the worktree when the upstream-config check errors (fail-safe)", async () => {
    // `git config --get` exits 1 for "not set". Any other failure means we do
    // not know, and not knowing is not a licence to delete.
    setup_git_mocks({
      worktree_list: listing(),
      merged_branches: "  feature/fresh\n",
      rev_parse_missing: ["feature/fresh"],
    });
    const inner = mock_exec_file.getMockImplementation();
    mock_exec_file.mockImplementation((cmd: string, args: string[], exec_opts: unknown) => {
      if (cmd === "git" && args[0] === "config") throw git_exit(128, "fatal: bad config line");
      return inner?.(cmd, args, exec_opts);
    });

    await sweep_stale_worktrees(single_repo_registry() as any);

    expect(removed_worktree_paths()).not.toContain(WT);
  });

  it("does not sweep a .claude/ worktree whose merged branch was never pushed", async () => {
    mock_readdir.mockImplementation(async (dir: string) =>
      dir.includes(".claude/worktrees") ? [{ name: "agent-fresh", isDirectory: () => true }] : [],
    );
    setup_git_mocks({
      worktree_list: make_porcelain({ path: "/repo", branch: "refs/heads/main" }),
      merged_branches: "  feature/fresh\n",
      rev_parse_missing: ["feature/fresh"],
      never_pushed_branches: ["feature/fresh"],
      trees: { "/repo/.claude/worktrees/agent-fresh": { status: "", unpushed: 0 } },
    });

    await sweep_stale_worktrees(single_repo_registry() as any);

    expect(removed_worktree_paths()).not.toContain("/repo/.claude/worktrees/agent-fresh");
  });

  it("still sweeps a branch whose upstream was configured and whose remote ref is gone", async () => {
    // The behaviour that must not regress: pushed once, remote ref deleted.
    setup_git_mocks({
      worktree_list: listing(),
      merged_branches: "",
      rev_parse_missing: ["feature/fresh"],
      never_pushed_branches: [], // branch.feature/fresh.remote is set
      trees: { [WT]: { status: "", upstream: undefined, unpushed: 0 } },
    });

    await sweep_stale_worktrees(single_repo_registry() as any);

    expect(removed_worktree_paths()).toContain(WT);
  });
});

describe("sweep_stale_worktrees — grace period", () => {
  const WT = "/repo/worktrees/young";
  let log_spy: ReturnType<typeof vi.spyOn>;

  function listing(): string {
    return make_porcelain(
      { path: "/repo", branch: "refs/heads/main" },
      { path: WT, branch: "refs/heads/feature/young" },
    );
  }

  /** Every mock check says "stale and safe" — only mtime differs per test. */
  function stale_and_safe(): void {
    setup_git_mocks({
      worktree_list: listing(),
      merged_branches: "  feature/young\n",
      rev_parse_missing: ["feature/young"],
      trees: { [WT]: { status: "", upstream: "origin/feature/young", unpushed: 0 } },
    });
  }

  /** mtime for the worktree only; everything else stays old. */
  function set_worktree_mtime(mtime_ms: number | undefined): void {
    mock_stat.mockImplementation(async (path: string) => ({
      isDirectory: () => true,
      mtimeMs: path === WT ? mtime_ms : OLD_MTIME,
    }));
  }

  beforeEach(() => {
    log_spy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("does not sweep a worktree modified within the grace period", async () => {
    set_worktree_mtime(Date.now() - 60_000);
    stale_and_safe();

    await sweep_stale_worktrees(single_repo_registry() as any);

    expect(removed_worktree_paths()).not.toContain(WT);
    expect(
      log_spy.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes("Skipping"))
        .join("\n"),
    ).toContain("grace period");
  });

  it("does not sweep a worktree just inside the 6h grace period", async () => {
    set_worktree_mtime(Date.now() - (6 * 60 * 60 * 1000 - 60_000));
    stale_and_safe();

    await sweep_stale_worktrees(single_repo_registry() as any);

    expect(removed_worktree_paths()).not.toContain(WT);
  });

  it("sweeps once the worktree is older than the grace period", async () => {
    set_worktree_mtime(Date.now() - (6 * 60 * 60 * 1000 + 60_000));
    stale_and_safe();

    await sweep_stale_worktrees(single_repo_registry() as any);

    expect(removed_worktree_paths()).toContain(WT);
  });

  it("skips a worktree whose mtime is unreadable (fail-safe)", async () => {
    set_worktree_mtime(undefined);
    stale_and_safe();

    await sweep_stale_worktrees(single_repo_registry() as any);

    expect(removed_worktree_paths()).not.toContain(WT);
  });
});

describe("sweep_stale_worktrees — not-fully-merged branches", () => {
  const WT = "/repo/worktrees/unmerged";
  let log_spy: ReturnType<typeof vi.spyOn>;

  function listing(): string {
    return make_porcelain(
      { path: "/repo", branch: "refs/heads/main" },
      { path: WT, branch: "refs/heads/feature/unmerged" },
    );
  }

  beforeEach(() => {
    log_spy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("does not remove a worktree whose branch git would refuse to delete", async () => {
    // Every other signal says "disposable": remote ref gone, tree clean,
    // nothing ahead of its upstream. Git still says the branch is not fully
    // merged, and that is a stop — the exact sequence in the #357 report was
    // "Removed worktree" immediately followed by "not fully merged".
    setup_git_mocks({
      worktree_list: listing(),
      merged_branches: "",
      rev_parse_missing: ["feature/unmerged"],
      unmerged_branches: ["feature/unmerged"],
      trees: { [WT]: { status: "", upstream: "origin/feature/unmerged", unpushed: 0 } },
    });

    await sweep_stale_worktrees(single_repo_registry() as any);

    expect(removed_worktree_paths()).not.toContain(WT);
    expect(
      log_spy.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes("Skipping"))
        .join("\n"),
    ).toContain("not fully merged");
  });

  it("never escalates to `git branch -D`", async () => {
    setup_git_mocks({
      worktree_list: listing(),
      merged_branches: "",
      rev_parse_missing: ["feature/unmerged"],
      unmerged_branches: ["feature/unmerged"],
      branch_delete_error: new Error("error: the branch 'x' is not fully merged"),
      trees: { [WT]: { status: "", upstream: "origin/feature/unmerged", unpushed: 0 } },
    });

    await sweep_stale_worktrees(single_repo_registry() as any);

    expect(branch_calls().filter((args) => args[1] === "-D")).toEqual([]);
  });

  it("skips when the merge check cannot be resolved (fail-safe)", async () => {
    setup_git_mocks({
      worktree_list: listing(),
      merged_branches: "  feature/unmerged\n",
      existing_refs: [], // no main/master to compare against
      trees: { [WT]: { status: "", upstream: "origin/feature/unmerged", unpushed: 0 } },
    });

    await sweep_stale_worktrees(single_repo_registry() as any);

    expect(removed_worktree_paths()).not.toContain(WT);
  });
});

describe("sweep_stale_worktrees — removal is never forced", () => {
  it("removes a stale worktree without --force", async () => {
    const WT = "/repo/worktrees/stale";
    setup_git_mocks({
      worktree_list: make_porcelain(
        { path: "/repo", branch: "refs/heads/main" },
        { path: WT, branch: "refs/heads/feature/stale" },
      ),
      merged_branches: "  feature/stale\n",
      trees: { [WT]: { status: "", upstream: "origin/feature/stale", unpushed: 0 } },
    });

    await sweep_stale_worktrees(single_repo_registry() as any);

    const call = removed_worktree_calls().find((args) => args[2] === WT);
    expect(call).toBeDefined();
    expect(call).not.toContain("--force");
  });

  it("keeps --force on the post-merge path, where the work is known to have landed", async () => {
    const WT = "/repo/worktrees/merged";
    setup_git_mocks({
      worktree_list: make_porcelain(
        { path: "/repo", branch: "refs/heads/main" },
        { path: WT, branch: "refs/heads/feature/merged" },
      ),
    });

    await cleanup_after_merge("/repo", "feature/merged");

    expect(removed_worktree_calls().find((args) => args[2] === WT)).toContain("--force");
  });
});

describe("cleanup_after_merge — worktree locks", () => {
  let log_spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    log_spy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  function skip_logs(): string {
    return log_spy.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.includes("Skipping"))
      .join("\n");
  }

  it("does not remove a locked worktree found by branch name", async () => {
    const WT = "/repo/worktrees/locked";
    setup_git_mocks({
      worktree_list: make_porcelain(
        { path: "/repo", branch: "refs/heads/main" },
        { path: WT, branch: "refs/heads/feature/locked", locked_reason: "builder running" },
      ),
    });

    await cleanup_after_merge("/repo", "feature/locked");

    expect(removed_worktree_paths()).not.toContain(WT);
    expect(skip_logs()).toContain("builder running");
  });

  it("does not delete the branch of a locked worktree", async () => {
    const WT = "/repo/worktrees/locked";
    setup_git_mocks({
      worktree_list: make_porcelain(
        { path: "/repo", branch: "refs/heads/main" },
        { path: WT, branch: "refs/heads/feature/locked", locked_reason: "builder running" },
      ),
    });

    await cleanup_after_merge("/repo", "feature/locked");

    expect(branch_calls().filter((args) => args[1] === "-d" || args[1] === "-D")).toEqual([]);
  });

  it("does not remove a locked .claude/ worktree", async () => {
    const WT = "/repo/.claude/worktrees/agent-locked";
    mock_readdir.mockImplementation(async (dir: string) =>
      dir.includes(".claude/worktrees") ? [{ name: "agent-locked", isDirectory: () => true }] : [],
    );
    setup_git_mocks({
      worktree_list: make_porcelain(
        { path: "/repo", branch: "refs/heads/main" },
        { path: WT, branch: "refs/heads/feature/agent-locked", locked_reason: "session live" },
      ),
    });

    await cleanup_after_merge("/repo", "feature/agent-locked");

    expect(removed_worktree_paths()).not.toContain(WT);
    expect(skip_logs()).toContain("session live");
  });

  it("does not remove a .claude/ directory registered to a different branch", async () => {
    // Slug matching is a substring test: "12" matches "agent-123-neighbour".
    const WT = "/repo/.claude/worktrees/agent-123-neighbour";
    mock_readdir.mockImplementation(async (dir: string) =>
      dir.includes(".claude/worktrees")
        ? [{ name: "agent-123-neighbour", isDirectory: () => true }]
        : [],
    );
    setup_git_mocks({
      worktree_list: make_porcelain(
        { path: "/repo", branch: "refs/heads/main" },
        { path: WT, branch: "refs/heads/feature/123-neighbour" },
      ),
    });

    await cleanup_after_merge("/repo", "feature/12");

    expect(removed_worktree_paths()).not.toContain(WT);
  });

  it("still removes an unlocked .claude/ worktree for the merged branch", async () => {
    const WT = "/repo/.claude/worktrees/agent-shipped";
    mock_readdir.mockImplementation(async (dir: string) =>
      dir.includes(".claude/worktrees") ? [{ name: "agent-shipped", isDirectory: () => true }] : [],
    );
    setup_git_mocks({
      worktree_list: make_porcelain(
        { path: "/repo", branch: "refs/heads/main" },
        { path: WT, branch: "refs/heads/feature/shipped" },
      ),
    });

    await cleanup_after_merge("/repo", "feature/shipped");

    expect(removed_worktree_paths()).toContain(WT);
  });
});

describe("cleanup_after_merge — guard does not apply", () => {
  it("removes the worktree even when dirty and ahead of main", async () => {
    // A merge event is positive evidence the work landed. Squash merges always
    // leave the local branch ahead of main, so guarding here would disable
    // post-merge cleanup entirely.
    const WT = "/repo/worktrees/merged";
    setup_git_mocks({
      worktree_list: make_porcelain(
        { path: "/repo", branch: "refs/heads/main" },
        { path: WT, branch: "refs/heads/feature/merged" },
      ),
      trees: { [WT]: { status: "?? build-artifact.log", upstream: undefined, unpushed: 4 } },
    });

    await cleanup_after_merge("/repo", "feature/merged");

    expect(removed_worktree_paths()).toContain(WT);
  });
});
