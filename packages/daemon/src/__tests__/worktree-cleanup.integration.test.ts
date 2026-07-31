/**
 * Integration coverage for the worktree sweep guard (issue #351).
 *
 * Unlike worktree-cleanup.test.ts, nothing here is mocked: these tests drive
 * real `git` against real temporary repositories. The bug they guard against
 * was a wrong assumption about what git reports for a never-pushed branch, so
 * the only test that can actually prove the fix is one that asks git.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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

  it("still removes a genuinely stale worktree: merged, clean, nothing unpushed", async () => {
    const wt = join(root, "wt-stale");
    await git(repo, ["worktree", "add", "--quiet", "-b", "feature/stale", wt]);

    await sweep_stale_worktrees(registry_for(repo) as never);

    expect(existsSync(wt)).toBe(false);
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

    await sweep_stale_worktrees(registry_for(repo) as never);

    expect(existsSync(wt)).toBe(false);
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
