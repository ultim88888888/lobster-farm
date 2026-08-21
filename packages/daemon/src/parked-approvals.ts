/**
 * Resolver for parked v1 approvals (#372).
 *
 * A v1 reviewer that approves while CI is still running does not merge. The
 * webhook handler parks the approval (`outcome: "approved"` + `v1_approved_sha`)
 * and `check_suite.completed` merges it once CI goes green — see
 * `handle_v1_check_suite` in check-suite-handler.ts.
 *
 * That handoff has a race it cannot win on its own. CI usually finishes while
 * the reviewer is still reading the diff, so `check_suite.completed` arrives
 * *before* the park exists, finds no approval to release, and no-ops. No second
 * event ever fires for that SHA, `pr_cron.enabled` is false, and the PR sits
 * open forever behind a single routine alert. That is exactly what happened to
 * PR #371: CI green at 19:36:12, approval parked at 19:39:19, merged by hand
 * three hours later.
 *
 * This module is the resolver that closes the loop. Every tick it reads the
 * parked approvals out of `state/pr-reviews.json`, asks GitHub what actually
 * happened, and drives each park to a terminal state:
 *
 *   CI green            → merge (the merge the check_suite event never got to do)
 *   CI red              → alert, drop the park; the code needs a new commit
 *   PR closed or merged → drop the park silently
 *   head SHA moved      → drop the park; those commits get their own review
 *   still pending       → wait, until PARK_STALE_AFTER_MS, then escalate loudly
 *
 * Three properties matter:
 *
 *  1. **Restart-safe.** The park lives in `state/pr-reviews.json` (atomic
 *     temp+rename via `save_pr_reviews`), not in a timer. A daemon restart
 *     loses nothing; the next tick picks the park back up.
 *  2. **Never merges past pending CI.** The only merge path re-reads
 *     `check_ci_status` and requires `passed && !pending`. This resolver can
 *     make a stuck PR move; it cannot make an unsafe one merge.
 *  3. **Fails loud.** A park that cannot be resolved escalates to #alerts as
 *     `action_required`. Nothing here expires quietly — silence was the bug.
 *
 * It is not a revival of pr-cron. pr-cron polled GitHub for open PRs to review;
 * this reads local state and touches GitHub only when a park exists, which is
 * approximately never.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import type { AlertPayload, AlertResult } from "./alert-router.js";
import { ALERT_COLOR_AMBER } from "./alert-router.js";
import type { GitHubAppAuth } from "./github-app.js";
import type { PRReviewState, ProcessedPR } from "./persistence.js";
import { load_pr_reviews, save_pr_reviews } from "./persistence.js";
import type { AutoMergeResult, CICheckStatus } from "./review-utils.js";
import { attempt_auto_merge, check_ci_status } from "./review-utils.js";
import * as sentry from "./sentry.js";

const exec_async = promisify(execFile);

// ── Tuning ──

/** How often the resolver runs. CI on these repos finishes in ~60s. */
export const PARK_SWEEP_INTERVAL_MS = 2 * 60 * 1000;

/**
 * How long a park may sit unresolved before a human is told.
 *
 * Generous enough to cover a slow or queued workflow, short enough that a PR
 * cannot quietly rot for an afternoon. Reaching it does not abandon the park —
 * the resolver keeps trying — it just stops being silent about it.
 */
export const PARK_STALE_AFTER_MS = 30 * 60 * 1000;

// ── Types ──

/** What `gh pr view` tells us about a parked PR. */
export interface ParkedPRSnapshot {
  /** GitHub's PR state: OPEN / MERGED / CLOSED. */
  state: string;
  head_sha: string;
  branch: string;
  title: string;
}

/**
 * What the resolver decided for one park. Returned for tests and structured
 * logging; the side effects already happened via the deps seam.
 */
export type ParkedApprovalOutcome =
  | { kind: "merged"; entity_id: string; pr_number: number }
  | {
      kind: "cleared";
      entity_id: string;
      pr_number: number;
      reason: "pr_gone" | "sha_moved" | "ci_failed" | "unresolvable";
    }
  | { kind: "waiting"; entity_id: string; pr_number: number }
  | {
      kind: "escalated";
      entity_id: string;
      pr_number: number;
      reason: "stale" | "ci_failed" | "merge_failed" | "unresolvable";
    };

export interface ParkedApprovalDeps {
  load_pr_reviews: () => Promise<PRReviewState>;
  save_pr_reviews: (state: PRReviewState) => Promise<void>;
  resolve_token: (installation_id: string | undefined) => Promise<string>;
  fetch_pr_snapshot: (
    pr_number: number,
    repo_path: string,
    gh_token: string,
  ) => Promise<ParkedPRSnapshot>;
  check_ci_status: (
    pr_number: number,
    repo_path: string,
    gh_token: string,
  ) => Promise<CICheckStatus>;
  attempt_merge: (
    pr_number: number,
    branch: string,
    repo_path: string,
    gh_token: string,
  ) => Promise<AutoMergeResult>;
  post_alert: (payload: AlertPayload) => Promise<AlertResult>;
  /** Injectable clock so staleness tests don't sleep. */
  now: () => number;
}

// ── Entry point ──

/**
 * Resolve every parked v1 approval once.
 *
 * Reads state once, walks the parks sequentially (there are almost never more
 * than one or two), and writes state back after each decision so a crash
 * mid-sweep cannot lose a merge stamp.
 */
export async function sweep_parked_approvals(
  deps: ParkedApprovalDeps,
): Promise<ParkedApprovalOutcome[]> {
  const state = await deps.load_pr_reviews();
  const parked = Object.entries(state).filter(([, entry]) => is_parked(entry));

  const outcomes: ParkedApprovalOutcome[] = [];
  for (const [key, entry] of parked) {
    try {
      outcomes.push(await resolve_one(key, entry, deps));
    } catch (err) {
      // A single unresolvable park must never stop the others.
      console.error(
        `[parked-approvals] Sweep failed for ${key}: ${err instanceof Error ? err.message : String(err)}`,
      );
      sentry.captureException(err, {
        tags: { module: "parked-approvals", entity: entry.entity_id, action: "resolve" },
        contexts: { pr: { number: entry.pr_number } },
      });
      outcomes.push({
        kind: "waiting",
        entity_id: entry.entity_id,
        pr_number: entry.pr_number,
      });
    }
  }

  return outcomes;
}

/**
 * A park is an approval pinned to a SHA that no merge has been attempted for.
 *
 * `v1_merge_attempted_sha` is the shared terminator: whichever path acts first
 * — this resolver or `check_suite.completed` — stamps it before merging, so the
 * two can never both merge the same commit.
 */
function is_parked(entry: ProcessedPR): boolean {
  return (
    entry.outcome === "approved" &&
    entry.v1_approved_sha !== undefined &&
    entry.v1_merge_attempted_sha !== entry.v1_approved_sha
  );
}

// ── Per-park resolution ──

async function resolve_one(
  key: string,
  entry: ProcessedPR,
  deps: ParkedApprovalDeps,
): Promise<ParkedApprovalOutcome> {
  const { entity_id, pr_number } = entry;
  const approved_sha = entry.v1_approved_sha!;

  // Parks written before #372 carry no repo path, and the state key
  // (entity_id:pr_number) does not identify one for a multi-repo entity. Guess
  // and we could merge the wrong PR — so say so out loud and drop it.
  if (!entry.v1_repo_path) {
    await escalate(
      key,
      entry,
      deps,
      `PR #${String(pr_number)} has a parked approval with no repo recorded (parked by an older daemon). It cannot be resolved automatically — merge or close it by hand.`,
    );
    await clear_park(key, entry, deps);
    return { kind: "escalated", entity_id, pr_number, reason: "unresolvable" };
  }

  const repo_path = entry.v1_repo_path;
  const gh_token = await deps.resolve_token(entry.v1_installation_id);
  const snapshot = await deps.fetch_pr_snapshot(pr_number, repo_path, gh_token);

  // Already merged (by us, by a human, by the check_suite path) or closed.
  if (snapshot.state !== "OPEN") {
    console.log(
      `[parked-approvals] PR #${String(pr_number)} is ${snapshot.state} — dropping the park`,
    );
    await clear_park(key, entry, deps);
    return { kind: "cleared", entity_id, pr_number, reason: "pr_gone" };
  }

  // New commits landed after the approval. They went through
  // `pull_request.synchronize` and are being reviewed on their own; merging
  // this park would land code nobody approved.
  if (snapshot.head_sha !== approved_sha) {
    console.log(
      `[parked-approvals] PR #${String(pr_number)} head moved (${snapshot.head_sha.slice(0, 8)} != approved ${approved_sha.slice(0, 8)}) — dropping the park`,
    );
    await clear_park(key, entry, deps);
    return { kind: "cleared", entity_id, pr_number, reason: "sha_moved" };
  }

  const ci = await deps.check_ci_status(pr_number, repo_path, gh_token);

  if (ci.failures.length > 0) {
    await escalate(
      key,
      entry,
      deps,
      `PR #${String(pr_number)}: "${snapshot.title}" was approved, but CI failed on ${approved_sha.slice(0, 8)} (${ci.failures.join(", ")}). Not merging — the branch needs a new commit.`,
    );
    await clear_park(key, entry, deps);
    return { kind: "escalated", entity_id, pr_number, reason: "ci_failed" };
  }

  if (ci.pending) {
    const parked_at = Date.parse(entry.v1_parked_at ?? "");
    if (Number.isNaN(parked_at)) {
      // No usable park timestamp — stamp one now so the clock can start.
      await patch_entry(key, entry, deps, { v1_parked_at: new Date(deps.now()).toISOString() });
      return { kind: "waiting", entity_id, pr_number };
    }

    const waited_ms = deps.now() - parked_at;
    if (waited_ms >= PARK_STALE_AFTER_MS && entry.v1_park_escalated_sha !== approved_sha) {
      await escalate(
        key,
        entry,
        deps,
        `PR #${String(pr_number)}: "${snapshot.title}" has been approved and waiting on CI for ${String(Math.round(waited_ms / 60_000))} minutes. Checks on ${approved_sha.slice(0, 8)} still report pending. The merge is still parked and still being retried, but CI may never report — worth a look.`,
      );
      return { kind: "escalated", entity_id, pr_number, reason: "stale" };
    }

    return { kind: "waiting", entity_id, pr_number };
  }

  // passed && !pending — this is the merge the check_suite event never made.
  return await merge_park(key, entry, snapshot, deps);
}

/**
 * Merge a park whose CI is green.
 *
 * Stamps `v1_merge_attempted_sha` before calling gh, so a crash or a concurrent
 * `check_suite.completed` cannot produce a second attempt on the same commit.
 */
async function merge_park(
  key: string,
  entry: ProcessedPR,
  snapshot: ParkedPRSnapshot,
  deps: ParkedApprovalDeps,
): Promise<ParkedApprovalOutcome> {
  const { entity_id, pr_number } = entry;
  const approved_sha = entry.v1_approved_sha!;
  const repo_path = entry.v1_repo_path!;

  await patch_entry(key, entry, deps, { v1_merge_attempted_sha: approved_sha });

  const gh_token = await deps.resolve_token(entry.v1_installation_id);
  const result = await deps.attempt_merge(pr_number, snapshot.branch, repo_path, gh_token);

  if (!result.merged) {
    const failure_tag = result.failure ? ` [${result.failure}]` : "";
    await deps.post_alert({
      entity_id,
      tier: "action_required",
      title: `⚠️ Parked merge failed — PR #${String(pr_number)}`,
      body: `${snapshot.title} — CI is green and the PR was approved, but the merge failed${failure_tag}. ${result.error ?? "Manual intervention needed."}`,
      embed_color: ALERT_COLOR_AMBER,
    });
    return { kind: "escalated", entity_id, pr_number, reason: "merge_failed" };
  }

  console.log(
    `[parked-approvals] Merged parked PR #${String(pr_number)} on ${approved_sha.slice(0, 8)} (${result.method ?? "direct"})`,
  );
  // Post-merge cleanup (linked issues, worktrees, PR watchers) rides the
  // `pull_request.closed` webhook this merge fires — see handle_pr_merged.
  await deps.post_alert({
    entity_id,
    tier: "routine",
    title: `PR #${String(pr_number)} merged`,
    body: `${snapshot.title} — CI completed green, parked approval merged (${result.method ?? "direct"}).`,
  });

  return { kind: "merged", entity_id, pr_number };
}

// ── State helpers ──

/**
 * Post an escalation and record the SHA it was posted for, so a park that
 * stays stuck produces one alert rather than one every tick.
 */
async function escalate(
  key: string,
  entry: ProcessedPR,
  deps: ParkedApprovalDeps,
  body: string,
): Promise<void> {
  await patch_entry(key, entry, deps, { v1_park_escalated_sha: entry.v1_approved_sha });
  await deps.post_alert({
    entity_id: entry.entity_id,
    tier: "action_required",
    title: `⚠️ Parked approval needs attention — PR #${String(entry.pr_number)}`,
    body,
    embed_color: ALERT_COLOR_AMBER,
  });
}

/** Drop the park's pins, leaving the review record itself intact. */
async function clear_park(
  key: string,
  entry: ProcessedPR,
  deps: ParkedApprovalDeps,
): Promise<void> {
  const state = await deps.load_pr_reviews();
  const current = state[key] ?? entry;
  const {
    v1_approved_sha: _sha,
    v1_parked_at: _at,
    v1_repo_path: _repo,
    v1_installation_id: _install,
    v1_park_escalated_sha: _escalated,
    ...rest
  } = current;
  state[key] = rest;
  await deps.save_pr_reviews(state);
}

/** Merge a patch into one entry, re-reading state so we don't clobber writers. */
async function patch_entry(
  key: string,
  entry: ProcessedPR,
  deps: ParkedApprovalDeps,
  patch: Partial<ProcessedPR>,
): Promise<void> {
  const state = await deps.load_pr_reviews();
  state[key] = { ...(state[key] ?? entry), ...patch };
  await deps.save_pr_reviews(state);
}

// ── Production wiring ──

/** Subset of `gh pr view` the resolver needs. */
async function default_fetch_pr_snapshot(
  pr_number: number,
  repo_path: string,
  gh_token: string,
): Promise<ParkedPRSnapshot> {
  const env = { ...process.env, GH_TOKEN: gh_token };
  const { stdout } = await exec_async(
    "gh",
    ["pr", "view", String(pr_number), "--json", "state,headRefOid,headRefName,title"],
    { cwd: repo_path, env, timeout: 15_000 },
  );
  const data = JSON.parse(stdout) as {
    state: string;
    headRefOid: string;
    headRefName: string;
    title: string;
  };

  return {
    state: data.state,
    head_sha: data.headRefOid,
    branch: data.headRefName,
    title: data.title,
  };
}

/** Wire the resolver to the real persistence, gh CLI and alert router. */
export function make_parked_approval_deps(options: {
  config: LobsterFarmConfig;
  github_app: GitHubAppAuth;
  post_alert: (payload: AlertPayload) => Promise<AlertResult>;
}): ParkedApprovalDeps {
  const { config, github_app, post_alert } = options;

  return {
    load_pr_reviews: () => load_pr_reviews(config),
    save_pr_reviews: (state) => save_pr_reviews(state, config),
    resolve_token: (installation_id) =>
      installation_id
        ? github_app.get_token_for_installation(installation_id)
        : github_app.get_token(),
    fetch_pr_snapshot: default_fetch_pr_snapshot,
    check_ci_status: (pr_number, repo_path, gh_token) =>
      check_ci_status(pr_number, repo_path, gh_token),
    attempt_merge: (pr_number, branch, repo_path, gh_token) =>
      attempt_auto_merge(pr_number, branch, repo_path, undefined, gh_token),
    post_alert,
    now: () => Date.now(),
  };
}
