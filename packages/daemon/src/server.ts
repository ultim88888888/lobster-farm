import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { DAEMON_PORT } from "@lobster-farm/shared";
import type { EntityRegistry } from "./registry.js";
import type { ClaudeSessionManager } from "./session.js";
import { QueueFullError } from "./queue.js";
import type { TaskQueue, TaskSubmission } from "./queue.js";
import type { CommanderProcess } from "./commander-process.js";
import { is_discord_snowflake } from "./discord.js";
import type { DiscordBot } from "./discord.js";
import type { BotPool } from "./pool.js";
import type { ArchetypeRole } from "@lobster-farm/shared";
import { persist_entity_config } from "./actions.js";
import type { GitHubAppAuth } from "./github-app.js";
import { handle_github_webhook, type WebhookContext } from "./webhook-handler.js";
import { createHmac, timingSafeEqual } from "node:crypto";
import * as sentry from "./sentry.js";

interface ServerContext {
  registry: EntityRegistry;
  config: LobsterFarmConfig;
  session_manager: ClaudeSessionManager;
  queue: TaskQueue;
  commander: CommanderProcess | null;
  discord: DiscordBot | null;
  pool: BotPool | null;
  github_app: GitHubAppAuth | null;
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
  // Verify signature if webhook secret is configured
  const webhook_secret = process.env["SENTRY_WEBHOOK_SECRET"];
  if (!webhook_secret) {
    console.warn("[sentry-webhook] SENTRY_WEBHOOK_SECRET not configured — webhook is unauthenticated");
  } else {
    const signature = req.headers["sentry-hook-signature"] as string | undefined;
    if (!signature || !verify_sentry_signature(raw_body, signature, webhook_secret)) {
      console.log("[sentry-webhook] Invalid or missing signature -- rejecting");
      return;
    }
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

  // Only process issue and event_alert resources
  if (resource !== "issue" && resource !== "event_alert") {
    console.log(`[sentry-webhook] Ignoring resource type: ${resource ?? "unknown"}`);
    return;
  }

  // Extract error info from payload
  const data = payload["data"] as Record<string, unknown> | undefined;
  if (!data) return;

  const issue = (resource === "issue" ? data : data["issue"]) as Record<string, unknown> | undefined;
  const error_title = (issue?.["title"] as string) ?? "Unknown error";
  const issue_url = (issue?.["web_url"] as string) ?? (issue?.["shortId"] as string) ?? "";
  const project_name = (data["project_name"] as string) ??
    ((data["project"] as Record<string, unknown>)?.["name"] as string) ?? "unknown";

  // Try to map Sentry project to an entity for targeted routing
  let target_entity_id: string | null = null;
  for (const entity of ctx.registry.get_active()) {
    const sentry_project = (entity.entity.accounts as Record<string, unknown>)?.["sentry"] as Record<string, unknown> | undefined;
    if (sentry_project?.["project"] === project_name) {
      target_entity_id = entity.entity.id;
      break;
    }
  }

  // Format alert message
  const action = payload["action"] as string | undefined;
  const env = (issue?.["environment"] as string) ?? "";
  const prefix = action === "resolved" ? "Resolved" : "Sentry";
  const env_part = env ? ` | Env: ${env}` : "";
  const alert_message = `${prefix}: ${error_title}\nProject: ${project_name}${env_part}\n${issue_url}`;

  sentry.addBreadcrumb({
    category: "daemon.api",
    message: `Sentry webhook: ${resource}.${action ?? "unknown"}`,
    data: { project: project_name, error_title },
  });

  // Post to entity alerts channel, or fall back to all active entities
  if (ctx.discord) {
    if (target_entity_id) {
      await ctx.discord.send_to_entity(target_entity_id, "alerts", alert_message, "system");
    } else {
      // No entity mapping -- post to first active entity's alerts as a catch-all
      const first_active = ctx.registry.get_active()[0];
      if (first_active) {
        await ctx.discord.send_to_entity(first_active.entity.id, "alerts", alert_message, "system");
      }
    }
  }

  console.log(`[sentry-webhook] Alert forwarded: ${error_title}`);
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
      submission.worktree_path = entity.entity.repos[0]?.path;
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

function task_summary(task: { id: string; entity_id: string; feature_id: string; archetype: string; priority: string; status: string; submitted_at: Date }) {
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
  let params: { channel_id?: string; entity_id?: string; archetype?: string; resume_session_id?: string };
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
    json_response(res, 400, { error: `Invalid channel ID "${params.channel_id}" — not a Discord snowflake` });
    return;
  }

  // Validate entity exists
  const entity = ctx.registry.get(params.entity_id);
  if (!entity) {
    json_response(res, 404, { error: `Entity "${params.entity_id}" not found` });
    return;
  }

  // Validate channel belongs to entity
  const channel_entry = entity.entity.channels.list.find(c => c.id === params.channel_id);
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
  entity.entity.channels.list = entity.entity.channels.list.filter(c => c.id !== params.channel_id);
  await persist_entity_config(entity);

  // Rebuild channel map
  ctx.discord.build_channel_map();

  json_response(res, 200, { ok: true, deleted: params.channel_id });
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
  { method: "POST", pattern: /^\/channels\/delete$/, handler: handle_channel_delete },
  { method: "POST", pattern: /^\/scaffold\/entity$/, handler: handle_scaffold_entity },
  { method: "POST", pattern: /^\/reload$/, handler: handle_reload },
  { method: "POST", pattern: /^\/webhooks\/github$/, handler: handle_webhook_github },
  { method: "POST", pattern: /^\/webhooks\/sentry$/, handler: handle_webhook_sentry },
  { method: "POST", pattern: /^\/hooks\/stop$/, handler: handle_stop_hook },
];

function route_request(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
): void {
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
  port: number = DAEMON_PORT,
): Server {
  const ctx: ServerContext = { registry, config, session_manager, queue, commander, discord, pool, github_app };

  const server = createServer((req, res) => {
    route_request(req, res, ctx);
  });

  server.listen(port, () => {
    console.log(`LobsterFarm daemon listening on http://localhost:${String(port)}`);
  });

  return server;
}
