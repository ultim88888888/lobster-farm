/**
 * Integration coverage for locking agent worktrees at creation (issue #359).
 *
 * Nothing here is mocked: these tests drive real `git` against real temporary
 * repositories. A lock is only worth anything if git itself honours it, and
 * the one thing a mocked exec cannot tell us is whether `git worktree remove`
 * actually refuses. So we ask git.
 *
 * The pairing under test is:
 *   - `create_worktree` locks, so nothing can remove the tree by accident.
 *   - the intended cleanup paths unlock first, so a finished tree still goes.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { EntityConfig } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FeatureData, cleanup_worktree, create_worktree } from "../actions.js";
import { cleanup_after_merge, sweep_stale_worktrees } from "../worktree-cleanup.js";
import { agent_lock_reason } from "../worktree-lock.js";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, timeout: 30_000 });
  return stdout;
}

/** Backdate a directory past the sweep's grace period. */
async function age_out(path: string): Promise<void> {
  const when = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await utimes(path, when, when);
}

/**
 * The lock reason git reports for a worktree, or null when it is unlocked.
 * Read straight from porcelain rather than from our own parser, so the test
 * fails if git's format and our expectations ever diverge.
 */
async function lock_reason_of(repo: string, worktree_path: string): Promise<string | null> {
  const out = await git(repo, ["worktree", "list", "--porcelain"]);
  for (const block of out.trim().split("\n\n")) {
    const lines = block.trim().split("\n");
    if (!lines.includes(`worktree ${worktree_path}`)) continue;
    const locked = lines.find((l) => l === "locked" || l.startsWith("locked "));
    if (locked === undefined) return null;
    return locked === "locked" ? "" : locked.slice("locked ".length);
  }
  return null;
}

async function branch_exists(repo: string, branch: string): Promise<boolean> {
  try {
    await git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

function make_feature(overrides: Partial<FeatureData> = {}): FeatureData {
  return {
    id: "lock-test",
    entity: "integration",
    githubIssue: 42,
    title: "Add widget support",
    branch: "feature/42-widget",
    worktreePath: null,
    discordWorkRoom: null,
    activeArchetype: null,
    prNumber: null,
    ...overrides,
  };
}

function config_for(repo_path: string): EntityConfig {
  return {
    entity: {
      id: "integration",
      name: "integration",
      repos: [{ name: "repo", url: "file://origin", path: repo_path }],
      channels: { category_id: "cat-1", list: [] },
      memory: { path: "/tmp/lock-test-memory" },
      secrets: { vault_name: "integration" },
    },
  } as EntityConfig;
}

/** Registry stub exposing a single repo, matching what the sweep consumes. */
function registry_for(repo_path: string) {
  return {
    get_active: () => [
      { entity: { id: "integration", repos: [{ path: repo_path, url: "file://origin" }] } },
    ],
  };
}

describe("worktree locking (real git)", () => {
  let root: string;
  let repo: string;
  let origin: string;

  beforeEach(async () => {
    // realpath matters on macOS, where tmpdir() is a symlink into /private and
    // git always reports the resolved path.
    root = await realpath(await mkdtemp(join(tmpdir(), "wt-lock-")));
    origin = join(root, "origin.git");
    repo = join(root, "repo");

    await git(root, ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
    await git(root, ["clone", "--quiet", origin, repo]);
    await git(repo, ["config", "user.email", "test@example.com"]);
    await git(repo, ["config", "user.name", "Integration Test"]);
    await writeFile(join(repo, "README.md"), "base\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "--quiet", "-m", "base"]);
    await git(repo, ["push", "--quiet", "-u", "origin", "main"]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /**
   * Take a worktree through everything the sweep reads as "finished": commit,
   * push, merge into main, delete the remote branch, and backdate the
   * directory past the grace period. What survives that is protected by the
   * lock and nothing else.
   */
  async function land(worktree_path: string, branch: string): Promise<void> {
    // Branch-specific content: two worktrees landing the same bytes would
    // leave the second with nothing to commit.
    await writeFile(join(worktree_path, "work.ts"), `export const branch = "${branch}";\n`);
    await git(worktree_path, ["add", "-A"]);
    await git(worktree_path, ["commit", "--quiet", "-m", `work on ${branch}`]);
    await git(worktree_path, ["push", "--quiet", "-u", "origin", branch]);
    await git(repo, ["merge", "--quiet", "--no-ff", "-m", `merge ${branch}`, branch]);
    await git(repo, ["push", "--quiet", "origin", "main"]);
    await git(repo, ["push", "--quiet", "origin", "--delete", branch]);
    await age_out(worktree_path);
  }

  // ── create_worktree ──

  describe("create_worktree", () => {
    it("locks the worktree it creates", async () => {
      const wt = await create_worktree(make_feature(), config_for(repo));

      expect(existsSync(wt)).toBe(true);
      expect(await lock_reason_of(repo, wt)).not.toBeNull();
    });

    it("names the owning issue in the lock reason, not a generic constant", async () => {
      const a = await create_worktree(
        make_feature({ githubIssue: 42, branch: "feature/42-widget" }),
        config_for(repo),
      );
      const b = await create_worktree(
        make_feature({ githubIssue: 570, branch: "feature/570-gadget" }),
        config_for(repo),
      );

      expect(await lock_reason_of(repo, a)).toBe("issue-42 active build");
      expect(await lock_reason_of(repo, b)).toBe("issue-570 active build");
    });

    it("falls back to the branch when the feature carries no issue number", async () => {
      const wt = await create_worktree(
        make_feature({ githubIssue: 0, branch: "feature/no-issue" }),
        config_for(repo),
      );

      expect(await lock_reason_of(repo, wt)).toBe("feature/no-issue active build");
    });

    it("produces a lock git itself refuses to remove, even with --force", async () => {
      // This is the whole point of the issue: `--force` alone is not enough to
      // remove a locked worktree, so a stray sweep cannot destroy the tree.
      const wt = await create_worktree(make_feature(), config_for(repo));

      await expect(git(repo, ["worktree", "remove", wt, "--force"])).rejects.toThrow(/lock/i);
      expect(existsSync(wt)).toBe(true);
    });

    it("re-locks on the already-exists path without throwing", async () => {
      const feature = make_feature();
      const first = await create_worktree(feature, config_for(repo));
      await git(repo, ["worktree", "unlock", first]);

      const second = await create_worktree(feature, config_for(repo));

      expect(second).toBe(first);
      expect(await lock_reason_of(repo, first)).toBe("issue-42 active build");
    });
  });

  // ── The sweep must never unlock ──

  describe("sweep_stale_worktrees", () => {
    it("leaves a worktree locked by create_worktree alone, and leaves it locked", async () => {
      // Two worktrees the sweep considers equally disposable — merged into
      // main, pushed, remote ref deleted, clean, well past the grace period.
      // The only difference is the lock, so the control proves the sweep
      // really would have taken the other one.
      const locked = await create_worktree(make_feature(), config_for(repo));
      await land(locked, "feature/42-widget");

      const control = join(root, "wt-control");
      await git(repo, ["worktree", "add", "--quiet", "-b", "feature/99-control", control]);
      await land(control, "feature/99-control");

      await sweep_stale_worktrees(registry_for(repo) as never);

      expect(existsSync(control)).toBe(false);
      expect(existsSync(locked)).toBe(true);
      // The sweep must never clear a lock — only an intended removal may.
      expect(await lock_reason_of(repo, locked)).toBe("issue-42 active build");
    });
  });

  // ── Intended cleanup still works ──

  describe("cleanup_worktree", () => {
    it("unlocks and removes a worktree it locked at creation", async () => {
      const feature = make_feature();
      const wt = await create_worktree(feature, config_for(repo));

      const logs = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await cleanup_worktree({ ...feature, worktreePath: wt }, config_for(repo));

        expect(existsSync(wt)).toBe(false);
        // git must have done the removal — the rm -rf fallback would hide a
        // broken unlock behind a directory that happens to be gone.
        const lines = logs.mock.calls.map((c) => String(c[0]));
        expect(lines.some((l) => l.includes(`Removed worktree at ${wt}`))).toBe(true);
        expect(lines.some((l) => l.includes("Force-removed worktree"))).toBe(false);
      } finally {
        logs.mockRestore();
      }

      expect(await git(repo, ["worktree", "list", "--porcelain"])).not.toContain(wt);
    });
  });

  describe("cleanup_after_merge", () => {
    it("unlocks and removes an agent-locked worktree whose branch merged", async () => {
      const feature = make_feature();
      const wt = await create_worktree(feature, config_for(repo));
      await writeFile(join(wt, "work.ts"), "export const done = true;\n");
      await git(wt, ["add", "-A"]);
      await git(wt, ["commit", "--quiet", "-m", "work"]);
      await git(repo, ["merge", "--quiet", "--no-ff", "-m", "merge", feature.branch]);

      await cleanup_after_merge(repo, feature.branch);

      expect(existsSync(wt)).toBe(false);
      expect(await branch_exists(repo, feature.branch)).toBe(false);
    });

    it("unlocks and removes an agent-locked .claude/worktrees directory", async () => {
      const claude_dir = join(repo, ".claude", "worktrees");
      await mkdir(claude_dir, { recursive: true });
      const wt = join(claude_dir, "agent-359-locked");
      await git(repo, ["worktree", "add", "--quiet", "-b", "feature/359-locked", wt]);
      await git(repo, ["worktree", "lock", wt, "--reason", agent_lock_reason("issue-359")]);

      await cleanup_after_merge(repo, "feature/359-locked");

      expect(existsSync(wt)).toBe(false);
    });

    it("still leaves a lock it did not place alone", async () => {
      // #358's guarantee, unchanged: a lock reason we do not recognise is a
      // human or an external tool saying "do not touch", and a merge is no
      // answer to that.
      const wt = join(root, "wt-foreign");
      await git(repo, ["worktree", "add", "--quiet", "-b", "feature/foreign", wt]);
      await git(repo, ["merge", "--quiet", "--no-ff", "-m", "merge", "feature/foreign"]);
      await git(repo, ["worktree", "lock", wt, "--reason", "builder still running"]);

      try {
        await cleanup_after_merge(repo, "feature/foreign");

        expect(existsSync(wt)).toBe(true);
        expect(await branch_exists(repo, "feature/foreign")).toBe(true);
        expect(await lock_reason_of(repo, wt)).toBe("builder still running");
      } finally {
        await git(repo, ["worktree", "unlock", wt]);
      }
    });
  });
});
