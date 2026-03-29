/**
 * Worktree cleanup utilities.
 *
 * Provides best-effort cleanup of git worktrees after PR merges and a periodic
 * sweep for stale worktrees whose branches have already been merged or deleted.
 *
 * All functions are designed to fail silently — cleanup should never break
 * the merge handler, PR cron, or daemon lifecycle.
 */

import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expand_home } from "@lobster-farm/shared";
import type { EntityRegistry } from "./registry.js";
import * as sentry from "./sentry.js";

const exec = promisify(execFile);

/** Timeout for git commands — generous but bounded. */
const GIT_TIMEOUT_MS = 30_000;

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

    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        path = line.slice("worktree ".length);
      } else if (line.startsWith("HEAD ")) {
        head = line.slice("HEAD ".length);
      } else if (line.startsWith("branch ")) {
        branch = line.slice("branch ".length);
      } else if (line === "bare") {
        bare = true;
      }
    }

    if (path) {
      entries.push({ path, head, branch, bare });
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
    console.error(
      `[worktree-cleanup] Failed to list worktrees in ${repo_path}: ${String(err)}`,
    );
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
export async function cleanup_after_merge(
  repo_path: string,
  branch: string,
): Promise<void> {
  console.log(`[worktree-cleanup] Cleaning up after merge of branch: ${branch}`);

  // 1. Check git worktree list for a worktree on this branch
  const worktree_path = await find_worktree_for_branch(repo_path, branch);
  if (worktree_path) {
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
async function cleanup_claude_worktrees(
  repo_path: string,
  branch: string,
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
  const branch_slug = branch.includes("/")
    ? branch.slice(branch.lastIndexOf("/") + 1)
    : branch;

  try {
    const entries = await readdir(claude_wt_dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      // Match directories that contain the branch slug
      if (entry.name.includes(branch_slug)) {
        const wt_path = join(claude_wt_dir, entry.name);
        console.log(`[worktree-cleanup] Found .claude/worktrees/ match: ${wt_path}`);
        await remove_worktree(repo_path, wt_path, branch);
      }
    }
  } catch (err) {
    console.error(
      `[worktree-cleanup] Error scanning .claude/worktrees/: ${String(err)}`,
    );
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
export async function sweep_stale_worktrees(
  registry: EntityRegistry,
): Promise<void> {
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
      console.log(
        `[worktree-cleanup] Stale worktree (branch merged): ${entry.path} [${branch}]`,
      );
      should_clean = true;
    }

    // Case 2: Remote tracking ref is gone (branch deleted on remote)
    if (!should_clean) {
      should_clean = await is_remote_branch_gone(repo_path, branch);
      if (should_clean) {
        console.log(
          `[worktree-cleanup] Stale worktree (remote gone): ${entry.path} [${branch}]`,
        );
      }
    }

    if (should_clean) {
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
async function is_remote_branch_gone(
  repo_path: string,
  branch: string,
): Promise<boolean> {
  try {
    await exec(
      "git",
      ["rev-parse", "--verify", `refs/remotes/origin/${branch}`],
      { cwd: repo_path, timeout: GIT_TIMEOUT_MS },
    );
    // Ref exists — not stale
    return false;
  } catch {
    // Ref doesn't exist — remote branch is gone
    return true;
  }
}
