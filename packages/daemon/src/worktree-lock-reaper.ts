/**
 * Release worktree locks whose owning session is gone (issue #370).
 *
 * ## Why this exists
 *
 * Nothing ever released a lock when its owner died. A session that finished,
 * crashed, or was recycled left its `git worktree lock` behind, the sweep
 * correctly refused to touch a locked tree, and the locks accumulated
 * permanently: 82 linked worktrees and ~140GB of build artifacts across the
 * live instance, 35 of 48 worktrees locked in one repo alone.
 *
 * #360 made that load-bearing. Every agent worktree is now locked at creation,
 * and since #358 a lock outranks even a confirmed merge — so without something
 * to release orphaned locks, no worktree is ever cleanable again.
 *
 * ## What it is allowed to do
 *
 * Release locks. Nothing else. This module deliberately imports no removal
 * helper and shells out to no destructive git command: `git worktree unlock`
 * is the only mutation it performs anywhere. Every worktree removal and branch
 * deletion stays behind the guarded sweep in `worktree-cleanup.ts`, with all
 * four of its #357/#358 guards intact. Clearing a lock returns a worktree to
 * *normal* cleanup eligibility — it never shortcuts it.
 *
 * That boundary is a property of the file, not a convention: if a future edit
 * needs `remove_worktree` here, the import is the review flag.
 *
 * ## How it decides
 *
 * Every uncertain answer is "keep". Releasing a lock we should have kept
 * exposes real work to the sweep; keeping one we could have released costs a
 * directory until the next hourly pass. The two are not remotely symmetric.
 *
 * | Lock                                    | Verdict                        |
 * |-----------------------------------------|--------------------------------|
 * | Reason we don't recognise (incl. git's  | never released, at any age     |
 * | own "added with --lock")                |                                |
 * | Ours, owner demonstrably alive          | never released                 |
 * | Ours, liveness probe couldn't answer    | never released                 |
 * | Ours, owner gone, dir past 2h           | released                       |
 * | Ours, no resolvable owner, dir past 2h  | released                       |
 * | No reason at all, dir past 24h          | released, loudly               |
 * | Directory age unreadable                | never released                 |
 */

import { execFile, execFileSync } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import { expand_home } from "@lobster-farm/shared";
import type { EntityRegistry } from "./registry.js";
import * as sentry from "./sentry.js";
import { parse_worktree_list } from "./worktree-cleanup.js";
import { type LockOwner, is_agent_lock, parse_lock_owner } from "./worktree-lock.js";

const exec = promisify(execFile);

/** Timeout for git commands — generous but bounded, matching the sweep. */
const GIT_TIMEOUT_MS = 30_000;

/** Timeout for a single liveness probe. These must never hold up a sweep. */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * How long a worktree must sit untouched before we act on a gone owner.
 *
 * The risk this covers is a false negative from the liveness probe — an owner
 * that is alive but momentarily unfindable (a session mid-restart, a pid
 * recorded before the process was reparented). Two hours is far longer than
 * any such window, and still short enough that a build finishing at 09:00 is
 * reclaimable the same morning.
 *
 * Deliberately shorter than the sweep's own 6h grace: releasing a lock is
 * reversible, removing a worktree is not, so the reaper may move first and the
 * sweep still applies its own, longer wait before destroying anything.
 */
export const LOCK_REAP_GRACE_MS = 2 * 60 * 60 * 1000;

/**
 * How long a lock with *no reason recorded* must sit untouched before we act.
 *
 * 29 of the 35 locks measured in canalstreet-admin recorded no reason at all,
 * so ownership is not merely stale — it is unknowable. Age is the only lever
 * left, and an un-ownable lock is indistinguishable from a leak.
 *
 * A full day is the deliberate price of that guesswork: long enough that no
 * plausible session is still working behind it, and long enough that a human
 * who locked a tree by hand this morning finds it as they left it. What makes
 * this safe rather than reckless is what happens *after* the release — the
 * sweep's guards still refuse anything with unpushed commits, uncommitted
 * changes, or a branch that never reached the remote.
 */
export const UNATTRIBUTABLE_LOCK_REAP_GRACE_MS = 24 * 60 * 60 * 1000;

// ── Liveness probing ──

/** What we could establish about a lock owner. `unknown` is never "gone". */
export type OwnerLiveness = "alive" | "gone" | "unknown";

/**
 * The two questions the reaper asks the machine, injectable so tests can drive
 * both answers without depending on a tmux server being present.
 *
 * Each returns `null` for "could not determine", which is a third answer and
 * not a synonym for false. A missing tmux binary must not read as "every
 * session is dead".
 */
export interface LivenessProbes {
  /** True if a tmux session by exactly this name exists. */
  tmux_session_alive(name: string): boolean | null;
  /** True if a process with this pid exists. */
  process_alive(pid: number): boolean | null;
}

export const default_liveness_probes: LivenessProbes = {
  tmux_session_alive(name: string): boolean | null {
    try {
      // `=` forces an exact match. Without it tmux resolves a bare target by
      // prefix, so a dead `pool-1` would match a live `pool-10` and keep its
      // lock forever.
      execFileSync("tmux", ["has-session", "-t", `=${name}`], {
        stdio: "ignore",
        timeout: PROBE_TIMEOUT_MS,
      });
      return true;
    } catch (err) {
      // tmux ran and said no. That is an answer.
      const status = (err as { status?: unknown }).status;
      if (typeof status === "number") return false;
      // tmux is not installed, timed out, or was signalled — no conclusion.
      return null;
    }
  },

  process_alive(pid: number): boolean | null {
    try {
      // Signal 0 performs the permission and existence checks without
      // delivering anything.
      process.kill(pid, 0);
      return true;
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (code === "ESRCH") return false;
      // EPERM means the process exists and belongs to another user.
      if (code === "EPERM") return true;
      return null;
    }
  },
};

/**
 * Resolve an owner token to a liveness verdict.
 *
 * A null owner is `unknown`, not `gone`: "we could not parse an owner" and
 * "the owner is dead" are different claims, and only the caller knows which
 * one is actionable for the lock it is holding.
 */
export function owner_liveness(
  owner: LockOwner | null,
  probes: LivenessProbes = default_liveness_probes,
): OwnerLiveness {
  if (owner === null) return "unknown";

  const answer =
    owner.kind === "tmux"
      ? probes.tmux_session_alive(owner.id)
      : probes.process_alive(Number.parseInt(owner.id, 10));

  if (answer === null) return "unknown";
  return answer ? "alive" : "gone";
}

// ── The decision ──

export type ReapDecision =
  | { action: "release"; detail: string; loud: boolean }
  | { action: "keep"; detail: string };

function hours(ms: number): string {
  return `${String(Math.round(ms / (60 * 60 * 1000)))}h`;
}

/**
 * Decide what to do about one locked worktree.
 *
 * Pure, so the whole table above is testable without a git repo. The caller
 * supplies what it observed; this function contains all of the judgement.
 *
 * @param locked_reason - Reason git reports, or null/empty when locked without
 *   one. Note that `git worktree add --lock` is *not* this case: git records
 *   the literal reason "added with --lock", which lands in the foreign branch.
 * @param owner - Parsed owner token, or null when the reason carries none.
 * @param liveness - What the probe established about `owner`.
 * @param age_ms - How long since the worktree directory was touched, or null
 *   when that could not be read.
 */
export function lock_reap_decision(input: {
  locked_reason: string | null;
  owner: LockOwner | null;
  liveness: OwnerLiveness;
  age_ms: number | null;
}): ReapDecision {
  const { locked_reason, owner, liveness, age_ms } = input;
  const reason = (locked_reason ?? "").trim();

  // ── Unattributable: locked, but nobody wrote down by whom ──
  if (reason === "") {
    if (age_ms === null) return { action: "keep", detail: "worktree age could not be determined" };
    if (age_ms < UNATTRIBUTABLE_LOCK_REAP_GRACE_MS) {
      return {
        action: "keep",
        detail: `locked with no reason, inside the ${hours(UNATTRIBUTABLE_LOCK_REAP_GRACE_MS)} grace`,
      };
    }
    return {
      action: "release",
      detail: `locked with no reason recorded and untouched for ${hours(age_ms)} — ownership is unknowable`,
      loud: true,
    };
  }

  // ── Foreign: someone else's "do not touch" (#358) ──
  //
  // A reason we do not recognise is a human or another tool asserting a claim
  // we have no standing to overrule, and age is no answer to it. git's own
  // "added with --lock" lands here too, which is exactly right.
  if (!is_agent_lock(reason)) {
    return { action: "keep", detail: `lock is not ours (${reason})` };
  }

  // ── Ours: is the owner still around? ──
  if (owner !== null) {
    if (liveness === "alive") {
      return { action: "keep", detail: `owner ${owner.kind}:${owner.id} is still alive` };
    }
    if (liveness === "unknown") {
      // The probe failed rather than answered. Assuming death here is how a
      // live session loses its protection to a missing tmux binary.
      return {
        action: "keep",
        detail: `could not determine whether owner ${owner.kind}:${owner.id} is alive`,
      };
    }
  }

  // Either the owner is gone, or the lock predates the owner token (#370) and
  // names nobody resolvable. Both mean the same thing to the sweep: there is
  // no one left to ask. Age is the last thing standing.
  const who =
    owner === null ? "lock names no resolvable owner" : `owner ${owner.kind}:${owner.id} is gone`;

  if (age_ms === null) return { action: "keep", detail: "worktree age could not be determined" };
  if (age_ms < LOCK_REAP_GRACE_MS) {
    return {
      action: "keep",
      detail: `${who}, but the worktree is inside the ${hours(LOCK_REAP_GRACE_MS)} grace`,
    };
  }

  return {
    action: "release",
    detail: `${who} and the worktree has been untouched for ${hours(age_ms)}`,
    loud: false,
  };
}

// ── The pass ──

export interface ReapOptions {
  probes?: LivenessProbes;
}

/**
 * Release orphaned locks across every active entity's repos.
 *
 * Best-effort throughout, like the rest of worktree cleanup: a repo that
 * cannot be read is skipped, never fatal. Runs on the daemon's existing hourly
 * cleanup cadence, immediately before the sweep, so a lock released this hour
 * is honoured by the same hour's sweep — which then applies its own, longer
 * grace and its own guards before destroying anything.
 *
 * @returns How many locks were released.
 */
export async function reap_stale_worktree_locks(
  registry: EntityRegistry,
  options: ReapOptions = {},
): Promise<number> {
  const probes = options.probes ?? default_liveness_probes;
  let total_released = 0;

  for (const entity_config of registry.get_active()) {
    for (const repo of entity_config.entity.repos) {
      const repo_path = expand_home(repo.path);

      try {
        await stat(repo_path);
      } catch {
        continue;
      }

      total_released += await reap_repo_locks(repo_path, probes);
    }
  }

  if (total_released > 0) {
    console.log(
      `[lock-reaper] Released ${String(total_released)} orphaned worktree lock(s); removal remains the guarded sweep's job`,
    );
  }

  return total_released;
}

/** Release orphaned locks in a single repo. Returns how many were released. */
async function reap_repo_locks(repo_path: string, probes: LivenessProbes): Promise<number> {
  let entries: ReturnType<typeof parse_worktree_list>;
  try {
    const { stdout } = await exec("git", ["worktree", "list", "--porcelain"], {
      cwd: repo_path,
      timeout: GIT_TIMEOUT_MS,
    });
    entries = parse_worktree_list(stdout);
  } catch (err) {
    console.error(
      `[lock-reaper] Could not list worktrees in ${repo_path}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  }

  let released = 0;

  for (const entry of entries) {
    if (!entry.locked) continue;

    // The repo's own working tree is never an agent worktree, and a lock on it
    // is only ever a deliberate human act. Not ours to second-guess.
    if (entry.bare || entry.path === repo_path) continue;

    const owner = parse_lock_owner(entry.locked_reason);
    const decision = lock_reap_decision({
      locked_reason: entry.locked_reason,
      owner,
      liveness: owner_liveness(owner, probes),
      age_ms: await worktree_age_ms(entry.path),
    });

    if (decision.action === "keep") {
      console.log(`[lock-reaper] Keeping lock on ${entry.path}: ${decision.detail}`);
      continue;
    }

    if (await release_lock(repo_path, entry.path)) {
      released++;
      const line = `[lock-reaper] Released lock on ${entry.path}: ${decision.detail}`;
      if (decision.loud) {
        // An un-ownable lock is a leak somewhere upstream. Say so where a
        // human will see it, not just in the cleanup stream.
        console.warn(line);
      } else {
        console.log(line);
      }
    }
  }

  return released;
}

/**
 * How long since the worktree directory was touched, or null when that cannot
 * be read — which every caller must treat as "do not act".
 */
async function worktree_age_ms(worktree_path: string): Promise<number | null> {
  try {
    const { mtimeMs } = await stat(worktree_path);
    if (typeof mtimeMs !== "number" || !Number.isFinite(mtimeMs)) return null;
    return Math.max(0, Date.now() - mtimeMs);
  } catch {
    // Directory is gone. `git worktree prune` cleans the registration up; a
    // lock on a path that no longer exists is not ours to reason about.
    return null;
  }
}

/**
 * The reaper's one and only mutation.
 *
 * Kept as a named function so the destructive surface of this module is a
 * single, greppable call site: `git worktree unlock`, nothing more.
 */
async function release_lock(repo_path: string, worktree_path: string): Promise<boolean> {
  try {
    await exec("git", ["worktree", "unlock", worktree_path], {
      cwd: repo_path,
      timeout: GIT_TIMEOUT_MS,
    });
    return true;
  } catch (err) {
    console.error(
      `[lock-reaper] Could not unlock ${worktree_path}: ${err instanceof Error ? err.message : String(err)}`,
    );
    sentry.captureException(err, {
      tags: { module: "lock-reaper", action: "release_lock" },
      contexts: { worktree: { path: worktree_path } },
    });
    return false;
  }
}
