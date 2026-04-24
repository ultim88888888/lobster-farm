/**
 * GitHub webhook handler.
 *
 * Receives PR events via POST /webhooks/github, verifies the signature,
 * maps the repo to an entity, and spawns headless reviewer sessions.
 *
 * Deduplication: only one reviewer runs per entity:pr# at a time. If a
 * `synchronize` event arrives mid-review, the PR is queued for re-review
 * once the current reviewer finishes.
 */

import { execFile } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { promisify } from "node:util";
import type { ArchetypeRole } from "@lobster-farm/shared";
import { expand_home } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { type ReviewOutcome, detect_review_outcome } from "./actions.js";
import { ALERT_COLOR_AMBER, ALERT_COLOR_RED, type AlertRouter } from "./alert-router.js";
import {
  type CheckSuiteWebhookPayload,
  handle_check_suite,
  make_default_deps as make_check_suite_deps,
  record_v2_review_feedback,
} from "./check-suite-handler.js";
import type { DiscordBot } from "./discord.js";
import type { GitHubAppAuth } from "./github-app.js";
import {
  close_linked_issues,
  extract_first_linked_issue,
  extract_linked_issues,
  fetch_issue_context,
  nwo_from_url,
} from "./issue-utils.js";
import { run_merge_gate } from "./merge-gate.js";
import {
  load_deploy_triage,
  load_pr_reviews,
  save_deploy_triage,
  save_pr_reviews,
} from "./persistence.js";
import type { DeployTriageEntry } from "./persistence.js";
import type { BotPool } from "./pool.js";
import type { PRWatchStore } from "./pr-watches.js";
import type { EntityRegistry } from "./registry.js";
import { find_entity_for_repo as find_entity_for_repo_full } from "./repo-utils.js";
import {
  MAX_CI_FIX_ATTEMPTS,
  MAX_DEPLOY_FIX_ATTEMPTS,
  attempt_auto_merge,
  build_ci_fix_prompt,
  build_deploy_triage_prompt,
  build_review_fix_prompt,
  check_ci_status,
  fetch_ci_failure_logs,
  fetch_pr_mergeability,
  fetch_review_comments,
} from "./review-utils.js";
import * as sentry from "./sentry.js";
import type { ClaudeSessionManager, SessionResult } from "./session.js";
import { cleanup_after_merge } from "./worktree-cleanup.js";

const exec = promisify(execFile);

// ── Types ──

export interface WebhookContext {
  github_app: GitHubAppAuth;
  session_manager: ClaudeSessionManager;
  registry: EntityRegistry;
  discord: DiscordBot | null;
  config: LobsterFarmConfig;
  pool: BotPool | null;
  pr_watches: PRWatchStore | null;
  alert_router: AlertRouter | null;
}

/** Minimal PR shape from webhook payload. */
export interface WebhookPR {
  number: number;
  title: string;
  head: { ref: string; sha: string };
  body: string | null;
  user: { login: string };
  merged?: boolean;
  draft?: boolean;
}

/** Minimal workflow_run shape from webhook payload. */
interface WebhookWorkflowRun {
  id: number;
  name: string;
  conclusion: string | null;
  event: string;
  head_branch: string;
  head_sha: string;
  html_url: string;
}

interface WebhookPayload {
  action: string;
  pull_request?: WebhookPR;
  workflow_run?: WebhookWorkflowRun;
  repository?: { full_name: string };
  /** GitHub includes the installation that generated the webhook event. */
  installation?: { id: number };
}

/**
 * State of a webhook review, keyed by {entity, pr, head_sha}.
 *
 * Lifecycle:
 * - `in_flight`: a reviewer session is currently running for this SHA
 * - `completed`: a review for this SHA finished within the dedup hold window
 *
 * While `in_flight`, any webhook event for the same SHA is dropped (it's
 * already being reviewed). After completion, we hold the entry for a short
 * TTL (REVIEW_DEDUP_HOLD_MS) so back-to-back events for the same SHA don't
 * re-trigger review. When HEAD actually moves the new SHA gets its own key.
 *
 * `needs_requeue` marks an in-flight review that should be re-run after it
 * finishes — set when a NEW head_sha arrived mid-review.
 */
interface ActiveWebhookReview {
  entity_id: string;
  pr_number: number;
  head_sha: string;
  state: "in_flight" | "completed";
  /** When set, the stored `requeue_*` fields describe the review to run next. */
  needs_requeue: boolean;
  requeue_head_sha?: string;
  requeue_pr?: WebhookPR;
  created_at: number;
  /** Set when state transitions to `completed`. Used by the TTL sweep. */
  completed_at?: number;
}

// ── Helpers ──

function json_response(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function read_body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/**
 * Map a GitHub repo full_name (e.g. "my-org/my-repo") to an entity.
 * Thin wrapper over the shared `find_entity_for_repo` that returns the
 * flattened `{ entity_id, repo_path }` shape used throughout this module.
 */
function find_entity_for_repo(
  full_name: string,
  registry: EntityRegistry,
): { entity_id: string; repo_path: string } | null {
  const match = find_entity_for_repo_full(full_name, registry);
  if (!match) return null;
  return { entity_id: match.entity.entity.id, repo_path: match.repo_path };
}

/**
 * Look up the pr_lifecycle flag ("v1" | "v2") for an entity.
 *
 * Uses `get_active()` rather than `get()` because many tests stub the
 * registry with just `get_active` — keeping the single accessor avoids
 * a test surface regression. Returns "v1" (the safe default) when the
 * entity is missing or doesn't have the flag.
 */
function get_pr_lifecycle(registry: EntityRegistry, entity_id: string): "v1" | "v2" {
  for (const entity of registry.get_active()) {
    if (entity.entity.id === entity_id) {
      return entity.entity.pr_lifecycle ?? "v1";
    }
  }
  return "v1";
}

/**
 * Resolve a GitHub App token for the given installation ID.
 * Falls back to the default installation when no ID is provided.
 */
function resolve_token(
  github_app: GitHubAppAuth,
  installation_id: string | undefined,
): Promise<string> {
  return installation_id
    ? github_app.get_token_for_installation(installation_id)
    : github_app.get_token();
}

// ── Pre-spawn review dedup ──

/**
 * Check whether a non-dismissed review from a bot account already exists on
 * a PR. Used as a pre-spawn guard to avoid duplicate reviews after daemon
 * restarts or re-delivered webhooks.
 *
 * Returns true if a bot review with state APPROVED or CHANGES_REQUESTED exists.
 */
async function has_existing_bot_review(
  repo_full_name: string,
  pr_number: number,
  repo_path: string,
  gh_token: string,
): Promise<boolean> {
  try {
    const env = { ...process.env, GH_TOKEN: gh_token };
    const { stdout } = await exec(
      "gh",
      [
        "api",
        `repos/${repo_full_name}/pulls/${String(pr_number)}/reviews`,
        "--jq",
        '[.[] | select((.state == "APPROVED" or .state == "CHANGES_REQUESTED") and (.user.login | endswith("[bot]")))] | length',
      ],
      { cwd: repo_path, timeout: 15_000, env },
    );
    return Number.parseInt(stdout.trim(), 10) > 0;
  } catch (err) {
    // On error, allow the review to proceed — better to risk a duplicate
    // than to silently skip a needed review.
    console.warn(
      `[webhook] Failed to check existing reviews for PR #${String(pr_number)}: ${String(err)}`,
    );
    return false;
  }
}

// ── Active review tracking ──
//
// Dedup key is {entity, pr_number, head_sha} — NOT just {entity, pr}. Two
// webhook events (e.g. `opened` + `synchronize`) for the same HEAD SHA must
// coalesce into a single review. HEAD SHA movement is the only thing that
// should trigger a fresh review. See #258 for the race this fixes.

const active_reviews = new Map<string, ActiveWebhookReview>();

function review_key(entity_id: string, pr_number: number, head_sha: string): string {
  return `${entity_id}:${String(pr_number)}:${head_sha}`;
}

/** Key prefix used to find any entry for a given PR regardless of SHA. */
function review_key_prefix(entity_id: string, pr_number: number): string {
  return `${entity_id}:${String(pr_number)}:`;
}

/** Persistent PR state key — SHA-independent. Tracks retry counts across commits. */
function ci_retry_key(entity_id: string, pr_number: number): string {
  return `${entity_id}:${String(pr_number)}`;
}

/**
 * Find the in-flight/completed review (if any) for a given PR, regardless of SHA.
 *
 * When multiple entries exist (e.g. a completed SHA-A and an in-flight SHA-B
 * coexisting during the TTL hold window), always prefer the in_flight entry.
 * Returning a completed entry when an in_flight one also exists would bypass
 * the dedup gate and allow a duplicate reviewer to spawn. See #258.
 */
function find_review_for_pr(
  entity_id: string,
  pr_number: number,
): { key: string; review: ActiveWebhookReview } | null {
  const prefix = review_key_prefix(entity_id, pr_number);
  let completed_entry: { key: string; review: ActiveWebhookReview } | null = null;
  for (const [key, review] of active_reviews) {
    if (key.startsWith(prefix)) {
      if (review.state === "in_flight") return { key, review };
      completed_entry ??= { key, review };
    }
  }
  return completed_entry;
}

const REVIEW_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * How long we keep a completed review in the dedup table. Any webhook for
 * the same head_sha arriving during this window is dropped.
 * 60s is long enough to catch clustered `opened`+`synchronize` bursts and
 * webhook retries, without holding stale state indefinitely.
 */
const REVIEW_DEDUP_HOLD_MS = 60_000;

function cleanup_stale_reviews(): void {
  const now = Date.now();
  for (const [key, review] of active_reviews) {
    // In-flight reviews age out on the session timeout.
    if (review.state === "in_flight" && now - review.created_at > REVIEW_TIMEOUT_MS) {
      console.log(`[webhook] Cleaning up stale in-flight review entry: ${key}`);
      active_reviews.delete(key);
      continue;
    }
    // Completed reviews age out on the dedup hold window.
    if (
      review.state === "completed" &&
      review.completed_at != null &&
      now - review.completed_at > REVIEW_DEDUP_HOLD_MS
    ) {
      active_reviews.delete(key);
    }
  }
}

// ── Main handler ──

/**
 * Handle incoming GitHub webhook events.
 * Must return 200 quickly — reviewer spawning is async.
 */
export async function handle_github_webhook(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: WebhookContext,
): Promise<void> {
  // 1. Read raw body for signature verification
  const raw_body = await read_body(req);

  // 2. Verify signature
  const signature = req.headers["x-hub-signature-256"] as string | undefined;
  if (!signature) {
    json_response(res, 401, { error: "Missing X-Hub-Signature-256 header" });
    return;
  }

  if (!ctx.github_app.verify_signature(raw_body, signature)) {
    console.log("[webhook] Invalid signature — rejecting request");
    json_response(res, 401, { error: "Invalid signature" });
    return;
  }

  // 3. Parse event type and payload
  const event_type = req.headers["x-github-event"] as string | undefined;
  if (!event_type) {
    json_response(res, 400, { error: "Missing X-GitHub-Event header" });
    return;
  }

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(raw_body) as WebhookPayload;
  } catch {
    json_response(res, 400, { error: "Invalid JSON payload" });
    return;
  }

  // 4. Return 200 immediately — all processing happens async
  json_response(res, 200, { ok: true });

  // 5. Route event
  void route_event(event_type, payload, ctx).catch((err) => {
    console.error(`[webhook] Error handling ${event_type}.${payload.action}: ${String(err)}`);
    sentry.captureException(err, {
      tags: { module: "webhook", webhook_source: "github" },
      contexts: { event: { type: event_type, action: payload.action } },
    });
  });
}

// ── Event routing ──

async function route_event(
  event_type: string,
  payload: WebhookPayload,
  ctx: WebhookContext,
): Promise<void> {
  cleanup_stale_reviews();

  // Handle workflow_run events — deploy failure notifications (#189)
  if (event_type === "workflow_run") {
    await handle_workflow_run(payload, ctx);
    return;
  }

  // Handle check_suite events — v2 PR lifecycle (#257).
  // Entities opted into pr_lifecycle=v2 dispatch their entire PR review /
  // merge / fix loop from check_suite.completed instead of pull_request.opened.
  // The handler itself gates on the feature flag — entities on v1 no-op.
  if (event_type === "check_suite") {
    const cs_payload = payload as unknown as CheckSuiteWebhookPayload;
    const cs_ctx = {
      registry: ctx.registry,
      config: ctx.config,
      github_app: ctx.github_app,
      session_manager: ctx.session_manager,
      discord: ctx.discord,
    };
    const outcome = await handle_check_suite(cs_payload, cs_ctx, make_check_suite_deps(cs_ctx));
    console.log(`[webhook] check_suite outcome: ${JSON.stringify(outcome)}`);
    return;
  }

  if (event_type !== "pull_request") {
    console.log(`[webhook] Ignoring event: ${event_type}`);
    return;
  }

  const action = payload.action;
  const pr = payload.pull_request;
  const repo_full_name = payload.repository?.full_name;

  if (!pr || !repo_full_name) {
    console.log("[webhook] pull_request event missing PR or repo data");
    return;
  }

  // Extract installation ID from the webhook payload so we authenticate
  // against the correct GitHub account (multi-installation support).
  const installation_id =
    payload.installation?.id != null ? String(payload.installation.id) : undefined;

  // Map repo to entity
  const match = find_entity_for_repo(repo_full_name, ctx.registry);
  if (!match) {
    console.log(`[webhook] No entity found for repo ${repo_full_name} — ignoring`);
    return;
  }

  // Handle merged PRs — close linked issues and notify watching bots
  if (action === "closed" && pr.merged === true) {
    console.log(
      `[webhook] pull_request.closed (merged) for #${String(pr.number)} ` +
        `in ${match.entity_id} (${repo_full_name})`,
    );
    await handle_pr_merged(pr, repo_full_name, match.repo_path, ctx, installation_id);
    await notify_pr_watcher(
      repo_full_name,
      pr.number,
      `PR #${String(pr.number)} ("${pr.title}") has been merged to main. Continue your work.`,
      ctx,
    );
    return;
  }

  // Handle closed-without-merge — notify watching bots
  if (action === "closed" && pr.merged !== true) {
    console.log(
      `[webhook] pull_request.closed (not merged) for #${String(pr.number)} ` +
        `in ${match.entity_id} (${repo_full_name})`,
    );
    await notify_pr_watcher(
      repo_full_name,
      pr.number,
      `PR #${String(pr.number)} ("${pr.title}") was closed without merging.`,
      ctx,
    );
    return;
  }

  // Only handle PR events that warrant a review
  const reviewable_actions = ["opened", "synchronize", "reopened", "ready_for_review"];
  if (!reviewable_actions.includes(action)) {
    console.log(`[webhook] Ignoring pull_request.${action} for #${String(pr.number)}`);
    return;
  }

  // v2 entities drive review from check_suite.completed — pull_request.opened
  // is a no-op because CI hasn't started yet. Skipping avoids the original
  // race condition where the reviewer ran against a PR with no CI reported.
  if (get_pr_lifecycle(ctx.registry, match.entity_id) === "v2") {
    console.log(
      `[webhook] Skipping pull_request.${action} for #${String(pr.number)} — entity ${match.entity_id} is on pr_lifecycle=v2 (check_suite will drive review)`,
    );
    return;
  }

  // Skip draft PRs — they're still being worked on
  if (pr.draft) {
    console.log(`[webhook] Skipping draft PR #${String(pr.number)}`);
    return;
  }

  console.log(
    `[webhook] pull_request.${action} for #${String(pr.number)} ` +
      `in ${match.entity_id} (${repo_full_name})`,
  );

  sentry.addBreadcrumb({
    category: "daemon.api",
    message: `Webhook: pull_request.${action} PR #${String(pr.number)}`,
    data: { entity: match.entity_id, pr_number: pr.number, action },
  });

  // Deduplicate keyed on {entity, pr, head_sha}. See ActiveWebhookReview.
  const head_sha = pr.head.sha;
  if (!head_sha) {
    console.log(
      `[webhook] pull_request.${action} for #${String(pr.number)} missing head.sha — skipping dedup`,
    );
  }
  const sha_key = review_key(match.entity_id, pr.number, head_sha ?? "unknown");
  const sha_entry = active_reviews.get(sha_key);

  if (sha_entry) {
    // Same SHA, already reviewed (or being reviewed) — drop as redundant.
    // This coalesces opened+synchronize bursts and webhook retries (#258).
    console.log(
      `[webhook] Dropping duplicate ${action} for #${String(pr.number)} @ ${head_sha?.slice(0, 7) ?? "unknown"} ` +
        `(state=${sha_entry.state})`,
    );
    return;
  }

  // Different SHA than the in-flight/completed entry (if any) — new HEAD, new review.
  const pr_entry = find_review_for_pr(match.entity_id, pr.number);
  if (pr_entry && pr_entry.review.state === "in_flight") {
    // An earlier SHA is currently being reviewed. Queue a requeue with the
    // new SHA; the old review's completion handler will spawn it.
    console.log(
      `[webhook] In-flight review for #${String(pr.number)} @ ${pr_entry.review.head_sha.slice(0, 7)} ` +
        `— requeueing as ${head_sha?.slice(0, 7) ?? "unknown"}`,
    );
    pr_entry.review.needs_requeue = true;
    pr_entry.review.requeue_head_sha = head_sha;
    pr_entry.review.requeue_pr = pr;
    return;
  }

  // Pre-spawn dedup: for non-synchronize events (opened, reopened, ready_for_review),
  // check whether a non-dismissed bot review already exists on the PR. This catches
  // duplicate reviews after daemon restarts or re-delivered webhooks. Synchronize
  // events (new commits pushed) always get a fresh review.
  if (action !== "synchronize") {
    try {
      const gh_token = await resolve_token(ctx.github_app, installation_id);
      const already_reviewed = await has_existing_bot_review(
        repo_full_name,
        pr.number,
        match.repo_path,
        gh_token,
      );
      if (already_reviewed) {
        console.log(
          `[webhook] Non-dismissed bot review already exists on PR #${String(pr.number)} — skipping spawn`,
        );
        return;
      }
    } catch (err) {
      // Token resolution failed — proceed with spawn rather than silently skipping
      console.warn(`[webhook] Pre-spawn dedup check failed: ${String(err)}`);
    }
  }

  // No in-flight review for this SHA — spawn fresh.
  await spawn_review(match.entity_id, match.repo_path, repo_full_name, pr, ctx, installation_id);
}

// ── Reviewer spawning ──

async function spawn_review(
  entity_id: string,
  repo_path: string,
  repo_full_name: string,
  pr: WebhookPR,
  ctx: WebhookContext,
  installation_id?: string,
): Promise<void> {
  const head_sha = pr.head.sha || "unknown";
  const key = review_key(entity_id, pr.number, head_sha);

  // Track active review
  active_reviews.set(key, {
    entity_id,
    pr_number: pr.number,
    head_sha,
    state: "in_flight",
    needs_requeue: false,
    created_at: Date.now(),
  });

  // Get installation token for the reviewer subprocess
  let gh_token: string;
  try {
    gh_token = await resolve_token(ctx.github_app, installation_id);
  } catch (err) {
    console.error(`[webhook] Failed to get installation token: ${String(err)}`);
    sentry.captureException(err, {
      tags: { module: "webhook", entity: entity_id },
      contexts: { pr: { number: pr.number, title: pr.title } },
    });
    active_reviews.delete(key);
    return;
  }

  // Fetch linked issue context if available (for #109)
  let issue_context = "";
  const linked_issue = extract_first_linked_issue(pr.body);
  if (linked_issue) {
    issue_context = await fetch_issue_context(repo_path, linked_issue, gh_token);
  }

  // Build reviewer prompt
  const prompt = build_reviewer_prompt(pr, repo_path, repo_full_name, issue_context);

  console.log(`[webhook] Spawning reviewer for PR #${String(pr.number)} in ${entity_id}`);

  try {
    const session = await ctx.session_manager.spawn({
      entity_id,
      feature_id: `pr-review-${String(pr.number)}`,
      archetype: "reviewer",
      dna: ["review-dna"],
      model: { model: "sonnet", think: "standard" },
      worktree_path: repo_path,
      prompt,
      interactive: false,
      env: { GH_TOKEN: gh_token },
    });

    console.log(
      `[webhook] Reviewer session ${session.session_id.slice(0, 8)} ` +
        `started for PR #${String(pr.number)}`,
    );

    // Listen for session completion
    const on_complete = (result: SessionResult) => {
      if (result.session_id !== session.session_id) return;
      ctx.session_manager.removeListener("session:completed", on_complete);
      ctx.session_manager.removeListener("session:failed", on_fail);

      void handle_review_completion(entity_id, repo_path, repo_full_name, pr, ctx, installation_id)
        .catch((err) => {
          console.error(`[webhook] Post-review error: ${String(err)}`);
          sentry.captureException(err, {
            tags: { module: "webhook", entity: entity_id },
            contexts: { pr: { number: pr.number, title: pr.title } },
          });
        })
        .finally(() => {
          cleanup_and_maybe_requeue(
            key,
            entity_id,
            repo_path,
            repo_full_name,
            pr,
            ctx,
            installation_id,
          );
        });
    };

    const on_fail = (session_id: string, error: string) => {
      if (session_id !== session.session_id) return;
      ctx.session_manager.removeListener("session:completed", on_complete);
      ctx.session_manager.removeListener("session:failed", on_fail);

      console.error(`[webhook] Review session failed for PR #${String(pr.number)}: ${error}`);
      sentry.captureException(new Error(error), {
        tags: { module: "webhook", entity: entity_id },
        contexts: { pr: { number: pr.number, title: pr.title } },
      });
      cleanup_and_maybe_requeue(
        key,
        entity_id,
        repo_path,
        repo_full_name,
        pr,
        ctx,
        installation_id,
      );
    };

    ctx.session_manager.on("session:completed", on_complete);
    ctx.session_manager.on("session:failed", on_fail);
  } catch (err) {
    console.error(
      `[webhook] Failed to spawn reviewer for PR #${String(pr.number)}: ${String(err)}`,
    );
    sentry.captureException(err, {
      tags: { module: "webhook", entity: entity_id, action: "spawn_reviewer" },
      contexts: { pr: { number: pr.number, title: pr.title } },
    });
    active_reviews.delete(key);
  }
}

// ── Post-review handling ──

async function handle_review_completion(
  entity_id: string,
  repo_path: string,
  repo_full_name: string,
  pr: WebhookPR,
  ctx: WebhookContext,
  installation_id?: string,
): Promise<void> {
  // Resolve a token so detect_review_outcome and check_pr_merged can
  // authenticate against the correct GitHub account (cross-account repos).
  let gh_token: string | undefined;
  try {
    gh_token = await resolve_token(ctx.github_app, installation_id);
  } catch (err) {
    console.error(`[webhook] Failed to get token for post-review: ${String(err)}`);
    sentry.captureException(err, {
      tags: { module: "webhook", entity: entity_id, action: "post_review_token" },
      contexts: { pr: { number: pr.number, title: pr.title } },
    });
    // Fall through — detect_review_outcome will use daemon's default auth
  }

  const outcome = await detect_review_outcome(pr.number, repo_path, gh_token);

  console.log(`[webhook] Review completed for PR #${String(pr.number)} — outcome: ${outcome}`);

  // v2 entities use the event-driven lifecycle (#257):
  //   - changes_requested → record feedback, spawn builder; the builder's push
  //     fires a fresh check_suite cycle which drives the next review pass.
  //   - approved → run the merge-gate (re-verifies CI + mergeability on the
  //     exact reviewed SHA, then merges via gh pr merge --squash).
  // We deliberately bypass the v1 CI-check + rebase + retry logic below.
  if (get_pr_lifecycle(ctx.registry, entity_id) === "v2") {
    await handle_v2_review_completion(
      entity_id,
      repo_path,
      repo_full_name,
      pr,
      outcome,
      gh_token,
      ctx,
      installation_id,
    );
    return;
  }

  // Route outcome
  if (outcome === "changes_requested") {
    // Spawn builder to fix
    await spawn_fixer(entity_id, repo_path, pr, ctx, installation_id);
    await ctx.alert_router?.post_alert({
      entity_id,
      tier: "routine",
      title: `PR #${String(pr.number)} changes requested`,
      body: `${pr.title} — spawning builder to fix`,
    });
    // Informational: let the watching bot know review feedback arrived.
    // Not terminal — the fix loop will push new commits, triggering re-review.
    // The watch stays alive so the bot gets the final merged/closed event.
    await notify_pr_watcher(
      repo_full_name,
      pr.number,
      `PR #${String(pr.number)} ("${pr.title}") received review feedback: changes requested. The fix loop is handling it.`,
      ctx,
      false,
    );
  } else if (outcome === "approved") {
    // Check if reviewer already merged
    const is_merged = await check_pr_merged(repo_path, pr.number, gh_token);

    if (!is_merged) {
      // Check CI status before attempting merge (#189)
      const ci = await check_ci_status(pr.number, repo_path, gh_token);

      if (ci.pending) {
        const pr_cron_enabled = ctx.config.pr_cron?.enabled !== false;

        if (pr_cron_enabled) {
          console.log(
            `[webhook] CI checks pending for PR #${String(pr.number)} — skipping merge, pr-cron retry pass will handle`,
          );
        } else {
          // pr-cron is disabled — no retry will happen. Attempt the merge now even
          // though CI is still running: without a cron, approved PRs would otherwise
          // be stuck indefinitely. The alert makes this bypass explicit.
          console.log(
            `[webhook] CI checks pending for PR #${String(pr.number)} but pr-cron is disabled — attempting merge`,
          );

          const result = await attempt_auto_merge(
            pr.number,
            pr.head.ref,
            repo_path,
            undefined,
            gh_token,
          );

          if (result.merged) {
            await post_auto_merge_cleanup(pr, entity_id, repo_path, ctx, installation_id);
            await ctx.alert_router?.post_alert({
              entity_id,
              tier: "routine",
              title: `PR #${String(pr.number)} merged`,
              body: `${pr.title} — approved and merged (CI pending bypassed)`,
            });
            await notify_pr_watcher(
              repo_full_name,
              pr.number,
              `PR #${String(pr.number)} ("${pr.title}") was approved and merged to main. Continue your work.`,
              ctx,
            );
          } else {
            const failure_tag = result.failure ? ` [${result.failure}]` : "";
            await ctx.alert_router?.post_alert({
              entity_id,
              tier: "action_required",
              title: `\u26a0\ufe0f Merge failed — PR #${String(pr.number)}`,
              body: `${pr.title} — CI pending, pr-cron disabled. Merge failed${failure_tag}: ${result.error ?? "manual intervention needed."}`,
              embed_color: ALERT_COLOR_AMBER,
            });
          }
        }
      } else if (ci.failures.length > 0) {
        // Spawn builder to fix CI failures (#196)
        await spawn_ci_fixer(entity_id, repo_path, pr, ci.failures, ctx, installation_id);
      } else {
        // All checks passed (or none configured) — proceed with merge
        const result = await attempt_auto_merge(
          pr.number,
          pr.head.ref,
          repo_path,
          undefined,
          gh_token,
        );

        if (result.merged) {
          // Post-merge cleanup: close linked issues and clean up worktrees
          await post_auto_merge_cleanup(pr, entity_id, repo_path, ctx, installation_id);
          await ctx.alert_router?.post_alert({
            entity_id,
            tier: "routine",
            title: `PR #${String(pr.number)} merged`,
            body: `${pr.title} — approved, auto-rebased (${result.method}), and merged`,
          });
          // Auto-merged — notify watching bot
          await notify_pr_watcher(
            repo_full_name,
            pr.number,
            `PR #${String(pr.number)} ("${pr.title}") was approved and merged to main. Continue your work.`,
            ctx,
          );
        } else {
          const failure_tag = result.failure ? ` [${result.failure}]` : "";
          await ctx.alert_router?.post_alert({
            entity_id,
            tier: "action_required",
            title: `\u26a0\ufe0f Merge failed — PR #${String(pr.number)}`,
            body: `${pr.title} — approved but merge failed${failure_tag}. ${result.error ?? "Manual intervention needed."}`,
            embed_color: ALERT_COLOR_AMBER,
          });
        }
      }
    } else {
      await ctx.alert_router?.post_alert({
        entity_id,
        tier: "routine",
        title: `PR #${String(pr.number)} merged`,
        body: `${pr.title} — approved and merged`,
      });
      // Reviewer already merged — notify watching bot
      await notify_pr_watcher(
        repo_full_name,
        pr.number,
        `PR #${String(pr.number)} ("${pr.title}") was approved and merged to main. Continue your work.`,
        ctx,
      );
    }
  } else if (outcome === "dismissed") {
    // All reviews were dismissed (e.g., duplicate cleanup gone wrong).
    // Don't spawn a new review inline — cleanup_and_maybe_requeue runs in
    // .finally() after this function resolves and would delete the new
    // review's active_reviews entry, leaving it untracked. Instead, let
    // the next pr-cron cycle pick it up (same strategy as pr-cron.ts).
    console.log(
      `[webhook] All reviews dismissed on PR #${String(pr.number)} — will be re-reviewed next cycle`,
    );
    await ctx.alert_router?.post_alert({
      entity_id,
      tier: "routine",
      title: `PR #${String(pr.number)} reviews dismissed`,
      body: `"${pr.title}" — all reviews dismissed, will re-review next cycle`,
    });
  } else {
    await ctx.alert_router?.post_alert({
      entity_id,
      tier: "routine",
      title: `PR #${String(pr.number)} review completed`,
      body: `"${pr.title}" (${outcome})`,
    });
  }
}

/**
 * v2 post-review dispatch (#257).
 *
 * Called from handle_review_completion when the entity is on pr_lifecycle=v2.
 * - changes_requested: capture the review body so the next reviewer pass can
 *   verify the builder addressed it (Decision 5). Then spawn the builder fix
 *   session; the push that follows fires a fresh check_suite that drives the
 *   next review cycle automatically.
 * - approved: run the merge-gate. It re-verifies CI + mergeability on the
 *   exact reviewed SHA and either merges or returns a tagged outcome we
 *   dispatch on. We do NOT fall through to the v1 rebase/retry loop.
 * - anything else: just alert; a new event will eventually drive the next step.
 */
export async function handle_v2_review_completion(
  entity_id: string,
  repo_path: string,
  repo_full_name: string,
  pr: WebhookPR,
  outcome: ReviewOutcome,
  gh_token: string | undefined,
  ctx: WebhookContext,
  installation_id?: string,
): Promise<void> {
  if (outcome === "changes_requested") {
    // Fetch current head SHA + the review body so the next pass can echo
    // feedback back at the reviewer.
    let head_sha = "";
    try {
      const mergeability = await fetch_pr_mergeability(pr.number, repo_path, gh_token);
      head_sha = mergeability.head_sha;
    } catch (err) {
      console.warn(
        `[webhook:v2] Could not fetch head SHA for PR #${String(pr.number)}: ${String(err)}`,
      );
    }

    let feedback_body = "";
    try {
      feedback_body = await fetch_review_comments(pr.number, repo_path);
    } catch (err) {
      console.warn(
        `[webhook:v2] Could not fetch review body for PR #${String(pr.number)}: ${String(err)}`,
      );
    }

    if (head_sha && feedback_body) {
      try {
        await record_v2_review_feedback(entity_id, pr.number, head_sha, feedback_body, ctx.config);
      } catch (err) {
        console.error(
          `[webhook:v2] Failed to record review feedback for PR #${String(pr.number)}: ${String(err)}`,
        );
        sentry.captureException(err, {
          tags: { module: "webhook", entity: entity_id, action: "record_v2_feedback" },
          contexts: { pr: { number: pr.number } },
        });
      }
    }

    await spawn_fixer(entity_id, repo_path, pr, ctx, installation_id);
    await ctx.alert_router?.post_alert({
      entity_id,
      tier: "routine",
      title: `PR #${String(pr.number)} changes requested`,
      body: `${pr.title} — spawning builder to fix`,
    });
    await notify_pr_watcher(
      repo_full_name,
      pr.number,
      `PR #${String(pr.number)} ("${pr.title}") received review feedback: changes requested. The fix loop is handling it.`,
      ctx,
      false,
    );
    return;
  }

  if (outcome === "approved") {
    if (!gh_token) {
      await ctx.alert_router?.post_alert({
        entity_id,
        tier: "action_required",
        title: `\u26a0\ufe0f No GH token — PR #${String(pr.number)}`,
        body: `${pr.title} — approved but no GH token available for merge-gate. Manual intervention needed.`,
        embed_color: ALERT_COLOR_AMBER,
      });
      return;
    }

    // Use the SHA from the webhook payload — this is the SHA the reviewer
    // actually reviewed. Fetching fresh from the API would miss drift if a
    // commit lands between review and this handler running.
    const approved_sha = pr.head.sha;

    const gate_outcome = await run_merge_gate({
      pr_number: pr.number,
      branch: pr.head.ref,
      approved_sha,
      repo_path,
      gh_token,
    });

    console.log(
      `[webhook:v2] merge-gate outcome for PR #${String(pr.number)}: ${JSON.stringify(gate_outcome)}`,
    );

    switch (gate_outcome.kind) {
      case "merged":
        await post_auto_merge_cleanup(pr, entity_id, repo_path, ctx, installation_id);
        await ctx.alert_router?.post_alert({
          entity_id,
          tier: "routine",
          title: `PR #${String(pr.number)} merged`,
          body: `${pr.title} — approved, merge-gate passed, merged (${gate_outcome.method})`,
        });
        await notify_pr_watcher(
          repo_full_name,
          pr.number,
          `PR #${String(pr.number)} ("${pr.title}") was approved and merged to main. Continue your work.`,
          ctx,
        );
        return;

      case "ci_regressed":
        await ctx.alert_router?.post_alert({
          entity_id,
          tier: "action_required",
          title: `\u26a0\ufe0f CI regressed — PR #${String(pr.number)}`,
          body: `${pr.title} — CI regressed on gate check (${gate_outcome.failures.join(", ")}). A new commit is required to re-enter the review cycle.`,
          embed_color: ALERT_COLOR_AMBER,
        });
        return;

      case "ci_pending":
        console.log(
          `[webhook:v2] merge-gate: CI pending for PR #${String(pr.number)} — dedup blocks re-dispatch on same SHA`,
        );
        await ctx.alert_router?.post_alert({
          entity_id,
          tier: "routine",
          title: `PR #${String(pr.number)} CI pending`,
          body: `${pr.title} — approved but CI still running on reviewed SHA. Auto-merge blocked until new commit.`,
        });
        return;

      case "sha_changed":
        // A new commit landed between review and merge attempt. The next
        // check_suite.completed event will drive a fresh review pass.
        console.log(
          `[webhook:v2] merge-gate: SHA changed for PR #${String(pr.number)} — ` +
            `observed ${gate_outcome.observed_sha}`,
        );
        return;

      case "rebased_awaiting_ci":
        // Branch was behind, rebase succeeded, force-push done. The fresh
        // check_suite on the rebased SHA will drive the next review pass.
        console.log(
          `[webhook:v2] merge-gate: rebased PR #${String(pr.number)} — awaiting fresh check_suite`,
        );
        return;

      case "rebase_conflict":
        await ctx.alert_router?.post_alert({
          entity_id,
          tier: "action_required",
          title: `\u26a0\ufe0f Rebase conflict — PR #${String(pr.number)}`,
          body: `${pr.title} — rebase conflict, manual resolution required. ${gate_outcome.error}`,
          embed_color: ALERT_COLOR_AMBER,
        });
        return;

      case "branch_protected":
        await ctx.alert_router?.post_alert({
          entity_id,
          tier: "action_required",
          title: `\u{1f6d1} Branch protected — PR #${String(pr.number)}`,
          body: `${pr.title} — blocked by branch protection (${gate_outcome.merge_state_status}). Human eyes required.`,
          embed_color: ALERT_COLOR_RED,
        });
        return;

      case "mergeable_unknown":
        console.log(
          `[webhook:v2] merge-gate: mergeability unknown for PR #${String(pr.number)} — waiting`,
        );
        return;

      case "merge_failed":
        await ctx.alert_router?.post_alert({
          entity_id,
          tier: "action_required",
          title: `\u26a0\ufe0f Merge failed — PR #${String(pr.number)}`,
          body: `${pr.title} — merge-gate failed: ${gate_outcome.error}`,
          embed_color: ALERT_COLOR_AMBER,
        });
        return;
    }
  }

  if (outcome === "dismissed") {
    // All reviews were dismissed (e.g., duplicate cleanup). Don't spawn a new
    // review inline — let the next check_suite cycle pick it up.
    console.log(
      `[webhook:v2] All reviews dismissed on PR #${String(pr.number)} — will be re-reviewed next cycle`,
    );
    await ctx.alert_router?.post_alert({
      entity_id,
      tier: "routine",
      title: `PR #${String(pr.number)} reviews dismissed`,
      body: `"${pr.title}" — all reviews dismissed, will re-review next cycle`,
    });
    return;
  }

  // outcome === "pending"
  await ctx.alert_router?.post_alert({
    entity_id,
    tier: "routine",
    title: `PR #${String(pr.number)} review completed`,
    body: `"${pr.title}" (${outcome})`,
  });
}

/**
 * Transition the in-flight review to `completed` with a TTL hold (for dedup),
 * then spawn a requeued review if a new HEAD SHA arrived mid-review.
 *
 * The completed entry stays in the map until the TTL sweep removes it — this
 * is what blocks back-to-back webhook events for the same SHA from spawning
 * duplicate reviews. See REVIEW_DEDUP_HOLD_MS and #258.
 */
function cleanup_and_maybe_requeue(
  key: string,
  entity_id: string,
  repo_path: string,
  repo_full_name: string,
  pr: WebhookPR,
  ctx: WebhookContext,
  installation_id?: string,
): void {
  const review = active_reviews.get(key);
  if (review) {
    // Mark completed and start the TTL hold window.
    review.state = "completed";
    review.completed_at = Date.now();
  }

  if (review?.needs_requeue) {
    // A new HEAD SHA arrived while this review was in-flight. Spawn a fresh
    // review for the new SHA — not the old one. Use the stored requeue_pr
    // if available so we pass the new head ref/sha through correctly.
    const next_pr = review.requeue_pr ?? pr;
    console.log(
      `[webhook] Re-reviewing PR #${String(next_pr.number)} — new commits arrived during previous review ` +
        `(${review.head_sha.slice(0, 7)} → ${(review.requeue_head_sha ?? next_pr.head.sha).slice(0, 7)})`,
    );
    void spawn_review(entity_id, repo_path, repo_full_name, next_pr, ctx, installation_id).catch(
      (err) => {
        console.error(`[webhook] Requeue failed for PR #${String(next_pr.number)}: ${String(err)}`);
        sentry.captureException(err, {
          tags: { module: "webhook", entity: entity_id, action: "requeue" },
          contexts: { pr: { number: next_pr.number, title: next_pr.title } },
        });
      },
    );
  }
}

// ── Builder spawning for failed reviews ──

async function spawn_fixer(
  entity_id: string,
  repo_path: string,
  pr: WebhookPR,
  ctx: WebhookContext,
  installation_id?: string,
): Promise<void> {
  const review_comments = await fetch_review_comments(pr.number, repo_path);

  const prompt = [
    "An external PR needs fixes based on reviewer feedback.",
    `PR #${String(pr.number)}: "${pr.title}" on branch ${pr.head.ref}`,
    `Repository: ${repo_path}`,
    "",
    `First, check out the PR branch: git checkout ${pr.head.ref}`,
    "",
    build_review_fix_prompt(pr.number, pr.title, review_comments),
    "",
    "Do NOT merge the PR.",
  ].join("\n");

  console.log(`[webhook] Spawning builder to fix PR #${String(pr.number)} in ${entity_id}`);

  try {
    // Get fresh token for builder too
    const gh_token = await resolve_token(ctx.github_app, installation_id);

    await ctx.session_manager.spawn({
      entity_id,
      feature_id: `webhook-pr-fix-${String(pr.number)}`,
      archetype: "builder",
      dna: ["coding-dna"],
      model: { model: "opus", think: "high" },
      worktree_path: repo_path,
      prompt,
      interactive: false,
      env: { GH_TOKEN: gh_token },
    });
  } catch (err) {
    console.error(`[webhook] Failed to spawn builder for PR #${String(pr.number)}: ${String(err)}`);
    sentry.captureException(err, {
      tags: { module: "webhook", entity: entity_id, action: "spawn_fixer" },
      contexts: { pr: { number: pr.number, title: pr.title } },
    });
  }
}

// ── Builder spawning for CI failures (#196) ──

/**
 * Spawn a builder session to fix CI failures on an approved PR.
 *
 * Checks the retry cap (max 3 attempts) before spawning. If the cap is
 * reached, alerts #alerts and stops.
 *
 * Note: does NOT check active_reviews for dedup here. This function is
 * called from handle_review_completion, which runs while the reviewer's
 * active_reviews entry is still present (cleaned up in .finally()).
 * Dedup for overlapping webhook events is handled at the route_event level.
 * The pr-cron path has its own active_reviews instance with separate dedup.
 *
 * The builder gets CI failure logs as context so it can diagnose and fix
 * lint errors, type errors, test failures, etc.
 */
async function spawn_ci_fixer(
  entity_id: string,
  repo_path: string,
  pr: WebhookPR,
  failed_checks: string[],
  ctx: WebhookContext,
  installation_id?: string,
): Promise<void> {
  const key = ci_retry_key(entity_id, pr.number);

  // Check retry cap
  const pr_state = await load_pr_reviews(ctx.config);
  const entry = pr_state[key];
  const attempts = entry?.ci_fix_attempts ?? 0;

  if (attempts >= MAX_CI_FIX_ATTEMPTS) {
    await ctx.alert_router?.post_alert({
      entity_id,
      tier: "action_required",
      title: `\u{1f6d1} CI fix exhausted — PR #${String(pr.number)}`,
      body: `${pr.title} — failed after ${String(MAX_CI_FIX_ATTEMPTS)} attempts. Needs human intervention. Failed: ${failed_checks.join(", ")}`,
    });
    return;
  }

  // Resolve token BEFORE incrementing attempt counter — transient token
  // errors (cert issues, rate limits) shouldn't consume retry slots.
  let gh_token: string;
  try {
    gh_token = await resolve_token(ctx.github_app, installation_id);
  } catch (err) {
    console.error(`[webhook] Failed to get token for CI fix: ${String(err)}`);
    sentry.captureException(err, {
      tags: { module: "webhook", entity: entity_id, action: "ci_fix_token" },
      contexts: { pr: { number: pr.number, title: pr.title } },
    });
    return;
  }

  // Increment attempt counter and set ci_failure_alerted so pr-cron's
  // retry_approved_unmerged doesn't double-spawn for the same failure set.
  const failure_key = JSON.stringify([...failed_checks].sort());
  pr_state[key] = {
    ...(entry ?? {
      entity_id,
      pr_number: pr.number,
      reviewed_at: new Date().toISOString(),
      outcome: "approved" as const,
    }),
    ci_fix_attempts: attempts + 1,
    ci_failure_alerted: failure_key,
  };
  await save_pr_reviews(pr_state, ctx.config);

  // Fetch CI failure logs for context
  const failure_logs = await fetch_ci_failure_logs(pr.head.ref, repo_path, gh_token);

  const prompt = [
    `Repository: ${repo_path}`,
    "",
    build_ci_fix_prompt(pr.number, pr.title, pr.head.ref, failure_logs, failed_checks),
  ].join("\n");

  console.log(
    `[webhook] Spawning CI fix builder for PR #${String(pr.number)} in ${entity_id} (attempt ${String(attempts + 1)}/${String(MAX_CI_FIX_ATTEMPTS)})`,
  );

  await ctx.alert_router?.post_alert({
    entity_id,
    tier: "routine",
    title: `PR #${String(pr.number)} CI fix spawned`,
    body: `${pr.title} — CI failed (${failed_checks.join(", ")}), spawning builder (attempt ${String(attempts + 1)}/${String(MAX_CI_FIX_ATTEMPTS)})`,
  });

  try {
    await ctx.session_manager.spawn({
      entity_id,
      feature_id: `ci-fix-${String(pr.number)}`,
      archetype: "builder",
      dna: ["coding-dna"],
      model: { model: "opus", think: "high" },
      worktree_path: repo_path,
      prompt,
      interactive: false,
      env: { GH_TOKEN: gh_token },
    });
  } catch (err) {
    console.error(
      `[webhook] Failed to spawn CI fix builder for PR #${String(pr.number)}: ${String(err)}`,
    );
    sentry.captureException(err, {
      tags: { module: "webhook", entity: entity_id, action: "spawn_ci_fixer" },
      contexts: { pr: { number: pr.number, title: pr.title } },
    });
  }
}

// ── Deploy triage spawning (#199) ──

/** Safety valve: max total deploy fix attempts across all runs for one entity in 24h. */
const DEPLOY_SAFETY_VALVE = 4;

/**
 * Spawn a Gary (planner) session to triage a deploy failure on main.
 *
 * Modeled on spawn_ci_fixer() but routes through the planner archetype
 * since deploy failures span a wider problem space (code, infra, config).
 *
 * Dedup: keyed by "entity_id:workflow_run_id". Same run ID won't spawn twice.
 * Retry cap: MAX_DEPLOY_FIX_ATTEMPTS (2) per workflow run.
 * Safety valve: 4+ total attempts for one entity in 24h pauses auto-triage.
 * Token failure: does NOT consume a retry slot (same pattern as CI fix loop).
 */
async function spawn_deploy_triage(
  entity_id: string,
  repo_path: string,
  workflow: WebhookWorkflowRun,
  ctx: WebhookContext,
  installation_id?: string,
): Promise<void> {
  const triage_key = `${entity_id}:${String(workflow.id)}`;
  const state = await load_deploy_triage(ctx.config);

  // Dedup + retry cap: if we already have an entry at or above the cap, stop.
  const existing = state[triage_key];
  if (existing && existing.fix_attempts >= MAX_DEPLOY_FIX_ATTEMPTS) {
    console.log(
      `[webhook] Deploy triage exhausted for ${triage_key} ` +
        `(${String(existing.fix_attempts)}/${String(MAX_DEPLOY_FIX_ATTEMPTS)}) — skipping`,
    );
    await ctx.alert_router?.post_alert({
      entity_id,
      tier: "action_required",
      title: `\u{1f6d1} Deploy fix exhausted — ${workflow.name}`,
      body: `${String(MAX_DEPLOY_FIX_ATTEMPTS)} attempts failed. Manual intervention needed. ${workflow.html_url}`,
    });
    return;
  }

  // Safety valve: count total deploy fix attempts for this entity in the last 24h.
  const twenty_four_hours_ago = Date.now() - 24 * 60 * 60 * 1000;
  let entity_attempts_24h = 0;
  for (const entry of Object.values(state)) {
    if (
      entry.entity_id === entity_id &&
      new Date(entry.last_attempt_at).getTime() > twenty_four_hours_ago
    ) {
      entity_attempts_24h += entry.fix_attempts;
    }
  }
  if (entity_attempts_24h >= DEPLOY_SAFETY_VALVE) {
    console.log(
      `[webhook] Deploy safety valve triggered for ${entity_id} ` +
        `(${String(entity_attempts_24h)} attempts in 24h) — skipping`,
    );
    await ctx.alert_router?.post_alert({
      entity_id,
      tier: "action_required",
      title: `\u{1f6d1} Deploy safety valve — ${entity_id}`,
      body: `${String(entity_attempts_24h)} fix attempts in 24h (safety valve = ${String(DEPLOY_SAFETY_VALVE)}). Auto-triage paused. Manual intervention needed.`,
    });
    return;
  }

  // Resolve token BEFORE incrementing attempt counter — transient token
  // errors (cert issues, rate limits) shouldn't consume retry slots.
  let gh_token: string;
  try {
    gh_token = await resolve_token(ctx.github_app, installation_id);
  } catch (err) {
    console.error(`[webhook] Failed to get token for deploy triage: ${String(err)}`);
    sentry.captureException(err, {
      tags: { module: "webhook", entity: entity_id, action: "deploy_triage_token" },
      contexts: { workflow: { name: workflow.name, run_id: workflow.id } },
    });
    return;
  }

  // Increment attempt counter and save state
  const now = new Date().toISOString();
  const attempt = (existing?.fix_attempts ?? 0) + 1;
  const entry: DeployTriageEntry = {
    entity_id,
    workflow_run_id: workflow.id,
    workflow_name: workflow.name,
    workflow_url: workflow.html_url,
    head_sha: workflow.head_sha,
    first_seen_at: existing?.first_seen_at ?? now,
    fix_attempts: attempt,
    last_attempt_at: now,
    resolved: false,
  };
  state[triage_key] = entry;
  await save_deploy_triage(state, ctx.config);

  // Fetch failure logs from GitHub Actions
  const failure_logs = await fetch_ci_failure_logs("main", repo_path, gh_token);

  // Build prompt for Gary
  const prompt = build_deploy_triage_prompt(
    workflow.name,
    workflow.html_url,
    workflow.id,
    repo_path,
    failure_logs,
    attempt,
    MAX_DEPLOY_FIX_ATTEMPTS,
  );

  console.log(
    `[webhook] Spawning Gary for deploy triage in ${entity_id} ` +
      `(run ${String(workflow.id)}, attempt ${String(attempt)}/${String(MAX_DEPLOY_FIX_ATTEMPTS)})`,
  );

  await ctx.alert_router?.post_alert({
    entity_id,
    tier: "action_required",
    title: "\u26a0\ufe0f Deploy failed on main",
    body: `Gary triaging "${workflow.name}" (attempt ${String(attempt)}/${String(MAX_DEPLOY_FIX_ATTEMPTS)}). ${workflow.html_url}`,
    embed_color: ALERT_COLOR_RED,
  });

  try {
    await ctx.session_manager.spawn({
      entity_id,
      feature_id: `deploy-triage-${String(workflow.id)}`,
      archetype: "planner" as ArchetypeRole,
      dna: ["planning-dna"],
      model: { model: "opus", think: "high" },
      worktree_path: repo_path,
      prompt,
      interactive: false,
      env: { GH_TOKEN: gh_token },
    });
  } catch (err) {
    console.error(
      `[webhook] Failed to spawn deploy triage for run ${String(workflow.id)}: ${String(err)}`,
    );
    sentry.captureException(err, {
      tags: { module: "webhook", entity: entity_id, action: "spawn_deploy_triage" },
      contexts: { workflow: { name: workflow.name, run_id: workflow.id } },
    });
  }
}

// ── Prompt building ──

/**
 * Builds the dynamic per-PR prefix for the v1 (pull_request webhook) reviewer
 * lifecycle. The reviewer agent's `initialPrompt` (see
 * `config/claude/agents/reviewer.md`) carries the static mechanics — identity,
 * posting rules, verdict format, echo / verify-landing safety. This function
 * emits only what changes per PR: header, pre-existing-review dedup check,
 * linked-issue context, the two-pass procedure, and v1-specific merge steps.
 *
 * The effective first user turn the reviewer sees is:
 *     <initialPrompt from frontmatter>  ← prepended automatically
 *     <blank line>
 *     <this builder's output, piped via stdin>
 */
export function build_reviewer_prompt(
  pr: WebhookPR,
  repo_path: string,
  repo_full_name: string,
  issue_context: string,
): string {
  const pr_num = String(pr.number);
  const head_sha = pr.head.sha;
  const has_issue = issue_context.length > 0;

  // Header + linked issue context FIRST, so the reviewer reads the spec before
  // being told what to do with it.
  //
  // The pre-existing-review check is SHA-aware (see #314). Prior buggy
  // behavior: the skip test ignored commit_id, so when fix commits pushed and
  // a new reviewer session spawned, it saw the stale CHANGES_REQUESTED review
  // on the OLD commit and exited silently — never posting a fresh review on
  // the new head. Fix: scope the skip to reviews whose commit_id matches the
  // current head SHA. Reviews on superseded commits are stale and must not
  // block a fresh review.
  const lines: string[] = [
    `Review PR #${pr_num}: "${pr.title}" on branch ${pr.head.ref}.`,
    `Repository: ${repo_path}`,
    `Current head SHA: ${head_sha}`,
    "",
    "Before posting, check for any existing bot reviews AND their commit_id:",
    `  gh api repos/${repo_full_name}/pulls/${pr_num}/reviews --jq '[.[] | select(.user.login | endswith("[bot]")) | {state, submitted_at, commit_id}]'`,
    "",
    `Skip posting ONLY if a review already exists with state APPROVED or CHANGES_REQUESTED on the current head SHA: ${head_sha}.`,
    "If prior reviews exist only on older commits, treat them as stale and",
    "proceed with a fresh formal review on the current head. A CHANGES_REQUESTED",
    "review on a superseded commit does NOT block a fresh review — the builder",
    "has since pushed fix commits and the new head must be re-evaluated.",
    "",
    "When you DO post, use a FORMAL review state via `gh pr review` ONLY:",
    `  gh pr review ${pr_num} --approve --body "<body>"`,
    `  gh pr review ${pr_num} --request-changes --body "<body>"`,
    `  gh pr review ${pr_num} --comment --body "<body>"`,
    "Formal review states update reviewDecision and drive auto-merge. Plain PR",
    "comments do NOT — they are invisible to the merge gate. Never substitute a",
    "plain comment for a formal review state, even if a prior review already",
    "exists and you are 'just adding a note'. If you have something to say about",
    "the PR, say it via `gh pr review`.",
    "",
  ];

  if (has_issue) {
    lines.push("## Linked Issue Context", "", issue_context, "");
  }

  // Two-pass review instructions. Pass 1 is a hard gate on spec compliance;
  // Pass 2 (code quality) only runs if Pass 1 passes. Single session, early
  // return on Pass 1 failure — no second spawn.
  lines.push(
    "## Review Procedure — Two Passes",
    "",
    "You will run TWO passes, in order. Pass 1 is a hard gate: if it fails,",
    "you do NOT run Pass 2. No exceptions.",
    "",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "### Pass 1 — Spec Compliance (ALWAYS runs first)",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "",
    "Purpose: verify the PR implements exactly what the linked issue asked for.",
    "Not more, not less. Code quality is NOT evaluated in this pass.",
    "",
  );

  if (has_issue) {
    lines.push(
      "Procedure:",
      "",
      "1. Read the `## Linked Issue Context` section above. Find the",
      "   Acceptance Criteria / Spec / Requirements block.",
      "",
      "2. Walk each acceptance criterion line by line against the diff",
      `   (\`gh pr diff ${pr_num}\`). For each criterion, classify as:`,
      "     - **met**     — the diff clearly implements this criterion",
      "     - **missing** — the diff does not address this criterion at all",
      "     - **partial** — the diff addresses it but incompletely or incorrectly",
      "",
      "   Treat **partial as failing**. A partially-met criterion is a Pass 1",
      "   failure, even if the gap is minor. Consistent gate behavior beats",
      "   case-by-case judgment — note the gap in your review body, but do",
      "   not waive it.",
      "",
      "3. Separately check for **over-building**: code or behavior the PR",
      "   introduces that the spec did not request. Unrequested features,",
      "   speculative abstractions, scope creep, drive-by refactors unrelated",
      "   to the stated criteria. Flag these as 'out of scope' items.",
      "",
      "   Out-of-scope additions are blocking even if they are well-written.",
      "",
      "4. Decide the Pass 1 verdict:",
      "",
      "   **FAIL** — if ANY criterion is missing or partial, OR any over-build",
      "   is flagged. Post a CHANGES REQUESTED review and STOP:",
      "",
      `     gh pr review ${pr_num} --request-changes --body "<pass 1 body>"`,
      "",
      "   The review body MUST start with this exact marker line (first line,",
      "   no prefix, no whitespace):",
      "",
      "     ## Pass 1 — Spec Compliance: CHANGES REQUESTED",
      "",
      "   Under the marker, list each failing criterion (missing / partial)",
      "   and each out-of-scope addition with a one-line explanation. Keep",
      "   it focused on the gap — the builder needs to know what to fix.",
      "",
      "   After posting the review, STOP IMMEDIATELY. Do NOT run Pass 2. Do",
      "   NOT do any code-quality analysis. Do NOT merge. A fresh review",
      "   cycle will run against the corrected diff on the next push.",
      "",
      "   **PASS** — if every criterion is met and no over-build is flagged.",
      "   Record the Pass 1 verdict (you will include it in the combined",
      "   review body) and proceed to Pass 2.",
      "",
    );
  } else {
    lines.push(
      "No linked issue was detected on this PR. Pass 1 is a documented no-op.",
      "There is no spec to compare against, so spec compliance cannot be",
      "evaluated. Record the Pass 1 verdict as SKIPPED and proceed to Pass 2.",
      "",
      "When you post the combined review in Pass 2, the body MUST start with",
      "this exact marker line (first line, no prefix, no whitespace):",
      "",
      "     ## Pass 1 — Spec Compliance: SKIPPED (no linked issue)",
      "",
    );
  }

  lines.push(
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "### Pass 2 — Code Quality (runs ONLY if Pass 1 passed or was skipped)",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "",
    "Do NOT run this pass if Pass 1 found missing criteria, partial",
    "criteria, or over-building. If Pass 1 failed, you have already posted",
    "a CHANGES REQUESTED review and you are done.",
    "",
    "Run /ultrareview to do a comprehensive code-quality review, guided by",
    "`review-dna`. Priority order: bugs → security → design → readability → nits.",
    "Every piece of actionable feedback should be included.",
    "",
    "Combined review body structure. The body MUST start with the Pass 1",
    "verdict line, then a blank line, then the `## Pass 2 — Code Quality`",
    "heading, then the Pass 2 findings:",
    "",
  );

  if (has_issue) {
    lines.push(
      "     ## Pass 1 — Spec Compliance: PASSED",
      "",
      "     <one-line summary confirming each acceptance criterion was met>",
      "",
      "     ## Pass 2 — Code Quality",
      "",
      "     <your code-quality findings, or 'No issues found.'>",
      "",
    );
  } else {
    lines.push(
      "     ## Pass 1 — Spec Compliance: SKIPPED (no linked issue)",
      "",
      "     ## Pass 2 — Code Quality",
      "",
      "     <your code-quality findings, or 'No issues found.'>",
      "",
    );
  }

  lines.push(
    "Post the combined review using the approve / request-changes commands",
    "from your initial instructions — one post, echo marker, verify it",
    `landed. Use PR #${pr_num} in the command and \`${repo_full_name}\` in`,
    "the verify API call.",
    "",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "### CI status & merge (only relevant if Pass 2 approved)",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "",
    "CI status — three distinct cases, treat them differently:",
    `  gh pr checks ${pr_num} --required`,
    "",
    "1. FAILING required checks (conclusion failure/cancelled/timed_out):",
    "   The PR is broken. Note the failing checks in your review and request",
    "   changes so the builder can fix them. Do NOT merge.",
    "",
    "2. PENDING required checks (state pending/queued/in_progress, no failures):",
    "   CI is still running — this is NOT a reason to request changes. Code",
    "   review is orthogonal to CI execution time. Review the code on its merits",
    "   and either:",
    "     - Approve (if the code is clean). The daemon gates the actual merge on",
    "       CI completion — pr-cron retries the merge once checks finish, so an",
    "       approve-and-wait is safe. Note in your review body that merge will",
    "       happen after CI clears.",
    "     - Request changes (only if the code itself has issues, independent of",
    "       CI status).",
    "   Do NOT request changes just because checks haven't finished yet — that",
    "   creates a deadlock: new commits from the fix loop re-trigger the webhook,",
    "   which spawns a fresh reviewer during the same pending-CI window, which",
    "   requests changes again.",
    "",
    "3. PASSING required checks (all success/neutral/skipped), or no checks",
    "   configured: safe to merge if you approved.",
    "",
    "After posting your review:",
    "- If you approved AND all required checks are passing (or none configured),",
    "  merge the PR:",
    `  gh pr merge ${pr_num} --squash --delete-branch`,
    "- If you approved but CI is still pending, do NOT run the merge command",
    "  yourself. The daemon will merge once checks clear. Your review is the signal.",
    "- If the merge command fails (branch behind main):",
    `  1. Try: git fetch origin && git checkout ${pr.head.ref} && git rebase origin/main`,
    `  2. If rebase is clean (no conflicts): git push --force-with-lease origin ${pr.head.ref}`,
    `  3. Then retry: gh pr merge ${pr_num} --squash --delete-branch`,
    "  4. If rebase has conflicts: git rebase --abort — do NOT force push conflict markers",
    "- If you requested changes, do NOT merge.",
  );

  return lines.join("\n");
}

// ── Merged PR handling ──

/**
 * Handle a PR that was just merged: close linked issues and clean up worktrees.
 *
 * GitHub Apps don't trigger auto-close when they merge PRs, so we do it
 * explicitly via the REST API. Worktree cleanup removes the branch's worktree
 * and local branch ref. Both operations are best-effort — failures are logged
 * but never thrown.
 */
async function handle_pr_merged(
  pr: WebhookPR,
  repo_full_name: string,
  repo_path: string,
  ctx: WebhookContext,
  installation_id?: string,
): Promise<void> {
  // Close linked issues
  const issue_numbers = extract_linked_issues(pr.body, pr.title);
  if (issue_numbers.length === 0) {
    console.log(`[webhook] Merged PR #${String(pr.number)} has no linked issues to close`);
  } else {
    let gh_token: string;
    try {
      gh_token = await resolve_token(ctx.github_app, installation_id);
    } catch (err) {
      console.error(`[webhook] Failed to get token for issue closing: ${String(err)}`);
      sentry.captureException(err, {
        tags: { module: "webhook", action: "close_issues" },
        contexts: { pr: { number: pr.number, title: pr.title } },
      });
      // Continue to worktree cleanup even if issue closing fails
      gh_token = "";
    }

    if (gh_token) {
      console.log(
        `[webhook] Closing linked issues ${issue_numbers.map((n) => `#${String(n)}`).join(", ")} ` +
          `for merged PR #${String(pr.number)}`,
      );

      const results = await close_linked_issues(repo_full_name, pr.number, issue_numbers, gh_token);

      for (const result of results) {
        if (!result.success) {
          sentry.captureException(new Error(result.error ?? "unknown"), {
            tags: { module: "webhook", action: "close_issue" },
            contexts: {
              pr: { number: pr.number, title: pr.title },
              issue: { number: result.issue_number },
            },
          });
        }
      }
    }
  }

  // Clean up worktrees for the merged branch
  try {
    await cleanup_after_merge(repo_path, pr.head.ref);
  } catch (err) {
    // Best-effort — never let cleanup break the merge handler
    console.error(`[webhook] Worktree cleanup failed for branch ${pr.head.ref}: ${String(err)}`);
    sentry.captureException(err, {
      tags: { module: "webhook", action: "worktree_cleanup" },
      contexts: { pr: { number: pr.number, branch: pr.head.ref } },
    });
  }
}

// ── Post auto-merge cleanup ──

/**
 * After a successful auto-merge, close linked issues and clean up worktrees.
 * Derives the repo full name from the entity registry rather than the webhook
 * payload, since this runs outside the `closed` event path.
 * All operations are best-effort — failures are logged but never thrown.
 */
async function post_auto_merge_cleanup(
  pr: WebhookPR,
  entity_id: string,
  repo_path: string,
  ctx: WebhookContext,
  installation_id?: string,
): Promise<void> {
  // Close linked issues
  const issue_numbers = extract_linked_issues(pr.body, pr.title);
  if (issue_numbers.length > 0) {
    // Derive repo full name from entity registry
    const entity_config = ctx.registry
      .get_active()
      .find((e: { entity: { id: string } }) => e.entity.id === entity_id);
    const repo = entity_config?.entity.repos.find((r: { path: string; url: string }) => {
      const expanded = expand_home(r.path);
      return expanded === repo_path;
    });
    const repo_full_name = repo ? nwo_from_url(repo.url) : undefined;

    if (repo_full_name) {
      try {
        const gh_token = await resolve_token(ctx.github_app, installation_id);
        const results = await close_linked_issues(
          repo_full_name,
          pr.number,
          issue_numbers,
          gh_token,
        );
        for (const result of results) {
          if (!result.success) {
            sentry.captureException(new Error(result.error ?? "unknown"), {
              tags: { module: "webhook", action: "auto_merge_close_issue" },
              contexts: {
                pr: { number: pr.number, title: pr.title },
                issue: { number: result.issue_number },
              },
            });
          }
        }
      } catch (err) {
        console.error(`[webhook] Failed to close issues after auto-merge: ${String(err)}`);
        sentry.captureException(err, {
          tags: { module: "webhook", action: "auto_merge_close_issues" },
          contexts: { pr: { number: pr.number, title: pr.title } },
        });
      }
    }
  }

  // Clean up worktrees
  try {
    await cleanup_after_merge(repo_path, pr.head.ref);
  } catch (err) {
    console.error(
      `[webhook] Worktree cleanup failed after auto-merge for branch ${pr.head.ref}: ${String(err)}`,
    );
    sentry.captureException(err, {
      tags: { module: "webhook", action: "auto_merge_worktree_cleanup" },
      contexts: { pr: { number: pr.number, branch: pr.head.ref } },
    });
  }
}

// ── Workflow run handling (#189) ──

/**
 * Handle workflow_run webhook events.
 * Notifies #alerts when a workflow fails on main (likely a deploy failure).
 *
 * IMPORTANT: The GitHub App must be subscribed to `workflow_run` events.
 * This is a manual one-time step in the GitHub App settings:
 * Settings → Permissions & Events → Subscribe to events → check "Workflow runs".
 * Without this subscription, this handler will never receive events.
 */
async function handle_workflow_run(payload: WebhookPayload, ctx: WebhookContext): Promise<void> {
  const workflow = payload.workflow_run;
  if (!workflow) {
    console.log("[webhook] workflow_run event missing workflow_run data");
    return;
  }

  // Only care about completed failures on main from push events (deploy workflows)
  if (
    payload.action !== "completed" ||
    workflow.conclusion !== "failure" ||
    workflow.event !== "push" ||
    workflow.head_branch !== "main"
  ) {
    console.log(
      `[webhook] Ignoring workflow_run: conclusion=${workflow.conclusion ?? "null"}, ` +
        `event=${workflow.event}, branch=${workflow.head_branch}`,
    );
    return;
  }

  const repo_full_name = payload.repository?.full_name;
  if (!repo_full_name) {
    console.log("[webhook] workflow_run event missing repository data");
    return;
  }

  const match = find_entity_for_repo(repo_full_name, ctx.registry);
  if (!match) {
    console.log(`[webhook] No entity found for repo ${repo_full_name} — ignoring workflow_run`);
    return;
  }

  const installation_id =
    payload.installation?.id != null ? String(payload.installation.id) : undefined;

  console.log(
    `[webhook] Workflow "${workflow.name}" failed on main in ${match.entity_id} (${repo_full_name})`,
  );

  await spawn_deploy_triage(match.entity_id, match.repo_path, workflow, ctx, installation_id);
}

// ── Utility helpers ──

// notify_alerts removed — all call sites migrated to ctx.alert_router.post_alert()

/**
 * Check if any bot is watching this PR and, if so, inject the event message
 * into that bot's tmux session.
 *
 * When `terminal` is true (default), the watch is removed after delivery.
 * Non-terminal events (e.g. changes_requested) keep the watch alive so the
 * bot still receives the final merged/closed notification.
 */
async function notify_pr_watcher(
  repo_full_name: string,
  pr_number: number,
  message: string,
  ctx: WebhookContext,
  terminal = true,
): Promise<void> {
  if (!ctx.pr_watches || !ctx.pool) return;

  const watch = ctx.pr_watches.get(repo_full_name, pr_number);
  if (!watch) return;

  const assignment = ctx.pool.get_assignment(watch.channel_id);
  if (assignment) {
    await ctx.pool.inject_message_to_bot(assignment.tmux_session, message);
    console.log(
      `[webhook] Notified watcher for ${repo_full_name}#${String(pr_number)} ` +
        `via ${assignment.tmux_session} (terminal=${String(terminal)})`,
    );
  } else {
    console.log(
      `[webhook] Watch exists for ${repo_full_name}#${String(pr_number)} ` +
        `but no active assignment for channel ${watch.channel_id} — cleaning up`,
    );
  }

  // Only remove the watch on terminal events (merged, closed).
  // Non-terminal events (changes_requested) keep it alive for the eventual outcome.
  if (terminal || !assignment) {
    await ctx.pr_watches.remove(repo_full_name, pr_number);
  }
}

async function check_pr_merged(
  repo_path: string,
  pr_number: number,
  gh_token?: string,
): Promise<boolean> {
  try {
    const env = gh_token ? { ...process.env, GH_TOKEN: gh_token } : undefined;
    const { stdout } = await exec(
      "gh",
      ["pr", "view", String(pr_number), "--json", "state", "--jq", ".state"],
      { cwd: repo_path, timeout: 15_000, ...(env ? { env } : {}) },
    );
    return stdout.trim() === "MERGED";
  } catch {
    return false;
  }
}

/** Get the currently active webhook reviews (for status/debugging). */
export function get_active_webhook_reviews(): Array<{
  key: string;
  entity_id: string;
  pr_number: number;
  head_sha: string;
  state: "in_flight" | "completed";
  needs_requeue: boolean;
}> {
  return [...active_reviews.entries()].map(([key, review]) => ({
    key,
    entity_id: review.entity_id,
    pr_number: review.pr_number,
    head_sha: review.head_sha,
    state: review.state,
    needs_requeue: review.needs_requeue,
  }));
}

/**
 * Reset active reviews map. Test-only helper — do not call from production code.
 * Vitest's vi.clearAllMocks() does not clear module-level state like this map,
 * so tests that depend on a clean dedup table must call this in beforeEach.
 */
export function _reset_active_reviews_for_testing(): void {
  active_reviews.clear();
}
