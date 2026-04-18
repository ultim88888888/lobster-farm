import { createHmac, timingSafeEqual } from "node:crypto";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { DAEMON_PORT } from "@lobster-farm/shared";
import { type ArchetypeRole, expand_home } from "@lobster-farm/shared";
import { persist_entity_config } from "./actions.js";
import { ALERT_COLOR_RED, type AlertRouter } from "./alert-router.js";
import type { CommanderProcess } from "./commander-process.js";
import { is_discord_snowflake } from "./discord.js";
import type { DiscordBot } from "./discord.js";
import type { GitHubAppAuth } from "./github-app.js";
import type { BotPool } from "./pool.js";
import type { PRWatchStore } from "./pr-watches.js";
import { QueueFullError } from "./queue.js";
import type { TaskQueue, TaskSubmission } from "./queue.js";
import type { EntityRegistry } from "./registry.js";
import {
  format_sentry_alert,
  format_sentry_alert_minimal,
  get_cached_issue_details,
} from "./sentry-alert-format.js";
import { fetch_sentry_issue_details } from "./sentry-api.js";
import {
  type SentryTriageContext,
  handle_sentry_resolved,
  handle_sentry_triage_event,
} from "./sentry-triage.js";
import * as sentry from "./sentry.js";
import type { ClaudeSessionManager } from "./session.js";
import { type WebhookContext, handle_github_webhook } from "./webhook-handler.js";

interface ServerContext {
  registry: EntityRegistry;
  config: LobsterFarmConfig;
  session_manager: ClaudeSessionManager;
  queue: TaskQueue;
  commander: CommanderProcess | null;
  discord: DiscordBot | null;
  pool: BotPool | null;
  github_app: GitHubAppAuth | null;
  pr_watches: PRWatchStore | null;
  alert_router: AlertRouter | null;
}

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
) => void | Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  handler: RouteHandler;
}

const start_time = Date.now();

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

// ── Route handlers ──

const handle_status: RouteHandler = (_req, res, ctx) => {
  const uptime_seconds = Math.floor((Date.now() - start_time) / 1000);
  const queue_stats = ctx.queue.get_stats();
  json_response(res, 200, {
    running: true,
    uptime_seconds,
    entities: {
      total: ctx.registry.count(),
      active: ctx.registry.get_active().length,
    },
    sessions: {
      active: ctx.session_manager.get_active().length,
      active_details: ctx.session_manager.get_active().map((s) => ({
        session_id: s.session_id,
        entity_id: s.entity_id,
        feature_id: s.feature_id,
        archetype: s.archetype,
        started_at: s.started_at.toISOString(),
        pid: s.pid,
      })),
    },
    queue: queue_stats,
    pool: ctx.pool?.get_status() ?? null,
    commander: ctx.commander?.health_check() ?? { state: "not_configured" },
    github_app: ctx.github_app ? "configured" : "not_configured",
  });
};

const handle_entities_list: RouteHandler = (_req, res, ctx) => {
  const entities = ctx.registry.get_all().map((e) => ({
    id: e.entity.id,
    name: e.entity.name,
    status: e.entity.status,
  }));
  json_response(res, 200, entities);
};

const handle_entity_detail: RouteHandler = (req, res, ctx) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const match = url.pathname.match(/^\/entities\/([a-z0-9-]+)$/);
  const entity_id = match?.[1];
  if (!entity_id) {
    json_response(res, 400, { error: "Invalid entity ID" });
    return;
  }

  const entity = ctx.registry.get(entity_id);
  if (!entity) {
    json_response(res, 404, { error: `Entity "${entity_id}" not found` });
    return;
  }

  json_response(res, 200, entity);
};

const handle_webhook_github: RouteHandler = async (req, res, ctx) => {
  if (!ctx.github_app) {
    // Fallback when GitHub App is not configured — log and accept
    const body = await read_body(req);
    console.log("[webhook] GitHub webhook received but App not configured:", body.slice(0, 200));
    json_response(res, 200, { ok: true, warning: "GitHub App not configured" });
    return;
  }

  const webhook_ctx: WebhookContext = {
    github_app: ctx.github_app,
    session_manager: ctx.session_manager,
    registry: ctx.registry,
    discord: ctx.discord,
    config: ctx.config,
    pool: ctx.pool,
    pr_watches: ctx.pr_watches,
    alert_router: ctx.alert_router,
  };

  await handle_github_webhook(req, res, webhook_ctx);
};

const handle_webhook_sentry: RouteHandler = async (req, res, ctx) => {
  const raw_body = await read_body(req);

  // Respond quickly after buffering body — process asynchronously
  json_response(res, 200, { ok: true });

  // Process the webhook event async
  void process_sentry_webhook(req, raw_body, ctx).catch((err) => {
    console.error(`[sentry-webhook] Error processing event: ${String(err)}`);
    sentry.captureException(err, {
      tags: { module: "webhook", webhook_source: "sentry" },
    });
  });
};

/** Verify Sentry webhook HMAC-SHA256 signature. */
function verify_sentry_signature(body: string, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(body, "utf-8").digest("hex");
  try {
    return timingSafeEqual(Buffer.from(expected, "utf-8"), Buffer.from(signature, "utf-8"));
  } catch {
    return false;
  }
}

/** Process a Sentry webhook event asynchronously (after 200 response). */
async function process_sentry_webhook(
  req: IncomingMessage,
  raw_body: string,
  ctx: ServerContext,
): Promise<void> {
  // Verify signature — reject entirely if webhook secret is not configured
  const webhook_secret = process.env.SENTRY_WEBHOOK_SECRET;
  if (!webhook_secret) {
    console.error("[sentry-webhook] SENTRY_WEBHOOK_SECRET not configured — rejecting webhook");
    return;
  }

  const signature = req.headers["sentry-hook-signature"] as string | undefined;
  if (!signature || !verify_sentry_signature(raw_body, signature, webhook_secret)) {
    console.log("[sentry-webhook] Invalid or missing signature -- rejecting");
    return;
  }

  const resource = req.headers["sentry-hook-resource"] as string | undefined;
  console.log(`[sentry-webhook] Received ${resource ?? "unknown"} event`);

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw_body) as Record<string, unknown>;
  } catch {
    console.log("[sentry-webhook] Invalid JSON payload");
    return;
  }

  // Only process issue resources
  if (resource !== "issue") {
    console.log(`[sentry-webhook] Ignoring resource type: ${resource ?? "unknown"}`);
    return;
  }

  // Extract error info from payload
  const data = payload.data as Record<string, unknown> | undefined;
  if (!data) return;

  const issue = data.issue as Record<string, unknown> | undefined;
  const error_title = (issue?.title as string) ?? "Unknown error";
  const issue_url =
    (issue?.web_url as string) ?? (issue?.permalink as string) ?? (issue?.shortId as string) ?? "";
  const action = payload.action as string | undefined;

  // Extract project slug for entity routing and triage.
  // Sentry sends the project inside data.issue.project.slug or data.project.
  const issue_project = issue?.project as Record<string, unknown> | undefined;
  const data_project = data.project as Record<string, unknown> | undefined;
  const project_slug =
    (issue_project?.slug as string) ??
    (data_project?.slug as string) ??
    (data.project_name as string) ??
    "unknown";

  // Extract the Sentry issue ID for dedup/triage tracking
  const sentry_issue_id = (issue?.id as string) ?? "";

  // Try to map Sentry project to an entity for targeted Discord routing.
  // First checks projects[] array (new config), then falls back to legacy
  // accounts.sentry.project field.
  let target_entity_id: string | null = null;
  for (const entity of ctx.registry.get_active()) {
    const sentry_config = (entity.entity.accounts as Record<string, unknown>)?.sentry as
      | Record<string, unknown>
      | undefined;
    if (!sentry_config) continue;

    // New: projects[] array
    const projects = sentry_config.projects as Array<Record<string, unknown>> | undefined;
    if (projects?.some((p) => p.slug === project_slug)) {
      target_entity_id = entity.entity.id;
      break;
    }

    // Legacy: single project string (project_name match)
    if (sentry_config.project === project_slug) {
      target_entity_id = entity.entity.id;
      break;
    }
  }

  // ── Event classification ──
  // created / regression → triage (Ray session) + alert
  // resolved              → alert only (+ update triage state)
  // unresolved            → alert only
  // assigned / archived   → ignore

  const triage_actions = ["created", "regression"];
  const ignore_actions = ["assigned", "archived"];

  if (resource === "issue" && action && ignore_actions.includes(action)) {
    console.log(`[sentry-webhook] Ignoring issue.${action} event`);
    return;
  }

  sentry.addBreadcrumb({
    category: "daemon.api",
    message: `Sentry webhook: ${resource}.${action ?? "unknown"}`,
    data: { project: project_slug, error_title },
  });

  // ── Triage path ──
  if (resource === "issue" && action && triage_actions.includes(action) && sentry_issue_id) {
    const triage_ctx: SentryTriageContext = {
      session_manager: ctx.session_manager,
      registry: ctx.registry,
      discord: ctx.discord,
      config: ctx.config,
      alert_router: ctx.alert_router,
    };

    // Fire-and-forget: triage runs async; failure is caught inside
    void handle_sentry_triage_event(sentry_issue_id, project_slug, action, triage_ctx).catch(
      (err) => {
        console.error(`[sentry-webhook] Triage error for ${sentry_issue_id}: ${String(err)}`);
        sentry.captureException(err, {
          tags: { module: "sentry-triage", project: project_slug },
          contexts: { issue: { id: sentry_issue_id, title: error_title } },
        });
      },
    );
  }

  // ── Resolved state update ──
  if (resource === "issue" && action === "resolved" && sentry_issue_id) {
    void handle_sentry_resolved(sentry_issue_id, ctx.config).catch((err) => {
      console.error(`[sentry-webhook] Failed to update resolved state: ${String(err)}`);
    });
  }

  // ── Alert forwarding ──
  // Always post an alert to Discord for issue events (except ignored ones).
  // Triage-worthy events also get a Ray session (spawned above).
  //
  // The initial alert is enriched with data fetched from the Sentry API
  // (#259) so it stands on its own without waiting for Ray's follow-up.
  // Enrichment is cached for 30s so the triage path does not double-fetch.
  // Any failure during enrichment falls back to the minimal legacy format —
  // we never drop the alert.
  const webhook_short_id = (issue?.shortId as string) ?? null;
  const alert_message = await build_sentry_alert_message({
    action,
    sentry_issue_id,
    webhook_short_id,
    project_slug,
    error_title,
    issue_url,
  });

  // Route through the tiered alert system (#253).
  // error/fatal + triage-worthy (created/regression) → incident_open (top-level embed + thread)
  // warning/other or non-triage actions → routine (daily thread)
  const sentry_level = (issue?.level as string) ?? "error";
  const is_triage_worthy = triage_actions.includes(action ?? "");
  const is_high_severity = sentry_level === "fatal" || sentry_level === "error";
  const effective_entity_id = target_entity_id ?? ctx.registry.get_active()[0]?.entity.id ?? null;

  if (ctx.alert_router && effective_entity_id) {
    if (is_triage_worthy && is_high_severity) {
      // Tier 3: incident thread for error/fatal triage events
      await ctx.alert_router.post_alert({
        entity_id: effective_entity_id,
        tier: "incident_open",
        title: `\u{1f534} Sentry [${sentry_level}]: ${error_title}`,
        body: alert_message,
        embed_color: ALERT_COLOR_RED,
      });
    } else {
      // Tier 2: routine (resolved, unresolved, warnings, P2/P3)
      await ctx.alert_router.post_alert({
        entity_id: effective_entity_id,
        tier: "routine",
        title: `Sentry [${action ?? "event"}]`,
        body: alert_message,
      });
    }
  } else if (ctx.discord) {
    // Fallback: no alert_router, use direct Discord send
    if (target_entity_id) {
      await ctx.discord.send_to_entity(target_entity_id, "alerts", alert_message, "system");
    } else {
      const first_active = ctx.registry.get_active()[0];
      if (first_active) {
        await ctx.discord.send_to_entity(first_active.entity.id, "alerts", alert_message, "system");
      }
    }
  }

  console.log(`[sentry-webhook] Processed: ${resource}.${action ?? "unknown"} — ${error_title}`);
}

/**
 * Build the Discord alert message for a Sentry webhook event.
 *
 * Attempts to enrich via `fetch_sentry_issue_details()` (through the shared
 * cache). On any failure — missing credentials, API error, timeout — falls
 * back to the minimal legacy format so the alert is never dropped.
 */
async function build_sentry_alert_message(opts: {
  action: string | undefined;
  sentry_issue_id: string;
  webhook_short_id: string | null;
  project_slug: string;
  error_title: string;
  issue_url: string;
}): Promise<string> {
  const { action, sentry_issue_id, webhook_short_id, project_slug, error_title, issue_url } = opts;

  const auth_token = process.env.SENTRY_AUTH_TOKEN;
  const org_slug = process.env.SENTRY_ORG;

  // No creds or no issue id → minimal format only, nothing to enrich with.
  if (!sentry_issue_id || !auth_token || !org_slug) {
    return format_sentry_alert_minimal({ action, error_title, project_slug, issue_url });
  }

  try {
    const details = await get_cached_issue_details(sentry_issue_id, () =>
      fetch_sentry_issue_details(sentry_issue_id, auth_token, org_slug),
    );

    return format_sentry_alert({
      action,
      short_id: details.short_id ?? webhook_short_id,
      project_slug,
      details,
      top_frame: details.top_frame,
    });
  } catch (err) {
    // Breadcrumb for postmortem; never throw past this point.
    sentry.addBreadcrumb({
      category: "sentry-webhook",
      message: `Alert enrichment failed for issue ${sentry_issue_id}`,
      level: "warning",
      data: { error: String(err), project: project_slug },
    });
    console.warn(
      `[sentry-webhook] Enrichment failed for ${sentry_issue_id}, falling back to minimal format: ${String(err)}`,
    );
    return format_sentry_alert_minimal({ action, error_title, project_slug, issue_url });
  }
}

// ── Hook endpoints ──

const handle_stop_hook: RouteHandler = async (req, res) => {
  const body = await read_body(req);
  console.log("[hooks] Stop hook triggered:", body.slice(0, 200));
  json_response(res, 200, { ok: true });
};

// ── Task routes ──

const handle_submit_task: RouteHandler = async (req, res, ctx) => {
  const body = await read_body(req);
  let submission: TaskSubmission;
  try {
    submission = JSON.parse(body) as TaskSubmission;
  } catch {
    json_response(res, 400, { error: "Invalid JSON body" });
    return;
  }

  // Validate required fields
  if (!submission.entity_id || !submission.prompt || !submission.archetype) {
    json_response(res, 400, {
      error: "Missing required fields: entity_id, prompt, archetype",
    });
    return;
  }

  // Default worktree_path from entity config if not provided
  if (!submission.worktree_path) {
    const entity = ctx.registry.get(submission.entity_id);
    if (entity) {
      submission.worktree_path = expand_home(entity.entity.repos[0]?.path ?? "");
    } else {
      json_response(res, 404, {
        error: `Entity "${submission.entity_id}" not found`,
      });
      return;
    }
  }

  try {
    const task_id = ctx.queue.submit(submission);
    json_response(res, 201, { task_id });
  } catch (err) {
    if (err instanceof QueueFullError) {
      json_response(res, 429, { error: err.message });
      return;
    }
    throw err;
  }
};

const handle_list_tasks: RouteHandler = (_req, res, ctx) => {
  json_response(res, 200, {
    pending: ctx.queue.get_pending().map(task_summary),
    active: ctx.queue.get_active().map(task_summary),
    stats: ctx.queue.get_stats(),
  });
};

const handle_cancel_task: RouteHandler = (req, res, ctx) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const match = url.pathname.match(/^\/tasks\/([a-f0-9-]+)$/);
  const task_id = match?.[1];
  if (!task_id) {
    json_response(res, 400, { error: "Invalid task ID" });
    return;
  }

  const cancelled = ctx.queue.cancel(task_id);
  if (cancelled) {
    json_response(res, 200, { ok: true, task_id });
  } else {
    json_response(res, 404, {
      error: `Task "${task_id}" not found in queue (may be active or already completed)`,
    });
  }
};

function task_summary(task: {
  id: string;
  entity_id: string;
  feature_id: string;
  archetype: string;
  priority: string;
  status: string;
  submitted_at: Date;
}) {
  return {
    id: task.id,
    entity_id: task.entity_id,
    feature_id: task.feature_id,
    archetype: task.archetype,
    priority: task.priority,
    status: task.status,
    submitted_at: task.submitted_at.toISOString(),
  };
}

// ── Scaffold routes ──

const handle_scaffold_entity: RouteHandler = async (req, res, ctx) => {
  const body = await read_body(req);
  let params: { entity_id?: string; entity_name?: string };
  try {
    params = JSON.parse(body) as { entity_id?: string; entity_name?: string };
  } catch {
    json_response(res, 400, { error: "Invalid JSON body" });
    return;
  }

  if (!params.entity_id || !params.entity_name) {
    json_response(res, 400, { error: "Missing required fields: entity_id, entity_name" });
    return;
  }

  if (!ctx.discord) {
    json_response(res, 503, { error: "Discord bot not connected" });
    return;
  }

  try {
    const result = await ctx.discord.scaffold_entity(params.entity_id, params.entity_name);
    json_response(res, 201, result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    json_response(res, 500, { error: msg });
  }
};

const handle_reload: RouteHandler = async (_req, res, ctx) => {
  try {
    await ctx.registry.load_all();
    if (ctx.discord) {
      ctx.discord.build_channel_map();
    }
    json_response(res, 200, {
      ok: true,
      entities: ctx.registry.count(),
      active: ctx.registry.get_active().length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    json_response(res, 500, { error: msg });
  }
};

// ── Pool routes ──

const handle_pool_status: RouteHandler = (_req, res, ctx) => {
  if (!ctx.pool) {
    json_response(res, 503, { error: "Bot pool not initialized" });
    return;
  }
  json_response(res, 200, ctx.pool.get_status());
};

const handle_pool_assign: RouteHandler = async (req, res, ctx) => {
  if (!ctx.pool) {
    json_response(res, 503, { error: "Bot pool not initialized" });
    return;
  }

  const body = await read_body(req);
  let params: {
    channel_id?: string;
    entity_id?: string;
    archetype?: string;
    resume_session_id?: string;
  };
  try {
    params = JSON.parse(body) as typeof params;
  } catch {
    json_response(res, 400, { error: "Invalid JSON body" });
    return;
  }

  if (!params.channel_id || !params.entity_id || !params.archetype) {
    json_response(res, 400, { error: "Missing required fields: channel_id, entity_id, archetype" });
    return;
  }

  const assignment = await ctx.pool.assign(
    params.channel_id,
    params.entity_id,
    params.archetype as ArchetypeRole,
    params.resume_session_id,
  );

  if (!assignment) {
    json_response(res, 503, { error: "No pool bots available" });
    return;
  }

  json_response(res, 200, assignment);
};

const handle_pool_release: RouteHandler = async (req, res, ctx) => {
  if (!ctx.pool) {
    json_response(res, 503, { error: "Bot pool not initialized" });
    return;
  }

  const body = await read_body(req);
  let params: { channel_id?: string };
  try {
    params = JSON.parse(body) as typeof params;
  } catch {
    json_response(res, 400, { error: "Invalid JSON body" });
    return;
  }

  if (!params.channel_id) {
    json_response(res, 400, { error: "Missing required field: channel_id" });
    return;
  }

  await ctx.pool.release(params.channel_id);
  json_response(res, 200, { ok: true });
};

// ── PR Watch routes ──

const handle_pr_watch: RouteHandler = async (req, res, ctx) => {
  if (!ctx.pr_watches) {
    json_response(res, 503, { error: "PR watch store not initialized" });
    return;
  }

  const body = await read_body(req);
  let params: { repo?: string; pr_number?: number; channel_id?: string };
  try {
    params = JSON.parse(body) as typeof params;
  } catch {
    json_response(res, 400, { error: "Invalid JSON body" });
    return;
  }

  if (!params.repo || !params.pr_number || !params.channel_id) {
    json_response(res, 400, { error: "Missing required fields: repo, pr_number, channel_id" });
    return;
  }

  if (typeof params.pr_number !== "number" || params.pr_number <= 0) {
    json_response(res, 400, { error: "pr_number must be a positive integer" });
    return;
  }

  await ctx.pr_watches.add(params.repo, params.pr_number, params.channel_id);
  json_response(res, 201, { ok: true, watch_key: `${params.repo}#${String(params.pr_number)}` });
};

// ── Channel routes ──

const PROTECTED_CHANNEL_TYPES = ["general", "alerts"];

const handle_channel_delete: RouteHandler = async (req, res, ctx) => {
  if (!ctx.discord) {
    json_response(res, 503, { error: "Discord bot not connected" });
    return;
  }

  const body = await read_body(req);
  let params: { channel_id?: string; entity_id?: string };
  try {
    params = JSON.parse(body) as typeof params;
  } catch {
    json_response(res, 400, { error: "Invalid JSON body" });
    return;
  }

  if (!params.channel_id || !params.entity_id) {
    json_response(res, 400, { error: "Missing required fields: channel_id, entity_id" });
    return;
  }

  if (!is_discord_snowflake(params.channel_id)) {
    json_response(res, 400, {
      error: `Invalid channel ID "${params.channel_id}" — not a Discord snowflake`,
    });
    return;
  }

  // Validate entity exists
  const entity = ctx.registry.get(params.entity_id);
  if (!entity) {
    json_response(res, 404, { error: `Entity "${params.entity_id}" not found` });
    return;
  }

  // Validate channel belongs to entity
  const channel_entry = entity.entity.channels.list.find((c) => c.id === params.channel_id);
  if (!channel_entry) {
    json_response(res, 404, { error: "Channel not in entity config" });
    return;
  }

  // Don't allow deleting general or alerts
  if (PROTECTED_CHANNEL_TYPES.includes(channel_entry.type)) {
    json_response(res, 400, { error: `Cannot delete ${channel_entry.type} channels` });
    return;
  }

  // Release any pool bot assigned to this channel
  if (ctx.pool) {
    const assignment = ctx.pool.get_assignment(params.channel_id);
    if (assignment) await ctx.pool.release(params.channel_id);
  }

  // Delete Discord channel
  const deleted = await ctx.discord.delete_channel(params.channel_id);
  if (!deleted) {
    json_response(res, 502, { error: "Failed to delete Discord channel" });
    return;
  }

  // Remove from entity config
  entity.entity.channels.list = entity.entity.channels.list.filter(
    (c) => c.id !== params.channel_id,
  );
  await persist_entity_config(entity);

  // Rebuild channel map
  ctx.discord.build_channel_map();

  json_response(res, 200, { ok: true, deleted: params.channel_id });
};

// ── Lockdown route ──

const handle_lockdown: RouteHandler = async (_req, res, ctx) => {
  if (!ctx.discord) {
    json_response(res, 503, { error: "Discord bot not connected" });
    return;
  }

  try {
    const result = await ctx.discord.lockdown();
    json_response(res, 200, { ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    json_response(res, 500, { error: msg });
  }
};

// ── Router ──

const routes: Route[] = [
  { method: "GET", pattern: /^\/status$/, handler: handle_status },
  { method: "GET", pattern: /^\/entities$/, handler: handle_entities_list },
  { method: "GET", pattern: /^\/entities\/[a-z0-9-]+$/, handler: handle_entity_detail },
  { method: "POST", pattern: /^\/tasks$/, handler: handle_submit_task },
  { method: "GET", pattern: /^\/tasks$/, handler: handle_list_tasks },
  { method: "DELETE", pattern: /^\/tasks\/[a-f0-9-]+$/, handler: handle_cancel_task },
  { method: "GET", pattern: /^\/pool$/, handler: handle_pool_status },
  { method: "POST", pattern: /^\/pool\/assign$/, handler: handle_pool_assign },
  { method: "POST", pattern: /^\/pool\/release$/, handler: handle_pool_release },
  { method: "POST", pattern: /^\/pr\/watch$/, handler: handle_pr_watch },
  { method: "POST", pattern: /^\/channels\/delete$/, handler: handle_channel_delete },
  { method: "POST", pattern: /^\/scaffold\/entity$/, handler: handle_scaffold_entity },
  { method: "POST", pattern: /^\/lockdown$/, handler: handle_lockdown },
  { method: "POST", pattern: /^\/reload$/, handler: handle_reload },
  { method: "POST", pattern: /^\/webhooks\/github$/, handler: handle_webhook_github },
  { method: "POST", pattern: /^\/webhooks\/sentry$/, handler: handle_webhook_sentry },
  { method: "POST", pattern: /^\/hooks\/stop$/, handler: handle_stop_hook },
];

function route_request(req: IncomingMessage, res: ServerResponse, ctx: ServerContext): void {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const method = req.method ?? "GET";

  for (const route of routes) {
    if (route.method === method && route.pattern.test(url.pathname)) {
      void Promise.resolve(route.handler(req, res, ctx)).catch((err: unknown) => {
        console.error("Route handler error:", err);
        sentry.captureException(err, {
          tags: { module: "server", route: url.pathname },
        });
        if (!res.headersSent) {
          json_response(res, 500, { error: "Internal server error" });
        }
      });
      return;
    }
  }

  json_response(res, 404, { error: "Not found" });
}

/** Create and start the HTTP server. Returns the server instance. */
export function start_server(
  registry: EntityRegistry,
  config: LobsterFarmConfig,
  session_manager: ClaudeSessionManager,
  queue: TaskQueue,
  commander: CommanderProcess | null = null,
  discord: DiscordBot | null = null,
  pool: BotPool | null = null,
  github_app: GitHubAppAuth | null = null,
  pr_watches: PRWatchStore | null = null,
  alert_router: AlertRouter | null = null,
  port: number = DAEMON_PORT,
): Server {
  const ctx: ServerContext = {
    registry,
    config,
    session_manager,
    queue,
    commander,
    discord,
    pool,
    github_app,
    pr_watches,
    alert_router,
  };

  const server = createServer((req, res) => {
    route_request(req, res, ctx);
  });

  server.listen(port, () => {
    console.log(`LobsterFarm daemon listening on http://localhost:${String(port)}`);
  });

  return server;
}
