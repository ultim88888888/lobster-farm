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
import { detect_review_outcome } from "./actions.js";
import type { DiscordBot } from "./discord.js";
import type { GitHubAppAuth } from "./github-app.js";
import {
  close_linked_issues,
  extract_first_linked_issue,
  extract_linked_issues,
  fetch_issue_context,
  nwo_from_url,
} from "./issue-utils.js";
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
import {
  MAX_CI_FIX_ATTEMPTS,
  MAX_DEPLOY_FIX_ATTEMPTS,
  attempt_auto_merge,
  build_ci_fix_prompt,
  build_deploy_triage_prompt,
  build_review_fix_prompt,
  check_ci_status,
  fetch_ci_failure_logs,
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
}

/** Minimal PR shape from webhook payload. */
interface WebhookPR {
  number: number;
  title: string;
  head: { ref: string };
  body: string | null;
  user: { login: string };
  merged?: boolean;
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

interface ActiveWebhookReview {
  entity_id: string;
  pr_number: number;
  /** Set to true if a new event arrived while this review was in-flight. */
  needs_requeue: boolean;
  created_at: number;
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
 * Checks each entity's repo URLs for a match.
 */
function find_entity_for_repo(
  full_name: string,
  registry: EntityRegistry,
): { entity_id: string; repo_path: string } | null {
  // Normalize: "owner/repo" matches against various URL formats
  const lower = full_name.toLowerCase();

  for (const entity of registry.get_active()) {
    for (const repo of entity.entity.repos) {
      // Match against HTTPS URL: https://github.com/owner/repo.git
      // Match against SSH URL: git@github.com:owner/repo.git
      const url = repo.url.toLowerCase();
      if (
        url.includes(lower) ||
        url.includes(lower.replace("/", ":")) // SSH format uses colon
      ) {
        return {
          entity_id: entity.entity.id,
          repo_path: expand_home(repo.path),
        };
      }
    }
  }

  return null;
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

// ── Active review tracking ──

const active_reviews = new Map<string, ActiveWebhookReview>();

function review_key(entity_id: string, pr_number: number): string {
  return `${entity_id}:${String(pr_number)}`;
}

const REVIEW_TIMEOUT_MS = 30 * 60 * 1000;

function cleanup_stale_reviews(): void {
  const now = Date.now();
  for (const [key, review] of active_reviews) {
    if (now - review.created_at > REVIEW_TIMEOUT_MS) {
      console.log(`[webhook] Cleaning up stale review entry: ${key}`);
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
  const reviewable_actions = ["opened", "synchronize", "reopened"];
  if (!reviewable_actions.includes(action)) {
    console.log(`[webhook] Ignoring pull_request.${action} for #${String(pr.number)}`);
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

  // Deduplicate: if review already in-flight for this PR, mark for requeue
  const key = review_key(match.entity_id, pr.number);
  const existing = active_reviews.get(key);
  if (existing) {
    console.log(`[webhook] Review already in-flight for ${key} — marking for requeue`);
    existing.needs_requeue = true;
    return;
  }

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
  const key = review_key(entity_id, pr.number);

  // Track active review
  active_reviews.set(key, {
    entity_id,
    pr_number: pr.number,
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
  const prompt = build_reviewer_prompt(pr, repo_path, issue_context);

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

  // Route outcome
  if (outcome === "changes_requested") {
    // Spawn builder to fix
    await spawn_fixer(entity_id, repo_path, pr, ctx, installation_id);
    await notify_alerts(
      entity_id,
      `PR #${String(pr.number)}: ${pr.title} — changes requested, spawning builder to fix`,
      ctx,
    );
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
        console.log(
          `[webhook] CI checks pending for PR #${String(pr.number)} — skipping merge, pr-cron retry pass will handle`,
        );
        // Don't merge yet — pr-cron's retry_approved_unmerged pass will check CI and merge next cycle
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
          await notify_alerts(
            entity_id,
            `PR #${String(pr.number)}: ${pr.title} — approved, auto-rebased (${result.method}), and merged`,
            ctx,
          );
          // Auto-merged — notify watching bot
          await notify_pr_watcher(
            repo_full_name,
            pr.number,
            `PR #${String(pr.number)} ("${pr.title}") was approved and merged to main. Continue your work.`,
            ctx,
          );
        } else {
          await notify_alerts(
            entity_id,
            `PR #${String(pr.number)}: ${pr.title} — approved but merge failed after rebase attempt. ${result.error ?? "Manual intervention needed."}`,
            ctx,
          );
        }
      }
    } else {
      await notify_alerts(
        entity_id,
        `PR #${String(pr.number)}: ${pr.title} — approved and merged`,
        ctx,
      );
      // Reviewer already merged — notify watching bot
      await notify_pr_watcher(
        repo_full_name,
        pr.number,
        `PR #${String(pr.number)} ("${pr.title}") was approved and merged to main. Continue your work.`,
        ctx,
      );
    }
  } else {
    await notify_alerts(
      entity_id,
      `PR #${String(pr.number)} review completed: "${pr.title}" (${outcome})`,
      ctx,
    );
  }
}

/**
 * Remove the active review entry and, if new events arrived mid-review,
 * spawn a fresh review.
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
  active_reviews.delete(key);

  if (review?.needs_requeue) {
    console.log(
      `[webhook] Re-reviewing PR #${String(pr.number)} — new commits arrived during previous review`,
    );
    void spawn_review(entity_id, repo_path, repo_full_name, pr, ctx, installation_id).catch(
      (err) => {
        console.error(`[webhook] Requeue failed for PR #${String(pr.number)}: ${String(err)}`);
        sentry.captureException(err, {
          tags: { module: "webhook", entity: entity_id, action: "requeue" },
          contexts: { pr: { number: pr.number, title: pr.title } },
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
  const key = review_key(entity_id, pr.number);

  // Check retry cap
  const pr_state = await load_pr_reviews(ctx.config);
  const entry = pr_state[key];
  const attempts = entry?.ci_fix_attempts ?? 0;

  if (attempts >= MAX_CI_FIX_ATTEMPTS) {
    await notify_alerts(
      entity_id,
      `PR #${String(pr.number)}: ${pr.title} — CI fix failed after ${String(MAX_CI_FIX_ATTEMPTS)} attempts. Needs human intervention. Failed checks: ${failed_checks.join(", ")}`,
      ctx,
    );
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

  await notify_alerts(
    entity_id,
    `PR #${String(pr.number)}: ${pr.title} — approved but CI failed (${failed_checks.join(", ")}), spawning builder to fix (attempt ${String(attempts + 1)}/${String(MAX_CI_FIX_ATTEMPTS)})`,
    ctx,
  );

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
    await notify_alerts(
      entity_id,
      `Deploy fix loop exhausted for workflow "${workflow.name}" ` +
        `(${String(MAX_DEPLOY_FIX_ATTEMPTS)} attempts). Manual intervention needed. ${workflow.html_url}`,
      ctx,
    );
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
    await notify_alerts(
      entity_id,
      `Deploy auto-triage paused for ${entity_id}: ${String(entity_attempts_24h)} fix attempts ` +
        `in 24h (safety valve = ${String(DEPLOY_SAFETY_VALVE)}). Manual intervention needed.`,
      ctx,
    );
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

  await notify_alerts(
    entity_id,
    `\u26a0\ufe0f Deploy failed on main — Gary triaging (attempt ${String(attempt)}/${String(MAX_DEPLOY_FIX_ATTEMPTS)}). ${workflow.html_url}`,
    ctx,
  );

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

function build_reviewer_prompt(pr: WebhookPR, repo_path: string, issue_context: string): string {
  const lines = [
    `Review PR #${String(pr.number)}: "${pr.title}" on branch ${pr.head.ref}.`,
    `Repository: ${repo_path}`,
    "",
    "Run /review to do a comprehensive code review.",
    "",
    "Post your review on the PR using gh cli.",
    "You are authenticated as the LobsterFarm Reviewer GitHub App.",
    "",
    "Review standards:",
    "- Every piece of actionable feedback should be included.",
    "- If there is ANY actionable feedback, request changes:",
    `  gh pr review ${String(pr.number)} --request-changes --body "<your review>"`,
    "- If the code is genuinely clean with no improvements needed, approve:",
    `  gh pr review ${String(pr.number)} --approve --body "Looks good."`,
    "",
    "Before merging, check CI status:",
    `  gh pr checks ${String(pr.number)} --required`,
    "If any required checks are failing or pending, do NOT merge.",
    "Instead, note the failing checks in your review and request changes.",
    "If no CI workflows are configured for this repo, proceed with merge normally.",
    "",
    "After posting your review:",
    "- If you approved, merge the PR:",
    `  gh pr merge ${String(pr.number)} --squash --delete-branch`,
    "- If the merge command fails (branch behind main):",
    `  1. Try: git fetch origin && git checkout ${pr.head.ref} && git rebase origin/main`,
    `  2. If rebase is clean (no conflicts): git push --force-with-lease origin ${pr.head.ref}`,
    `  3. Then retry: gh pr merge ${String(pr.number)} --squash --delete-branch`,
    "  4. If rebase has conflicts: git rebase --abort — do NOT force push conflict markers",
    "- If you requested changes, do NOT merge.",
  ];

  if (issue_context) {
    lines.push("", "## Linked Issue Context", "", issue_context);
  }

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

async function notify_alerts(
  entity_id: string,
  message: string,
  ctx: WebhookContext,
): Promise<void> {
  console.log(`[webhook:alerts] ${message}`);
  if (ctx.discord) {
    await ctx.discord.send_to_entity(entity_id, "alerts", message, "reviewer" as ArchetypeRole);
  }
}

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
  needs_requeue: boolean;
}> {
  return [...active_reviews.entries()].map(([key, review]) => ({
    key,
    entity_id: review.entity_id,
    pr_number: review.pr_number,
    needs_requeue: review.needs_requeue,
  }));
}
