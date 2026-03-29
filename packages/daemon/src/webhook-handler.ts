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

import type { IncomingMessage, ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ArchetypeRole } from "@lobster-farm/shared";
import { expand_home } from "@lobster-farm/shared";
import type { GitHubAppAuth } from "./github-app.js";
import type { EntityRegistry } from "./registry.js";
import type { ClaudeSessionManager, SessionResult } from "./session.js";
import type { DiscordBot } from "./discord.js";
import { detect_review_outcome } from "./actions.js";
import { fetch_review_comments, build_review_fix_prompt } from "./review-utils.js";
import {
  extract_first_linked_issue,
  extract_linked_issues,
  fetch_issue_context,
  close_linked_issues,
} from "./issue-utils.js";
import * as sentry from "./sentry.js";

const exec = promisify(execFile);

// ── Types ──

export interface WebhookContext {
  github_app: GitHubAppAuth;
  session_manager: ClaudeSessionManager;
  registry: EntityRegistry;
  discord: DiscordBot | null;
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

interface WebhookPayload {
  action: string;
  pull_request?: WebhookPR;
  repository?: { full_name: string };
}

interface ActiveWebhookReview {
  entity_id: string;
  pr_number: number;
  /** Set to true if a new event arrived while this review was in-flight. */
  needs_requeue: boolean;
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

// ── Active review tracking ──

const active_reviews = new Map<string, ActiveWebhookReview>();

function review_key(entity_id: string, pr_number: number): string {
  return `${entity_id}:${String(pr_number)}`;
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
  if (event_type !== "pull_request") {
    console.log(`[webhook] Ignoring event: ${event_type}`);
    return;
  }

  const action = payload.action;
  const pr = payload.pull_request;
  const repo_full_name = payload.repository?.full_name;

  if (!pr || !repo_full_name) {
    console.log(`[webhook] pull_request event missing PR or repo data`);
    return;
  }

  // Map repo to entity
  const match = find_entity_for_repo(repo_full_name, ctx.registry);
  if (!match) {
    console.log(`[webhook] No entity found for repo ${repo_full_name} — ignoring`);
    return;
  }

  // Handle merged PRs — close linked issues
  if (action === "closed" && pr.merged === true) {
    console.log(
      `[webhook] pull_request.closed (merged) for #${String(pr.number)} ` +
      `in ${match.entity_id} (${repo_full_name})`,
    );
    await handle_pr_merged(pr, repo_full_name, ctx);
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
    console.log(
      `[webhook] Review already in-flight for ${key} — marking for requeue`,
    );
    existing.needs_requeue = true;
    return;
  }

  await spawn_review(match.entity_id, match.repo_path, pr, ctx);
}

// ── Reviewer spawning ──

async function spawn_review(
  entity_id: string,
  repo_path: string,
  pr: WebhookPR,
  ctx: WebhookContext,
): Promise<void> {
  const key = review_key(entity_id, pr.number);

  // Track active review
  active_reviews.set(key, {
    entity_id,
    pr_number: pr.number,
    needs_requeue: false,
  });

  // Get installation token for the reviewer subprocess
  let gh_token: string;
  try {
    gh_token = await ctx.github_app.get_token();
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

  console.log(
    `[webhook] Spawning reviewer for PR #${String(pr.number)} in ${entity_id}`,
  );

  try {
    const session = await ctx.session_manager.spawn({
      entity_id,
      feature_id: `pr-review-${String(pr.number)}`,
      archetype: "reviewer",
      dna: ["review-guideline"],
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

      void handle_review_completion(entity_id, repo_path, pr, ctx).catch(
        (err) => {
          console.error(`[webhook] Post-review error: ${String(err)}`);
          sentry.captureException(err, {
            tags: { module: "webhook", entity: entity_id },
            contexts: { pr: { number: pr.number, title: pr.title } },
          });
        },
      );
    };

    const on_fail = (session_id: string, error: string) => {
      if (session_id !== session.session_id) return;
      ctx.session_manager.removeListener("session:completed", on_complete);
      ctx.session_manager.removeListener("session:failed", on_fail);

      console.error(
        `[webhook] Review session failed for PR #${String(pr.number)}: ${error}`,
      );
      sentry.captureException(new Error(error), {
        tags: { module: "webhook", entity: entity_id },
        contexts: { pr: { number: pr.number, title: pr.title } },
      });
      cleanup_and_maybe_requeue(key, entity_id, repo_path, pr, ctx);
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
  pr: WebhookPR,
  ctx: WebhookContext,
): Promise<void> {
  const key = review_key(entity_id, pr.number);
  const outcome = await detect_review_outcome(pr.number, repo_path);

  console.log(
    `[webhook] Review completed for PR #${String(pr.number)} — outcome: ${outcome}`,
  );

  // Route outcome
  if (outcome === "changes_requested") {
    // Spawn builder to fix
    await spawn_fixer(entity_id, repo_path, pr, ctx);
    await notify_alerts(
      entity_id,
      `PR #${String(pr.number)}: ${pr.title} — changes requested, spawning builder to fix`,
      ctx,
    );
  } else if (outcome === "approved") {
    // Check if reviewer already merged
    const is_merged = await check_pr_merged(repo_path, pr.number);
    await notify_alerts(
      entity_id,
      `PR #${String(pr.number)}: ${pr.title} — ${is_merged ? "approved and merged" : "approved"}`,
      ctx,
    );
  } else {
    await notify_alerts(
      entity_id,
      `PR #${String(pr.number)} review completed: "${pr.title}" (${outcome})`,
      ctx,
    );
  }

  // Check if we need to re-review (new commits arrived during review)
  cleanup_and_maybe_requeue(key, entity_id, repo_path, pr, ctx);
}

/**
 * Remove the active review entry and, if new events arrived mid-review,
 * spawn a fresh review.
 */
function cleanup_and_maybe_requeue(
  key: string,
  entity_id: string,
  repo_path: string,
  pr: WebhookPR,
  ctx: WebhookContext,
): void {
  const review = active_reviews.get(key);
  active_reviews.delete(key);

  if (review?.needs_requeue) {
    console.log(
      `[webhook] Re-reviewing PR #${String(pr.number)} — new commits arrived during previous review`,
    );
    void spawn_review(entity_id, repo_path, pr, ctx).catch((err) => {
      console.error(`[webhook] Requeue failed for PR #${String(pr.number)}: ${String(err)}`);
      sentry.captureException(err, {
        tags: { module: "webhook", entity: entity_id, action: "requeue" },
        contexts: { pr: { number: pr.number, title: pr.title } },
      });
    });
  }
}

// ── Builder spawning for failed reviews ──

async function spawn_fixer(
  entity_id: string,
  repo_path: string,
  pr: WebhookPR,
  ctx: WebhookContext,
): Promise<void> {
  const review_comments = await fetch_review_comments(pr.number, repo_path);

  const prompt = [
    `An external PR needs fixes based on reviewer feedback.`,
    `PR #${String(pr.number)}: "${pr.title}" on branch ${pr.head.ref}`,
    `Repository: ${repo_path}`,
    ``,
    `First, check out the PR branch: git checkout ${pr.head.ref}`,
    ``,
    build_review_fix_prompt(pr.number, pr.title, review_comments),
    ``,
    `Do NOT merge the PR.`,
  ].join("\n");

  console.log(
    `[webhook] Spawning builder to fix PR #${String(pr.number)} in ${entity_id}`,
  );

  try {
    // Get fresh token for builder too
    const gh_token = await ctx.github_app.get_token();

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
    console.error(
      `[webhook] Failed to spawn builder for PR #${String(pr.number)}: ${String(err)}`,
    );
    sentry.captureException(err, {
      tags: { module: "webhook", entity: entity_id, action: "spawn_fixer" },
      contexts: { pr: { number: pr.number, title: pr.title } },
    });
  }
}

// ── Prompt building ──

function build_reviewer_prompt(
  pr: WebhookPR,
  repo_path: string,
  issue_context: string,
): string {
  const lines = [
    `Review PR #${String(pr.number)}: "${pr.title}" on branch ${pr.head.ref}.`,
    `Repository: ${repo_path}`,
    ``,
    `Run /review to do a comprehensive code review.`,
    ``,
    `Post your review on the PR using gh cli.`,
    `You are authenticated as the LobsterFarm Reviewer GitHub App.`,
    ``,
    `Review standards:`,
    `- Every piece of actionable feedback should be included.`,
    `- If there is ANY actionable feedback, request changes:`,
    `  gh pr review ${String(pr.number)} --request-changes --body "<your review>"`,
    `- If the code is genuinely clean with no improvements needed, approve:`,
    `  gh pr review ${String(pr.number)} --approve --body "Looks good."`,
    ``,
    `After posting your review:`,
    `- If you approved, merge the PR:`,
    `  gh pr merge ${String(pr.number)} --squash --delete-branch`,
    `- If you requested changes, do NOT merge.`,
  ];

  if (issue_context) {
    lines.push(``, `## Linked Issue Context`, ``, issue_context);
  }

  return lines.join("\n");
}

// ── Merged PR handling ──

/**
 * Handle a PR that was just merged: close any linked issues.
 *
 * GitHub Apps don't trigger auto-close when they merge PRs, so we do it
 * explicitly via the REST API. Failures are logged but never thrown.
 */
async function handle_pr_merged(
  pr: WebhookPR,
  repo_full_name: string,
  ctx: WebhookContext,
): Promise<void> {
  const issue_numbers = extract_linked_issues(pr.body, pr.title);
  if (issue_numbers.length === 0) {
    console.log(`[webhook] Merged PR #${String(pr.number)} has no linked issues to close`);
    return;
  }

  let gh_token: string;
  try {
    gh_token = await ctx.github_app.get_token();
  } catch (err) {
    console.error(`[webhook] Failed to get token for issue closing: ${String(err)}`);
    sentry.captureException(err, {
      tags: { module: "webhook", action: "close_issues" },
      contexts: { pr: { number: pr.number, title: pr.title } },
    });
    return;
  }

  console.log(
    `[webhook] Closing linked issues ${issue_numbers.map(n => `#${String(n)}`).join(", ")} ` +
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

// ── Utility helpers ──

async function notify_alerts(
  entity_id: string,
  message: string,
  ctx: WebhookContext,
): Promise<void> {
  console.log(`[webhook:alerts] ${message}`);
  if (ctx.discord) {
    await ctx.discord.send_to_entity(
      entity_id,
      "alerts",
      message,
      "reviewer" as ArchetypeRole,
    );
  }
}

async function check_pr_merged(repo_path: string, pr_number: number): Promise<boolean> {
  try {
    const { stdout } = await exec("gh", [
      "pr", "view", String(pr_number),
      "--json", "state",
      "--jq", ".state",
    ], { cwd: repo_path, timeout: 15_000 });
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
