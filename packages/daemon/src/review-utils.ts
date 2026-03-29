/**
 * Utility functions for PR review feedback.
 *
 * Used by both webhook-handler.ts and pr-cron.ts to fetch reviewer
 * comments and build fix prompts for the auto-fix loop.
 *
 * Extracted from features.ts during feature lifecycle removal (#100).
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
