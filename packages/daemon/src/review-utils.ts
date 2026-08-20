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
  method?: "direct" | "update-branch" | "local-rebase" | "policy-retry";
  error?: string;
  /** Machine-readable classification of the failure (when merged=false). */
  failure?: MergeFailure;
}

/**
 * Classification of why a merge failed. Drives user-facing messages and
 * retry behavior. See classify_merge_failure().
 *
 * - CONFLICT              → real rebase/merge conflict; needs human resolution
 * - REQUIRED_CHECKS_PENDING → CI still running; retry when it completes
 * - POLICY_LAG            → "base branch policy prohibits the merge" despite
 *                           checks reported complete — GitHub branch-protection
 *                           eval hasn't caught up; retry with backoff
 * - BEHIND                → branch is behind base; needs update-branch/rebase
 * - UNKNOWN               → anything else; surfaced verbatim
 */
export type MergeFailure =
  | "CONFLICT"
  | "REQUIRED_CHECKS_PENDING"
  | "POLICY_LAG"
  | "BEHIND"
  | "UNKNOWN";

export interface MergeState {
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  mergeStateStatus:
    | "CLEAN"
    | "BLOCKED"
    | "BEHIND"
    | "DIRTY"
    | "DRAFT"
    | "HAS_HOOKS"
    | "UNKNOWN"
    | "UNSTABLE";
}

/** How long to wait for GitHub to recompute mergeable state after an update. */
const MERGEABLE_POLL_TIMEOUT_MS = 30_000;
const MERGEABLE_POLL_INTERVAL_MS = 5_000;

/**
 * Policy-lag retry budget. Exponential backoff capped at ~10 minutes total.
 * Intervals: 10s, 20s, 40s, 80s, 160s, 300s (cap) = ~610s ≈ 10m.
 * The daemon path is the primary retry mechanism when pr-cron is disabled;
 * this is long enough to absorb GitHub's branch-protection evaluation lag
 * without blocking the webhook handler indefinitely.
 */
const POLICY_RETRY_BACKOFF_MS = [10_000, 20_000, 40_000, 80_000, 160_000, 300_000];

/**
 * Classify a merge failure given the PR's GraphQL state and any error text.
 *
 * Pure function — no I/O, safe to unit-test exhaustively. The classification
 * drives both the user-facing alert message and whether the daemon retries.
 *
 * Order of precedence:
 * 1. `mergeable === "CONFLICTING"` — always a real conflict, regardless of status
 * 2. `mergeStateStatus === "BEHIND"` — rebase onto base is the correct recovery
 * 3. Error text matches "base branch policy prohibits" — GitHub's branch-protection
 *    evaluation hasn't caught up; retry with backoff
 * 4. `mergeStateStatus === "BLOCKED"` with mergeable MERGEABLE — required checks
 *    pending or reviewers missing; retry on check completion
 * 5. Anything else → UNKNOWN (surfaced to #alerts as-is)
 */
export function classify_merge_failure(state: MergeState, error_text: string): MergeFailure {
  if (state.mergeable === "CONFLICTING") return "CONFLICT";
  if (state.mergeStateStatus === "BEHIND") return "BEHIND";

  // Policy-lag text match is more specific than BLOCKED — check first so we
  // can distinguish "GitHub eval lag" from "genuinely waiting on CI".
  if (/base branch policy prohibits the merge/i.test(error_text)) return "POLICY_LAG";

  if (state.mergeStateStatus === "BLOCKED" && state.mergeable === "MERGEABLE") {
    return "REQUIRED_CHECKS_PENDING";
  }
  return "UNKNOWN";
}

/** Map a MergeFailure to a human-readable explanation for #alerts. */
export function format_merge_failure(failure: MergeFailure, error_text: string): string {
  switch (failure) {
    case "CONFLICT":
      return "Rebase conflicts require manual resolution";
    case "REQUIRED_CHECKS_PENDING":
      return "Branch protection checks still pending — will retry when CI completes";
    case "POLICY_LAG":
      return "GitHub branch-protection evaluation did not converge within retry window";
    case "BEHIND":
      return "Branch is behind base and rebase/update failed";
    default:
      return error_text.slice(0, 200) || "Unknown merge failure";
  }
}

/**
 * Attempt to merge an approved PR, correctly diagnosing and recovering from
 * each merge-state failure class.
 *
 * Flow:
 * 1. Fetch current mergeable + mergeStateStatus from GitHub
 * 2. Short-circuit on CONFLICTING (real conflict) — skip the fallback chain;
 *    a rebase cannot fix a rebase conflict GitHub already knows about
 * 3. For BLOCKED+MERGEABLE, try a direct merge first (cheap path when the
 *    blocker has just cleared). If direct fails with "base branch policy
 *    prohibits the merge", enter the exponential-backoff retry loop to absorb
 *    GitHub's branch-protection evaluation lag
 * 4. For BEHIND or after-the-fact BEHIND transitions, run the
 *    update-branch → local-rebase fallback chain
 * 5. Every failure is classified via `classify_merge_failure` and surfaced
 *    with an accurate user-facing message
 *
 * See the MergeFailure enum for the full classification taxonomy.
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

  // Step 0: Fetch current merge state so we can route intelligently.
  const initial_state = await fetch_merge_state(pr_number, repo_path, gh_bin, env);

  // Short-circuit real conflicts — rebase cannot fix what GitHub already sees.
  if (initial_state.mergeable === "CONFLICTING") {
    return {
      merged: false,
      failure: "CONFLICT",
      error: format_merge_failure("CONFLICT", ""),
    };
  }

  // Step 1: Direct merge attempt.
  // Fast path when state is CLEAN, and cheap probe when state is BLOCKED
  // (branch protection may have just cleared between our poll and the merge).
  let direct_error = "";
  try {
    await exec_async(gh_bin, ["pr", "merge", pr, "--squash", "--delete-branch"], exec_opts);
    return { merged: true, method: "direct" };
  } catch (err) {
    direct_error = err instanceof Error ? err.message : String(err);
    console.log(`[auto-merge] Direct merge failed for PR #${pr}: ${direct_error}`);
  }

  // Refresh state — it may have transitioned since our initial read.
  const post_direct_state = await fetch_merge_state(pr_number, repo_path, gh_bin, env);
  const failure = classify_merge_failure(post_direct_state, direct_error);

  // Step 2: Recoverable pending/lag states → exponential backoff retry.
  // Both REQUIRED_CHECKS_PENDING and POLICY_LAG resolve when GitHub finishes
  // evaluating branch protection against the head SHA. No merge action on our
  // part will speed this up — we just have to wait.
  if (failure === "REQUIRED_CHECKS_PENDING" || failure === "POLICY_LAG") {
    const retry_result = await retry_merge_with_backoff(
      pr_number,
      repo_path,
      gh_bin,
      env,
      exec_opts,
    );
    if (retry_result.merged || retry_result.failure !== "BEHIND") return retry_result;
    // Fall through to Step 3 — PR transitioned to BEHIND during backoff
  }

  // Step 3: BEHIND or fall-through → update-branch + local rebase fallback.
  // Derive owner/repo from the git remote.
  const nwo = await get_repo_nwo(repo_path, gh_bin, env);
  if (!nwo) {
    return {
      merged: false,
      failure: "UNKNOWN",
      error: "Could not determine repo owner/name from remote",
    };
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

  // Step 4: Local git rebase fallback
  const rebase_result = await try_local_rebase(branch, repo_path, env);
  if (rebase_result.success) {
    // Wait for GitHub to process the force-push, then merge
    const mergeable = await poll_mergeable(pr_number, repo_path, gh_bin, env);
    if (mergeable) {
      try {
        await exec_async(gh_bin, ["pr", "merge", pr, "--squash", "--delete-branch"], exec_opts);
        return { merged: true, method: "local-rebase" };
      } catch (err) {
        const err_text = err instanceof Error ? err.message : String(err);
        return {
          merged: false,
          failure: "UNKNOWN",
          error: `Rebase succeeded but merge still failed: ${err_text}`,
        };
      }
    }
    return {
      merged: false,
      failure: "UNKNOWN",
      error: "Rebase succeeded but PR not mergeable after update",
    };
  }

  // Both update-branch and local-rebase exhausted. Re-classify with the fresh
  // rebase error text so a real conflict surfaces accurately.
  const final_state = await fetch_merge_state(pr_number, repo_path, gh_bin, env);
  const raw_error = rebase_result.error ?? direct_error;
  const final_failure = classify_merge_failure(final_state, raw_error);
  // Prefer the raw rebase error (e.g. "Rebase failed: timeout") over the
  // re-classified message, UNLESS the raw text IS the canned "rebase conflicts"
  // string that we want to replace with the accurate classification.
  const is_canned_conflict_message =
    rebase_result.error != null &&
    /rebase conflicts require manual resolution/i.test(rebase_result.error);
  return {
    merged: false,
    failure: final_failure,
    error: is_canned_conflict_message
      ? format_merge_failure(final_failure, raw_error)
      : (rebase_result.error ?? format_merge_failure(final_failure, raw_error)),
  };
}

/**
 * Retry `gh pr merge` on a policy-lag or required-checks-pending failure.
 *
 * Uses exponential backoff (see POLICY_RETRY_BACKOFF_MS). Before each attempt
 * we re-read mergeStateStatus — if it transitions to CLEAN we merge; if it
 * transitions to CONFLICTING or BEHIND we fall out (the main flow will catch
 * those on the next classification). Any other state keeps us in the loop.
 *
 * Returns an AutoMergeResult. On exhaustion, returns merged=false with
 * failure=POLICY_LAG (the most specific explanation for "we waited and it
 * still wouldn't merge").
 */
async function retry_merge_with_backoff(
  pr_number: number,
  repo_path: string,
  gh_bin: string,
  env: NodeJS.ProcessEnv,
  exec_opts: { cwd: string; env: NodeJS.ProcessEnv; timeout: number },
): Promise<AutoMergeResult> {
  const pr = String(pr_number);
  let last_error = "";

  for (let attempt = 0; attempt < POLICY_RETRY_BACKOFF_MS.length; attempt++) {
    const delay = POLICY_RETRY_BACKOFF_MS[attempt]!;
    console.log(
      `[auto-merge] Policy retry ${String(attempt + 1)}/${String(POLICY_RETRY_BACKOFF_MS.length)} ` +
        `for PR #${pr} in ${String(delay / 1000)}s`,
    );
    await sleep(delay);

    const state = await fetch_merge_state(pr_number, repo_path, gh_bin, env);

    // Hard fail cases we should drop out on.
    if (state.mergeable === "CONFLICTING") {
      return { merged: false, failure: "CONFLICT", error: format_merge_failure("CONFLICT", "") };
    }
    if (state.mergeStateStatus === "BEHIND") {
      // Let the outer flow handle update-branch/rebase.
      return {
        merged: false,
        failure: "BEHIND",
        error: format_merge_failure("BEHIND", ""),
      };
    }

    // If state is CLEAN, merge should succeed. If still BLOCKED, try anyway —
    // branch protection might clear between the poll and the merge call.
    try {
      await exec_async(gh_bin, ["pr", "merge", pr, "--squash", "--delete-branch"], exec_opts);
      console.log(
        `[auto-merge] Policy retry succeeded for PR #${pr} on attempt ${String(attempt + 1)}`,
      );
      return { merged: true, method: "policy-retry" };
    } catch (err) {
      last_error = err instanceof Error ? err.message : String(err);
      console.log(
        `[auto-merge] Policy retry ${String(attempt + 1)} failed for PR #${pr}: ${last_error}`,
      );
    }
  }

  // Exhausted budget. Re-classify in case the state has drifted.
  const state = await fetch_merge_state(pr_number, repo_path, gh_bin, env);
  const failure = classify_merge_failure(state, last_error);
  const final: MergeFailure =
    failure === "UNKNOWN" || failure === "REQUIRED_CHECKS_PENDING" ? "POLICY_LAG" : failure;
  return {
    merged: false,
    failure: final,
    error: format_merge_failure(final, last_error),
  };
}

/**
 * Fetch current mergeable + mergeStateStatus for a PR.
 * Returns UNKNOWN state on error so the caller can fall through to the
 * regular fallback chain rather than crash on transient gh failures.
 */
export async function fetch_merge_state(
  pr_number: number,
  repo_path: string,
  gh_bin: string,
  env: NodeJS.ProcessEnv,
): Promise<MergeState> {
  try {
    const { stdout } = await exec_async(
      gh_bin,
      ["pr", "view", String(pr_number), "--json", "mergeable,mergeStateStatus"],
      { cwd: repo_path, env, timeout: 15_000 },
    );
    const parsed = JSON.parse(stdout) as {
      mergeable?: string;
      mergeStateStatus?: string;
    };
    return {
      mergeable: (parsed.mergeable ?? "UNKNOWN") as MergeState["mergeable"],
      mergeStateStatus: (parsed.mergeStateStatus ?? "UNKNOWN") as MergeState["mergeStateStatus"],
    };
  } catch {
    return { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" };
  }
}

// ── Mergeable state queries (#257 merge-gate) ──

/**
 * GitHub's `mergeStateStatus` field, returned by GraphQL via `gh pr view`.
 * Documented at https://docs.github.com/en/graphql/reference/enums#mergestatestatus.
 *
 * - `CLEAN` — mergeable, all checks green, ready
 * - `HAS_HOOKS` — mergeable, but a status hook will run on merge (also OK)
 * - `BLOCKED` — branch protection is blocking (missing review, failing checks…)
 * - `BEHIND` — base ref has new commits; needs update / rebase
 * - `DIRTY` — merge conflicts
 * - `UNSTABLE` — non-required check failed; may still merge
 * - `UNKNOWN` — GitHub still computing
 */
export type MergeStateStatus =
  | "CLEAN"
  | "HAS_HOOKS"
  | "BLOCKED"
  | "BEHIND"
  | "DIRTY"
  | "UNSTABLE"
  | "UNKNOWN";

export interface PRMergeability {
  /** GitHub's `mergeable` field — MERGEABLE | CONFLICTING | UNKNOWN. */
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  /** GitHub's `mergeStateStatus` field. */
  merge_state_status: MergeStateStatus;
  /** Latest commit SHA on the head branch. */
  head_sha: string;
}

/**
 * Fetch a PR's mergeability state and head SHA via `gh pr view`.
 * Used by the v2 merge-gate (#257) to verify a PR is ready to merge.
 *
 * Throws on auth/network errors so the caller can decide between abort and retry.
 */
export async function fetch_pr_mergeability(
  pr_number: number,
  repo_path: string,
  gh_token?: string,
  gh_bin = "gh",
): Promise<PRMergeability> {
  const env = gh_token ? { ...process.env, GH_TOKEN: gh_token } : process.env;

  const { stdout } = await exec_async(
    gh_bin,
    ["pr", "view", String(pr_number), "--json", "mergeable,mergeStateStatus,headRefOid"],
    { cwd: repo_path, env, timeout: 15_000 },
  );

  const data = JSON.parse(stdout) as {
    mergeable: string;
    mergeStateStatus: string;
    headRefOid: string;
  };

  const VALID_MERGEABLE = new Set(["MERGEABLE", "CONFLICTING", "UNKNOWN"]);
  const VALID_MERGE_STATE = new Set([
    "CLEAN",
    "HAS_HOOKS",
    "BLOCKED",
    "BEHIND",
    "DIRTY",
    "UNSTABLE",
    "UNKNOWN",
  ]);

  const mergeable = data.mergeable.toUpperCase();
  const merge_state_status = data.mergeStateStatus.toUpperCase();

  if (!VALID_MERGEABLE.has(mergeable)) {
    throw new Error(`Unexpected mergeable value from GitHub: "${data.mergeable}"`);
  }
  if (!VALID_MERGE_STATE.has(merge_state_status)) {
    throw new Error(`Unexpected mergeStateStatus value from GitHub: "${data.mergeStateStatus}"`);
  }

  return {
    mergeable: mergeable as PRMergeability["mergeable"],
    merge_state_status: merge_state_status as MergeStateStatus,
    head_sha: data.headRefOid,
  };
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
 * Result of attempting a local git rebase.
 *
 * `kind` differentiates between transient failures (could_not_clone,
 * fetch_failed, push_failed) and a real merge conflict that requires manual
 * resolution. The merge-gate (#257) uses `kind` to decide whether to alert
 * a human or wait for the next CI cycle.
 *
 * `unsafe_merge_commits` (#367) is neither: the branch was never rebased at
 * all, because rebasing it would have been unsafe. It carries the SHAs of the
 * merge commits that made it so.
 */
export type LocalRebaseResult =
  | { success: true }
  | {
      success: false;
      kind: "unsafe_merge_commits";
      /** Merge commits found in `origin/main..HEAD`, newest first. */
      merge_shas: string[];
      error: string;
    }
  | {
      success: false;
      kind:
        | "conflict"
        | "no_remote"
        | "no_tmp_dir"
        | "clone_failed"
        | "fetch_failed"
        | "push_failed"
        | "other";
      error: string;
    };

/**
 * Attempt a local git rebase of the branch onto origin/main.
 * Uses a temp directory with a minimal clone, then force-pushes with lease.
 *
 * Exported so the v2 merge-gate (#257) can drive the rebase fallback path
 * without going through the legacy `attempt_auto_merge` wrapper.
 */
export async function try_local_rebase(
  branch: string,
  repo_path: string,
  env: NodeJS.ProcessEnv,
): Promise<LocalRebaseResult> {
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
    return { success: false, kind: "no_remote", error: "Could not determine remote URL" };
  }

  // Create temp dir for the rebase
  let tmp_dir: string;
  try {
    const { stdout } = await exec_async("mktemp", ["-d"], { timeout: 5_000 });
    tmp_dir = stdout.trim();
  } catch {
    return { success: false, kind: "no_tmp_dir", error: "Could not create temp directory" };
  }

  try {
    // Clone the branch (shallow to save time)
    try {
      await exec_async(
        "git",
        ["clone", "--single-branch", "--branch", branch, remote_url, tmp_dir],
        {
          env,
          timeout: 60_000,
        },
      );
    } catch (err) {
      return {
        success: false,
        kind: "clone_failed",
        error: `Clone failed: ${String(err instanceof Error ? err.message : err)}`,
      };
    }

    // Fetch main.
    //
    // The explicit refspec is load-bearing. The clone above is --single-branch,
    // so remote.origin.fetch only maps the PR branch; a bare `git fetch origin
    // main` then writes FETCH_HEAD and nothing else, leaving `origin/main`
    // unresolvable and every subsequent `git rebase origin/main` dying with
    // "fatal: invalid upstream 'origin/main'". Naming the destination ref
    // creates refs/remotes/origin/main, which both the merge-commit scan and
    // the rebase below address by name.
    try {
      await exec_async("git", ["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"], {
        cwd: tmp_dir,
        env,
        timeout: 30_000,
      });
    } catch (err) {
      return {
        success: false,
        kind: "fetch_failed",
        error: `Fetch failed: ${String(err instanceof Error ? err.message : err)}`,
      };
    }

    // Refuse to rebase a branch that contains merge commits (#367).
    //
    // Plain `git rebase` drops merge commits and linearises history. Anything
    // recorded only in a merge commit — a conflict resolution, or an edit made
    // while merging main to adapt the branch to it — has no commit to replay
    // from, so it is simply lost, and the branch's pre-merge version of the
    // file lands on top instead. Git raises no conflict: it never sees the
    // collision, because the content it would have collided with is gone. The
    // rebase reports success and we force-push a regression.
    //
    // There is no safe automatic answer. `--rebase-merges` preserves the
    // topology but brings its own surprises, so we fail closed and hand the
    // branch to a human rather than guess.
    let merge_shas: string[];
    try {
      const { stdout } = await exec_async("git", ["rev-list", "--merges", "origin/main..HEAD"], {
        cwd: tmp_dir,
        env,
        timeout: 30_000,
      });
      merge_shas = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    } catch (err) {
      // Could not establish whether the branch is safe. Fail closed — never
      // fall through to the rebase on an unanswered question.
      return {
        success: false,
        kind: "other",
        error: `Could not scan branch for merge commits: ${String(err instanceof Error ? err.message : err)}`,
      };
    }

    if (merge_shas.length > 0) {
      console.log(
        `[auto-merge] Refusing to rebase ${branch}: ${String(merge_shas.length)} merge commit(s) in origin/main..HEAD`,
      );
      return {
        success: false,
        kind: "unsafe_merge_commits",
        merge_shas,
        error: `Branch contains ${String(merge_shas.length)} merge commit(s) (${merge_shas.join(", ")}). A plain rebase would drop them and can silently revert work already on main, so no rebase was attempted. Manual resolution required.`,
      };
    }

    // Attempt rebase
    try {
      await exec_async("git", ["rebase", "origin/main"], { cwd: tmp_dir, env, timeout: 60_000 });
    } catch (err) {
      // Rebase failed — abort and clean up
      try {
        await exec_async("git", ["rebase", "--abort"], { cwd: tmp_dir, env, timeout: 10_000 });
      } catch {
        // Abort failed too — best-effort
      }
      // Differentiate real content conflicts from transient git errors
      // (timeouts, network failures, unreachable remotes). Only the first
      // category warrants a "rebase conflicts" user-facing message; the
      // others get their actual error surfaced so we don't send false alarms.
      const msg = err instanceof Error ? err.message : String(err);
      const is_conflict = /CONFLICT|could not apply|Merge conflict/i.test(msg);
      return {
        success: false,
        kind: is_conflict ? "conflict" : "other",
        error: is_conflict
          ? "Rebase conflicts require manual resolution"
          : `Rebase failed: ${msg.slice(0, 200)}`,
      };
    }

    // Rebase succeeded — force-push with lease
    try {
      await exec_async("git", ["push", "--force-with-lease", "origin", branch], {
        cwd: tmp_dir,
        env,
        timeout: 30_000,
      });
    } catch (err) {
      return {
        success: false,
        kind: "push_failed",
        error: `Force-push failed: ${String(err instanceof Error ? err.message : err)}`,
      };
    }

    console.log(`[auto-merge] Local rebase succeeded for branch ${branch}`);
    return { success: true };
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

interface GhCheck {
  name: string;
  state: string;
  conclusion: string;
}

/**
 * Outcome of a single `gh pr checks` query.
 *
 * `none` means gh answered "nothing matches this query" — either an empty JSON
 * array or the non-zero exit carrying "no [required] checks reported on the
 * 'x' branch". `error` means we never got an answer (auth, rate limit, network).
 */
type ChecksQuery = { kind: "checks"; checks: GhCheck[] } | { kind: "none" } | { kind: "error" };

async function query_pr_checks(
  pr_number: number,
  repo_path: string,
  env: NodeJS.ProcessEnv,
  gh_bin: string,
  required: boolean,
): Promise<ChecksQuery> {
  const args = ["pr", "checks", String(pr_number)];
  if (required) args.push("--required");
  args.push("--json", "name,state,conclusion");

  try {
    const { stdout } = await exec_async(gh_bin, args, {
      cwd: repo_path,
      env,
      timeout: 15_000,
    });
    const checks = JSON.parse(stdout) as GhCheck[];
    return checks.length === 0 ? { kind: "none" } : { kind: "checks", checks };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no.*checks?\s+reported/i.test(msg)) return { kind: "none" };
    return { kind: "error" };
  }
}

/**
 * Classify a non-empty list of checks into pass / pending / failures.
 *
 * SUCCESS, NEUTRAL and SKIPPED all count as passing — our workflows use change
 * detection, so a frontend-only PR legitimately skips the backend job. Treating
 * skipped as pending would wedge every partial-CI PR forever.
 */
function classify_checks(checks: GhCheck[]): CICheckStatus {
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
}

/**
 * Query the CI check status for a PR.
 *
 * Asks `gh pr checks --required` first — required checks are the authoritative
 * merge gate where branch protection exists. When that reports nothing, falls
 * back to the unfiltered list (#361): `--required` only sees checks pinned by
 * branch protection, and private repos without GitHub Pro cannot configure
 * branch protection at all (the API 403s), so it comes back empty on repos whose
 * CI is running right now. Only an empty *unfiltered* list means "no CI".
 *
 * Fails closed on infrastructure errors — an unanswered query reports pending,
 * never mergeable, so a rate limit or auth blip can't wave a PR through.
 */
export async function check_ci_status(
  pr_number: number,
  repo_path: string,
  gh_token?: string,
  gh_bin = "gh",
): Promise<CICheckStatus> {
  const env = gh_token ? { ...process.env, GH_TOKEN: gh_token } : process.env;

  const required = await query_pr_checks(pr_number, repo_path, env, gh_bin, true);
  if (required.kind === "error") return { passed: false, pending: true, failures: [] };
  if (required.kind === "checks") return classify_checks(required.checks);

  const all = await query_pr_checks(pr_number, repo_path, env, gh_bin, false);
  if (all.kind === "error") return { passed: false, pending: true, failures: [] };
  // Nothing required *and* nothing at all — the repo really has no CI.
  if (all.kind === "none") return { passed: true, pending: false, failures: [] };
  return classify_checks(all.checks);
}

/** Maximum number of CI fix attempts before escalating to a human (#196). */
export const MAX_CI_FIX_ATTEMPTS = 3;

/** Maximum number of deploy triage attempts before escalating to a human (#199).
 * Lower than CI fix cap — deploy failures on main are higher stakes. */
export const MAX_DEPLOY_FIX_ATTEMPTS = 2;

/** Maximum number of Sentry auto-fix attempts before requiring human pickup (#250). */
export const MAX_SENTRY_FIX_ATTEMPTS = 2;

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
    "## Deploy Failure Triage",
    "",
    `Workflow "${workflow_name}" failed on main.`,
    `Run: ${workflow_url}`,
    `Run ID: ${String(run_id)}`,
    `Repository: ${repo_path}`,
    `Attempt: ${String(attempt)}/${String(max_attempts)}`,
    "",
  ];

  if (failure_logs.length > 0) {
    lines.push("## Failure Logs", "");

    for (const log of failure_logs) {
      lines.push(`### ${log.check_name}`, "", "```", log.log_output, "```", "");
    }
  } else {
    lines.push(
      "(No failure logs could be fetched from GitHub Actions.",
      `Run \`gh run view ${String(run_id)} --log-failed\` manually, or check CloudWatch.)`,
      "",
    );
  }

  lines.push(
    "## Instructions",
    "",
    "1. **Diagnose** — read the failure logs above. Identify the failing step and root cause.",
    "2. **Classify** — is this a code issue, infra/config issue, or external dependency failure?",
    "3. **Decide** — fix forward (hotfix branch + PR), recommend rollback, or escalate to human.",
    "4. **Act**:",
    "   - For code fixes: create a hotfix branch, fix the issue, open a PR with `Closes` link if applicable.",
    "   - For infra/config: post diagnosis and recommended fix to #alerts and escalate.",
    "   - If unclear: post full diagnosis to #alerts and escalate.",
    "",
    "Rules:",
    "- Do NOT push directly to main. All fixes go through PRs.",
    "- Do NOT attempt rollbacks (git revert on main) without human approval.",
    "- If GitHub Actions logs are insufficient, note this and recommend checking CloudWatch.",
    "- Keep fixes minimal and targeted.",
  );

  return lines.join("\n");
}

// ── Sentry auto-fix prompt (#250) ──

/**
 * Build the prompt given to Bob (builder) when auto-fixing a Sentry error
 * after Ray's triage diagnosis.
 *
 * Takes the triage verdict (severity, fix approach, issue number) and
 * Sentry issue details (title, URL, stack trace, culprit) to construct
 * a targeted fix prompt.
 */
export function build_sentry_fix_prompt(
  verdict: { severity: string; fix_approach: string | null; github_issue: number | null },
  issue_details: { title: string; web_url: string; stack_trace: string; culprit: string },
): string {
  const lines = [
    "## Sentry Error Auto-Fix",
    "",
    `**Error:** ${issue_details.title}`,
    `**Severity:** ${verdict.severity}`,
    `**Culprit:** ${issue_details.culprit}`,
    `**Sentry URL:** ${issue_details.web_url}`,
  ];

  if (verdict.github_issue != null) {
    lines.push(`**GitHub Issue:** #${String(verdict.github_issue)}`);
  }

  lines.push("", "## Stack Trace", "", "```", issue_details.stack_trace, "```", "");

  if (verdict.fix_approach) {
    lines.push("## Diagnosis & Fix Approach", "", verdict.fix_approach, "");
  }

  lines.push(
    "## Instructions",
    "",
    "1. Read the source files referenced in the stack trace above",
    "2. Understand the root cause based on the diagnosis",
    "3. Implement a minimal, targeted fix",
    "4. Add or update tests if applicable",
    "5. Create a feature branch, commit your changes, and open a PR",
  );

  if (verdict.github_issue != null) {
    lines.push(`6. Include \`Closes #${String(verdict.github_issue)}\` in the PR body`);
  }

  lines.push(
    "",
    "## Rules",
    "",
    "- Keep changes minimal and targeted — fix the bug, nothing else.",
    "- Do NOT touch auth, permissions, encryption, or user data handling beyond what the diagnosis calls for.",
    "- Do NOT make architectural changes or refactor unrelated code.",
    "- Do NOT merge the PR — the AutoReviewer will handle review and merge.",
    "- If you are unsure about the fix or it requires broader changes, post your analysis to #alerts and stop.",
  );

  return lines.join("\n");
}
