/**
 * Utility functions for PR review feedback and auto-merge with rebase.
 *
 * Used by both webhook-handler.ts and pr-cron.ts to fetch reviewer
 * comments and build fix prompts for the auto-fix loop.
 *
 * Extracted from features.ts during feature lifecycle removal (#100).
 * Auto-merge with rebase added in #166.
 * CI failure log fetching and CI fix prompts added in #196.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec_async = promisify(execFile);

/**
 * Fetch the most recent review comments from a PR.
 * Returns the concatenated review body text, or a fallback message if fetching fails.
 */
export async function fetch_review_comments(pr_number: number, repo_path: string): Promise<string> {
  try {
    const { stdout } = await exec_async(
      "gh",
      [
        "pr",
        "view",
        String(pr_number),
        "--json",
        "reviews",
        "--jq",
        '.reviews | map(select(.state == "CHANGES_REQUESTED")) | last | .body // empty',
      ],
      { cwd: repo_path, timeout: 15_000 },
    );
    const body = stdout.trim();
    if (body) return body;
  } catch {
    // Fall through to fallback
  }

  // Fallback: try to get any review body
  try {
    const { stdout } = await exec_async(
      "gh",
      [
        "pr",
        "view",
        String(pr_number),
        "--json",
        "reviews",
        "--jq",
        ".reviews | last | .body // empty",
      ],
      { cwd: repo_path, timeout: 15_000 },
    );
    return (
      stdout.trim() ||
      `(No review body found. Run \`gh pr view ${String(pr_number)} --json reviews\` to inspect.)`
    );
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
    const { stdout } = await exec_async(
      "gh",
      ["pr", "view", String(pr_number), "--json", "mergeable", "--jq", ".mergeable"],
      { cwd: repo_path, timeout: 15_000 },
    );

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
  const lines = [`The reviewer requested changes on PR #${pr}: ${title}`, ""];

  if (review_comments) {
    lines.push("## Reviewer Feedback", "", review_comments, "");
  }

  lines.push(
    "## Instructions",
    "",
    `1. Read the reviewer's feedback carefully`,
    "2. Fix each issue mentioned",
    "3. Run the test suite to verify your changes",
    "4. Commit and push",
    "",
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
  gh_bin = "gh",
  gh_token?: string,
): Promise<AutoMergeResult> {
  const pr = String(pr_number);
  const env = gh_token ? { ...process.env, GH_TOKEN: gh_token } : process.env;
  const exec_opts = { cwd: repo_path, env, timeout: 30_000 };

  // Step 1: Direct merge retry
  try {
    await exec_async(gh_bin, ["pr", "merge", pr, "--squash", "--delete-branch"], exec_opts);
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
        await exec_async(gh_bin, ["pr", "merge", pr, "--squash", "--delete-branch"], exec_opts);
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
        await exec_async(gh_bin, ["pr", "merge", pr, "--squash", "--delete-branch"], exec_opts);
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
    const { stdout } = await exec_async(
      gh_bin,
      ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
      { cwd: repo_path, env, timeout: 15_000 },
    );
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
    await exec_async(
      gh_bin,
      ["api", `repos/${nwo}/pulls/${String(pr_number)}/update-branch`, "--method", "PUT"],
      { cwd: "/tmp", env, timeout: 30_000 },
    );
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
      const { stdout } = await exec_async(
        gh_bin,
        ["pr", "view", pr, "--json", "mergeable", "--jq", ".mergeable"],
        { cwd: repo_path, env, timeout: 15_000 },
      );

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
    const { stdout } = await exec_async("git", ["remote", "get-url", "origin"], {
      cwd: repo_path,
      env,
      timeout: 10_000,
    });
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
    await exec_async("git", ["clone", "--single-branch", "--branch", branch, remote_url, tmp_dir], {
      env,
      timeout: 60_000,
    });

    // Fetch main
    await exec_async("git", ["fetch", "origin", "main"], { cwd: tmp_dir, env, timeout: 30_000 });

    // Attempt rebase
    try {
      await exec_async("git", ["rebase", "origin/main"], { cwd: tmp_dir, env, timeout: 60_000 });
    } catch {
      // Rebase failed — abort and clean up
      try {
        await exec_async("git", ["rebase", "--abort"], { cwd: tmp_dir, env, timeout: 10_000 });
      } catch {
        // Abort failed too — best-effort
      }
      return { success: false, error: "Rebase conflicts require manual resolution" };
    }

    // Rebase succeeded — force-push with lease
    await exec_async("git", ["push", "--force-with-lease", "origin", branch], {
      cwd: tmp_dir,
      env,
      timeout: 30_000,
    });

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

// ── CI check gating (#189) ──

export interface CICheckStatus {
  passed: boolean;
  pending: boolean;
  failures: string[];
}

/**
 * Query the CI check status for a PR.
 *
 * Uses `gh pr checks` to get the current state of all status checks.
 * Returns whether all checks passed, any are pending, or which ones failed.
 * When no checks are configured, returns { passed: true, pending: false, failures: [] }
 * so the merge flow proceeds normally.
 */
export async function check_ci_status(
  pr_number: number,
  repo_path: string,
  gh_token?: string,
  gh_bin = "gh",
): Promise<CICheckStatus> {
  const env = gh_token ? { ...process.env, GH_TOKEN: gh_token } : process.env;

  try {
    const { stdout } = await exec_async(
      gh_bin,
      ["pr", "checks", String(pr_number), "--required", "--json", "name,state,conclusion"],
      { cwd: repo_path, env, timeout: 15_000 },
    );

    const checks = JSON.parse(stdout) as Array<{
      name: string;
      state: string;
      conclusion: string;
    }>;

    // No checks configured — proceed with merge normally
    if (checks.length === 0) {
      return { passed: true, pending: false, failures: [] };
    }

    const failures: string[] = [];
    let has_pending = false;

    for (const check of checks) {
      if (check.state === "PENDING" || check.state === "QUEUED" || check.state === "IN_PROGRESS") {
        has_pending = true;
      } else if (
        check.conclusion !== "SUCCESS" &&
        check.conclusion !== "NEUTRAL" &&
        check.conclusion !== "SKIPPED"
      ) {
        failures.push(check.name);
      }
    }

    return {
      passed: failures.length === 0 && !has_pending,
      pending: has_pending,
      failures,
    };
  } catch {
    // gh pr checks command failed — could be rate limit, auth error, or network issue.
    // Treat as pending to avoid bypassing CI gates on infrastructure failures.
    // pr-cron will retry on the next cycle.
    return { passed: false, pending: true, failures: [] };
  }
}

/** Maximum number of CI fix attempts before escalating to a human (#196). */
export const MAX_CI_FIX_ATTEMPTS = 3;

/** Maximum number of deploy triage attempts before escalating to a human (#199).
 * Lower than CI fix cap — deploy failures on main are higher stakes. */
export const MAX_DEPLOY_FIX_ATTEMPTS = 2;

// ── CI failure log fetching (#196) ──

/** Max number of lines to keep per failed job's log output. */
const CI_LOG_TAIL_LINES = 100;

export interface CIFailureLog {
  check_name: string;
  log_output: string;
}

/**
 * Fetch failure logs for failed CI runs on a branch.
 *
 * Strategy:
 * 1. List failed workflow runs for the branch via `gh run list`
 * 2. For each failed run, fetch the failed log output via `gh run view --log-failed`
 * 3. Truncate each log to the last ~100 lines to keep prompts manageable
 *
 * Returns an array of { check_name, log_output } for each failed run.
 * Returns an empty array if no failed runs are found or fetching fails.
 */
export async function fetch_ci_failure_logs(
  branch: string,
  repo_path: string,
  gh_token?: string,
  gh_bin = "gh",
): Promise<CIFailureLog[]> {
  const env = gh_token ? { ...process.env, GH_TOKEN: gh_token } : process.env;
  const exec_opts = { cwd: repo_path, env, timeout: 30_000 };

  // Step 1: Find failed runs on this branch
  let runs: Array<{ databaseId: number; name: string }>;
  try {
    const { stdout } = await exec_async(
      gh_bin,
      [
        "run",
        "list",
        "--branch",
        branch,
        "--status",
        "failure",
        "--json",
        "databaseId,name",
        "--limit",
        "5",
      ],
      exec_opts,
    );

    runs = JSON.parse(stdout) as Array<{ databaseId: number; name: string }>;
  } catch {
    console.log(`[ci-fix] Could not list failed runs for branch ${branch}`);
    return [];
  }

  if (runs.length === 0) return [];

  // Step 2: Fetch failed log output for each run
  const logs: CIFailureLog[] = [];

  for (const run of runs) {
    try {
      const { stdout } = await exec_async(
        gh_bin,
        ["run", "view", String(run.databaseId), "--log-failed"],
        { ...exec_opts, timeout: 60_000 },
      );

      // Truncate to last N lines — CI logs can be enormous
      const lines = stdout.split("\n");
      const truncated =
        lines.length > CI_LOG_TAIL_LINES
          ? `... (${String(lines.length - CI_LOG_TAIL_LINES)} lines truncated)\n${lines.slice(-CI_LOG_TAIL_LINES).join("\n")}`
          : stdout;

      logs.push({
        check_name: run.name,
        log_output: truncated.trim(),
      });
    } catch {
      // Log fetch failed — include the run name with a note
      logs.push({
        check_name: run.name,
        log_output: `(Could not fetch failure logs for run ${String(run.databaseId)}. Run \`gh run view ${String(run.databaseId)} --log-failed\` manually.)`,
      });
    }
  }

  return logs;
}

/**
 * Build the prompt given to a builder when fixing CI failures.
 * Used by both the webhook handler and PR cron CI fix paths.
 */
export function build_ci_fix_prompt(
  pr_number: number,
  title: string,
  branch: string,
  failure_logs: CIFailureLog[],
  failed_check_names?: string[],
): string {
  const pr = String(pr_number);
  const lines = [
    `PR #${pr}: "${title}" on branch ${branch} was approved but CI checks are failing.`,
    "",
  ];

  if (failure_logs.length > 0) {
    lines.push("## CI Failure Logs", "");

    for (const log of failure_logs) {
      lines.push(`### ${log.check_name}`, "", "```", log.log_output, "```", "");
    }
  } else if (failed_check_names?.length) {
    // Log fetching failed but we still know which checks are failing
    lines.push(
      `Failing CI checks: ${failed_check_names.join(", ")}`,
      "",
      `(Detailed logs unavailable — run \`gh run list --branch ${branch} --status failure\` to investigate)`,
      "",
    );
  }

  lines.push(
    "## Instructions",
    "",
    `1. Check out the branch: git checkout ${branch}`,
    "2. Read the CI failure logs above carefully",
    "3. Fix the issues causing CI failures (lint errors, type errors, test failures, etc.)",
    "4. Run the test suite locally to verify your fixes",
    "5. Commit and push your changes",
    "",
    "Keep changes minimal and targeted — only fix what CI is complaining about.",
    "Do NOT merge the PR.",
  );

  return lines.join("\n");
}

// ── Deploy triage prompt (#199) ──

/**
 * Build the prompt given to Gary (planner) when triaging a deploy failure on main.
 *
 * Gary will diagnose the failure, classify it, and decide whether to fix forward
 * (open a hotfix PR), recommend rollback, or escalate to a human.
 */
export function build_deploy_triage_prompt(
  workflow_name: string,
  workflow_url: string,
  run_id: number,
  repo_path: string,
  failure_logs: CIFailureLog[],
  attempt: number,
  max_attempts: number,
): string {
  const lines = [
    `## Deploy Failure Triage`,
    ``,
    `Workflow "${workflow_name}" failed on main.`,
    `Run: ${workflow_url}`,
    `Run ID: ${String(run_id)}`,
    `Repository: ${repo_path}`,
    `Attempt: ${String(attempt)}/${String(max_attempts)}`,
    ``,
  ];

  if (failure_logs.length > 0) {
    lines.push(`## Failure Logs`, ``);

    for (const log of failure_logs) {
      lines.push(
        `### ${log.check_name}`,
        ``,
        "```",
        log.log_output,
        "```",
        ``,
      );
    }
  } else {
    lines.push(
      `(No failure logs could be fetched from GitHub Actions.`,
      `Run \`gh run view ${String(run_id)} --log-failed\` manually, or check CloudWatch.)`,
      ``,
    );
  }

  lines.push(
    `## Instructions`,
    ``,
    `1. **Diagnose** — read the failure logs above. Identify the failing step and root cause.`,
    `2. **Classify** — is this a code issue, infra/config issue, or external dependency failure?`,
    `3. **Decide** — fix forward (hotfix branch + PR), recommend rollback, or escalate to human.`,
    `4. **Act**:`,
    `   - For code fixes: create a hotfix branch, fix the issue, open a PR with \`Closes\` link if applicable.`,
    `   - For infra/config: post diagnosis and recommended fix to #alerts and escalate.`,
    `   - If unclear: post full diagnosis to #alerts and escalate.`,
    ``,
    `Rules:`,
    `- Do NOT push directly to main. All fixes go through PRs.`,
    `- Do NOT attempt rollbacks (git revert on main) without human approval.`,
    `- If GitHub Actions logs are insufficient, note this and recommend checking CloudWatch.`,
    `- Keep fixes minimal and targeted.`,
  );

  return lines.join("\n");
}
