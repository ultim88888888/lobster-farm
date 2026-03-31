/**
 * Utility functions for PR review feedback and auto-merge with rebase.
 *
 * Used by both webhook-handler.ts and pr-cron.ts to fetch reviewer
 * comments and build fix prompts for the auto-fix loop.
 *
 * Extracted from features.ts during feature lifecycle removal (#100).
 * Auto-merge with rebase added in #166.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec_async = promisify(execFile);

/**
 * Fetch the most recent review comments from a PR.
 * Returns the concatenated review body text, or a fallback message if fetching fails.
 */
export async function fetch_review_comments(
  pr_number: number,
  repo_path: string,
): Promise<string> {
  try {
    const { stdout } = await exec_async("gh", [
      "pr", "view", String(pr_number),
      "--json", "reviews",
      "--jq", ".reviews | map(select(.state == \"CHANGES_REQUESTED\")) | last | .body // empty",
    ], { cwd: repo_path, timeout: 15_000 });
    const body = stdout.trim();
    if (body) return body;
  } catch {
    // Fall through to fallback
  }

  // Fallback: try to get any review body
  try {
    const { stdout } = await exec_async("gh", [
      "pr", "view", String(pr_number),
      "--json", "reviews",
      "--jq", ".reviews | last | .body // empty",
    ], { cwd: repo_path, timeout: 15_000 });
    return stdout.trim() || `(No review body found. Run \`gh pr view ${String(pr_number)} --json reviews\` to inspect.)`;
  } catch {
    return `(Could not fetch review comments. Run \`gh pr view ${String(pr_number)} --json reviews\` to inspect.)`;
  }
}

/**
 * Check if a PR has merge conflicts by inspecting its mergeable state.
 */
export async function check_merge_conflicts(
  pr_number: number,
  repo_path: string,
): Promise<boolean> {
  try {
    const { stdout } = await exec_async("gh", [
      "pr", "view", String(pr_number),
      "--json", "mergeable",
      "--jq", ".mergeable",
    ], { cwd: repo_path, timeout: 15_000 });

    // GitHub returns "CONFLICTING", "MERGEABLE", or "UNKNOWN"
    return stdout.trim().toUpperCase() === "CONFLICTING";
  } catch {
    // If we can't determine, err on the side of not blocking
    return false;
  }
}

/**
 * Build the prompt given to a builder when fixing reviewer feedback.
 * Used by both the webhook handler and PR cron auto-fix paths.
 */
export function build_review_fix_prompt(
  pr_number: number,
  title: string,
  review_comments?: string,
): string {
  const pr = String(pr_number);
  const lines = [
    `The reviewer requested changes on PR #${pr}: ${title}`,
    ``,
  ];

  if (review_comments) {
    lines.push(`## Reviewer Feedback`, ``, review_comments, ``);
  }

  lines.push(
    `## Instructions`,
    ``,
    `1. Read the reviewer's feedback carefully`,
    `2. Fix each issue mentioned`,
    `3. Run the test suite to verify your changes`,
    `4. Commit and push`,
    ``,
    `Do NOT change anything the reviewer didn't flag. Keep changes minimal and targeted.`,
  );

  return lines.join("\n");
}

// ── Auto-merge with rebase (#166) ──

export interface AutoMergeResult {
  merged: boolean;
  method?: "direct" | "update-branch" | "local-rebase";
  error?: string;
}

/** How long to wait for GitHub to recompute mergeable state after an update. */
const MERGEABLE_POLL_TIMEOUT_MS = 30_000;
const MERGEABLE_POLL_INTERVAL_MS = 5_000;

/**
 * Attempt to merge an approved PR, rebasing if necessary.
 * Returns { merged: true } if merge succeeded, { merged: false } if manual intervention needed.
 *
 * Strategy (in order):
 * 1. Try direct merge (maybe reviewer hit a transient error)
 * 2. If that fails: try GitHub's update-branch API (merge-update from base)
 * 3. If update-branch fails: attempt local git rebase in a temp dir
 * 4. If rebase has real conflicts: give up, return false
 */
export async function attempt_auto_merge(
  pr_number: number,
  branch: string,
  repo_path: string,
  gh_bin: string = "gh",
  gh_token?: string,
): Promise<AutoMergeResult> {
  const pr = String(pr_number);
  const env = gh_token
    ? { ...process.env, GH_TOKEN: gh_token }
    : process.env;
  const exec_opts = { cwd: repo_path, env, timeout: 30_000 };

  // Step 1: Direct merge retry
  try {
    await exec_async(gh_bin, [
      "pr", "merge", pr, "--squash", "--delete-branch",
    ], exec_opts);
    return { merged: true, method: "direct" };
  } catch (err) {
    console.log(
      `[auto-merge] Direct merge failed for PR #${pr}: ${String(err instanceof Error ? err.message : err)}`,
    );
  }

  // Step 2: GitHub API update-branch (merge-update, not rebase)
  // Derive owner/repo from the git remote
  const nwo = await get_repo_nwo(repo_path, gh_bin, env);
  if (!nwo) {
    return { merged: false, error: "Could not determine repo owner/name from remote" };
  }

  const update_branch_ok = await try_update_branch(nwo, pr_number, gh_bin, env);

  if (update_branch_ok) {
    // Wait for GitHub to recompute mergeable state, then retry merge
    const mergeable = await poll_mergeable(pr_number, repo_path, gh_bin, env);
    if (mergeable) {
      try {
        await exec_async(gh_bin, [
          "pr", "merge", pr, "--squash", "--delete-branch",
        ], exec_opts);
        return { merged: true, method: "update-branch" };
      } catch (err) {
        console.log(
          `[auto-merge] Merge after update-branch failed for PR #${pr}: ${String(err instanceof Error ? err.message : err)}`,
        );
      }
    }
  }

  // Step 3: Local git rebase fallback
  const rebase_result = await try_local_rebase(branch, repo_path, env);
  if (rebase_result.success) {
    // Wait for GitHub to process the force-push, then merge
    const mergeable = await poll_mergeable(pr_number, repo_path, gh_bin, env);
    if (mergeable) {
      try {
        await exec_async(gh_bin, [
          "pr", "merge", pr, "--squash", "--delete-branch",
        ], exec_opts);
        return { merged: true, method: "local-rebase" };
      } catch (err) {
        return {
          merged: false,
          error: `Rebase succeeded but merge still failed: ${String(err instanceof Error ? err.message : err)}`,
        };
      }
    }
    return { merged: false, error: "Rebase succeeded but PR not mergeable after update" };
  }

  return { merged: false, error: rebase_result.error };
}

/**
 * Get the repo owner/name (e.g. "org/repo") from the git remote.
 * Tries `gh repo view --json nameWithOwner` first.
 */
async function get_repo_nwo(
  repo_path: string,
  gh_bin: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  try {
    const { stdout } = await exec_async(gh_bin, [
      "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner",
    ], { cwd: repo_path, env, timeout: 15_000 });
    const nwo = stdout.trim();
    return nwo || null;
  } catch {
    return null;
  }
}

/**
 * Try the GitHub API update-branch endpoint.
 * Returns true if the API call succeeded (branch was updated).
 */
async function try_update_branch(
  nwo: string,
  pr_number: number,
  gh_bin: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  try {
    await exec_async(gh_bin, [
      "api", `repos/${nwo}/pulls/${String(pr_number)}/update-branch`,
      "--method", "PUT",
    ], { cwd: "/tmp", env, timeout: 30_000 });
    console.log(`[auto-merge] update-branch API succeeded for PR #${String(pr_number)}`);
    return true;
  } catch (err) {
    console.log(
      `[auto-merge] update-branch API failed for PR #${String(pr_number)}: ${String(err instanceof Error ? err.message : err)}`,
    );
    return false;
  }
}

/**
 * Poll the PR's mergeable state until it becomes MERGEABLE or we time out.
 * Returns true if the PR is mergeable.
 */
async function poll_mergeable(
  pr_number: number,
  repo_path: string,
  gh_bin: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const deadline = Date.now() + MERGEABLE_POLL_TIMEOUT_MS;
  const pr = String(pr_number);

  while (Date.now() < deadline) {
    try {
      const { stdout } = await exec_async(gh_bin, [
        "pr", "view", pr,
        "--json", "mergeable",
        "--jq", ".mergeable",
      ], { cwd: repo_path, env, timeout: 15_000 });

      const state = stdout.trim().toUpperCase();
      if (state === "MERGEABLE") return true;
      if (state === "CONFLICTING") return false;
      // UNKNOWN — GitHub still computing, keep polling
    } catch {
      // gh CLI error — keep polling
    }

    await sleep(MERGEABLE_POLL_INTERVAL_MS);
  }

  console.log(`[auto-merge] Timed out waiting for mergeable state on PR #${pr}`);
  return false;
}

/**
 * Attempt a local git rebase of the branch onto origin/main.
 * Uses a temp directory with a minimal clone, then force-pushes with lease.
 */
async function try_local_rebase(
  branch: string,
  repo_path: string,
  env: NodeJS.ProcessEnv,
): Promise<{ success: boolean; error?: string }> {
  // Get the remote URL from the repo
  let remote_url: string;
  try {
    const { stdout } = await exec_async("git", [
      "remote", "get-url", "origin",
    ], { cwd: repo_path, env, timeout: 10_000 });
    remote_url = stdout.trim();
  } catch {
    return { success: false, error: "Could not determine remote URL" };
  }

  // Create temp dir for the rebase
  let tmp_dir: string;
  try {
    const { stdout } = await exec_async("mktemp", ["-d"], { timeout: 5_000 });
    tmp_dir = stdout.trim();
  } catch {
    return { success: false, error: "Could not create temp directory" };
  }

  try {
    // Clone the branch (shallow to save time)
    await exec_async("git", [
      "clone", "--single-branch", "--branch", branch, remote_url, tmp_dir,
    ], { env, timeout: 60_000 });

    // Fetch main
    await exec_async("git", [
      "fetch", "origin", "main",
    ], { cwd: tmp_dir, env, timeout: 30_000 });

    // Attempt rebase
    try {
      await exec_async("git", [
        "rebase", "origin/main",
      ], { cwd: tmp_dir, env, timeout: 60_000 });
    } catch {
      // Rebase failed — abort and clean up
      try {
        await exec_async("git", [
          "rebase", "--abort",
        ], { cwd: tmp_dir, env, timeout: 10_000 });
      } catch {
        // Abort failed too — best-effort
      }
      return { success: false, error: "Rebase conflicts require manual resolution" };
    }

    // Rebase succeeded — force-push with lease
    await exec_async("git", [
      "push", "--force-with-lease", "origin", branch,
    ], { cwd: tmp_dir, env, timeout: 30_000 });

    console.log(`[auto-merge] Local rebase succeeded for branch ${branch}`);
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: `Local rebase failed: ${String(err instanceof Error ? err.message : err)}`,
    };
  } finally {
    // Clean up temp dir — best-effort
    try {
      await exec_async("rm", ["-rf", tmp_dir], { timeout: 10_000 });
    } catch {
      // Ignore cleanup failures
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
