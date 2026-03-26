import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { LobsterFarmConfig, Phase } from "@lobster-farm/shared";
import { DAEMON_PORT } from "@lobster-farm/shared";
import type { EntityRegistry } from "./registry.js";
import type { ClaudeSessionManager } from "./session.js";
import { QueueFullError } from "./queue.js";
import type { TaskQueue, TaskSubmission } from "./queue.js";
import type { FeatureManager, CreateFeatureOptions } from "./features.js";
import type { CommanderProcess } from "./commander-process.js";
import type { DiscordBot } from "./discord.js";
import type { BotPool } from "./pool.js";
import type { ArchetypeRole } from "@lobster-farm/shared";

interface ServerContext {
  registry: EntityRegistry;
  config: LobsterFarmConfig;
  session_manager: ClaudeSessionManager;
  queue: TaskQueue;
  features: FeatureManager;
  commander: CommanderProcess | null;
  discord: DiscordBot | null;
  pool: BotPool | null;
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

const handle_webhook_github: RouteHandler = async (req, res) => {
  const body = await read_body(req);
  console.log("GitHub webhook received:", body.slice(0, 200));
  json_response(res, 200, { ok: true });
};

const handle_webhook_sentry: RouteHandler = async (req, res) => {
  const body = await read_body(req);
  console.log("Sentry webhook received:", body.slice(0, 200));
  json_response(res, 200, { ok: true });
};

// ── Hook endpoints ──

const handle_stop_hook: RouteHandler = async (req, res, ctx) => {
  const body = await read_body(req);
  console.log("[hooks] Stop hook triggered:", body.slice(0, 200));

  try {
    const data = JSON.parse(body) as { session_id?: string; working_dir?: string };
    if (data.session_id) {
      // Find which feature this session belongs to and log it
      const features = ctx.features.list_features();
      const feature = features.find((f) => f.lastSessionId === data.session_id);
      if (feature) {
        console.log(`[hooks] Session ${data.session_id.slice(0, 8)} was for feature ${feature.id}`);
      }
    }
  } catch {
    // Best effort
  }

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

// ── Feature routes ──

const VALID_START_PHASES = ["plan", "design", "build"];

const handle_create_feature: RouteHandler = async (req, res, ctx) => {
  const body = await read_body(req);
  let opts: CreateFeatureOptions;
  try {
    opts = JSON.parse(body) as CreateFeatureOptions;
  } catch {
    json_response(res, 400, { error: "Invalid JSON body" });
    return;
  }

  if (!opts.entity_id || !opts.title || !opts.github_issue) {
    json_response(res, 400, {
      error: "Missing required fields: entity_id, title, github_issue",
    });
    return;
  }

  // Validate start_phase before passing to feature manager
  if (opts.start_phase !== undefined && !VALID_START_PHASES.includes(opts.start_phase)) {
    json_response(res, 400, {
      error: `Invalid start_phase "${opts.start_phase}". Must be one of: ${VALID_START_PHASES.join(", ")}`,
    });
    return;
  }

  try {
    const feature = await ctx.features.create_feature(opts);
    json_response(res, 201, feature);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    json_response(res, 400, { error: msg });
  }
};

const handle_list_features: RouteHandler = (req, res, ctx) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const entity_id = url.searchParams.get("entity_id");

  const features = entity_id
    ? ctx.features.get_features_by_entity(entity_id)
    : ctx.features.list_features();

  json_response(res, 200, features);
};

const handle_get_feature: RouteHandler = (req, res, ctx) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const match = url.pathname.match(/^\/features\/([a-z0-9-]+)$/);
  const feature_id = match?.[1];
  if (!feature_id) {
    json_response(res, 400, { error: "Invalid feature ID" });
    return;
  }

  const feature = ctx.features.get_feature(feature_id);
  if (!feature) {
    json_response(res, 404, { error: `Feature "${feature_id}" not found` });
    return;
  }

  json_response(res, 200, feature);
};

const handle_advance_feature: RouteHandler = async (req, res, ctx) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const match = url.pathname.match(/^\/features\/([a-z0-9-]+)\/advance$/);
  const feature_id = match?.[1];
  if (!feature_id) {
    json_response(res, 400, { error: "Invalid feature ID" });
    return;
  }

  let target_phase: Phase | undefined;
  const body = await read_body(req);
  if (body) {
    try {
      const parsed = JSON.parse(body) as { target_phase?: Phase };
      target_phase = parsed.target_phase;
    } catch {
      // No body is fine — auto-determine next phase
    }
  }

  try {
    const feature = await ctx.features.advance_feature(feature_id, target_phase);
    json_response(res, 200, feature);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    json_response(res, 400, { error: msg });
  }
};

const handle_approve_feature: RouteHandler = (_req, res, ctx) => {
  const url = new URL(_req.url ?? "/", `http://${_req.headers.host ?? "localhost"}`);
  const match = url.pathname.match(/^\/features\/([a-z0-9-]+)\/approve$/);
  const feature_id = match?.[1];
  if (!feature_id) {
    json_response(res, 400, { error: "Invalid feature ID" });
    return;
  }

  try {
    const feature = ctx.features.approve_phase(feature_id);
    json_response(res, 200, feature);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    json_response(res, 400, { error: msg });
  }
};

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

// ── Router ──

const routes: Route[] = [
  { method: "GET", pattern: /^\/status$/, handler: handle_status },
  { method: "GET", pattern: /^\/entities$/, handler: handle_entities_list },
  { method: "GET", pattern: /^\/entities\/[a-z0-9-]+$/, handler: handle_entity_detail },
  { method: "POST", pattern: /^\/tasks$/, handler: handle_submit_task },
  { method: "GET", pattern: /^\/tasks$/, handler: handle_list_tasks },
  { method: "DELETE", pattern: /^\/tasks\/[a-f0-9-]+$/, handler: handle_cancel_task },
  { method: "POST", pattern: /^\/features$/, handler: handle_create_feature },
  { method: "GET", pattern: /^\/features$/, handler: handle_list_features },
  { method: "GET", pattern: /^\/features\/[a-z0-9-]+$/, handler: handle_get_feature },
  { method: "POST", pattern: /^\/features\/[a-z0-9-]+\/advance$/, handler: handle_advance_feature },
  { method: "POST", pattern: /^\/features\/[a-z0-9-]+\/approve$/, handler: handle_approve_feature },
  { method: "GET", pattern: /^\/pool$/, handler: handle_pool_status },
  { method: "POST", pattern: /^\/pool\/assign$/, handler: handle_pool_assign },
  { method: "POST", pattern: /^\/pool\/release$/, handler: handle_pool_release },
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
  features: FeatureManager,
  commander: CommanderProcess | null = null,
  discord: DiscordBot | null = null,
  pool: BotPool | null = null,
  port: number = DAEMON_PORT,
): Server {
  const ctx: ServerContext = { registry, config, session_manager, queue, features, commander, discord, pool };

  const server = createServer((req, res) => {
    route_request(req, res, ctx);
  });

  server.listen(port, () => {
    console.log(`LobsterFarm daemon listening on http://localhost:${String(port)}`);
  });

  return server;
}
