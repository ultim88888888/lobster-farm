/**
 * Event-driven PR lifecycle dispatch (#257).
 *
 * The v2 PR lifecycle is anchored on `check_suite.completed`, not
 * `pull_request.opened`. Every transition is a webhook event:
 *
 *   PR opened       → no-op (just wait for CI)
 *   CI succeeds     → spawn reviewer
 *   CI fails        → spawn ci-fixer (separate from reviewer; reviewer never
 *                     sees broken code)
 *   CI cancelled    → alert, manual triage
 *   CI flake        → auto-rerun once, then escalate
 *   Review changes  → spawn builder (handled in webhook-handler post-review)
 *   Builder pushes  → fresh check_suite fires → loop
 *
 * The handler is gated per-entity by `entity.pr_lifecycle === "v2"`. Entities
 * still on v1 drive review from the legacy `pull_request.opened` spawn in
 * `webhook-handler.ts` and take one narrow branch here (#355): merging a PR
 * that was approved while its CI was still running. See
 * `handle_v1_check_suite` — it merges or does nothing, never spawning a
 * reviewer, ci-fixer, or flake rerun.
 *
 * Architecture: every external side effect (gh CLI, session spawn, alert) goes
 * through a `CheckSuiteDeps` seam so tests can stub them precisely. Production
 * callers use `make_default_deps(...)` to wire the real implementations.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ArchetypeRole, EntityConfig, LobsterFarmConfig } from "@lobster-farm/shared";
import type { DiscordBot } from "./discord.js";
import type { GitHubAppAuth } from "./github-app.js";
import { extract_first_linked_issue, fetch_issue_context } from "./issue-utils.js";
import {
  type PRReviewState,
  type ProcessedPR,
  load_pr_reviews,
  save_pr_reviews,
} from "./persistence.js";
import type { EntityRegistry } from "./registry.js";
import { find_entity_for_repo } from "./repo-utils.js";
import {
  type AutoMergeResult,
  MAX_CI_FIX_ATTEMPTS,
  attempt_auto_merge,
  build_ci_fix_prompt,
  fetch_ci_failure_logs,
} from "./review-utils.js";
import * as sentry from "./sentry.js";
import type { ClaudeSessionManager } from "./session.js";

const exec_async = promisify(execFile);

// ── Webhook payload types (subset we care about) ──

/** Conclusion field on a `check_suite.completed` event. */
export type CheckSuiteConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "timed_out"
  | "action_required"
  | "stale"
  | "skipped";

/** Subset of the `pull_requests[]` entry shape we read. */
interface CheckSuitePR {
  number: number;
  head: { ref: string; sha: string };
  base: { ref: string };
}

interface CheckSuiteData {
  id: number;
  head_sha: string;
  head_branch: string | null;
  conclusion: CheckSuiteConclusion | null;
  pull_requests: CheckSuitePR[];
  /** Present on rerun events; used to bound flake retries. */
  rerequestable?: boolean;
}

export interface CheckSuiteWebhookPayload {
  action: string;
  check_suite?: CheckSuiteData;
  repository?: {
    full_name: string;
    fork?: boolean;
  };
  installation?: { id: number };
}

// ── PR detail type fetched from gh ──

/** Subset of `gh pr view` we need for dispatch. */
export interface PRDetail {
  number: number;
  title: string;
  branch: string;
  base_ref: string;
  body: string;
  head_sha: string;
  is_fork: boolean;
  is_draft: boolean;
}

// ── Dependency seam ──

export interface CheckSuiteDeps {
  /** Resolve a GH App installation token. */
  resolve_token: (installation_id: string | undefined) => Promise<string>;
  /** Look up the full PR details by number — needed because the webhook
   * payload's `pull_requests[]` is sparse. */
  fetch_pr_detail: (pr_number: number, repo_path: string, gh_token: string) => Promise<PRDetail>;
  /** Fetch CI failure logs for the head branch. */
  fetch_ci_failure_logs: typeof fetch_ci_failure_logs;
  /** Fetch issue context for the linked issue (shown to reviewer). */
  fetch_issue_context: (
    repo_path: string,
    issue_number: number,
    gh_token: string,
  ) => Promise<string>;
  /** Persisted PR review state (reads). */
  load_pr_reviews: (config: LobsterFarmConfig) => Promise<PRReviewState>;
  /** Persisted PR review state (writes). */
  save_pr_reviews: (state: PRReviewState, config: LobsterFarmConfig) => Promise<void>;
  /** Spawn a session via the session manager. */
  spawn_session: (options: SpawnSessionOptions) => Promise<{ session_id: string }>;
  /** Post a message to an entity's #alerts channel. */
  notify_alerts: (entity_id: string, message: string) => Promise<void>;
  /** Re-run a check suite (GH API). Used for the single flake-retry. */
  rerequest_check_suite: (
    repo_full_name: string,
    check_suite_id: number,
    gh_token: string,
  ) => Promise<void>;
  /** Merge an approved PR. Only used by the v1 re-entry path (#355); v2 goes
   * through the merge-gate in webhook-handler instead. */
  attempt_merge: (
    pr_number: number,
    branch: string,
    repo_path: string,
    gh_token: string,
  ) => Promise<AutoMergeResult>;
}

export interface SpawnSessionOptions {
  entity_id: string;
  feature_id: string;
  archetype: ArchetypeRole;
  dna: string[];
  model: { model: "opus" | "sonnet" | "haiku"; think: "none" | "standard" | "high" };
  worktree_path: string;
  prompt: string;
  gh_token: string;
}

// ── Context wiring ──

export interface CheckSuiteContext {
  registry: EntityRegistry;
  config: LobsterFarmConfig;
  github_app: GitHubAppAuth;
  session_manager: ClaudeSessionManager;
  discord: DiscordBot | null;
}

// ── Dispatch outcome ──

/**
 * What the handler decided to do. Returned for testing and structured logging.
 * The handler still performs the side effect; this is just a description.
 */
export type CheckSuiteOutcome =
  | { kind: "noop"; reason: NoopReason }
  | { kind: "spawned_reviewer"; pr_number: number; head_sha: string; with_prior_feedback: boolean }
  | { kind: "spawned_ci_fixer"; pr_number: number; head_sha: string; attempt: number }
  | { kind: "rerequested"; check_suite_id: number; pr_number: number }
  | { kind: "ci_fix_exhausted"; pr_number: number; attempts: number }
  | { kind: "merged"; pr_number: number; head_sha: string; method?: AutoMergeResult["method"] }
  | { kind: "alerted"; pr_number: number; reason: string };

export type NoopReason =
  | "wrong_action"
  | "missing_check_suite"
  | "no_repository"
  | "unknown_repo"
  | "pr_fetch_failed"
  | "fork_pr"
  | "no_pull_requests"
  | "v1_not_approved"
  | "v1_sha_moved"
  | "draft_pr"
  | "duplicate_sha"
  | "unhandled_conclusion"
  | "non_default_base";

// ── Public entrypoint ──

/**
 * Handle a `check_suite.completed` webhook event.
 *
 * Returns a `CheckSuiteOutcome` describing the action taken. Side effects
 * (sessions, alerts, persistence writes) happen via the deps seam.
 */
export async function handle_check_suite(
  payload: CheckSuiteWebhookPayload,
  ctx: CheckSuiteContext,
  deps: CheckSuiteDeps,
): Promise<CheckSuiteOutcome> {
  // Only `completed` actions trigger dispatch — `requested`/`rerequested`
  // mean CI is starting, which we don't act on.
  if (payload.action !== "completed") {
    return { kind: "noop", reason: "wrong_action" };
  }

  const suite = payload.check_suite;
  if (!suite) {
    return { kind: "noop", reason: "missing_check_suite" };
  }

  const repo_full_name = payload.repository?.full_name;
  if (!repo_full_name) {
    return { kind: "noop", reason: "no_repository" };
  }

  // Map repo → entity
  const match = find_entity_for_repo(repo_full_name, ctx.registry);
  if (!match) {
    console.log(`[check-suite] No entity found for ${repo_full_name} — ignoring`);
    return { kind: "noop", reason: "unknown_repo" };
  }

  // v2 gating — entities still on v1 drive review from `pull_request.*` in
  // webhook-handler. They get one narrow behaviour here: merging a PR that was
  // approved while CI was still running (#355). Nothing else.
  if (match.entity.entity.pr_lifecycle !== "v2") {
    return await handle_v1_check_suite(suite, match.entity, match.repo_path, payload, ctx, deps);
  }

  // No associated PRs — this check_suite ran against `main` (push to main) or
  // a branch with no open PR. Nothing to dispatch on.
  if (suite.pull_requests.length === 0) {
    return { kind: "noop", reason: "no_pull_requests" };
  }

  // For now, dispatch only on the first associated PR. GitHub typically lists
  // exactly one PR for a feature branch's check suite.
  const pr_ref = suite.pull_requests[0]!;

  const installation_id =
    payload.installation?.id != null ? String(payload.installation.id) : undefined;

  let gh_token: string;
  try {
    gh_token = await deps.resolve_token(installation_id);
  } catch (err) {
    console.error(`[check-suite] Failed to resolve token: ${String(err)}`);
    sentry.captureException(err, {
      tags: { module: "check-suite", entity: match.entity.entity.id, action: "resolve_token" },
    });
    await deps.notify_alerts(
      match.entity.entity.id,
      `check_suite handler could not resolve GitHub token for PR #${String(pr_ref.number)}: ${error_message(err)}`,
    );
    return { kind: "alerted", pr_number: pr_ref.number, reason: "token_failed" };
  }

  // Fetch the full PR detail. The webhook's `pull_requests[]` is sparse and
  // doesn't include `body` / `draft` / `fork`.
  let pr: PRDetail;
  try {
    pr = await deps.fetch_pr_detail(pr_ref.number, match.repo_path, gh_token);
  } catch (err) {
    console.error(
      `[check-suite] Failed to fetch PR #${String(pr_ref.number)} detail: ${String(err)}`,
    );
    sentry.captureException(err, {
      tags: { module: "check-suite", entity: match.entity.entity.id, action: "fetch_pr" },
      contexts: { pr: { number: pr_ref.number } },
    });
    return { kind: "noop", reason: "pr_fetch_failed" };
  }

  // Decision 3: skip fork PRs entirely. Out of scope for v2.
  if (pr.is_fork) {
    return { kind: "noop", reason: "fork_pr" };
  }

  // Drafts are still in progress — we don't review them.
  if (pr.is_draft) {
    return { kind: "noop", reason: "draft_pr" };
  }

  // Only act on PRs targeting the default branch. Stacked PRs against feature
  // branches shouldn't trigger merge attempts.
  if (pr.base_ref !== "main" && pr.base_ref !== "master") {
    console.warn(
      `[check-suite] PR #${String(pr.number)} targets base "${pr.base_ref}" — skipping (only main/master supported). If this repo uses a different default branch, the v2 lifecycle will silently ignore all its PRs.`,
    );
    return { kind: "noop", reason: "non_default_base" };
  }

  // Dedup: if we already dispatched on this exact head SHA for this PR, ignore.
  // Multiple workflows on the same SHA fire multiple check_suite.completed
  // events; we only want to act once.
  //
  // NOTE: This handles sequential duplicates (second webhook arrives after the
  // first saves). Two truly concurrent webhooks — both calling load_pr_reviews
  // before either completes save_pr_reviews — will both read stale state and
  // both dispatch. The window is small (milliseconds) and the pre-existing v1
  // path had no dedup at all, so this is not a regression. File-level locking
  // would close the gap if it ever causes double-dispatch in practice.
  const state_key = pr_state_key(match.entity.entity.id, pr.number);
  const state = await deps.load_pr_reviews(ctx.config);
  const existing = state[state_key];
  if (existing?.v2_last_dispatched_sha === pr.head_sha) {
    return { kind: "noop", reason: "duplicate_sha" };
  }

  // Branch on conclusion
  switch (suite.conclusion) {
    case "success":
      return await dispatch_success(
        match.entity,
        match.repo_path,
        repo_full_name,
        pr,
        gh_token,
        ctx,
        deps,
        state,
      );

    case "failure":
      return await dispatch_failure(
        match.entity,
        match.repo_path,
        repo_full_name,
        pr,
        suite,
        gh_token,
        ctx,
        deps,
        state,
      );

    case "cancelled":
    case "timed_out":
    case "action_required": {
      const reason = suite.conclusion;
      // Do NOT stamp v2_last_dispatched_sha — the user may re-queue CI on the
      // same SHA and we want to dispatch on the fresh check_suite event.
      // We only persist the outcome field for tracking, not the dedup key.
      const updated = { ...state };
      updated[state_key] = {
        ...(existing ?? {
          entity_id: match.entity.entity.id,
          pr_number: pr.number,
          reviewed_at: new Date().toISOString(),
          outcome: "pending" as const,
        }),
        outcome: "pending" as const,
      };
      await deps.save_pr_reviews(updated, ctx.config);
      await deps.notify_alerts(
        match.entity.entity.id,
        `PR #${String(pr.number)}: "${pr.title}" — check_suite ${reason} on ${pr.head_sha.slice(0, 8)}. Manual triage needed.`,
      );
      return { kind: "alerted", pr_number: pr.number, reason };
    }

    case "neutral":
    case "stale":
    case "skipped":
    case null:
      // These are non-actionable. `neutral` and `skipped` mean a workflow
      // explicitly opted out; `stale` means a newer commit superseded this
      // run. None should drive review/merge.
      return { kind: "noop", reason: "unhandled_conclusion" };

    default:
      // Exhaustiveness — TypeScript will flag if we add a conclusion above.
      return { kind: "noop", reason: "unhandled_conclusion" };
  }
}

// ── v1 merge re-entry (#355) ──

/**
 * The only thing `check_suite.completed` does for a v1 entity: finish a merge
 * that was deliberately parked.
 *
 * A v1 reviewer that approves while CI is still running used to be merged
 * immediately — past red-to-be checks. webhook-handler now parks the PR
 * (`outcome: "approved"` + `v1_approved_sha`) and returns. CI completing fires
 * no `pull_request` event, so without this branch the PR would sit unmerged
 * with nothing to wake it.
 *
 * Deliberately narrow: this merges or it does nothing. No reviewers, no
 * ci-fixers, no flake reruns — v1 already has its own loops for those, driven
 * by `pull_request.synchronize`.
 *
 * This is the *fast* release path, not the only one. It fires once per SHA, and
 * on a fast CI run it fires while the reviewer is still reading — before the
 * park exists — so it finds nothing and no-ops, and no second event ever comes
 * (#372). `parked-approvals.ts` is the resolver that always finishes the job;
 * both stamp `v1_merge_attempted_sha` before merging, so whichever gets there
 * first excludes the other.
 */
async function handle_v1_check_suite(
  suite: CheckSuiteData,
  entity: EntityConfig,
  repo_path: string,
  payload: CheckSuiteWebhookPayload,
  ctx: CheckSuiteContext,
  deps: CheckSuiteDeps,
): Promise<CheckSuiteOutcome> {
  if (suite.pull_requests.length === 0) {
    return { kind: "noop", reason: "no_pull_requests" };
  }

  const pr_ref = suite.pull_requests[0]!;
  const entity_id = entity.entity.id;
  const state_key = pr_state_key(entity_id, pr_ref.number);

  // Local state first — no GitHub round-trips for the overwhelming majority of
  // v1 check_suite events, which belong to PRs nobody has approved yet.
  const state = await deps.load_pr_reviews(ctx.config);
  const existing = state[state_key];

  if (!existing || existing.outcome !== "approved" || existing.v1_approved_sha !== suite.head_sha) {
    return { kind: "noop", reason: "v1_not_approved" };
  }

  switch (suite.conclusion) {
    case "success":
      return await v1_merge_parked_pr(
        suite,
        entity_id,
        repo_path,
        payload,
        existing,
        state,
        ctx,
        deps,
      );

    case "failure":
    case "timed_out":
    case "cancelled":
      return await v1_alert_ci_failure(suite, entity_id, existing, state, ctx, deps);

    default:
      // neutral / stale / skipped / action_required / null. None of these mean
      // "CI is green", and none warrant an alert of their own — the PR stays
      // parked until a conclusive suite arrives.
      return { kind: "noop", reason: "unhandled_conclusion" };
  }
}

/** Merge a parked-approved v1 PR now that its CI is green. */
async function v1_merge_parked_pr(
  suite: CheckSuiteData,
  entity_id: string,
  repo_path: string,
  payload: CheckSuiteWebhookPayload,
  existing: ProcessedPR,
  state: PRReviewState,
  ctx: CheckSuiteContext,
  deps: CheckSuiteDeps,
): Promise<CheckSuiteOutcome> {
  const pr_number = suite.pull_requests[0]!.number;
  const state_key = pr_state_key(entity_id, pr_number);

  // One SHA fires one check_suite.completed per workflow — merge at most once.
  if (existing.v1_merge_attempted_sha === suite.head_sha) {
    return { kind: "noop", reason: "duplicate_sha" };
  }

  const installation_id =
    payload.installation?.id != null ? String(payload.installation.id) : undefined;

  let gh_token: string;
  try {
    gh_token = await deps.resolve_token(installation_id);
  } catch (err) {
    console.error(`[check-suite:v1] Failed to resolve token: ${String(err)}`);
    sentry.captureException(err, {
      tags: { module: "check-suite", entity: entity_id, action: "v1_resolve_token" },
      contexts: { pr: { number: pr_number } },
    });
    await deps.notify_alerts(
      entity_id,
      `PR #${String(pr_number)} is approved and its CI is green, but the GitHub token could not be resolved to merge it: ${error_message(err)}`,
    );
    return { kind: "alerted", pr_number, reason: "token_failed" };
  }

  let pr: PRDetail;
  try {
    pr = await deps.fetch_pr_detail(pr_number, repo_path, gh_token);
  } catch (err) {
    console.error(`[check-suite:v1] Failed to fetch PR #${String(pr_number)}: ${String(err)}`);
    sentry.captureException(err, {
      tags: { module: "check-suite", entity: entity_id, action: "v1_fetch_pr" },
      contexts: { pr: { number: pr_number } },
    });
    return { kind: "noop", reason: "pr_fetch_failed" };
  }

  if (pr.is_fork) return { kind: "noop", reason: "fork_pr" };
  if (pr.is_draft) return { kind: "noop", reason: "draft_pr" };
  if (pr.base_ref !== "main" && pr.base_ref !== "master") {
    return { kind: "noop", reason: "non_default_base" };
  }

  // The PR head moved after the approval was parked. Those commits went
  // through `pull_request.synchronize` and are being reviewed on their own —
  // merging here would land code nobody approved.
  if (pr.head_sha !== suite.head_sha) {
    console.log(
      `[check-suite:v1] PR #${String(pr_number)} head moved (${pr.head_sha.slice(0, 8)} != approved ${suite.head_sha.slice(0, 8)}) — leaving to the fresh review`,
    );
    return { kind: "noop", reason: "v1_sha_moved" };
  }

  // Stamp the dedup key BEFORE merging so a concurrent duplicate event — or a
  // merge that throws — can't drive a second attempt.
  const updated = { ...state };
  updated[state_key] = { ...existing, v1_merge_attempted_sha: suite.head_sha };
  await deps.save_pr_reviews(updated, ctx.config);

  let result: AutoMergeResult;
  try {
    result = await deps.attempt_merge(pr_number, pr.branch, repo_path, gh_token);
  } catch (err) {
    console.error(`[check-suite:v1] Merge threw for PR #${String(pr_number)}: ${String(err)}`);
    sentry.captureException(err, {
      tags: { module: "check-suite", entity: entity_id, action: "v1_merge" },
      contexts: { pr: { number: pr_number, title: pr.title, head_sha: pr.head_sha } },
    });
    await deps.notify_alerts(
      entity_id,
      `PR #${String(pr_number)}: "${pr.title}" — CI went green but the merge failed: ${error_message(err)}`,
    );
    return { kind: "alerted", pr_number, reason: "merge_failed" };
  }

  if (!result.merged) {
    const failure_tag = result.failure ? ` [${result.failure}]` : "";
    await deps.notify_alerts(
      entity_id,
      `PR #${String(pr_number)}: "${pr.title}" — CI went green but the merge failed${failure_tag}: ${result.error ?? "manual intervention needed."}`,
    );
    return { kind: "alerted", pr_number, reason: "merge_failed" };
  }

  console.log(
    `[check-suite:v1] Merged parked PR #${String(pr_number)} on ${suite.head_sha.slice(0, 8)} (${result.method ?? "direct"})`,
  );
  // Post-merge cleanup (closing linked issues, worktree removal, notifying the
  // watching bot) is driven by the `pull_request.closed` webhook this merge
  // fires — see handle_pr_merged in webhook-handler.ts.
  await deps.notify_alerts(
    entity_id,
    `PR #${String(pr_number)}: "${pr.title}" — CI completed green, approved PR merged (${result.method ?? "direct"}).`,
  );

  return { kind: "merged", pr_number, head_sha: suite.head_sha, method: result.method };
}

/**
 * A parked PR whose CI ended red. Do not merge; alert once so the parked state
 * is visible, then leave it to the existing v1 fix loop (which reacts to the
 * builder's next push, not to this event).
 */
async function v1_alert_ci_failure(
  suite: CheckSuiteData,
  entity_id: string,
  existing: ProcessedPR,
  state: PRReviewState,
  ctx: CheckSuiteContext,
  deps: CheckSuiteDeps,
): Promise<CheckSuiteOutcome> {
  const pr_number = suite.pull_requests[0]!.number;
  const state_key = pr_state_key(entity_id, pr_number);
  const conclusion = suite.conclusion ?? "failure";
  const alert_key = v1_ci_failure_key(conclusion, suite.head_sha);

  if (existing.ci_failure_alerted === alert_key) {
    return { kind: "noop", reason: "duplicate_sha" };
  }

  const updated = { ...state };
  updated[state_key] = { ...existing, ci_failure_alerted: alert_key };
  await deps.save_pr_reviews(updated, ctx.config);

  await deps.notify_alerts(
    entity_id,
    `PR #${String(pr_number)} was approved but CI ${conclusion} on ${suite.head_sha.slice(0, 8)} — not merging. The fix loop takes it from here.`,
  );

  return { kind: "alerted", pr_number, reason: conclusion };
}

/** Dedup key for the v1 parked-PR CI failure alert. Scoped to the SHA so a
 * re-parked PR that fails again on a new commit alerts again. */
function v1_ci_failure_key(conclusion: string, head_sha: string): string {
  return `v1_check_suite:${conclusion}:${head_sha}`;
}

// ── Success path: spawn reviewer ──

async function dispatch_success(
  entity: EntityConfig,
  repo_path: string,
  _repo_full_name: string,
  pr: PRDetail,
  gh_token: string,
  ctx: CheckSuiteContext,
  deps: CheckSuiteDeps,
  state: PRReviewState,
): Promise<CheckSuiteOutcome> {
  const entity_id = entity.entity.id;
  const state_key = pr_state_key(entity_id, pr.number);
  const existing = state[state_key];

  // Re-review memory (Decision 5): if we have prior changes_requested feedback,
  // pass it to the reviewer so it can verify the builder addressed the issues.
  const prior_feedback =
    existing?.v2_last_review_feedback && existing.v2_last_review_sha !== pr.head_sha
      ? {
          body: existing.v2_last_review_feedback,
          since_sha: existing.v2_last_review_sha ?? "",
        }
      : undefined;

  // Linked issue context
  let issue_context = "";
  const linked = extract_first_linked_issue(pr.body);
  if (linked) {
    try {
      issue_context = await deps.fetch_issue_context(repo_path, linked, gh_token);
    } catch (err) {
      console.warn(
        `[check-suite] Could not fetch linked issue context for #${String(linked)}: ${String(err)}`,
      );
    }
  }

  const prompt = build_v2_reviewer_prompt(pr, repo_path, issue_context, prior_feedback);

  // Persist BEFORE spawning so an immediate duplicate event sees the dedup.
  const updated = { ...state };
  updated[state_key] = stamp_dispatch(existing, entity_id, pr);
  await deps.save_pr_reviews(updated, ctx.config);

  try {
    await deps.spawn_session({
      entity_id,
      feature_id: `pr-review-${String(pr.number)}`,
      archetype: "reviewer",
      dna: ["review-dna"],
      model: { model: "sonnet", think: "standard" },
      worktree_path: repo_path,
      prompt,
      gh_token,
    });
  } catch (err) {
    console.error(
      `[check-suite] Failed to spawn reviewer for PR #${String(pr.number)}: ${String(err)}`,
    );
    sentry.captureException(err, {
      tags: { module: "check-suite", entity: entity_id, action: "spawn_reviewer" },
      contexts: { pr: { number: pr.number, title: pr.title, head_sha: pr.head_sha } },
    });
    await deps.notify_alerts(
      entity_id,
      `Failed to spawn reviewer for PR #${String(pr.number)}: ${error_message(err)}`,
    );
    return { kind: "alerted", pr_number: pr.number, reason: "spawn_failed" };
  }

  return {
    kind: "spawned_reviewer",
    pr_number: pr.number,
    head_sha: pr.head_sha,
    with_prior_feedback: prior_feedback !== undefined,
  };
}

// ── Failure path: ci-fixer or rerun ──

async function dispatch_failure(
  entity: EntityConfig,
  repo_path: string,
  repo_full_name: string,
  pr: PRDetail,
  suite: CheckSuiteData,
  gh_token: string,
  ctx: CheckSuiteContext,
  deps: CheckSuiteDeps,
  state: PRReviewState,
): Promise<CheckSuiteOutcome> {
  const entity_id = entity.entity.id;
  const state_key = pr_state_key(entity_id, pr.number);
  const existing = state[state_key];

  // Decision 4: auto-rerun once per SHA before escalating to the ci-fixer.
  // Track flake retries by SHA so a new push resets the counter.
  const flake_sha = existing?.v2_flake_retry_sha;
  const flake_attempts = flake_sha === pr.head_sha ? (existing?.v2_flake_retries ?? 0) : 0;

  if (flake_attempts < 1) {
    // First failure on this SHA — record flake retry WITHOUT touching
    // v2_last_dispatched_sha. The dedup key is only meaningful when we've
    // spawned a reviewer or ci-fixer; setting it here would permanently
    // block the follow-up failure from reaching the ci-fixer path (the
    // rerequested suite runs on the exact same SHA).
    const updated = { ...state };
    updated[state_key] = {
      ...(existing ?? {
        entity_id,
        pr_number: pr.number,
        reviewed_at: new Date().toISOString(),
        outcome: "pending" as const,
      }),
      v2_flake_retries: flake_attempts + 1,
      v2_flake_retry_sha: pr.head_sha,
    };
    await deps.save_pr_reviews(updated, ctx.config);

    try {
      await deps.rerequest_check_suite(repo_full_name, suite.id, gh_token);
      console.log(
        `[check-suite] Re-requested check_suite ${String(suite.id)} for PR #${String(pr.number)} (flake retry 1/1)`,
      );
      return { kind: "rerequested", check_suite_id: suite.id, pr_number: pr.number };
    } catch (err) {
      console.error(
        `[check-suite] Failed to re-request check_suite ${String(suite.id)}: ${String(err)}`,
      );
      sentry.captureException(err, {
        tags: { module: "check-suite", entity: entity_id, action: "rerequest" },
        contexts: { pr: { number: pr.number, title: pr.title, head_sha: pr.head_sha } },
      });
      // Fall through to the ci-fixer path below — better to spawn a fixer than
      // to do nothing.
    }
  }

  // Either rerun already happened (and failed again) OR rerun API failed.
  // Spawn the ci-fixer, subject to the existing retry budget.
  const ci_fix_attempts = existing?.ci_fix_attempts ?? 0;

  if (ci_fix_attempts >= MAX_CI_FIX_ATTEMPTS) {
    const updated = { ...state };
    updated[state_key] = stamp_dispatch(existing, entity_id, pr);
    await deps.save_pr_reviews(updated, ctx.config);

    await deps.notify_alerts(
      entity_id,
      `PR #${String(pr.number)}: "${pr.title}" — CI fix failed after ${String(MAX_CI_FIX_ATTEMPTS)} attempts. Needs human intervention.`,
    );
    return { kind: "ci_fix_exhausted", pr_number: pr.number, attempts: ci_fix_attempts };
  }

  // Fetch failure logs
  let failure_logs: Awaited<ReturnType<typeof fetch_ci_failure_logs>>;
  try {
    failure_logs = await deps.fetch_ci_failure_logs(pr.branch, repo_path, gh_token);
  } catch (err) {
    console.warn(`[check-suite] Could not fetch CI failure logs for ${pr.branch}: ${String(err)}`);
    failure_logs = [];
  }

  const failed_check_names = failure_logs.map((log) => log.check_name);

  const prompt = [
    `Repository: ${repo_path}`,
    "",
    build_ci_fix_prompt(pr.number, pr.title, pr.branch, failure_logs, failed_check_names),
  ].join("\n");

  // Persist BEFORE spawning to dedupe duplicate events
  const new_attempts = ci_fix_attempts + 1;
  const updated = { ...state };
  updated[state_key] = {
    ...stamp_dispatch(existing, entity_id, pr),
    ci_fix_attempts: new_attempts,
  };
  await deps.save_pr_reviews(updated, ctx.config);

  try {
    await deps.spawn_session({
      entity_id,
      feature_id: `ci-fix-${String(pr.number)}`,
      archetype: "builder",
      dna: ["coding-dna"],
      model: { model: "opus", think: "high" },
      worktree_path: repo_path,
      prompt,
      gh_token,
    });
  } catch (err) {
    console.error(
      `[check-suite] Failed to spawn ci-fixer for PR #${String(pr.number)}: ${String(err)}`,
    );
    sentry.captureException(err, {
      tags: { module: "check-suite", entity: entity_id, action: "spawn_ci_fixer" },
      contexts: { pr: { number: pr.number, title: pr.title, head_sha: pr.head_sha } },
    });
    await deps.notify_alerts(
      entity_id,
      `Failed to spawn CI fix builder for PR #${String(pr.number)}: ${error_message(err)}`,
    );
    return { kind: "alerted", pr_number: pr.number, reason: "spawn_failed" };
  }

  await deps.notify_alerts(
    entity_id,
    `PR #${String(pr.number)}: "${pr.title}" — CI failed (${failed_check_names.join(", ") || "unknown checks"}), spawning builder to fix (attempt ${String(new_attempts)}/${String(MAX_CI_FIX_ATTEMPTS)})`,
  );

  return {
    kind: "spawned_ci_fixer",
    pr_number: pr.number,
    head_sha: pr.head_sha,
    attempt: new_attempts,
  };
}

// ── Reviewer prompt builder (v2) ──

interface PriorReviewFeedback {
  body: string;
  since_sha: string;
}

/**
 * Build the v2 reviewer prompt (dynamic per-PR prefix).
 *
 * The reviewer agent's `initialPrompt` (see `config/claude/agents/reviewer.md`)
 * carries the static mechanics — identity, posting rules, verdict format,
 * echo / verify-landing safety. This function emits only the per-PR prefix:
 * header, optional prior-feedback block, optional linked-issue context, and
 * v2-specific procedural notes (CI already green, don't merge, run /review).
 *
 * Differences from the v1 prompt:
 *
 * - No "check CI status / request changes if pending" section. CI is already
 *   green by the time the v2 reviewer runs — that's the entire point of the
 *   check_suite-driven trigger. Asking the reviewer to second-guess CI was
 *   the source of the original race condition.
 * - Adds the "Previous review feedback" section when re-reviewing a PR that
 *   the reviewer previously requested changes on (Decision 5). The reviewer
 *   verifies the builder actually addressed the prior comments instead of
 *   doing a blind re-read.
 */
export function build_v2_reviewer_prompt(
  pr: PRDetail,
  repo_path: string,
  issue_context: string,
  prior_feedback?: PriorReviewFeedback,
): string {
  const lines = [
    `Review PR #${String(pr.number)}: "${pr.title}" on branch ${pr.branch}.`,
    `Repository: ${repo_path}`,
    `Head SHA: ${pr.head_sha}`,
    "",
    "Run /ultrareview to do a comprehensive code review.",
    "",
    "CI status: GREEN. CI has already completed successfully against this exact",
    "head SHA. Do NOT run `gh pr checks` or attempt to gate on CI yourself —",
    "the check_suite-driven lifecycle has already verified it.",
    "",
    "Do NOT run `gh pr merge`. The merge-gate handles merging after approval —",
    `your job is the review, not the merge. Post using PR #${String(pr.number)}`,
    "with the commands from your initial instructions.",
  ];

  if (prior_feedback) {
    lines.push(
      "",
      "## Previous Review Feedback (addressed by builder)",
      "",
      `Your previous review at SHA ${prior_feedback.since_sha.slice(0, 8)} requested changes:`,
      "",
      "````",
      prior_feedback.body.trim(),
      "````",
      "",
      "Verify each item above was actually addressed in the new commits. If any",
      "feedback was missed or only partially addressed, request changes again.",
      "If all prior feedback is resolved AND the rest of the diff is clean,",
      "approve.",
    );
  }

  if (issue_context) {
    lines.push("", "## Linked Issue Context", "", issue_context);
  }

  return lines.join("\n");
}

// ── State helpers ──

export function pr_state_key(entity_id: string, pr_number: number): string {
  return `${entity_id}:${String(pr_number)}`;
}

/**
 * Persist that we dispatched on this SHA. Preserves prior fields (review
 * feedback, retry counts) so we don't lose context across events.
 */
function stamp_dispatch(
  existing: ProcessedPR | undefined,
  entity_id: string,
  pr: PRDetail,
): ProcessedPR {
  return {
    ...(existing ?? {
      entity_id,
      pr_number: pr.number,
      reviewed_at: new Date().toISOString(),
      outcome: "pending" as const,
    }),
    v2_last_dispatched_sha: pr.head_sha,
  };
}

/**
 * Record that a reviewer requested changes — captures the feedback body so
 * the next dispatch can pass it back to the reviewer (Decision 5).
 *
 * Called from the post-review handler in webhook-handler.ts after a v2
 * reviewer completes with `changes_requested`.
 */
export async function record_v2_review_feedback(
  entity_id: string,
  pr_number: number,
  head_sha: string,
  feedback_body: string,
  config: LobsterFarmConfig,
): Promise<void> {
  const state = await load_pr_reviews(config);
  const key = pr_state_key(entity_id, pr_number);
  const existing = state[key];
  state[key] = {
    ...(existing ?? {
      entity_id,
      pr_number,
      reviewed_at: new Date().toISOString(),
      outcome: "changes_requested" as const,
    }),
    outcome: "changes_requested",
    v2_last_review_feedback: feedback_body,
    v2_last_review_sha: head_sha,
  };
  await save_pr_reviews(state, config);
}

function error_message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Default deps factory ──

/**
 * Build the production CheckSuiteDeps. Wires the real session manager,
 * Discord bot, GitHub App, and persistence layer.
 */
export function make_default_deps(ctx: CheckSuiteContext): CheckSuiteDeps {
  return {
    resolve_token: (installation_id) =>
      installation_id
        ? ctx.github_app.get_token_for_installation(installation_id)
        : ctx.github_app.get_token(),

    fetch_pr_detail: default_fetch_pr_detail,
    fetch_ci_failure_logs,
    fetch_issue_context,
    load_pr_reviews,
    save_pr_reviews,

    spawn_session: async (options) => {
      const session = await ctx.session_manager.spawn({
        entity_id: options.entity_id,
        feature_id: options.feature_id,
        archetype: options.archetype,
        dna: options.dna,
        model: options.model,
        worktree_path: options.worktree_path,
        prompt: options.prompt,
        interactive: false,
        env: { GH_TOKEN: options.gh_token },
      });
      return { session_id: session.session_id };
    },

    notify_alerts: async (entity_id, message) => {
      console.log(`[check-suite:alerts] ${message}`);
      if (ctx.discord) {
        await ctx.discord.send_to_entity(entity_id, "alerts", message, "reviewer" as ArchetypeRole);
      }
    },

    rerequest_check_suite: default_rerequest_check_suite,

    attempt_merge: (pr_number, branch, repo_path, gh_token) =>
      attempt_auto_merge(pr_number, branch, repo_path, undefined, gh_token),
  };
}

async function default_fetch_pr_detail(
  pr_number: number,
  repo_path: string,
  gh_token: string,
): Promise<PRDetail> {
  const env = { ...process.env, GH_TOKEN: gh_token };
  const { stdout } = await exec_async(
    "gh",
    [
      "pr",
      "view",
      String(pr_number),
      "--json",
      "number,title,headRefName,headRefOid,baseRefName,body,isDraft,isCrossRepository",
    ],
    { cwd: repo_path, env, timeout: 15_000 },
  );
  const data = JSON.parse(stdout) as {
    number: number;
    title: string;
    headRefName: string;
    headRefOid: string;
    baseRefName: string;
    body: string | null;
    isDraft: boolean;
    isCrossRepository: boolean;
  };

  return {
    number: data.number,
    title: data.title,
    branch: data.headRefName,
    base_ref: data.baseRefName,
    head_sha: data.headRefOid,
    body: data.body ?? "",
    is_draft: data.isDraft,
    is_fork: data.isCrossRepository,
  };
}

async function default_rerequest_check_suite(
  repo_full_name: string,
  check_suite_id: number,
  gh_token: string,
): Promise<void> {
  const env = { ...process.env, GH_TOKEN: gh_token };
  await exec_async(
    "gh",
    [
      "api",
      "--method",
      "POST",
      `repos/${repo_full_name}/check-suites/${String(check_suite_id)}/rerequest`,
    ],
    { env, timeout: 15_000 },
  );
}
