/**
 * Worktree cleanup utilities.
 *
 * Provides best-effort cleanup of git worktrees after PR merges and a periodic
 * sweep for stale worktrees whose branches have already been merged or deleted.
 *
 * All functions are designed to fail silently — cleanup should never break
 * the merge handler, PR cron, or daemon lifecycle.
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

/**
 * Check whether any live tmux pane has its cwd inside `target_path`.
 *
 * Used as an in-flight guard: a worktree with an active session/build inside
 * it must never be force-removed, even mid-merge. Best-effort — if tmux is
 * unavailable we return false (no evidence of activity) rather than throwing.
 */
export function has_active_session_in_path(target_path: string): boolean {
  const target_prefix = target_path.endsWith("/") ? target_path : `${target_path}/`;

  let pane_lines: string[];
  try {
    const result = execFileSync("tmux", ["list-panes", "-a", "-F", "#{pane_current_path}"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    pane_lines = result.trim().split("\n").filter(Boolean);
  } catch {
    // tmux not running or no sessions — no evidence of an active build.
    return false;
  }

  return pane_lines.some((cwd) => cwd === target_path || cwd.startsWith(target_prefix));
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
  /** True if the worktree is locked (`git worktree lock` / a `locked` file). */
  locked: boolean;
  /**
   * The lock reason, if the porcelain emitted one (`locked <reason>`), else null.
   * The harness embeds the owning pid here, e.g. "claude agent agent-x (pid 123)".
   */
  lock_reason: string | null;
}

/**
 * Parse the output of `git worktree list --porcelain` into structured entries.
 *
 * Porcelain format is blocks separated by blank lines:
 *   worktree /path/to/tree
 *   HEAD abc123
 *   branch refs/heads/main
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
    let lock_reason: string | null = null;

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
        // Porcelain emits a bare "locked" line when there's no reason.
        locked = true;
      } else if (line.startsWith("locked ")) {
        // "locked <reason>" — the reason carries the owning agent's pid.
        locked = true;
        lock_reason = line.slice("locked ".length);
      }
    }

    if (path) {
      entries.push({ path, head, branch, bare, locked, lock_reason });
    }
  }

  return entries;
}

/**
 * Extract the short branch name from a refs/heads/ ref.
 * e.g. "refs/heads/feature/134-auto-cleanup" → "feature/134-auto-cleanup"
 */
function short_branch(ref: string): string {
  const prefix = "refs/heads/";
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
}

/**
 * Determine whether the process that locked a worktree is still alive.
 *
 * The harness embeds the owning pid in the git lock reason, e.g.
 * "claude agent agent-abc (pid 12345)". Returns:
 *   - `true`  → the owner pid is alive (a genuine in-flight build, keep it)
 *   - `false` → the owner pid is dead (an orphaned lock, safe to reclaim)
 *   - `null`  → no parseable pid in the reason (unknown — caller treats as in-flight)
 */
export function lock_owner_alive(reason: string | null): boolean | null {
  if (!reason) return null;
  const match = reason.match(/\bpid (\d+)\b/);
  if (!match) return null;
  const pid = Number(match[1]);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    // Signal 0 performs existence/permission checks without sending a signal.
    process.kill(pid, 0);
    return true; // process exists
  } catch (err) {
    // EPERM → process exists but we may not signal it → still alive.
    // ESRCH → no such process → dead/orphaned.
    if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}

/**
 * Read the lock status (and reason) of a specific worktree from git porcelain.
 * Throws on git failure — callers decide how to fail safe.
 */
async function get_lock_status(
  repo_path: string,
  worktree_path: string,
): Promise<{ locked: boolean; reason: string | null }> {
  const { stdout } = await exec("git", ["worktree", "list", "--porcelain"], {
    cwd: repo_path,
    timeout: GIT_TIMEOUT_MS,
  });
  const normalized = worktree_path.replace(/\/+$/, "");
  const entry = parse_worktree_list(stdout).find((e) => e.path.replace(/\/+$/, "") === normalized);
  // Unknown path → not a registered worktree here → treat as unlocked.
  return { locked: entry ? entry.locked : false, reason: entry ? entry.lock_reason : null };
}

/**
 * Check whether the worktree at `worktree_path` is locked.
 *
 * The harness (EnterWorktree) marks every active agent build with a git
 * `locked` file. Best-effort — on any error we conservatively report `true`
 * (assume in-flight) so cleanup never destroys an active build. Note this does
 * NOT consider whether the lock is orphaned; `remove_worktree` does that.
 */
export async function is_worktree_locked(
  repo_path: string,
  worktree_path: string,
): Promise<boolean> {
  try {
    const { locked } = await get_lock_status(repo_path, worktree_path);
    return locked;
  } catch (err) {
    // Couldn't determine lock state — fail safe: treat as in-flight, skip removal.
    console.error(
      `[worktree-cleanup] Could not determine lock state for ${worktree_path}, ` +
        `treating as in-flight: ${String(err instanceof Error ? err.message : err)}`,
    );
    return true;
  }
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

  // In-flight guard: never force-remove a worktree that has a live session/build
  // with its cwd inside it, or that is locked by a still-running agent. The
  // harness marks active builds with a git `locked` file whose reason embeds the
  // owner pid. We reclaim a lock ONLY when that pid is dead AND no live session
  // remains — an orphaned lock left by a build that crashed without cleanup.
  // Otherwise we skip. This preserves the protection for in-progress builds (the
  // #155/#174 reaping hazard) while letting cleanup reclaim dead worktrees that
  // would otherwise pile up and spam the sweep forever.
  if (has_active_session_in_path(worktree_path)) {
    console.warn(
      `[worktree-cleanup] Skipping worktree with an active session/build: ${worktree_path}`,
    );
    return false;
  }

  let reclaim_orphaned_lock = false;
  let lock: { locked: boolean; reason: string | null };
  try {
    lock = await get_lock_status(repo_path, worktree_path);
  } catch (err) {
    // Couldn't determine lock state — fail safe: assume in-flight, skip.
    console.error(
      `[worktree-cleanup] Could not determine lock state for ${worktree_path}, ` +
        `treating as in-flight: ${String(err instanceof Error ? err.message : err)}`,
    );
    return false;
  }

  if (lock.locked) {
    const owner_alive = lock_owner_alive(lock.reason);
    if (owner_alive !== false) {
      // Alive, or unknown owner (no parseable pid) — treat as in-flight, keep.
      console.warn(
        `[worktree-cleanup] Skipping locked (in-flight) worktree: ${worktree_path}${
          lock.reason ? ` [${lock.reason}]` : ""
        }`,
      );
      return false;
    }
    // owner_alive === false: the locking agent is gone and no live session
    // remains — this is an orphaned lock, safe to reclaim.
    console.warn(
      `[worktree-cleanup] Reclaiming orphaned lock (owner pid dead) for worktree: ${worktree_path}${
        lock.reason ? ` [${lock.reason}]` : ""
      }`,
    );
    reclaim_orphaned_lock = true;
    // Best-effort unlock so the subsequent remove isn't blocked by the lock.
    try {
      await exec("git", ["worktree", "unlock", worktree_path], {
        cwd: repo_path,
        timeout: GIT_TIMEOUT_MS,
      });
    } catch {
      // Unlock may fail (already unlocked, or git refuses) — the second
      // `--force` below still overrides a residual lock.
    }
  }

  // Step 1: Remove the worktree. A single `--force` lets git's own lock check
  // guard against a build that locked the path between our check and now; a
  // second `--force` is added only when deliberately reclaiming a dead lock.
  const remove_args = ["worktree", "remove", worktree_path, "--force"];
  if (reclaim_orphaned_lock) remove_args.push("--force");
  try {
    await exec("git", remove_args, {
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
    // remove_worktree refuses to remove a locked or in-use worktree, so we do
    // NOT relocate sessions out first — relocating would move a live build's
    // pane away and defeat the in-flight guard. If the worktree is genuinely
    // idle, there's nothing to relocate anyway.
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
 */
async function cleanup_claude_worktrees(repo_path: string, branch: string): Promise<void> {
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
        console.log(`[worktree-cleanup] Found .claude/worktrees/ match: ${wt_path}`);
        // remove_worktree refuses locked / in-use worktrees; don't relocate
        // first (it would defeat the in-flight guard). Agent worktrees here
        // carry a `locked` file, so an active build is skipped outright.
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

  let cleaned = 0;

  for (const entry of entries) {
    // Skip the main working tree (the first entry, or bare repos)
    if (entry.bare || !entry.branch) continue;

    const branch = short_branch(entry.branch);

    // Never clean up main
    if (branch === "main" || branch === "master") continue;

    // Check if this is the main working tree (same path as repo_path)
    if (entry.path === repo_path) continue;

    let should_clean = false;

    // Case 1: Branch is merged into main
    if (merged_branches.has(branch)) {
      console.log(`[worktree-cleanup] Stale worktree (branch merged): ${entry.path} [${branch}]`);
      should_clean = true;
    }

    // Case 2: Remote tracking ref is gone (branch deleted on remote)
    if (!should_clean) {
      should_clean = await is_remote_branch_gone(repo_path, branch);
      if (should_clean) {
        console.log(`[worktree-cleanup] Stale worktree (remote gone): ${entry.path} [${branch}]`);
      }
    }

    if (should_clean) {
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
  }

  // Also sweep .claude/worktrees/ for agent directories referencing merged branches
  for (const branch of merged_branches) {
    await cleanup_claude_worktrees(repo_path, branch);
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
