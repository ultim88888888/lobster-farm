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

/**
 * Which query produced a CI reading.
 *
 * The three real sources are tried in order and answer with decreasing
 * precision, so the source is part of the answer: a human reading an alert
 * needs to know whether "not green" means "the `lint` job failed" or "GitHub
 * says this branch is not mergeable and we cannot see why".
 *
 * - `pr-checks`     — `gh pr checks`. Per-check names and states. Best signal,
 *                     but needs `Actions: Read` on the App installation.
 * - `status-rollup` — `gh pr view --json statusCheckRollup`. Per-check names
 *                     and states too, without touching `checkSuite.workflowRun`.
 * - `merge-state`   — `gh pr view --json mergeStateStatus,mergeable`. GitHub's
 *                     own verdict. Coarse: green or not, never *which* check.
 * - `unavailable`   — nothing answered. Always fail-closed pending.
 */
export type CIStatusSource = "pr-checks" | "status-rollup" | "merge-state" | "unavailable";

/**
 * A PR's CI verdict.
 *
 * **Invariant: `passed === false` implies `pending === true || failures.length > 0`.**
 *
 * Every caller derives "safe to merge" from `!pending && failures.length === 0`
 * rather than from `passed`, so a status that is not passing must always carry
 * one of the two — otherwise a PR GitHub refuses to merge reads as green. The
 * `merge-state` source is where this bites: it knows a PR is blocked but cannot
 * name a single failing check, so it reports `pending` and lets the parked
 * approval escalate loudly instead of inventing a failure name or, worse,
 * merging.
 */
export interface CICheckStatus {
  passed: boolean;
  pending: boolean;
  failures: string[];
  /** Which query answered. See {@link CIStatusSource}. */
  source: CIStatusSource;
}

/** Human-readable note on how much a reading from this source can be trusted. */
export function describe_ci_source(source: CIStatusSource): string {
  switch (source) {
    case "pr-checks":
      return "read from `gh pr checks` (per-check detail)";
    case "status-rollup":
      return "read from the PR's statusCheckRollup — `gh pr checks` is denied to this token (per-check detail)";
    case "merge-state":
      return "read from GitHub's own mergeStateStatus — per-check detail is unavailable to this token, so no individual check can be named";
    case "unavailable":
      return "no CI source answered — reported pending to fail closed";
  }
}

/** The fail-closed reading: we could not tell, so nothing merges. */
function ci_unavailable(): CICheckStatus {
  return { passed: false, pending: true, failures: [], source: "unavailable" };
}

/**
 * One source's attempt at a reading.
 *
 * The distinction that matters is `denied` vs `failed`: a permission refusal is
 * a standing condition that the next source may not share, so it falls through.
 * A timeout, rate limit or network blip says nothing about permissions and must
 * fail closed exactly as it always has — retrying it against a different query
 * would just be three timeouts instead of one.
 */
type SourceOutcome =
  | { kind: "answer"; status: CICheckStatus }
  | { kind: "denied"; message: string }
  | { kind: "failed"; message: string };

/**
 * Does this failure mean GitHub refused the query on permissions?
 *
 * Two things trip it. `gh pr checks` resolves through `checkSuite.workflowRun`,
 * which an installation token may only read with `Actions: Read`; without it
 * GitHub 403s that node and gh exits non-zero for the *whole* query, taking
 * `name` and `state` down with it. The same string comes back for any other
 * node the installation cannot reach. The `workflowRun` path is the tell; the
 * bare permission string is matched too because gh does not always echo a path.
 *
 * A false positive costs one extra query against a different source — which
 * either answers or fails closed like any other error — so this errs on the
 * side of trying the next source.
 */
function is_permission_denied(msg: string): boolean {
  return /workflowRun/i.test(msg) || /resource not accessible by integration/i.test(msg);
}

/**
 * Collapse a gh failure into a single log-safe line.
 *
 * The permission denial arrives as one clause repeated once per check in the
 * rollup — ten of them per line, every two minutes, per parked PR. Clauses are
 * dropped when an earlier one already contains them end-to-end, which also
 * catches the first copy hiding behind gh's `Command failed: …` echo. The
 * result is capped so a diagnostic stays a diagnostic.
 */
function summarize_gh_error(msg: string): string {
  const kept: string[] = [];
  for (const clause of msg
    .split("\n")
    .slice(0, 3)
    .join(" | ")
    .split(", ")
    .map((c) => c.trim())) {
    if (kept.some((seen) => seen.endsWith(clause) || clause.endsWith(seen))) continue;
    kept.push(clause);
  }
  const summary = kept.join(", ");
  return summary.length > 300 ? `${summary.slice(0, 300)}…` : summary;
}

/**
 * Diagnostics that have already been stated this process.
 *
 * Every condition announced through here is a standing one — a missing App
 * permission, not an incident — so it is stated once per daemon run rather than
 * on every poll of every parked PR. Keyed by condition, so degrading from
 * `gh pr checks` to the rollup and then to mergeStateStatus produces three
 * distinct lines rather than one that hides the other two.
 */
const reported_notices = new Set<string>();

/** Test seam: forget the once-per-process diagnostics. */
export function _reset_ci_status_notices_for_testing(): void {
  reported_notices.clear();
}

/**
 * Say something once per process.
 *
 * Silence is how a permanently-broken CI query hid for weeks twice over (#372,
 * #382). Degrading to a coarser source is never allowed to be silent.
 */
function notice_once(key: string, line: string, stream: "log" | "error" = "error"): void {
  if (reported_notices.has(key)) return;
  reported_notices.add(key);
  if (stream === "log") console.log(line);
  else console.error(line);
}

/** Announce which source answered — once per process, per source. */
function note_source(source: CIStatusSource, pr_number: number): void {
  const seen_on = `First seen on PR #${String(pr_number)}.`;
  switch (source) {
    case "pr-checks":
      notice_once(
        "source:pr-checks",
        `[ci-status] Reading CI from \`gh pr checks\`. ${seen_on}`,
        "log",
      );
      return;
    case "status-rollup":
      notice_once(
        "source:status-rollup",
        `[ci-status] \`gh pr checks\` is denied to this token (needs Actions: Read on the App installation) — reading CI from \`gh pr view --json statusCheckRollup\` instead for the rest of this process. Per-check names and states are still available. ${seen_on}`,
      );
      return;
    case "merge-state":
      notice_once(
        "source:merge-state",
        `[ci-status] Both \`gh pr checks\` and statusCheckRollup are denied to this token — falling back to GitHub's own \`mergeStateStatus\` for the rest of this process. Only CLEAN reads as green; anything else reports pending, because this source cannot name which check failed. ${seen_on}`,
      );
      return;
    case "unavailable":
      return;
  }
}

// ── Source 1: `gh pr checks` ──

/**
 * One row of `gh pr checks --json name,state,bucket`.
 *
 * `state` is gh's single verdict field: the check run's conclusion once it has
 * completed (SUCCESS / FAILURE / NEUTRAL / SKIPPED / CANCELLED / TIMED_OUT /
 * ACTION_REQUIRED / STALE), otherwise its status (PENDING / QUEUED /
 * IN_PROGRESS / REQUESTED / WAITING).
 *
 * `bucket` is gh's own coarse grouping — "pass" | "fail" | "pending" |
 * "skipping" | "cancel" — kept as a backstop for states we don't enumerate.
 * It is optional: gh resolves it through `checkSuite.workflowRun`, which an
 * installation token can only read with the `Actions: Read` permission, so the
 * query is retried without it when GitHub says no.
 *
 * There is deliberately no `conclusion` field here: `gh pr checks --json` has
 * never accepted one, and asking for it made gh exit 1 on every query (#372).
 */
interface GhCheck {
  name: string;
  state: string;
  bucket?: string;
}

/** The exact `--json` field list. Every name here must exist in `gh pr checks --json`. */
const GH_CHECKS_JSON_FIELDS = "name,state,bucket";

/** The same query minus `bucket` — the one field that needs `Actions: Read`. */
const GH_CHECKS_JSON_FIELDS_NO_BUCKET = "name,state";

/**
 * Outcome of a single `gh pr checks` invocation.
 *
 * `none` means gh answered "nothing matches this query" — either an empty JSON
 * array or the non-zero exit carrying "no [required] checks reported on the
 * 'x' branch". `error` keeps the failure text, because what the text says
 * decides whether another source is worth trying.
 */
type ChecksAttempt =
  | { kind: "checks"; checks: GhCheck[] }
  | { kind: "none" }
  | { kind: "error"; message: string };

/**
 * Outcome of the whole `gh pr checks` source, bucket retry included.
 *
 * A single attempt cannot tell `denied` from `error` on its own — only the
 * retry without `bucket` proves the refusal was about the query rather than
 * the field.
 */
type ChecksQuery = ChecksAttempt | { kind: "denied"; message: string };

/** Run `gh pr checks` once with an explicit `--json` field list. */
async function run_pr_checks(
  pr_number: number,
  repo_path: string,
  env: NodeJS.ProcessEnv,
  gh_bin: string,
  required: boolean,
  json_fields: string,
): Promise<ChecksAttempt> {
  const args = ["pr", "checks", String(pr_number)];
  if (required) args.push("--required");
  args.push("--json", json_fields);

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
    return { kind: "error", message: msg };
  }
}

/**
 * Ask gh for a PR's checks, degrading rather than failing closed.
 *
 * `bucket` is a nicety — it only sharpens the reading of deployment-gate states
 * that `state` alone would misread. When the token cannot read it, dropping the
 * field and re-asking is strictly better than reporting a green PR as pending
 * forever — which is what asking for `bucket` unconditionally (472e110) did to
 * every approved PR across every entity until this fallback existed.
 *
 * Dropping the field is not always enough, though: `gh pr checks` resolves
 * `checkSuite.workflowRun` whatever `--json` asks for, so on an installation
 * without `Actions: Read` the bucketless retry is refused too. That is not a
 * dead end any more — it returns `denied`, and the caller tries a different
 * query entirely.
 */
async function query_pr_checks(
  pr_number: number,
  repo_path: string,
  env: NodeJS.ProcessEnv,
  gh_bin: string,
  required: boolean,
): Promise<ChecksQuery> {
  const first = await run_pr_checks(
    pr_number,
    repo_path,
    env,
    gh_bin,
    required,
    GH_CHECKS_JSON_FIELDS,
  );
  if (first.kind !== "error") return first;

  if (is_permission_denied(first.message)) {
    notice_once(
      "bucket-dropped",
      `[ci-status] gh denied the 'bucket' field (needs Actions: Read on the App installation) — retrying CI queries as '${GH_CHECKS_JSON_FIELDS_NO_BUCKET}' for the rest of this process; deployment gates now read from 'state' alone. First seen on PR #${String(pr_number)}: ${summarize_gh_error(first.message)}`,
    );

    const fallback = await run_pr_checks(
      pr_number,
      repo_path,
      env,
      gh_bin,
      required,
      GH_CHECKS_JSON_FIELDS_NO_BUCKET,
    );
    if (fallback.kind !== "error") return fallback;

    // Refused even without `bucket` — `gh pr checks` needs the permission no
    // matter which fields are asked for. Hand the caller a different query.
    if (is_permission_denied(fallback.message)) {
      return { kind: "denied", message: fallback.message };
    }

    console.error(
      `[ci-status] gh pr checks failed for PR #${String(pr_number)} even without 'bucket' — reporting CI as pending: ${summarize_gh_error(fallback.message)}`,
    );
    return { kind: "error", message: fallback.message };
  }

  // Everything else fails closed as pending, which is safe but silent — and
  // silence is how a permanently-broken query (#372) hid for weeks. Say so.
  console.error(
    `[ci-status] gh pr checks failed for PR #${String(pr_number)} — reporting CI as pending: ${summarize_gh_error(first.message)}`,
  );
  return { kind: "error", message: first.message };
}

/**
 * Check states that mean "not finished yet".
 *
 * WAITING and REQUESTED are deployment approval gates. They are enumerated here
 * rather than left to gh's `bucket` because `bucket` is not always available
 * — and without them, an unfinished gate reads as a failure and gets
 * handed to a CI fixer.
 */
const PENDING_CHECK_STATES = new Set(["PENDING", "QUEUED", "IN_PROGRESS", "REQUESTED", "WAITING"]);

/** Conclusions that count as "this check is not standing in the way". */
const PASSING_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/**
 * Classify a non-empty list of checks into pass / pending / failures.
 *
 * SUCCESS, NEUTRAL and SKIPPED all count as passing — our workflows use change
 * detection, so a frontend-only PR legitimately skips the backend job. Treating
 * skipped as pending would wedge every partial-CI PR forever.
 *
 * `state` is the authority; gh's `bucket` only widens the pending set, as a
 * backstop for states we have not enumerated. When `bucket` is absent — the
 * token could not read it, so the query fell back to `name,state` — the
 * reading is `state` alone. A missing bucket is never itself a failure signal.
 */
function classify_checks(checks: GhCheck[]): CICheckStatus {
  const failures: string[] = [];
  let has_pending = false;

  for (const check of checks) {
    if (check.bucket === "pending" || PENDING_CHECK_STATES.has(check.state)) {
      has_pending = true;
    } else if (!PASSING_CONCLUSIONS.has(check.state)) {
      failures.push(check.name);
    }
  }

  return {
    passed: failures.length === 0 && !has_pending,
    pending: has_pending,
    failures,
    source: "pr-checks",
  };
}

/**
 * Source 1 — `gh pr checks`, required checks first.
 *
 * Asks `gh pr checks --required` first: required checks are the authoritative
 * merge gate where branch protection exists. When that reports nothing, falls
 * back to the unfiltered list (#361): `--required` only sees checks pinned by
 * branch protection, and private repos without GitHub Pro cannot configure
 * branch protection at all (the API 403s), so it comes back empty on repos
 * whose CI is running right now. Only an empty *unfiltered* list means "no CI".
 */
async function ci_status_from_pr_checks(
  pr_number: number,
  repo_path: string,
  env: NodeJS.ProcessEnv,
  gh_bin: string,
): Promise<SourceOutcome> {
  const required = await query_pr_checks(pr_number, repo_path, env, gh_bin, true);
  if (required.kind === "denied") return { kind: "denied", message: required.message };
  if (required.kind === "error") return { kind: "failed", message: required.message };
  if (required.kind === "checks") {
    return { kind: "answer", status: classify_checks(required.checks) };
  }

  const all = await query_pr_checks(pr_number, repo_path, env, gh_bin, false);
  if (all.kind === "denied") return { kind: "denied", message: all.message };
  if (all.kind === "error") return { kind: "failed", message: all.message };
  // Nothing required *and* nothing at all — the repo really has no CI.
  if (all.kind === "none") {
    return {
      kind: "answer",
      status: { passed: true, pending: false, failures: [], source: "pr-checks" },
    };
  }
  return { kind: "answer", status: classify_checks(all.checks) };
}

// ── Source 2: `gh pr view --json statusCheckRollup` ──

/**
 * One entry of a PR's `statusCheckRollup`.
 *
 * The list is heterogeneous. `CheckRun` entries (GitHub Actions and most Apps)
 * carry `name`, a lifecycle `status` and, once complete, a `conclusion`.
 * `StatusContext` entries (the older commit-status API — Vercel, Netlify, some
 * bots) carry `context` and a single `state` that is both at once. Both shapes
 * are handled; an entry matching neither is treated as failing, because a check
 * we cannot read is not a check we may wave through.
 *
 * Unlike `gh pr checks`, this query never resolves `checkSuite.workflowRun`, so
 * it survives an installation without `Actions: Read`.
 */
interface RollupEntry {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  workflowName?: string;
}

/** The `--json` field list for the rollup query. */
const GH_ROLLUP_JSON_FIELDS = "statusCheckRollup";

/**
 * States that mean "not finished yet", across both rollup shapes.
 *
 * EXPECTED is the StatusContext equivalent of a queued check: a required
 * context branch protection knows about but nothing has reported yet.
 */
const PENDING_ROLLUP_STATES = new Set([
  "PENDING",
  "QUEUED",
  "IN_PROGRESS",
  "REQUESTED",
  "WAITING",
  "EXPECTED",
]);

/** The name to show for a rollup entry, whichever shape it is. */
function rollup_entry_name(entry: RollupEntry): string {
  return entry.name ?? entry.context ?? entry.workflowName ?? "(unnamed check)";
}

/**
 * Reduce one rollup entry to a verdict.
 *
 * A `StatusContext`'s single `state` field stands in for both `status` and
 * `conclusion`, which collapses the two shapes into one rule: if the lifecycle
 * field says "running", it is pending; otherwise the conclusion field decides,
 * and anything that is not an explicit pass is a failure. That last clause is
 * what keeps a COMPLETED check with a null conclusion — or an entry in a shape
 * we have never seen — from reading as green.
 */
function classify_rollup_entry(entry: RollupEntry): "pending" | "pass" | "fail" {
  const status = (entry.status ?? entry.state ?? "").toUpperCase();
  const conclusion = (entry.conclusion ?? entry.state ?? "").toUpperCase();

  if (PENDING_ROLLUP_STATES.has(status)) return "pending";
  if (PASSING_CONCLUSIONS.has(conclusion)) return "pass";
  return "fail";
}

/**
 * Source 2 — the PR's own check rollup.
 *
 * Same per-check precision as `gh pr checks`, reached by a query GitHub will
 * answer without `Actions: Read`. An empty rollup means the repo reported no
 * checks at all, which is the same "no CI configured" verdict source 1 gives
 * for an empty unfiltered list.
 */
async function ci_status_from_rollup(
  pr_number: number,
  repo_path: string,
  env: NodeJS.ProcessEnv,
  gh_bin: string,
): Promise<SourceOutcome> {
  let stdout: string;
  try {
    ({ stdout } = await exec_async(
      gh_bin,
      ["pr", "view", String(pr_number), "--json", GH_ROLLUP_JSON_FIELDS],
      { cwd: repo_path, env, timeout: 15_000 },
    ));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (is_permission_denied(message)) return { kind: "denied", message };
    console.error(
      `[ci-status] gh pr view --json ${GH_ROLLUP_JSON_FIELDS} failed for PR #${String(pr_number)} — reporting CI as pending: ${summarize_gh_error(message)}`,
    );
    return { kind: "failed", message };
  }

  let entries: RollupEntry[];
  try {
    const parsed = JSON.parse(stdout) as { statusCheckRollup?: RollupEntry[] | null };
    entries = parsed.statusCheckRollup ?? [];
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[ci-status] Could not parse statusCheckRollup for PR #${String(pr_number)} — reporting CI as pending: ${summarize_gh_error(message)}`,
    );
    return { kind: "failed", message };
  }

  const failures: string[] = [];
  let has_pending = false;
  for (const entry of entries) {
    const verdict = classify_rollup_entry(entry);
    if (verdict === "pending") has_pending = true;
    else if (verdict === "fail") failures.push(rollup_entry_name(entry));
  }

  return {
    kind: "answer",
    status: {
      passed: failures.length === 0 && !has_pending,
      pending: has_pending,
      failures,
      source: "status-rollup",
    },
  };
}

// ── Source 3: `gh pr view --json mergeStateStatus,mergeable` ──

/** The `--json` field list for GitHub's own merge verdict. */
const GH_MERGE_STATE_JSON_FIELDS = "mergeStateStatus,mergeable";

/**
 * Source 3 — GitHub's own verdict on whether the PR may merge.
 *
 * `mergeStateStatus` already folds in branch protection and required checks,
 * and it needs no Actions permission. What it cannot do is name anything: a
 * blocked PR looks identical whether `lint` failed or a required check never
 * reported. So only CLEAN reads as green.
 *
 * Everything else reports `{ passed: false, pending: true }` rather than a bare
 * `passed: false`. That is deliberate, and it is the invariant documented on
 * {@link CICheckStatus}: every caller decides "safe to merge" from
 * `!pending && failures.length === 0`, so a `passed: false` with no named
 * failure would sail straight through the gate this function exists to hold.
 * Reporting pending keeps the approval parked, keeps it retrying in case the
 * state resolves, and escalates it loudly — with the source named — once the
 * park goes stale. Coarse and honest beats precise and wrong.
 */
async function ci_status_from_merge_state(
  pr_number: number,
  repo_path: string,
  env: NodeJS.ProcessEnv,
  gh_bin: string,
): Promise<SourceOutcome> {
  let stdout: string;
  try {
    ({ stdout } = await exec_async(
      gh_bin,
      ["pr", "view", String(pr_number), "--json", GH_MERGE_STATE_JSON_FIELDS],
      { cwd: repo_path, env, timeout: 15_000 },
    ));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (is_permission_denied(message)) return { kind: "denied", message };
    console.error(
      `[ci-status] gh pr view --json ${GH_MERGE_STATE_JSON_FIELDS} failed for PR #${String(pr_number)} — reporting CI as pending: ${summarize_gh_error(message)}`,
    );
    return { kind: "failed", message };
  }

  let merge_state: string;
  let mergeable: string;
  try {
    const parsed = JSON.parse(stdout) as { mergeStateStatus?: string; mergeable?: string };
    merge_state = (parsed.mergeStateStatus ?? "").toUpperCase();
    mergeable = (parsed.mergeable ?? "").toUpperCase();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[ci-status] Could not parse ${GH_MERGE_STATE_JSON_FIELDS} for PR #${String(pr_number)} — reporting CI as pending: ${summarize_gh_error(message)}`,
    );
    return { kind: "failed", message };
  }

  // CLEAN is the only state that means "nothing is standing in the way".
  // UNKNOWN on either field means GitHub is still computing the merge commit.
  const green = merge_state === "CLEAN" && mergeable !== "UNKNOWN";

  return {
    kind: "answer",
    status: {
      passed: green,
      pending: !green,
      failures: [],
      source: "merge-state",
    },
  };
}

// ── The chain ──

/**
 * Query the CI check status for a PR.
 *
 * Three sources, tried in order, stopping at the first that answers:
 *
 *   1. `gh pr checks`                              — per-check detail
 *   2. `gh pr view --json statusCheckRollup`       — per-check detail
 *   3. `gh pr view --json mergeStateStatus`        — green / not green
 *
 * A source is skipped to the next one **only** when GitHub refused it on
 * permissions. That is the whole point of the chain: `gh pr checks` resolves
 * `checkSuite.workflowRun` on every query, so an App installation without
 * `Actions: Read` gets nothing from it, whatever `--json` asks for. Sources 2
 * and 3 do not touch that node. Where the org will not grant the permission —
 * and we do not always own the org — the gate has to read the same facts from
 * a query GitHub will actually answer.
 *
 * Everything else still fails closed. A timeout, rate limit or network blip
 * reports pending immediately and does not fall through: it says nothing about
 * permissions, and three timeouts are no more informative than one. There is
 * deliberately no path that returns `passed: true` because we could not tell.
 */
export async function check_ci_status(
  pr_number: number,
  repo_path: string,
  gh_token?: string,
  gh_bin = "gh",
): Promise<CICheckStatus> {
  const env = gh_token ? { ...process.env, GH_TOKEN: gh_token } : process.env;

  const sources = [ci_status_from_pr_checks, ci_status_from_rollup, ci_status_from_merge_state];

  for (const read_source of sources) {
    const outcome = await read_source(pr_number, repo_path, env, gh_bin);
    if (outcome.kind === "answer") {
      note_source(outcome.status.source, pr_number);
      return outcome.status;
    }
    if (outcome.kind === "failed") return ci_unavailable();
    // `denied` — try the next source.
  }

  console.error(
    `[ci-status] Every CI source was refused for PR #${String(pr_number)} (gh pr checks, statusCheckRollup and mergeStateStatus all denied) — reporting CI as pending.`,
  );
  return ci_unavailable();
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
