/**
 * Integration coverage for the worktree sweep guards (issues #351 and #357).
 *
 * Unlike worktree-cleanup.test.ts, nothing here is mocked: these tests drive
 * real `git` against real temporary repositories. The bugs they guard against
 * were wrong assumptions about what git reports for a never-pushed branch, so
 * the only tests that can actually prove the fixes are ones that ask git.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup_after_merge, sweep_stale_worktrees } from "../worktree-cleanup.js";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, timeout: 30_000 });
  return stdout;
}

/**
 * Push a directory's mtime far enough into the past that the sweep's grace
 * period has lapsed. Tests that assert removal must call this — every
 * worktree a test creates is seconds old, and the grace period alone would
 * otherwise explain the result.
 */
async function age_out(path: string): Promise<void> {
  const when = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await utimes(path, when, when);
}

/** Does a local branch still exist in `repo`? */
async function branch_exists(repo_path: string, branch: string): Promise<boolean> {
  try {
    await git(repo_path, ["rev-parse", "--verify", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** Registry stub exposing a single repo, matching what the sweep consumes. */
function registry_for(repo_path: string) {
  return {
    get_active: () => [
      {
        entity: { id: "integration", repos: [{ path: repo_path, url: "file://origin" }] },
      },
    ],
  };
}

describe("sweep_stale_worktrees (real git)", () => {
  let root: string;
  let repo: string;
  let origin: string;

  beforeEach(async () => {
    // realpath matters on macOS, where tmpdir() is a symlink into /private and
    // git always reports the resolved path.
    root = await realpath(await mkdtemp(join(tmpdir(), "wt-guard-")));
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

  it("does not remove a worktree that has commits but was never pushed", async () => {
    // The exact reported scenario: a builder creates a worktree, commits, and
    // has not pushed — so refs/remotes/origin/<branch> does not exist and the
    // pre-fix sweep classified it as "remote gone".
    const wt = join(root, "wt-unpushed");
    await git(repo, ["worktree", "add", "--quiet", "-b", "feature/unpushed", wt]);
    await writeFile(join(wt, "work.ts"), "export const answer = 42;\n");
    await git(wt, ["add", "-A"]);
    await git(wt, ["commit", "--quiet", "-m", "20 minutes of work"]);
    // Aged out, so the grace period is not what saves it — the never-pushed
    // guard has to hold on its own. ("never swept, at any age".)
    await age_out(wt);

    // Precondition: this is genuinely the state the old code deleted on.
    await expect(
      git(repo, ["rev-parse", "--verify", "refs/remotes/origin/feature/unpushed"]),
    ).rejects.toThrow();

    await sweep_stale_worktrees(registry_for(repo) as never);

    expect(existsSync(wt)).toBe(true);
    expect(existsSync(join(wt, "work.ts"))).toBe(true);
    // The branch must survive too — remove_worktree also deletes the branch.
    await expect(
      git(repo, ["rev-parse", "--verify", "refs/heads/feature/unpushed"]),
    ).resolves.toBeTruthy();
  });

  it("does not remove a worktree with uncommitted changes", async () => {
    const wt = join(root, "wt-dirty");
    // Branch tip is main, so `git branch --merged main` lists it: this
    // exercises the Case 1 path rather than Case 2.
    await git(repo, ["worktree", "add", "--quiet", "-b", "feature/dirty", wt]);
    await writeFile(join(wt, "scratch.md"), "unsaved thinking\n");

    await sweep_stale_worktrees(registry_for(repo) as never);

    expect(existsSync(wt)).toBe(true);
    expect(existsSync(join(wt, "scratch.md"))).toBe(true);
  });

  it("does not remove a locked worktree, and does not fail trying", async () => {
    const wt = join(root, "wt-locked");
    await git(repo, ["worktree", "add", "--quiet", "-b", "feature/locked", wt]);
    await git(repo, ["worktree", "lock", wt, "--reason", "agent session running"]);

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await sweep_stale_worktrees(registry_for(repo) as never);
      expect(existsSync(wt)).toBe(true);
      // The old behaviour was a `Failed to remove worktree` error line.
      const failures = errors.mock.calls
        .map((c) => String(c[0]))
        .filter((line) => line.includes("Failed to remove worktree"));
      expect(failures).toEqual([]);
    } finally {
      errors.mockRestore();
      await git(repo, ["worktree", "unlock", wt]);
    }
  });

  it("does not remove a never-pushed worktree even when merged, clean and old", async () => {
    // Before #357 this was the sweep's showcase "genuinely stale" case: a
    // branch sitting exactly on main, nothing committed, nothing dirty.
    //
    // It is also indistinguishable from a worktree an agent was handed
    // seconds before it started work. The only thing separating the two is
    // whether the branch has ever reached the remote, so a branch with no
    // upstream ever configured is now off-limits regardless of age. The cost
    // is a leaked directory; the alternative cost is the agent's work.
    const wt = join(root, "wt-stale");
    await git(repo, ["worktree", "add", "--quiet", "-b", "feature/stale", wt]);
    await age_out(wt);

    await sweep_stale_worktrees(registry_for(repo) as never);

    expect(existsSync(wt)).toBe(true);
    expect(await branch_exists(repo, "feature/stale")).toBe(true);
  });

  it("still removes a worktree whose work was merged into main and remote branch deleted", async () => {
    const wt = join(root, "wt-merged");
    await git(repo, ["worktree", "add", "--quiet", "-b", "feature/shipped", wt]);
    await writeFile(join(wt, "shipped.ts"), "export const shipped = true;\n");
    await git(wt, ["add", "-A"]);
    await git(wt, ["commit", "--quiet", "-m", "shipped work"]);
    await git(wt, ["push", "--quiet", "-u", "origin", "feature/shipped"]);

    // A real merge keeps the branch commits reachable from main.
    await git(repo, ["merge", "--quiet", "--no-ff", "-m", "merge", "feature/shipped"]);
    await git(repo, ["push", "--quiet", "origin", "main"]);
    await git(repo, ["push", "--quiet", "origin", "--delete", "feature/shipped"]);
    await age_out(wt);

    await sweep_stale_worktrees(registry_for(repo) as never);

    expect(existsSync(wt)).toBe(false);
  });

  it("still removes a pushed worktree whose remote ref is gone but is not merged locally", async () => {
    // The behaviour the fix must not regress, isolated to case 2: the branch
    // reached the remote, was merged there, and its remote ref was deleted —
    // while this clone's local `main` never moved. `git branch --merged main`
    // does not list it, so only the remote-gone path can clean it up.
    const wt = join(root, "wt-remote-gone");
    await git(repo, ["worktree", "add", "--quiet", "-b", "feature/gone", wt]);
    await writeFile(join(wt, "gone.ts"), "export const gone = true;\n");
    await git(wt, ["add", "-A"]);
    await git(wt, ["commit", "--quiet", "-m", "shipped work"]);
    await git(wt, ["push", "--quiet", "-u", "origin", "feature/gone"]);

    // Land and delete the branch from a different clone, so `repo`'s local
    // main stays behind and learns about it only through `fetch --prune`.
    const elsewhere = join(root, "elsewhere");
    await git(root, ["clone", "--quiet", origin, elsewhere]);
    await git(elsewhere, ["config", "user.email", "test@example.com"]);
    await git(elsewhere, ["config", "user.name", "Integration Test"]);
    await git(elsewhere, ["merge", "--quiet", "--no-ff", "-m", "merge", "origin/feature/gone"]);
    await git(elsewhere, ["push", "--quiet", "origin", "main"]);
    await git(elsewhere, ["push", "--quiet", "origin", "--delete", "feature/gone"]);

    // Preconditions: local main has not moved, and the branch was pushed.
    const merged_locally = await git(repo, ["branch", "--merged", "main"]);
    expect(merged_locally).not.toContain("feature/gone");
    expect((await git(repo, ["config", "--get", "branch.feature/gone.remote"])).trim()).toBe(
      "origin",
    );
    await age_out(wt);

    await sweep_stale_worktrees(registry_for(repo) as never);

    expect(existsSync(wt)).toBe(false);
  });

  it("does not sweep a worktree younger than the grace period", async () => {
    // Same setup as the test above, minus the age_out() call. Everything the
    // sweep looks at says "stale"; only the worktree's mtime says otherwise.
    const wt = join(root, "wt-young");
    await git(repo, ["worktree", "add", "--quiet", "-b", "feature/young", wt]);
    await writeFile(join(wt, "young.ts"), "export const young = true;\n");
    await git(wt, ["add", "-A"]);
    await git(wt, ["commit", "--quiet", "-m", "shipped work"]);
    await git(wt, ["push", "--quiet", "-u", "origin", "feature/young"]);

    await git(repo, ["merge", "--quiet", "--no-ff", "-m", "merge", "feature/young"]);
    await git(repo, ["push", "--quiet", "origin", "main"]);
    await git(repo, ["push", "--quiet", "origin", "--delete", "feature/young"]);

    await sweep_stale_worktrees(registry_for(repo) as never);

    expect(existsSync(wt)).toBe(true);
    expect(await branch_exists(repo, "feature/young")).toBe(true);
  });

  it("never deletes a branch git reports as not fully merged", async () => {
    // Pushed once, then the remote branch was deleted without ever landing —
    // an abandoned PR. The remote ref is genuinely gone, so case 2 fires, but
    // the branch still carries commits that exist nowhere else.
    const wt = join(root, "wt-unmerged");
    await git(repo, ["worktree", "add", "--quiet", "-b", "feature/unmerged", wt]);
    await writeFile(join(wt, "unmerged.ts"), "export const unmerged = true;\n");
    await git(wt, ["add", "-A"]);
    await git(wt, ["commit", "--quiet", "-m", "work nobody merged"]);
    await git(wt, ["push", "--quiet", "-u", "origin", "feature/unmerged"]);
    await git(repo, ["push", "--quiet", "origin", "--delete", "feature/unmerged"]);
    await age_out(wt);

    // Precondition: the branch is not an ancestor of main, which is exactly
    // the state `git branch -d` refuses to delete. (`branch -d` itself cannot
    // be asked yet — git blocks it while a worktree has the branch checked
    // out, which is why the old code only heard "not fully merged" *after*
    // it had already removed the worktree.)
    await expect(
      git(repo, ["merge-base", "--is-ancestor", "refs/heads/feature/unmerged", "main"]),
    ).rejects.toThrow();

    await sweep_stale_worktrees(registry_for(repo) as never);

    expect(existsSync(wt)).toBe(true);
    expect(await branch_exists(repo, "feature/unmerged")).toBe(true);
  });

  it("post-merge cleanup leaves a locked worktree alone", async () => {
    // cleanup_after_merge has positive evidence the PR landed, but a lock is
    // an explicit "something is still running in here" from whoever took it.
    const wt = join(root, "wt-merged-locked");
    await git(repo, ["worktree", "add", "--quiet", "-b", "feature/locked-merge", wt]);
    await writeFile(join(wt, "landed.ts"), "export const landed = true;\n");
    await git(wt, ["add", "-A"]);
    await git(wt, ["commit", "--quiet", "-m", "work"]);
    await git(repo, ["merge", "--quiet", "--no-ff", "-m", "merge", "feature/locked-merge"]);
    await git(repo, ["worktree", "lock", wt, "--reason", "builder still running"]);

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await cleanup_after_merge(repo, "feature/locked-merge");
      expect(existsSync(wt)).toBe(true);
      expect(await branch_exists(repo, "feature/locked-merge")).toBe(true);
      // The lock must be read as a skip, not discovered as a removal failure —
      // otherwise every locked worktree is a Sentry event.
      expect(
        errors.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("Failed to remove")),
      ).toEqual([]);
    } finally {
      errors.mockRestore();
      await git(repo, ["worktree", "unlock", wt]);
    }
  });

  it("post-merge cleanup leaves a locked .claude/worktrees directory alone", async () => {
    const claude_dir = join(repo, ".claude", "worktrees");
    await mkdir(claude_dir, { recursive: true });
    const wt = join(claude_dir, "agent-341-locked");
    await git(repo, ["worktree", "add", "--quiet", "-b", "feature/341-locked", wt]);
    await writeFile(join(wt, "landed.ts"), "export const landed = true;\n");
    await git(wt, ["add", "-A"]);
    await git(wt, ["commit", "--quiet", "-m", "work"]);
    await git(repo, ["worktree", "lock", wt, "--reason", "builder still running"]);

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await cleanup_after_merge(repo, "feature/341-locked");
      expect(existsSync(wt)).toBe(true);
      expect(
        errors.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("Failed to remove")),
      ).toEqual([]);
    } finally {
      errors.mockRestore();
      await git(repo, ["worktree", "unlock", wt]);
    }
  });

  it("post-merge cleanup does not remove a .claude/ worktree checked out on another branch", async () => {
    // Slug matching is a substring test: cleaning up "feature/12" must not
    // reach into the live worktree for "feature/123".
    const claude_dir = join(repo, ".claude", "worktrees");
    await mkdir(claude_dir, { recursive: true });
    const neighbour = join(claude_dir, "agent-123-neighbour");
    await git(repo, ["worktree", "add", "--quiet", "-b", "feature/123-neighbour", neighbour]);
    await writeFile(join(neighbour, "wip.ts"), "export const wip = true;\n");
    await git(neighbour, ["add", "-A"]);
    await git(neighbour, ["commit", "--quiet", "-m", "in progress"]);

    await cleanup_after_merge(repo, "feature/123");

    expect(existsSync(neighbour)).toBe(true);
    expect(await branch_exists(repo, "feature/123-neighbour")).toBe(true);
  });

  it("conservatively keeps a squash-merged worktree, whose commits are not in main", async () => {
    // A squash merge rewrites the work into a new commit, so the branch's own
    // commits are reachable from nothing on the remote. Offline, that is
    // indistinguishable from work that was never pushed, and this guard
    // resolves the ambiguity in favour of keeping the directory.
    //
    // The cost is bounded: a leftover directory, cleaned on the next merge
    // webhook via the unguarded cleanup_after_merge path. The alternative —
    // guessing "already merged" and being wrong — is the data loss in #351.
    const wt = join(root, "wt-squashed");
    await git(repo, ["worktree", "add", "--quiet", "-b", "feature/squashed", wt]);
    await writeFile(join(wt, "squashed.ts"), "export const squashed = true;\n");
    await git(wt, ["add", "-A"]);
    await git(wt, ["commit", "--quiet", "-m", "work"]);
    await git(wt, ["push", "--quiet", "-u", "origin", "feature/squashed"]);

    await git(repo, ["merge", "--quiet", "--squash", "feature/squashed"]);
    await git(repo, ["commit", "--quiet", "-m", "squashed work (#1)"]);
    await git(repo, ["push", "--quiet", "origin", "main"]);
    await git(repo, ["push", "--quiet", "origin", "--delete", "feature/squashed"]);

    await sweep_stale_worktrees(registry_for(repo) as never);

    expect(existsSync(wt)).toBe(true);
  });

  it("removes a squash-merged worktree via the unguarded post-merge path", async () => {
    // The counterpart to the test above: the merge webhook has positive
    // evidence the PR landed, so it cleans up what the sweep declines to.
    const wt = join(root, "wt-squashed-merged");
    await git(repo, ["worktree", "add", "--quiet", "-b", "feature/landed", wt]);
    await writeFile(join(wt, "landed.ts"), "export const landed = true;\n");
    await git(wt, ["add", "-A"]);
    await git(wt, ["commit", "--quiet", "-m", "work"]);
    await git(wt, ["push", "--quiet", "-u", "origin", "feature/landed"]);

    await git(repo, ["merge", "--quiet", "--squash", "feature/landed"]);
    await git(repo, ["commit", "--quiet", "-m", "landed work (#2)"]);

    await cleanup_after_merge(repo, "feature/landed");

    expect(existsSync(wt)).toBe(false);
  });
});
