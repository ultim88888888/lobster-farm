/**
 * Worktree cleanup utilities.
 *
 * Provides best-effort cleanup of git worktrees after PR merges and a periodic
 * sweep for stale worktrees whose branches have already been merged or deleted.
 *
 * All functions are designed to fail silently — cleanup should never break
 * the merge handler, PR cron, or daemon lifecycle.
 *
 * The periodic sweep decides staleness from branch state alone, which cannot
 * distinguish an abandoned branch from a live one that has not been pushed
 * yet. Four independent guards stand between a staleness guess and an
 * irreversible `git worktree remove`:
 *
 *  1. `branch_remote_state` — a branch with no upstream *ever* configured has
 *     never reached the remote, so "no remote ref" says nothing about whether
 *     it is finished. Those branches are off-limits at any age (#357).
 *  2. `grace_period_reason` — a recently touched worktree directory is not
 *     swept, whatever the branch state suggests (#357).
 *  3. `worktree_protection_reason` — refuses to give up a worktree holding
 *     unpushed commits, uncommitted changes, or a lock (#351).
 *  4. `branch_merge_state` — git must confirm the branch's commits are
 *     reachable from main before anything is removed. "Not fully merged" is a
 *     stop, never a warning to log past (#357).
 *
 * Every guard fails closed: a check that errors protects the worktree. Losing
 * an hour of agent work is far more expensive than leaking a directory.
 */

import { execFile, execFileSync } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expand_home } from "@lobster-farm/shared";
import type { EntityRegistry } from "./registry.js";
import * as sentry from "./sentry.js";
import { sq } from "./shell.js";
import { is_agent_lock } from "./worktree-lock.js";

const exec = promisify(execFile);

/** Timeout for git commands — generous but bounded. */
const GIT_TIMEOUT_MS = 30_000;

/**
 * A worktree whose directory has been touched more recently than this is
 * never swept, however stale its branch looks.
 *
 * The window that destroyed work in #357 was worktree creation → first push,
 * usually minutes. Six hours covers that with room to spare while still
 * letting the sweep reclaim genuinely abandoned trees the same day.
 */
const SWEEP_GRACE_MS = 6 * 60 * 60 * 1000;

/**
 * Refs the sweep will accept as proof that a branch's commits survive its
 * deletion, in the order they are tried. `origin/main` matters on its own:
 * a clone whose local `main` is behind still has the merge recorded there.
 */
const MERGE_TARGET_REFS = ["main", "origin/main", "master", "origin/master"];

// ── Session relocation ──

/**
 * Check all tmux sessions for panes whose cwd is inside `target_path`.
 * For any matches, send a `cd` command to relocate them to `safe_path`.
 *
 * Best-effort: errors for individual sessions are logged but never thrown.
 * This prevents worktree cleanup from failing if tmux is unavailable or
 * a session is in a transient state.
 *
 * @returns The number of sessions that were relocated.
 */
export function relocate_sessions_from_path(target_path: string, safe_path: string): number {
  // Normalize: ensure target_path ends with / for prefix matching.
  // This prevents false positives like /foo/bar-baz matching /foo/bar.
  const target_prefix = target_path.endsWith("/") ? target_path : `${target_path}/`;

  let pane_lines: string[];
  try {
    const result = execFileSync(
      "tmux",
      ["list-panes", "-a", "-F", "#{session_name} #{pane_id} #{pane_current_path}"],
      { encoding: "utf-8", timeout: 5000 },
    );
    pane_lines = result.trim().split("\n").filter(Boolean);
  } catch {
    // tmux not running or no sessions — nothing to relocate
    return 0;
  }

  let relocated = 0;

  for (const line of pane_lines) {
    // Each line: "session_name %N /path/to/cwd"
    const [session, pane_id, ...path_parts] = line.split(" ");
    if (!session || !pane_id) continue;
    const pane_cwd = path_parts.join(" "); // handles paths with spaces

    try {
      // Check if the pane's cwd is inside (or exactly at) the target path
      if (pane_cwd === target_path || pane_cwd.startsWith(target_prefix)) {
        execFileSync("tmux", ["send-keys", "-t", pane_id, `cd ${sq(safe_path)}`, "Enter"], {
          timeout: 2000,
        });
        console.log(
          `[worktree-cleanup] Relocated pane ${pane_id} (${session}): ${pane_cwd} → ${safe_path}`,
        );
        relocated++;
      }
    } catch (err) {
      // Per-pane errors are non-fatal — the pane may have died between
      // listing and querying, or it may be in a state that rejects send-keys.
      console.log(
        `[worktree-cleanup] Could not relocate pane ${pane_id} (${session}): ${String(err instanceof Error ? err.message : err)}`,
      );
    }
  }

  return relocated;
}

// ── Parsed worktree entry from `git worktree list --porcelain` ──

interface WorktreeEntry {
  /** Absolute path to the worktree directory. */
  path: string;
  /** HEAD commit hash. */
  head: string;
  /** Branch ref (e.g. "refs/heads/feature/foo"), or null if detached. */
  branch: string | null;
  /** True if this is the main working tree. */
  bare: boolean;
  /** True if the worktree is locked (`git worktree lock`). */
  locked: boolean;
  /** Reason given at lock time, or null when locked without one / unlocked. */
  locked_reason: string | null;
}

/**
 * Parse the output of `git worktree list --porcelain` into structured entries.
 *
 * Porcelain format is blocks separated by blank lines:
 *   worktree /path/to/tree
 *   HEAD abc123
 *   branch refs/heads/main
 *   locked optional reason
 *   <blank line>
 */
export function parse_worktree_list(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  const blocks = output.trim().split("\n\n");

  for (const block of blocks) {
    if (!block.trim()) continue;

    const lines = block.trim().split("\n");
    let path = "";
    let head = "";
    let branch: string | null = null;
    let bare = false;
    let locked = false;
    let locked_reason: string | null = null;

    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        path = line.slice("worktree ".length);
      } else if (line.startsWith("HEAD ")) {
        head = line.slice("HEAD ".length);
      } else if (line.startsWith("branch ")) {
        branch = line.slice("branch ".length);
      } else if (line === "bare") {
        bare = true;
      } else if (line === "locked") {
        locked = true;
      } else if (line.startsWith("locked ")) {
        locked = true;
        locked_reason = line.slice("locked ".length).trim() || null;
      }
    }

    if (path) {
      entries.push({ path, head, branch, bare, locked, locked_reason });
    }
  }

  return entries;
}

// ── Work-in-progress protection (issue #351) ──

/**
 * Base refs to compare against when a branch has no upstream, in preference
 * order. Anything on the worktree that is not already in one of these exists
 * only on this machine.
 */
const FALLBACK_BASE_REFS = ["origin/main", "main", "origin/master", "master"];

function err_msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Outcome of a git command whose non-zero exit codes are part of its answer. */
type GitProbe = { ok: true; stdout: string } | { ok: false; code: number | null; message: string };

/**
 * Run a git command and report its exit status instead of throwing.
 *
 * Several of git's queries answer "no" by exiting non-zero, and the sweep has
 * to tell that apart from "the command failed". `code` is the exit status when
 * git ran and exited, and null when it never got that far (timeout, signal,
 * missing binary) — the cases where no conclusion may be drawn.
 */
async function git_probe(cwd: string, args: string[]): Promise<GitProbe> {
  try {
    const { stdout } = await exec("git", args, { cwd, timeout: GIT_TIMEOUT_MS });
    return { ok: true, stdout };
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    return {
      ok: false,
      code: typeof code === "number" ? code : null,
      message: err_msg(err),
    };
  }
}

/**
 * Return the first ref in `refs` that resolves to a commit, or null if none do.
 */
async function first_existing_ref(cwd: string, refs: string[]): Promise<string | null> {
  for (const ref of refs) {
    try {
      await exec("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
        cwd,
        timeout: GIT_TIMEOUT_MS,
      });
      return ref;
    } catch {
      // Ref doesn't exist in this repo — try the next candidate.
    }
  }
  return null;
}

/**
 * Describe any commits in the worktree that exist nowhere but this machine,
 * or null if everything is safely pushed.
 */
async function unpushed_commits_reason(worktree_path: string): Promise<string | null> {
  // The branch's own upstream is the only authoritative answer to "what has
  // already been pushed?". It is absent for a branch that has never been
  // pushed — precisely the case this guard exists for — so handle that
  // explicitly instead of letting `@{u}` throw and be swallowed as "clean".
  let base: string | null = null;
  try {
    const { stdout } = await exec(
      "git",
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
      { cwd: worktree_path, timeout: GIT_TIMEOUT_MS },
    );
    base = stdout.trim() || null;
  } catch {
    base = null; // no upstream configured
  }

  if (base === null) {
    base = await first_existing_ref(worktree_path, FALLBACK_BASE_REFS);
    if (base === null) {
      return "no upstream and no main/master ref to compare against";
    }
  }

  try {
    const { stdout } = await exec("git", ["rev-list", "--count", `${base}..HEAD`], {
      cwd: worktree_path,
      timeout: GIT_TIMEOUT_MS,
    });
    const count = Number.parseInt(stdout.trim(), 10);
    if (Number.isNaN(count)) {
      return `unpushed-commit check returned unparseable output: ${JSON.stringify(stdout.trim())}`;
    }
    return count > 0 ? `${String(count)} unpushed commit(s) vs ${base}` : null;
  } catch (err) {
    return `unpushed-commit check failed: ${err_msg(err)}`;
  }
}

// ── Branch state (issue #357) ──

/**
 * What the remote knows about a branch.
 *
 * - `present`     — `refs/remotes/origin/<branch>` still exists.
 * - `gone`        — an upstream was configured, and the remote ref is now
 *                   absent. The branch reached the remote and was deleted
 *                   there, which is the only thing the sweep may read as
 *                   "finished".
 * - `never-pushed`— no upstream was ever configured. The branch exists only
 *                   on this machine, so nothing about the remote can say
 *                   whether its work is done.
 * - `unknown`     — a check failed. Draw no conclusions.
 */
type BranchRemoteState = "present" | "gone" | "never-pushed" | "unknown";

/**
 * Classify a branch by what the remote knows about it.
 *
 * This is the root-cause fix for #357. The old check asked only whether
 * `refs/remotes/origin/<branch>` existed, and a branch created ten minutes ago
 * answers that question exactly like a branch whose remote was deleted after
 * merge. `branch.<name>.remote` separates them: git writes it on the first
 * `push -u`, so its absence means the branch has never been pushed at all.
 */
async function branch_remote_state(repo_path: string, branch: string): Promise<BranchRemoteState> {
  const ref = await git_probe(repo_path, [
    "rev-parse",
    "--verify",
    `refs/remotes/origin/${branch}`,
  ]);
  if (ref.ok) return "present";
  // git exits 128 for a ref it cannot resolve and 1 for a quiet failure;
  // anything else (timeout, signal) means the probe never answered.
  if (ref.code !== 1 && ref.code !== 128) return "unknown";

  const configured = await git_probe(repo_path, ["config", "--get", `branch.${branch}.remote`]);
  if (configured.ok) {
    return configured.stdout.trim() === "" ? "never-pushed" : "gone";
  }
  // `git config --get` exits 1 when the key is not set — the whole point.
  if (configured.code === 1) return "never-pushed";
  return "unknown";
}

/** Whether a branch's commits survive deleting the branch. */
type BranchMergeState = "merged" | "unmerged" | "unknown";

/**
 * Ask git whether every commit on `branch` is already reachable from a merge
 * target — the same question `git branch -d` asks before it agrees to delete.
 *
 * The sweep asks *before* touching the worktree. In the #357 incident the
 * answer arrived the other way round: `Removed worktree` was logged first, and
 * `the branch ... is not fully merged` second, by which point the only copy of
 * the work was already gone. (git will not even run `branch -d` while a
 * worktree has the branch checked out, so the pre-check cannot use it.)
 */
async function branch_merge_state(repo_path: string, branch: string): Promise<BranchMergeState> {
  let compared_against_something = false;
  let a_check_failed = false;

  for (const ref of MERGE_TARGET_REFS) {
    const exists = await git_probe(repo_path, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${ref}^{commit}`,
    ]);
    if (!exists.ok) continue;

    compared_against_something = true;
    const ancestor = await git_probe(repo_path, [
      "merge-base",
      "--is-ancestor",
      `refs/heads/${branch}`,
      ref,
    ]);
    if (ancestor.ok) return "merged";
    // Exit 1 is git's "no". Anything else is a failure to answer.
    if (ancestor.code !== 1) a_check_failed = true;
  }

  if (!compared_against_something || a_check_failed) return "unknown";
  return "unmerged";
}

/**
 * Refuse to sweep a worktree that has been touched recently, whatever its
 * branch state suggests.
 *
 * Belt and braces for anything the branch-level guards miss: the branch checks
 * reason about history, and history says nothing about whether an agent is
 * sitting in the directory right now.
 */
async function grace_period_reason(worktree_path: string): Promise<string | null> {
  let mtime_ms: number;
  try {
    ({ mtimeMs: mtime_ms } = await stat(worktree_path));
  } catch {
    // Already gone — nothing to protect, and the registration should be pruned.
    return null;
  }

  if (typeof mtime_ms !== "number" || !Number.isFinite(mtime_ms)) {
    return "worktree age could not be determined";
  }

  const age_ms = Date.now() - mtime_ms;
  if (age_ms < SWEEP_GRACE_MS) {
    const age_min = Math.max(0, Math.round(age_ms / 60_000));
    const grace_h = SWEEP_GRACE_MS / (60 * 60 * 1000);
    return `modified ${String(age_min)}m ago, inside the ${String(grace_h)}h grace period`;
  }
  return null;
}

/**
 * Decide whether a worktree still holds work that must not be destroyed.
 *
 * Returns a human-readable reason to skip the worktree, or null when it is
 * safe to remove.
 *
 * Every failure path returns a reason: if we cannot *prove* a worktree is
 * disposable, we leave it alone. Losing an hour of agent work is far more
 * expensive than leaking a directory until the next sweep.
 *
 * @param index - The repo's worktree listing, for lock state.
 */
async function worktree_protection_reason(
  worktree_path: string,
  index: WorktreeIndex,
): Promise<string | null> {
  // Detecting the lock here turns what used to be a `git worktree remove`
  // failure into a logged skip, so genuine removal errors stay visible.
  const locked = lock_reason(index, worktree_path);
  if (locked !== null) return locked;

  // A directory that is already gone holds nothing worth saving, and leaving
  // it registered leaks a stale entry forever.
  try {
    await stat(worktree_path);
  } catch {
    return null;
  }

  // Confirm git resolves this path as a worktree root. A non-empty prefix
  // means the checks below would read some parent repo's state and draw
  // conclusions about the wrong tree.
  try {
    const { stdout } = await exec("git", ["rev-parse", "--show-prefix"], {
      cwd: worktree_path,
      timeout: GIT_TIMEOUT_MS,
    });
    const prefix = stdout.trim();
    if (prefix !== "") {
      return `not a worktree root (git resolves it to the subdirectory ${prefix})`;
    }
  } catch (err) {
    return `worktree root check failed: ${err_msg(err)}`;
  }

  // Uncommitted changes are the most unrecoverable thing on disk.
  try {
    const { stdout } = await exec("git", ["status", "--porcelain"], {
      cwd: worktree_path,
      timeout: GIT_TIMEOUT_MS,
    });
    const changed = stdout.trim();
    if (changed !== "") {
      return `uncommitted changes (${String(changed.split("\n").length)} path(s))`;
    }
  } catch (err) {
    return `dirty-tree check failed: ${err_msg(err)}`;
  }

  return await unpushed_commits_reason(worktree_path);
}

/**
 * Extract the short branch name from a refs/heads/ ref.
 * e.g. "refs/heads/feature/134-auto-cleanup" → "feature/134-auto-cleanup"
 */
function short_branch(ref: string): string {
  const prefix = "refs/heads/";
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
}

// ── Core cleanup function ──

/**
 * Remove a single worktree and its branch. Best-effort — logs errors but
 * never throws. Safe to call even if the worktree or branch no longer exists.
 *
 * @param repo_path - Root repo path (not the worktree itself)
 * @param worktree_path - Absolute path to the worktree directory
 * @param branch - Branch name (short form, e.g. "feature/134-auto-cleanup")
 * @param options.force - Pass `--force` to `git worktree remove`. Appropriate
 *   after a merge, where the work is known to have landed and leftover build
 *   output should not block cleanup. The sweep passes false: there, `--force`
 *   overrides git's own refusal to remove a locked or dirty tree, which is
 *   the last line of defence between a wrong staleness guess and lost work.
 */
export async function remove_worktree(
  repo_path: string,
  worktree_path: string,
  branch: string,
  options: { force?: boolean } = {},
): Promise<boolean> {
  const { force = true } = options;
  let removed_worktree = false;

  // Step 1: Remove the worktree
  try {
    await exec("git", ["worktree", "remove", worktree_path, ...(force ? ["--force"] : [])], {
      cwd: repo_path,
      timeout: GIT_TIMEOUT_MS,
    });
    removed_worktree = true;
    console.log(`[worktree-cleanup] Removed worktree: ${worktree_path}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // "not a working tree" or similar means it's already gone — that's fine
    if (msg.includes("not a working tree") || msg.includes("is not a valid")) {
      console.log(`[worktree-cleanup] Worktree already gone: ${worktree_path}`);
      removed_worktree = true;
    } else {
      console.error(`[worktree-cleanup] Failed to remove worktree ${worktree_path}: ${msg}`);
      sentry.captureException(err, {
        tags: { module: "worktree-cleanup", action: "remove_worktree" },
        contexts: { worktree: { path: worktree_path, branch } },
      });
    }
  }

  // Step 2: Prune any stale worktree references
  try {
    await exec("git", ["worktree", "prune"], {
      cwd: repo_path,
      timeout: GIT_TIMEOUT_MS,
    });
  } catch {
    // Non-critical — prune is housekeeping
  }

  // Step 3: Delete the branch.
  //
  // Only once the worktree is actually gone: if removal was refused (locked,
  // dirty, still in use) the branch is the last handle on that work and must
  // outlive the failure.
  //
  // Always `-d`, never `-D`. Git refusing with "not fully merged" means the
  // branch holds commits reachable from nowhere else, and this function is
  // best-effort cleanup — it has no standing to overrule that.
  if (!removed_worktree) {
    console.log(
      `[worktree-cleanup] Keeping branch ${branch}: its worktree ${worktree_path} was not removed`,
    );
    return removed_worktree;
  }

  try {
    await exec("git", ["branch", "-d", branch], {
      cwd: repo_path,
      timeout: GIT_TIMEOUT_MS,
    });
    console.log(`[worktree-cleanup] Deleted branch: ${branch}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // "not found" means branch already deleted (e.g., --delete-branch on merge)
    if (msg.includes("not found") || msg.includes("error: branch")) {
      console.log(`[worktree-cleanup] Branch already gone: ${branch}`);
    } else {
      // Not critical — branch may still be needed or was force-deleted
      console.log(`[worktree-cleanup] Could not delete branch ${branch}: ${msg}`);
    }
  }

  return removed_worktree;
}

// ── Worktree index ──

/**
 * What `git worktree list` knows about a repo, keyed by path.
 *
 * Both cleanup paths need the same two facts about a directory before they
 * touch it — is it locked, and which branch is checked out in it — so both
 * read them from one listing.
 */
interface WorktreeIndex {
  /** Lock reason by path. Presence of the key means the worktree is locked. */
  locks: Map<string, string | null>;
  /** Short branch name by worktree path. */
  branch_by_path: Map<string, string>;
  /** Worktree path by short branch name. */
  path_by_branch: Map<string, string>;
}

function index_worktrees(entries: WorktreeEntry[]): WorktreeIndex {
  const index: WorktreeIndex = {
    locks: new Map(),
    branch_by_path: new Map(),
    path_by_branch: new Map(),
  };

  for (const entry of entries) {
    if (entry.locked) index.locks.set(entry.path, entry.locked_reason);
    if (entry.branch) {
      const branch = short_branch(entry.branch);
      index.branch_by_path.set(entry.path, branch);
      if (!index.path_by_branch.has(branch)) index.path_by_branch.set(branch, entry.path);
    }
  }

  return index;
}

/** Read the repo's worktree listing. Returns an empty index if git fails. */
async function load_worktree_index(repo_path: string): Promise<WorktreeIndex> {
  try {
    const { stdout } = await exec("git", ["worktree", "list", "--porcelain"], {
      cwd: repo_path,
      timeout: GIT_TIMEOUT_MS,
    });
    return index_worktrees(parse_worktree_list(stdout));
  } catch (err) {
    console.error(`[worktree-cleanup] Failed to list worktrees in ${repo_path}: ${String(err)}`);
    return index_worktrees([]);
  }
}

/**
 * A lock is an explicit "do not touch" from whoever created the worktree, and
 * it outranks every reason the sweep has for removing it — a merged branch
 * says the *work* landed but nothing about whether a session is still living
 * in the directory.
 *
 * The one exception is our own lock on the post-merge path; see
 * `clear_lock_for_intended_removal`.
 *
 * Returns a skip reason, or null when the worktree is not locked.
 */
function lock_reason(index: WorktreeIndex, worktree_path: string): string | null {
  if (!index.locks.has(worktree_path)) return null;
  const reason = index.locks.get(worktree_path);
  return reason ? `worktree is locked (${reason})` : "worktree is locked";
}

/**
 * The lock check for an *intended* removal — the post-merge path, which has
 * positive evidence the PR landed.
 *
 * Since #359 every agent worktree is locked from the moment it is created, so
 * honouring locks unconditionally here would mean nothing is ever cleaned up.
 * Our own lock is a note-to-self that expires when the work lands, and this is
 * the one place entitled to release it. Anyone else's lock still wins.
 *
 * Returns a skip reason, or null once the worktree is clear to remove.
 */
async function clear_lock_for_intended_removal(
  repo_path: string,
  worktree_path: string,
  index: WorktreeIndex,
): Promise<string | null> {
  const locked = lock_reason(index, worktree_path);
  if (locked === null) return null;
  if (!is_agent_lock(index.locks.get(worktree_path))) return locked;

  // Best-effort: if the unlock fails, git refuses the removal below and
  // remove_worktree reports it — which is the correct outcome, not a reason
  // to bypass git with an rm.
  try {
    await exec("git", ["worktree", "unlock", worktree_path], {
      cwd: repo_path,
      timeout: GIT_TIMEOUT_MS,
    });
    console.log(`[worktree-cleanup] Released our own lock on ${worktree_path}`);
  } catch (err) {
    console.log(`[worktree-cleanup] Could not unlock ${worktree_path}: ${err_msg(err)}`);
  }
  return null;
}

// ── Find worktree for a specific branch ──

/**
 * Find the worktree entry for a given branch name in a repo.
 * Returns the worktree path if found, null otherwise.
 */
export async function find_worktree_for_branch(
  repo_path: string,
  branch: string,
): Promise<string | null> {
  const index = await load_worktree_index(repo_path);
  return index.path_by_branch.get(branch) ?? null;
}

// ── Cleanup on PR merge ──

/**
 * Clean up worktrees associated with a merged PR's branch.
 * Called from the webhook handler after a PR merge event.
 *
 * Checks both git-tracked worktrees and .claude/worktrees/ directories.
 */
export async function cleanup_after_merge(repo_path: string, branch: string): Promise<void> {
  console.log(`[worktree-cleanup] Cleaning up after merge of branch: ${branch}`);

  const index = await load_worktree_index(repo_path);

  // 1. Check git worktree list for a worktree on this branch
  const worktree_path = index.path_by_branch.get(branch);
  if (worktree_path !== undefined) {
    const locked = await clear_lock_for_intended_removal(repo_path, worktree_path, index);
    if (locked !== null) {
      // Leave the branch alone too: it is the handle on whatever the lock
      // holder is still doing in that directory.
      console.log(`[worktree-cleanup] Skipping ${worktree_path} [${branch}]: ${locked}`);
    } else {
      // Relocate any sessions whose cwd is inside this worktree before removal
      const relocated = relocate_sessions_from_path(worktree_path, repo_path);
      if (relocated > 0) {
        console.log(
          `[worktree-cleanup] Relocated ${String(relocated)} session(s) from ${worktree_path}`,
        );
      }
      await remove_worktree(repo_path, worktree_path, branch);
    }
  } else {
    console.log(`[worktree-cleanup] No git worktree found for branch: ${branch}`);
    // Still try to delete the branch even if no worktree was found
    try {
      await exec("git", ["branch", "-d", branch], {
        cwd: repo_path,
        timeout: GIT_TIMEOUT_MS,
      });
      console.log(`[worktree-cleanup] Deleted branch: ${branch}`);
    } catch {
      // Branch may already be gone — fine
    }
  }

  // 2. Check .claude/worktrees/ for agent-created worktrees matching this branch
  await cleanup_claude_worktrees(repo_path, branch, index);
}

/**
 * Scan .claude/worktrees/ in the repo for directories that reference the
 * given branch. Agent-created worktrees follow the pattern of branch slug
 * as directory name (e.g., .claude/worktrees/agent-feature-134-auto-cleanup).
 *
 * Directory names are matched by substring, which is loose enough to catch a
 * neighbour: cleaning up "feature/12" also matches "agent-123-something". The
 * worktree listing settles it — a directory git has registered against a
 * different branch is never the one we were asked to clean up.
 *
 * @param sweep - Supplied only by the periodic sweep. Its presence turns on
 *   the age and work-in-progress guards, and drops `--force` from the removal.
 *
 *   The post-merge path deliberately omits it: a merge event is positive
 *   evidence the work landed, whereas the sweep is only guessing. A squash
 *   merge also always leaves the local branch ahead of main, so guarding the
 *   post-merge path would disable it entirely.
 *
 *   Locks are honoured either way, with one exception: the post-merge path
 *   releases the lock `create_worktree` placed on its own worktrees (#359),
 *   which would otherwise make every agent worktree permanent.
 */
async function cleanup_claude_worktrees(
  repo_path: string,
  branch: string,
  index: WorktreeIndex,
  sweep = false,
): Promise<void> {
  const claude_wt_dir = join(repo_path, ".claude", "worktrees");

  try {
    await stat(claude_wt_dir);
  } catch {
    // No .claude/worktrees/ directory — nothing to do
    return;
  }

  // The branch slug is the part after the last slash, lowercased
  // e.g. "feature/134-auto-cleanup" → "134-auto-cleanup"
  const branch_slug = branch.includes("/") ? branch.slice(branch.lastIndexOf("/") + 1) : branch;

  try {
    const entries = await readdir(claude_wt_dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      // Match directories that contain the branch slug
      if (entry.name.includes(branch_slug)) {
        const wt_path = join(claude_wt_dir, entry.name);

        // The sweep is only guessing at staleness, so it honours every lock,
        // including our own. Only the post-merge path may release one.
        const locked = sweep
          ? lock_reason(index, wt_path)
          : await clear_lock_for_intended_removal(repo_path, wt_path, index);
        if (locked !== null) {
          console.log(`[worktree-cleanup] Skipping ${wt_path} [${branch}]: ${locked}`);
          continue;
        }

        const registered_branch = index.branch_by_path.get(wt_path);
        if (registered_branch !== undefined && registered_branch !== branch) {
          console.log(
            `[worktree-cleanup] Skipping ${wt_path} [${branch}]: name matched, but git has it checked out on ${registered_branch}`,
          );
          continue;
        }

        if (sweep) {
          const young = await grace_period_reason(wt_path);
          if (young !== null) {
            console.log(`[worktree-cleanup] Skipping ${wt_path} [${branch}]: ${young}`);
            continue;
          }

          const protection = await worktree_protection_reason(wt_path, index);
          if (protection !== null) {
            console.log(`[worktree-cleanup] Skipping ${wt_path} [${branch}]: ${protection}`);
            continue;
          }
        }

        console.log(`[worktree-cleanup] Found .claude/worktrees/ match: ${wt_path}`);
        // Relocate any sessions whose cwd is inside this worktree before removal
        const relocated = relocate_sessions_from_path(wt_path, repo_path);
        if (relocated > 0) {
          console.log(
            `[worktree-cleanup] Relocated ${String(relocated)} session(s) from ${wt_path}`,
          );
        }
        await remove_worktree(repo_path, wt_path, branch, { force: !sweep });
      }
    }
  } catch (err) {
    console.error(`[worktree-cleanup] Error scanning .claude/worktrees/: ${String(err)}`);
  }
}

// ── Periodic stale worktree sweep ──

/**
 * Sweep all entity repos for stale worktrees. A worktree is a *candidate* if
 * its branch has been merged into main, or its branch reached the remote and
 * its remote tracking ref has since been deleted.
 *
 * Being a candidate is not sufficient — see the four guards described at the
 * top of this file, every one of which can veto the removal.
 *
 * Designed to run periodically (e.g., hourly) as a safety net.
 */
export async function sweep_stale_worktrees(registry: EntityRegistry): Promise<void> {
  const entities = registry.get_active();
  let total_cleaned = 0;

  for (const entity_config of entities) {
    for (const repo of entity_config.entity.repos) {
      const repo_path = expand_home(repo.path);

      // Verify repo exists before shelling out
      try {
        await stat(repo_path);
      } catch {
        continue;
      }

      const cleaned = await sweep_repo(repo_path);
      total_cleaned += cleaned;
    }
  }

  if (total_cleaned > 0) {
    console.log(
      `[worktree-cleanup] Sweep complete: cleaned ${String(total_cleaned)} stale worktree(s)`,
    );
  }
}

/**
 * Sweep a single repo for stale worktrees.
 * Returns the number of worktrees cleaned up.
 */
async function sweep_repo(repo_path: string): Promise<number> {
  // Fetch remote refs first so we have current state
  try {
    await exec("git", ["fetch", "--prune"], {
      cwd: repo_path,
      timeout: GIT_TIMEOUT_MS,
    });
  } catch {
    // Non-critical — we'll still check local state
  }

  // Get the list of branches merged into main
  let merged_branches: Set<string>;
  try {
    const { stdout } = await exec("git", ["branch", "--merged", "main"], {
      cwd: repo_path,
      timeout: GIT_TIMEOUT_MS,
    });
    merged_branches = new Set(
      stdout
        .split("\n")
        .map((line) => line.trim().replace(/^\* /, ""))
        .filter((b) => b && b !== "main"),
    );
  } catch {
    // Can't determine merged branches — skip this repo
    return 0;
  }

  // List all worktrees
  let entries: WorktreeEntry[];
  try {
    const { stdout } = await exec("git", ["worktree", "list", "--porcelain"], {
      cwd: repo_path,
      timeout: GIT_TIMEOUT_MS,
    });
    entries = parse_worktree_list(stdout);
  } catch {
    return 0;
  }

  const index = index_worktrees(entries);

  let cleaned = 0;

  for (const entry of entries) {
    // Skip the main working tree (the first entry, or bare repos)
    if (entry.bare || !entry.branch) continue;

    const branch = short_branch(entry.branch);

    // Never clean up main
    if (branch === "main" || branch === "master") continue;

    // Check if this is the main working tree (same path as repo_path)
    if (entry.path === repo_path) continue;

    // Guard 1 (#357): a branch that has never been pushed is new, not stale.
    // Nothing on the remote can vouch for its commits, so nothing about the
    // remote may be used to decide the worktree is disposable — at any age.
    const remote_state = await branch_remote_state(repo_path, branch);
    if (remote_state === "never-pushed") {
      console.log(
        `[worktree-cleanup] Skipping ${entry.path} [${branch}]: branch has never been pushed`,
      );
      continue;
    }
    if (remote_state === "unknown") {
      console.log(
        `[worktree-cleanup] Skipping ${entry.path} [${branch}]: could not determine remote state`,
      );
      continue;
    }

    let stale_reason: string | null = null;

    // Case 1: Branch is merged into main
    if (merged_branches.has(branch)) {
      stale_reason = "branch merged";
    }

    // Case 2: The branch reached the remote and its ref has since been deleted
    if (stale_reason === null && remote_state === "gone") {
      stale_reason = "remote gone";
    }

    if (stale_reason === null) continue;

    // Both cases above are heuristics about whether the *work* is finished,
    // and neither is evidence that the *worktree* is idle: a merged branch can
    // pick up new commits at any time. Check the disk before destroying
    // anything.
    const young = await grace_period_reason(entry.path);
    if (young !== null) {
      console.log(`[worktree-cleanup] Skipping ${entry.path} [${branch}]: ${young}`);
      continue;
    }

    const protection = await worktree_protection_reason(entry.path, index);
    if (protection !== null) {
      console.log(`[worktree-cleanup] Skipping ${entry.path} [${branch}]: ${protection}`);
      continue;
    }

    // Last gate: git must agree the branch's commits outlive the branch.
    const merge_state = await branch_merge_state(repo_path, branch);
    if (merge_state !== "merged") {
      const detail =
        merge_state === "unmerged"
          ? "branch is not fully merged"
          : "could not confirm the branch is fully merged";
      console.log(`[worktree-cleanup] Skipping ${entry.path} [${branch}]: ${detail}`);
      continue;
    }

    console.log(`[worktree-cleanup] Stale worktree (${stale_reason}): ${entry.path} [${branch}]`);

    // Relocate any sessions whose cwd is inside this worktree before removal
    const relocated = relocate_sessions_from_path(entry.path, repo_path);
    if (relocated > 0) {
      console.log(
        `[worktree-cleanup] Relocated ${String(relocated)} session(s) from ${entry.path}`,
      );
    }
    // Unforced: git's own refusal to remove a locked or dirty tree is the last
    // thing standing between a wrong guess above and lost work.
    const removed = await remove_worktree(repo_path, entry.path, branch, { force: false });
    if (removed) cleaned++;
  }

  // Also sweep .claude/worktrees/ for agent directories referencing merged
  // branches. Guarded, for the same reasons the loop above is.
  //
  // Checked once up front: without a .claude/worktrees/ directory this loop
  // has nothing to do, and it would otherwise cost two git calls per merged
  // branch on every sweep of every repo.
  try {
    await stat(join(repo_path, ".claude", "worktrees"));
  } catch {
    return cleaned;
  }

  for (const branch of merged_branches) {
    const remote_state = await branch_remote_state(repo_path, branch);
    if (remote_state === "never-pushed" || remote_state === "unknown") continue;
    await cleanup_claude_worktrees(repo_path, branch, index, true);
  }

  return cleaned;
}
