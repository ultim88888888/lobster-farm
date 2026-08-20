/**
 * Integration coverage for the pre-merge rebase guard (issue #367).
 *
 * Nothing here is mocked: these tests drive real `git` against real temporary
 * repositories. The bug being guarded against is a *silent* one — plain
 * `git rebase` drops merge commits, replays the branch's older file versions
 * on top of main, and exits 0. A mocked exec can never show that, because the
 * whole failure lives inside git's replay semantics. So we ask git.
 *
 * The fixture that matters is `merge_fixture()`. Note what actually causes the
 * revert, because it is narrower than "the branch merged main": git's 3-way
 * replay is good at protecting content that exists in a commit it replays, and
 * raises a conflict when a branch patch collides with main. What it cannot
 * protect is content that exists *only in the merge commit* — conflict
 * resolutions and merge-time adaptations, which have no commit to replay from.
 * Those vanish, the pre-merge version of the file lands on top, and git reports
 * success. The first test proves that on real git before anything else runs.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { try_local_rebase } from "../review-utils.js";

const exec = promisify(execFile);

/** Deterministic identity + no user config bleeding in from the host. */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Integration Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Integration Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, env: GIT_ENV, timeout: 30_000 });
  return stdout;
}

async function commit(repo: string, file: string, body: string, message: string): Promise<string> {
  await writeFile(join(repo, file), body);
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "--quiet", "-m", message]);
  return (await git(repo, ["rev-parse", "HEAD"])).trim();
}

/** Tip SHA of a branch as the *remote* sees it — the force-push detector. */
async function remote_tip(origin: string, branch: string): Promise<string> {
  return (await git(origin, ["rev-parse", `refs/heads/${branch}`])).trim();
}

/** Content of a file at a remote ref, without checking anything out. */
async function remote_file(origin: string, ref: string, path: string): Promise<string> {
  return await git(origin, ["show", `${ref}:${path}`]);
}

describe("try_local_rebase merge-commit guard (real git)", () => {
  let root: string;
  let origin: string;
  let repo: string;

  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    // realpath matters on macOS, where tmpdir() is a symlink into /private.
    root = await realpath(await mkdtemp(join(tmpdir(), "rebase-guard-")));
    origin = join(root, "origin.git");
    repo = join(root, "repo");

    await git(root, ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
    await git(root, ["clone", "--quiet", origin, repo]);
    await commit(repo, "app.ts", "base\n", "chore: base");
    await git(repo, ["push", "--quiet", "-u", "origin", "main"]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  /**
   * A branch that merged main and silently reverts a file under plain rebase.
   *
   *   main:    base ── fix: helper(a, b) ───────────────── unrelated
   *                             \
   *   feature:  ── edits app.ts ─ M(merge main) ── more work
   *
   * The load-bearing detail is *where the adapted content lives*. Main changed
   * `helper`'s signature; the branch, while merging main, updated its own
   * `app.ts` call site to match. That call site exists in exactly one tree —
   * the merge commit's. Neither parent has it.
   *
   * Plain rebase drops M, so that content has nothing to replay from; the
   * branch's own pre-merge commit reinstates the one-argument call. Git sees
   * no conflict, because main never touched `app.ts` — the diff applies
   * cleanly. What ships is a call site that no longer matches main's helper.
   *
   * This is the general shape of the bug: anything recorded only in a merge
   * commit (conflict resolutions, merge-time adaptations) is dropped, and the
   * pre-merge version of the file is replayed over the top in silence.
   *
   * Returns the SHA of the merge commit that the guard must report.
   */
  async function merge_fixture(): Promise<string> {
    await commit(repo, "lib.ts", "export function helper(a) {\n  return a;\n}\n", "chore: helper");
    await git(repo, ["push", "--quiet", "origin", "main"]);

    await git(repo, ["checkout", "--quiet", "-b", "feature"]);
    await commit(repo, "app.ts", "base\nexport const total = helper(1);\n", "feat: call helper");

    // main changes the helper's signature — the fix that must survive.
    await git(repo, ["checkout", "--quiet", "main"]);
    await commit(
      repo,
      "lib.ts",
      "export function helper(a, b) {\n  return a + b;\n}\n",
      "fix: helper takes two args",
    );
    await git(repo, ["push", "--quiet", "origin", "main"]);

    // The branch merges main and adapts its call site inside the merge commit.
    await git(repo, ["checkout", "--quiet", "feature"]);
    await git(repo, ["merge", "--quiet", "--no-ff", "--no-commit", "main"]);
    await writeFile(join(repo, "app.ts"), "base\nexport const total = helper(1, 2);\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "--quiet", "-m", "merge main into feature"]);
    const merge_sha = (await git(repo, ["rev-parse", "HEAD"])).trim();

    await commit(repo, "feature.ts", "more work\n", "feat: continue feature");

    // main moves on again, so the branch is BEHIND and a rebase is warranted.
    await git(repo, ["checkout", "--quiet", "main"]);
    await commit(repo, "unrelated.ts", "unrelated\n", "chore: unrelated");
    await git(repo, ["push", "--quiet", "origin", "main"]);

    await git(repo, ["checkout", "--quiet", "feature"]);
    await git(repo, ["push", "--quiet", "-u", "origin", "feature"]);
    return merge_sha;
  }

  /** A plain linear branch, behind main, that rebases cleanly. */
  async function linear_fixture(): Promise<void> {
    await git(repo, ["checkout", "--quiet", "-b", "feature"]);
    await commit(repo, "feature.ts", "work\n", "feat: start feature");
    await git(repo, ["push", "--quiet", "-u", "origin", "feature"]);

    await git(repo, ["checkout", "--quiet", "main"]);
    await commit(repo, "app.ts", "fixed on main\n", "fix: repair app.ts");
    await git(repo, ["push", "--quiet", "origin", "main"]);

    await git(repo, ["checkout", "--quiet", "feature"]);
  }

  /** A linear branch that edits the same lines main edited — a real conflict. */
  async function conflict_fixture(): Promise<void> {
    await git(repo, ["checkout", "--quiet", "-b", "feature"]);
    await commit(repo, "app.ts", "branch version\n", "feat: branch edits app.ts");
    await git(repo, ["push", "--quiet", "-u", "origin", "feature"]);

    await git(repo, ["checkout", "--quiet", "main"]);
    await commit(repo, "app.ts", "main version\n", "fix: main edits app.ts");
    await git(repo, ["push", "--quiet", "origin", "main"]);

    await git(repo, ["checkout", "--quiet", "feature"]);
  }

  // ── The fixture is real ──

  it("fixture: plain `git rebase origin/main` silently reverts app.ts with no conflict", async () => {
    // This documents *why* the guard exists. It drives git directly rather
    // than try_local_rebase, so it keeps proving the hazard after the guard
    // stops us from ever reaching a plain rebase on such a branch. If a future
    // git release ever made plain rebase safe here, this test would be the
    // one to tell us.
    await merge_fixture();

    // Mirrors try_local_rebase's own setup, so what we prove here is what
    // would have happened in production.
    const scratch = join(root, "plain-rebase");
    await git(root, [
      "clone",
      "--quiet",
      "--single-branch",
      "--branch",
      "feature",
      origin,
      scratch,
    ]);
    await git(scratch, ["fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main"]);

    // Before: the branch's call site matches main's two-argument helper.
    expect(await readFile(join(scratch, "app.ts"), "utf8")).toBe(
      "base\nexport const total = helper(1, 2);\n",
    );

    // Plain rebase exits 0 — no conflict, nothing to resolve, nothing to see.
    await git(scratch, ["rebase", "origin/main"]);

    // After: the pre-merge call site is back, against a helper that now needs
    // two arguments. This is the regression that shipped a red main.
    expect(await readFile(join(scratch, "app.ts"), "utf8")).toBe(
      "base\nexport const total = helper(1);\n",
    );
    expect(await readFile(join(scratch, "lib.ts"), "utf8")).toContain("helper(a, b)");
  });

  // ── The guard ──

  it("refuses to rebase a branch containing a merge commit and reports the SHAs", async () => {
    const merge_sha = await merge_fixture();

    const result = await try_local_rebase("feature", repo, GIT_ENV);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.kind).toBe("unsafe_merge_commits");
    expect(result.merge_shas).toEqual([merge_sha]);
    expect(result.error).toContain(merge_sha);
  });

  it("does not force-push a branch containing a merge commit", async () => {
    await merge_fixture();
    const tip_before = await remote_tip(origin, "feature");

    await try_local_rebase("feature", repo, GIT_ENV);

    expect(await remote_tip(origin, "feature")).toBe(tip_before);
    // And the merge-time adaptation is still on the branch, un-reverted.
    expect(await remote_file(origin, "refs/heads/feature", "app.ts")).toBe(
      "base\nexport const total = helper(1, 2);\n",
    );
  });

  it("rebases and force-pushes a linear branch exactly as before", async () => {
    await linear_fixture();
    const tip_before = await remote_tip(origin, "feature");

    const result = await try_local_rebase("feature", repo, GIT_ENV);

    expect(result).toEqual({ success: true });
    // Force-push happened: the remote tip moved to the rebased commit.
    expect(await remote_tip(origin, "feature")).not.toBe(tip_before);
    // The rebased branch carries both main's fix and the branch's own work.
    expect(await remote_file(origin, "refs/heads/feature", "app.ts")).toBe("fixed on main\n");
    expect(await remote_file(origin, "refs/heads/feature", "feature.ts")).toBe("work\n");
  });

  it("still reports a genuine conflict, aborts cleanly, and leaves the remote alone", async () => {
    await conflict_fixture();
    const tip_before = await remote_tip(origin, "feature");

    const result = await try_local_rebase("feature", repo, GIT_ENV);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.kind).toBe("conflict");
    expect(result.error).toMatch(/manual resolution/i);
    expect(await remote_tip(origin, "feature")).toBe(tip_before);
  });
});
