/**
 * Merge-gate: the final pre-merge sanity check for the v2 PR lifecycle (#257).
 *
 * Called only after a reviewer has explicitly approved a PR. The gate
 * re-verifies, in order:
 *
 *   1. CI is still green on the latest head SHA (catches flakes that flipped
 *      between review and merge).
 *   2. The branch is up-to-date with main, or can be cleanly rebased.
 *   3. GitHub considers the PR mergeable (no conflicts, branch protection
 *      satisfied).
 *
 * If all three hold, it executes `gh pr merge --squash --delete-branch` and
 * reports back. If any precondition fails, it returns a tagged outcome so the
 * caller can dispatch (alert, wait for next check_suite, retry rebase, etc.).
 *
 * Pure side-effect surface: `gh pr view`, `gh pr checks`, `gh pr merge`, and
 * the local rebase fallback. No state mutation, no event emission — the caller
 * owns notifications and persistence.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  type PRMergeability,
  check_ci_status,
  fetch_pr_mergeability,
  try_local_rebase,
} from "./review-utils.js";

const exec_async = promisify(execFile);

// ── Types ──

export interface MergeGateInput {
  pr_number: number;
  branch: string;
  /** Head SHA the reviewer approved. Used to detect "the SHA moved under us". */
  approved_sha: string;
  repo_path: string;
  /** GitHub installation token. Required for cross-account auth. */
  gh_token: string;
}

/**
 * Outcome of the merge-gate. Tagged so the caller can dispatch precisely.
 *
 * - `merged` — successful merge, branch deleted.
 * - `ci_regressed` — CI was green at review time but is now failing on the
 *   latest SHA. Automated retry is NOT possible on the same SHA because the
 *   check-suite handler's dedup key (`v2_last_dispatched_sha`) prevents
 *   re-dispatch. A new commit (new SHA) is needed to re-enter the cycle.
 * - `ci_pending` — CI is still running. Automated retry on the same SHA is
 *   blocked by the dedup key — a new `check_suite.completed` event for the
 *   same SHA will be deduped out. In practice, this resolves when the pending
 *   check completes and fires its own event (which may carry a new SHA if
 *   triggered by a follow-up push).
 * - `sha_changed` — new commits landed between review and merge. Re-review
 *   needed; the next check_suite will fire.
 * - `rebased_awaiting_ci` — branch was behind, rebase succeeded, force-push
 *   done. Waiting for a fresh check_suite on the rebased SHA before merging.
 * - `rebase_conflict` — branch is behind and cannot be safely rebased. Either
 *   a real content conflict, or a branch carrying merge commits that a plain
 *   rebase would drop (#367). Both need human resolution; neither can be
 *   retried automatically.
 * - `branch_protected` — branch protection is blocking (missing required review
 *   from a team, etc.). Cannot self-resolve; alert.
 * - `mergeable_unknown` — GitHub hasn't finished computing mergeability. Wait
 *   for the next event.
 * - `merge_failed` — gh pr merge returned non-zero for an unexpected reason.
 *   Alert with the underlying error.
 */
export type MergeGateOutcome =
  | { kind: "merged"; method: "direct" | "rebase" }
  | { kind: "ci_regressed"; failures: string[] }
  | { kind: "ci_pending" }
  | { kind: "sha_changed"; observed_sha: string }
  | { kind: "rebased_awaiting_ci" }
  | { kind: "rebase_conflict"; error: string }
  | { kind: "branch_protected"; merge_state_status: PRMergeability["merge_state_status"] }
  | { kind: "mergeable_unknown" }
  | { kind: "merge_failed"; error: string };

// ── Public entrypoint ──

/**
 * Run the merge-gate. The implementation is a pure pre-merge check followed
 * by a single merge attempt — no retry loops, no cron handoff.
 *
 * The dependencies argument is for tests; production callers pass nothing.
 */
export async function run_merge_gate(
  input: MergeGateInput,
  deps: MergeGateDeps = default_deps,
): Promise<MergeGateOutcome> {
  const { pr_number, approved_sha, repo_path, gh_token } = input;

  // Step 1: re-fetch mergeability (head SHA, mergeable, mergeStateStatus)
  let mergeability: PRMergeability;
  try {
    mergeability = await deps.fetch_pr_mergeability(pr_number, repo_path, gh_token);
  } catch (err) {
    return {
      kind: "merge_failed",
      error: `Could not fetch PR mergeability: ${error_message(err)}`,
    };
  }

  // SHA drift: a new commit landed between review and gate. Bail; the
  // synchronize / check_suite event for the new SHA will spin a new review.
  if (mergeability.head_sha !== approved_sha) {
    return { kind: "sha_changed", observed_sha: mergeability.head_sha };
  }

  // Step 2: re-verify CI on this exact SHA. The reviewer saw green, but a
  // flake or follow-up check could have flipped it.
  const ci = await deps.check_ci_status(pr_number, repo_path, gh_token);

  if (ci.failures.length > 0) {
    return { kind: "ci_regressed", failures: ci.failures };
  }
  if (ci.pending) {
    // Pending after we already received check_suite.completed === success
    // means a new check started (e.g., a deploy preview kicked off after CI).
    // Wait for it to settle rather than guessing.
    return { kind: "ci_pending" };
  }

  // Step 3: UNKNOWN mergeability is almost always transient — GitHub is still
  // computing. Retry once after a short delay before entering the dispatch.
  if (mergeability.merge_state_status === "UNKNOWN") {
    await deps.sleep(5_000);
    try {
      mergeability = await deps.fetch_pr_mergeability(pr_number, repo_path, gh_token);
    } catch {
      // Retry failed — proceed with UNKNOWN, the switch will return mergeable_unknown.
    }
  }

  // Step 4: branch protection / mergeable state dispatch
  switch (mergeability.merge_state_status) {
    case "CLEAN":
    case "HAS_HOOKS":
    case "UNSTABLE":
      // UNSTABLE = non-required check failed. We've already verified required
      // checks above, so this is safe to merge.
      break;

    case "BEHIND":
      return await rebase_then_merge(input, deps);

    case "DIRTY":
      return {
        kind: "rebase_conflict",
        error: "GitHub reports DIRTY (merge conflicts) — manual resolution required",
      };

    case "BLOCKED":
      // mergeStateStatus=BLOCKED with mergeable=MERGEABLE means branch
      // protection is the blocker (e.g. required review from team), not CI
      // or conflicts. The reviewer's approval already counted; if we're still
      // blocked, this needs human eyes — see issue #254 scenario.
      return {
        kind: "branch_protected",
        merge_state_status: mergeability.merge_state_status,
      };

    case "UNKNOWN":
      return { kind: "mergeable_unknown" };

    default:
      return {
        kind: "merge_failed",
        error: `Unhandled mergeStateStatus: ${mergeability.merge_state_status}`,
      };
  }

  // Step 5: actually merge
  return await execute_merge(input, "direct", deps);
}

// ── Internal helpers ──

async function rebase_then_merge(
  input: MergeGateInput,
  deps: MergeGateDeps,
): Promise<MergeGateOutcome> {
  const env = { ...process.env, GH_TOKEN: input.gh_token };
  const result = await deps.try_local_rebase(input.branch, input.repo_path, env);

  if (!result.success) {
    if (result.kind === "conflict") {
      return { kind: "rebase_conflict", error: result.error };
    }
    // The branch carries merge commits, so the rebase was refused before it
    // started (#367). Like a conflict, this cannot resolve itself and cannot
    // be retried — it needs a human — so it takes the same alert path. The
    // distinct signal lives on `LocalRebaseResult.kind`; giving the gate its
    // own outcome kind would need matching dispatch in webhook-handler.ts,
    // which is owned by open PR #366. Worth splitting once that lands.
    if (result.kind === "unsafe_merge_commits") {
      return { kind: "rebase_conflict", error: result.error };
    }
    return {
      kind: "merge_failed",
      error: `Rebase failed (${result.kind}): ${result.error}`,
    };
  }

  // Force-push succeeded. The push will fire a fresh check_suite cycle on
  // the new SHA; abort this merge attempt and let that drive the next pass.
  // This is intentional — merging right after a force-push without re-running
  // CI on the rebased SHA defeats the whole point of the v2 lifecycle.
  return { kind: "rebased_awaiting_ci" };
}

async function execute_merge(
  input: MergeGateInput,
  method: "direct" | "rebase",
  deps: MergeGateDeps,
): Promise<MergeGateOutcome> {
  try {
    await deps.gh_pr_merge(input.pr_number, input.repo_path, input.gh_token);
    return { kind: "merged", method };
  } catch (err) {
    return {
      kind: "merge_failed",
      error: `gh pr merge failed: ${error_message(err)}`,
    };
  }
}

function error_message(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ── Dependency injection seam ──

/**
 * The merge-gate's external dependencies, broken out so tests can stub them
 * without mocking node:child_process. Production callers use `default_deps`.
 */
export interface MergeGateDeps {
  fetch_pr_mergeability: typeof fetch_pr_mergeability;
  check_ci_status: typeof check_ci_status;
  try_local_rebase: typeof try_local_rebase;
  gh_pr_merge: (pr_number: number, repo_path: string, gh_token: string) => Promise<void>;
  /** Delay function for the UNKNOWN mergeability retry. Injectable for tests. */
  sleep: (ms: number) => Promise<void>;
}

async function default_gh_pr_merge(
  pr_number: number,
  repo_path: string,
  gh_token: string,
): Promise<void> {
  const env = { ...process.env, GH_TOKEN: gh_token };
  await exec_async("gh", ["pr", "merge", String(pr_number), "--squash", "--delete-branch"], {
    cwd: repo_path,
    env,
    timeout: 30_000,
  });
}

export const default_deps: MergeGateDeps = {
  fetch_pr_mergeability,
  check_ci_status,
  try_local_rebase,
  gh_pr_merge: default_gh_pr_merge,
  sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
};
