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
 * yet. Before removing anything it therefore consults
 * `worktree_protection_reason`, which refuses to give up a worktree holding
 * unpushed commits, uncommitted changes, or a lock — and refuses on any check
 * that errors. See issue #351.
 */

import { execFile, execFileSync } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expand_home } from "@lobster-farm/shared";
import type { EntityRegistry } from "./registry.js";
import * as sentry from "./sentry.js";
import { sq } from "./shell.js";

const exec = promisify(execFile);

/** Timeout for git commands — generous but bounded. */
const GIT_TIMEOUT_MS = 30_000;

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
 * @param locks - Lock reason by worktree path, from `git worktree list`.
 *                Presence of the path means the worktree is locked.
 */
async function worktree_protection_reason(
  worktree_path: string,
  locks: Map<string, string | null>,
): Promise<string | null> {
  // A lock is an explicit "do not touch" from whoever created the worktree.
  // Detecting it here turns what used to be a `git worktree remove` failure
  // into a logged skip, so genuine removal errors stay visible.
  if (locks.has(worktree_path)) {
    const reason = locks.get(worktree_path);
    return reason ? `worktree is locked (${reason})` : "worktree is locked";
  }

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
 */
export async function remove_worktree(
  repo_path: string,
  worktree_path: string,
  branch: string,
): Promise<boolean> {
  let removed_worktree = false;

  // Step 1: Remove the worktree
  try {
    await exec("git", ["worktree", "remove", worktree_path, "--force"], {
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

  // Step 3: Delete the branch (soft delete — fails if not fully merged, which is fine)
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

// ── Find worktree for a specific branch ──

/**
 * Find the worktree entry for a given branch name in a repo.
 * Returns the worktree path if found, null otherwise.
 */
export async function find_worktree_for_branch(
  repo_path: string,
  branch: string,
): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["worktree", "list", "--porcelain"], {
      cwd: repo_path,
      timeout: GIT_TIMEOUT_MS,
    });

    const entries = parse_worktree_list(stdout);
    for (const entry of entries) {
      if (entry.branch && short_branch(entry.branch) === branch) {
        return entry.path;
      }
    }
  } catch (err) {
    console.error(`[worktree-cleanup] Failed to list worktrees in ${repo_path}: ${String(err)}`);
  }

  return null;
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

  // 1. Check git worktree list for a worktree on this branch
  const worktree_path = await find_worktree_for_branch(repo_path, branch);
  if (worktree_path) {
    // Relocate any sessions whose cwd is inside this worktree before removal
    const relocated = relocate_sessions_from_path(worktree_path, repo_path);
    if (relocated > 0) {
      console.log(
        `[worktree-cleanup] Relocated ${String(relocated)} session(s) from ${worktree_path}`,
      );
    }
    await remove_worktree(repo_path, worktree_path, branch);
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
  await cleanup_claude_worktrees(repo_path, branch);
}

/**
 * Scan .claude/worktrees/ in the repo for directories that reference the
 * given branch. Agent-created worktrees follow the pattern of branch slug
 * as directory name (e.g., .claude/worktrees/agent-feature-134-auto-cleanup).
 *
 * @param sweep_locks - Supplied only by the periodic sweep. Its presence turns
 *   on the work-in-progress guard, using the map for worktree lock state.
 *
 *   The post-merge path deliberately omits it: a merge event is positive
 *   evidence the work landed, whereas the sweep is only guessing. A squash
 *   merge also always leaves the local branch ahead of main, so guarding the
 *   post-merge path would disable it entirely.
 */
async function cleanup_claude_worktrees(
  repo_path: string,
  branch: string,
  sweep_locks?: Map<string, string | null>,
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

        if (sweep_locks) {
          const protection = await worktree_protection_reason(wt_path, sweep_locks);
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
        await remove_worktree(repo_path, wt_path, branch);
      }
    }
  } catch (err) {
    console.error(`[worktree-cleanup] Error scanning .claude/worktrees/: ${String(err)}`);
  }
}

// ── Periodic stale worktree sweep ──

/**
 * Sweep all entity repos for stale worktrees. A worktree is stale if:
 * - Its branch has been merged into main, or
 * - Its branch's remote tracking ref no longer exists
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

  // Lock state by worktree path, so a locked tree becomes an explicit skip
  // rather than a `git worktree remove --force` failure.
  const locks = new Map<string, string | null>();
  for (const entry of entries) {
    if (entry.locked) locks.set(entry.path, entry.locked_reason);
  }

  let cleaned = 0;

  for (const entry of entries) {
    // Skip the main working tree (the first entry, or bare repos)
    if (entry.bare || !entry.branch) continue;

    const branch = short_branch(entry.branch);

    // Never clean up main
    if (branch === "main" || branch === "master") continue;

    // Check if this is the main working tree (same path as repo_path)
    if (entry.path === repo_path) continue;

    let stale_reason: string | null = null;

    // Case 1: Branch is merged into main
    if (merged_branches.has(branch)) {
      stale_reason = "branch merged";
    }

    // Case 2: Remote tracking ref is gone (branch deleted on remote)
    if (stale_reason === null && (await is_remote_branch_gone(repo_path, branch))) {
      stale_reason = "remote gone";
    }

    if (stale_reason === null) continue;

    // Both cases above are heuristics about whether the *work* is finished.
    // Neither is evidence that the *worktree* is empty: a merged branch can
    // pick up new commits at any time, and "no remote ref" is also the normal
    // state of a branch that has simply never been pushed. Check the disk
    // before destroying anything.
    const protection = await worktree_protection_reason(entry.path, locks);
    if (protection !== null) {
      console.log(`[worktree-cleanup] Skipping ${entry.path} [${branch}]: ${protection}`);
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
    const removed = await remove_worktree(repo_path, entry.path, branch);
    if (removed) cleaned++;
  }

  // Also sweep .claude/worktrees/ for agent directories referencing merged
  // branches. Guarded, for the same reason the loop above is.
  for (const branch of merged_branches) {
    await cleanup_claude_worktrees(repo_path, branch, locks);
  }

  return cleaned;
}

/**
 * Check if a branch's remote tracking ref (origin/<branch>) no longer exists.
 * Returns true if the remote ref is gone, false if it still exists or on error.
 */
async function is_remote_branch_gone(repo_path: string, branch: string): Promise<boolean> {
  try {
    await exec("git", ["rev-parse", "--verify", `refs/remotes/origin/${branch}`], {
      cwd: repo_path,
      timeout: GIT_TIMEOUT_MS,
    });
    // Ref exists — not stale
    return false;
  } catch {
    // Ref doesn't exist — remote branch is gone
    return true;
  }
}
