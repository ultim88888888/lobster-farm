/**
 * Integration coverage for the orphaned-lock reaper (issue #370).
 *
 * Nothing is mocked below the reaper's own liveness probe: these tests drive
 * real `git` against real temporary repositories, and read lock state back out
 * of `git worktree list --porcelain` rather than from our own parser. A reaper
 * that "released" a lock git still honours would be worthless, so we ask git.
 *
 * The two things worth proving, and the reason this file is separate from the
 * unit tests:
 *
 *  1. Releasing is *all* it does. The worktree and its branch survive every
 *     release, and the sweep's #357/#358 guards still stand behind them.
 *  2. The release actually unblocks the sweep — a control worktree that was
 *     pushed, merged and had its remote ref deleted really is reclaimed on the
 *     next sweep, so a passing "still there" assertion elsewhere means the
 *     guard held, not that the sweep was inert.
 */

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sweep_stale_worktrees } from "../worktree-cleanup.js";
import { reap_stale_worktree_locks } from "../worktree-lock-reaper.js";
import { agent_lock_reason } from "../worktree-lock.js";

const exec = promisify(execFile);

const HOUR_MS = 60 * 60 * 1000;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, timeout: 30_000 });
  return stdout;
}

/** Backdate a directory so the reaper sees it as `hours` old. */
async function backdate(path: string, hours: number): Promise<void> {
  const when = new Date(Date.now() - hours * HOUR_MS);
  await utimes(path, when, when);
}

/**
 * A pid that is definitely not running: spawn a process, kill it, and wait for
 * the exit event before handing back its pid.
 */
async function dead_pid(): Promise<string> {
  const child = spawn("sleep", ["30"]);
  const pid = child.pid;
  if (pid === undefined) throw new Error("could not spawn a probe process");
  await new Promise<void>((resolve) => {
    child.once("exit", () => {
      resolve();
    });
    child.kill("SIGKILL");
  });
  return String(pid);
}

/**
 * The lock reason git reports for a worktree: a string when locked (empty when
 * locked without a reason), or null when unlocked. Read straight from
 * porcelain, so the test fails if git's format and our expectations diverge.
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

/** Registry stub exposing a single repo, matching what both sweeps consume. */
function registry_for(repo_path: string) {
  return {
    get_active: () => [
      { entity: { id: "integration", repos: [{ path: repo_path, url: "file://origin" }] } },
    ],
  };
}

describe("reap_stale_worktree_locks (real git)", () => {
  let root: string;
  let repo: string;
  let origin: string;
  let logs: ReturnType<typeof vi.spyOn>;
  let warns: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    // realpath matters on macOS, where tmpdir() is a symlink into /private and
    // git always reports the resolved path.
    root = await realpath(await mkdtemp(join(tmpdir(), "wt-reap-")));
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

    logs = vi.spyOn(console, "log").mockImplementation(() => {});
    warns = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    logs.mockRestore();
    warns.mockRestore();
    await rm(root, { recursive: true, force: true });
  });

  function logged(): string[] {
    return logs.mock.calls.map((c) => String(c[0]));
  }

  function warned(): string[] {
    return warns.mock.calls.map((c) => String(c[0]));
  }

  /**
   * Create a worktree on a fresh branch, commit some branch-specific work, and
   * optionally lock it with `reason`.
   */
  async function make_worktree(
    name: string,
    branch: string,
    reason?: string | null,
  ): Promise<string> {
    const wt = join(root, name);
    await git(repo, ["worktree", "add", "--quiet", "-b", branch, wt]);
    await writeFile(join(wt, "work.ts"), `export const branch = "${branch}";\n`);
    await git(wt, ["add", "-A"]);
    await git(wt, ["commit", "--quiet", "-m", `work on ${branch}`]);
    if (reason === null) {
      await git(repo, ["worktree", "lock", wt]);
    } else if (reason !== undefined) {
      await git(repo, ["worktree", "lock", wt, "--reason", reason]);
    }
    return wt;
  }

  /**
   * Everything the sweep reads as "this work is finished": push the branch,
   * merge it into main, push main, and delete the remote branch ref.
   */
  async function land(worktree_path: string, branch: string): Promise<void> {
    await git(worktree_path, ["push", "--quiet", "-u", "origin", branch]);
    await git(repo, ["merge", "--quiet", "--no-ff", "-m", `merge ${branch}`, branch]);
    await git(repo, ["push", "--quiet", "origin", "main"]);
    await git(repo, ["push", "--quiet", "origin", "--delete", branch]);
  }

  // ── Owner liveness ──

  describe("owner liveness", () => {
    it("releases our lock once its owner is gone and the tree is past grace", async () => {
      const wt = await make_worktree(
        "wt-orphan",
        "feature/1-orphan",
        agent_lock_reason("issue-1", { kind: "pid", id: await dead_pid() }),
      );
      await backdate(wt, 3);

      const released = await reap_stale_worktree_locks(registry_for(repo) as never);

      expect(released).toBe(1);
      expect(await lock_reason_of(repo, wt)).toBeNull();
      expect(logged().some((l) => l.includes(wt))).toBe(true);
    });

    it("never releases a lock whose owner is still alive", async () => {
      // This very test process is the owner, so the probe must find it.
      const wt = await make_worktree(
        "wt-live",
        "feature/2-live",
        agent_lock_reason("issue-2", { kind: "pid", id: String(process.pid) }),
      );
      await backdate(wt, 30 * 24);

      const released = await reap_stale_worktree_locks(registry_for(repo) as never);

      expect(released).toBe(0);
      expect(await lock_reason_of(repo, wt)).toContain("[lf-owner:pid:");
    });

    it("holds an orphaned lock until the grace period elapses", async () => {
      const wt = await make_worktree(
        "wt-warm",
        "feature/3-warm",
        agent_lock_reason("issue-3", { kind: "pid", id: await dead_pid() }),
      );
      await backdate(wt, 1); // inside the 2h grace

      expect(await reap_stale_worktree_locks(registry_for(repo) as never)).toBe(0);
      expect(await lock_reason_of(repo, wt)).not.toBeNull();
    });

    it("keeps the lock when the liveness probe cannot answer", async () => {
      const wt = await make_worktree(
        "wt-unknown",
        "feature/4-unknown",
        agent_lock_reason("issue-4", { kind: "tmux", id: "pool-9" }),
      );
      await backdate(wt, 30 * 24);

      const released = await reap_stale_worktree_locks(registry_for(repo) as never, {
        probes: { tmux_session_alive: () => null, process_alive: () => null },
      });

      expect(released).toBe(0);
      expect(await lock_reason_of(repo, wt)).not.toBeNull();
    });

    it("releases a tmux-owned lock once that session is gone", async () => {
      const wt = await make_worktree(
        "wt-tmux",
        "feature/5-tmux",
        agent_lock_reason("issue-5", { kind: "tmux", id: "pool-9" }),
      );
      await backdate(wt, 3);

      const released = await reap_stale_worktree_locks(registry_for(repo) as never, {
        probes: { tmux_session_alive: () => false, process_alive: () => null },
      });

      expect(released).toBe(1);
      expect(await lock_reason_of(repo, wt)).toBeNull();
    });
  });

  // ── Locks predating the owner token ──

  describe("locks placed before #370", () => {
    it("releases one past grace, since its owner can never be resolved", async () => {
      const wt = await make_worktree("wt-legacy", "feature/6-legacy", "issue-570 active build");
      await backdate(wt, 3);

      expect(await reap_stale_worktree_locks(registry_for(repo) as never)).toBe(1);
      expect(await lock_reason_of(repo, wt)).toBeNull();
    });

    it("still honours the grace period for one", async () => {
      const wt = await make_worktree(
        "wt-legacy-warm",
        "feature/7-legacy",
        "issue-570 active build",
      );
      await backdate(wt, 1);

      expect(await reap_stale_worktree_locks(registry_for(repo) as never)).toBe(0);
      expect(await lock_reason_of(repo, wt)).not.toBeNull();
    });
  });

  // ── Foreign locks (#358, unchanged) ──

  describe("foreign locks", () => {
    const foreign: [string, string][] = [
      ["human", "Ray - issue #151 follow-up, in progress"],
      ["agent-active", "agent-556 active"],
      ["session", "active agent session #577"],
      ["bare-marker", "active build"],
    ];

    for (const [name, reason] of foreign) {
      it(`never releases ${JSON.stringify(reason)}, at any age`, async () => {
        const wt = await make_worktree(`wt-foreign-${name}`, `feature/8-${name}`, reason);
        await backdate(wt, 365 * 24);

        expect(await reap_stale_worktree_locks(registry_for(repo) as never)).toBe(0);
        expect(await lock_reason_of(repo, wt)).toBe(reason);
      });
    }

    it("never releases a worktree added with --lock, at any age", async () => {
      // git records the literal reason "added with --lock" for these, which is
      // not our format — so the generic foreign rule already covers it. Pinned
      // separately because the acceptance criteria name it, and because a
      // future git changing that string must fail here loudly.
      const wt = join(root, "wt-added-lock");
      await git(repo, ["worktree", "add", "--quiet", "--lock", "-b", "feature/9-added", wt]);
      await backdate(wt, 365 * 24);

      expect(await lock_reason_of(repo, wt)).toBe("added with --lock");
      expect(await reap_stale_worktree_locks(registry_for(repo) as never)).toBe(0);
      expect(await lock_reason_of(repo, wt)).toBe("added with --lock");
    });
  });

  // ── Unattributable locks ──

  describe("locks with no reason recorded", () => {
    it("releases one past the long grace, and says so loudly", async () => {
      const wt = await make_worktree("wt-anon", "feature/10-anon", null);
      expect(await lock_reason_of(repo, wt)).toBe("");
      await backdate(wt, 25);

      expect(await reap_stale_worktree_locks(registry_for(repo) as never)).toBe(1);
      expect(await lock_reason_of(repo, wt)).toBeNull();

      // Loud means the warn channel, not just another line in the log stream:
      // nobody can say who owned this tree, and that is worth someone's eye.
      expect(warned().some((l) => l.includes(wt))).toBe(true);
    });

    it("keeps one that is merely old, not ancient", async () => {
      // Past the 2h owner-gone grace but inside the 24h unattributable one.
      const wt = await make_worktree("wt-anon-warm", "feature/11-anon", null);
      await backdate(wt, 6);

      expect(await reap_stale_worktree_locks(registry_for(repo) as never)).toBe(0);
      expect(await lock_reason_of(repo, wt)).toBe("");
    });
  });

  // ── The main working tree is never touched ──

  it("leaves a lock on the repo's own working tree alone", async () => {
    // Locking the main checkout is only ever a deliberate human act, and the
    // reaper has no business second-guessing it.
    await git(repo, ["worktree", "lock", repo]).catch(() => {
      // git refuses to lock the main working tree in some versions; if it
      // refuses there is nothing to protect and nothing to assert.
    });
    await backdate(repo, 365 * 24);

    await reap_stale_worktree_locks(registry_for(repo) as never);

    expect(existsSync(join(repo, "README.md"))).toBe(true);
  });

  // ── Release only: never removal ──

  describe("release is all it does", () => {
    it("leaves the worktree directory and its branch untouched", async () => {
      const wt = await make_worktree(
        "wt-survives",
        "feature/12-survives",
        agent_lock_reason("issue-12", { kind: "pid", id: await dead_pid() }),
      );
      await land(wt, "feature/12-survives");
      await backdate(wt, 48);

      await reap_stale_worktree_locks(registry_for(repo) as never);

      // Everything the sweep would have destroyed is still here: the reaper
      // only clears the sign, it never takes the tree.
      expect(await lock_reason_of(repo, wt)).toBeNull();
      expect(existsSync(wt)).toBe(true);
      expect(existsSync(join(wt, "work.ts"))).toBe(true);
      expect(await branch_exists(repo, "feature/12-survives")).toBe(true);
      expect(await git(repo, ["worktree", "list", "--porcelain"])).toContain(wt);
    });
  });

  // ── The sweep's guards still stand behind the release ──

  describe("interaction with the guarded sweep", () => {
    it("does not expose a never-pushed branch to the sweep", async () => {
      // Merged into main locally, so the sweep calls it stale; never pushed,
      // so #357's first guard refuses it — at any age, lock or no lock.
      const wt = await make_worktree(
        "wt-never-pushed",
        "feature/13-never-pushed",
        agent_lock_reason("issue-13", { kind: "pid", id: await dead_pid() }),
      );
      await git(repo, ["merge", "--quiet", "--no-ff", "-m", "merge", "feature/13-never-pushed"]);
      await backdate(wt, 48);

      await reap_stale_worktree_locks(registry_for(repo) as never);
      expect(await lock_reason_of(repo, wt)).toBeNull(); // the lock did go

      await sweep_stale_worktrees(registry_for(repo) as never);

      expect(existsSync(wt)).toBe(true);
      expect(await branch_exists(repo, "feature/13-never-pushed")).toBe(true);
      expect(logged().some((l) => l.includes("never been pushed"))).toBe(true);
    });

    it("lets the sweep reclaim a tree that really is finished", async () => {
      // The control for the assertion above: same reaper, same sweep, and the
      // only difference is that this branch reached the remote and landed.
      const wt = await make_worktree(
        "wt-finished",
        "feature/14-finished",
        agent_lock_reason("issue-14", { kind: "pid", id: await dead_pid() }),
      );
      await land(wt, "feature/14-finished");
      await backdate(wt, 48);

      // Without the reaper the lock alone keeps it forever (#358).
      await sweep_stale_worktrees(registry_for(repo) as never);
      expect(existsSync(wt)).toBe(true);

      await reap_stale_worktree_locks(registry_for(repo) as never);
      await backdate(wt, 48);
      await sweep_stale_worktrees(registry_for(repo) as never);

      expect(existsSync(wt)).toBe(false);
    });

    it("does not expose a tree with uncommitted work to the sweep", async () => {
      const wt = await make_worktree(
        "wt-dirty",
        "feature/15-dirty",
        agent_lock_reason("issue-15", { kind: "pid", id: await dead_pid() }),
      );
      await land(wt, "feature/15-dirty");
      await writeFile(join(wt, "scratch.ts"), "export const wip = true;\n");
      await backdate(wt, 48);

      await reap_stale_worktree_locks(registry_for(repo) as never);
      await sweep_stale_worktrees(registry_for(repo) as never);

      expect(existsSync(wt)).toBe(true);
      expect(logged().some((l) => l.includes("uncommitted changes"))).toBe(true);
    });
  });

  // ── .claude/worktrees/ ──

  it("reaps agent worktrees under .claude/worktrees/ too", async () => {
    const claude_dir = join(repo, ".claude", "worktrees");
    await mkdir(claude_dir, { recursive: true });
    const wt = join(claude_dir, "agent-370-orphan");
    await git(repo, ["worktree", "add", "--quiet", "-b", "feature/16-claude", wt]);
    await git(repo, [
      "worktree",
      "lock",
      wt,
      "--reason",
      agent_lock_reason("issue-16", { kind: "pid", id: await dead_pid() }),
    ]);
    await backdate(wt, 3);

    expect(await reap_stale_worktree_locks(registry_for(repo) as never)).toBe(1);
    expect(await lock_reason_of(repo, wt)).toBeNull();
    expect(existsSync(wt)).toBe(true);
  });

  // ── Robustness ──

  it("survives a repo path that does not exist", async () => {
    const missing = registry_for(join(root, "nope"));
    await expect(reap_stale_worktree_locks(missing as never)).resolves.toBe(0);
  });

  it("does nothing when no worktree is locked", async () => {
    await make_worktree("wt-unlocked", "feature/17-unlocked");
    await backdate(join(root, "wt-unlocked"), 365 * 24);

    expect(await reap_stale_worktree_locks(registry_for(repo) as never)).toBe(0);
  });
});
