import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { DAEMON_PORT } from "@lobster-farm/shared";
import type { EntityRegistry } from "./registry.js";
import type { ClaudeSessionManager } from "./session.js";
import type { TaskQueue, TaskSubmission } from "./queue.js";

interface ServerContext {
  registry: EntityRegistry;
  config: LobsterFarmConfig;
  session_manager: ClaudeSessionManager;
  queue: TaskQueue;
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
      submission.worktree_path = entity.entity.repo.path;
    } else {
      json_response(res, 404, {
        error: `Entity "${submission.entity_id}" not found`,
      });
      return;
    }
  }

  const task_id = ctx.queue.submit(submission);
  json_response(res, 201, { task_id });
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

// ── Router ──

const routes: Route[] = [
  { method: "GET", pattern: /^\/status$/, handler: handle_status },
  { method: "GET", pattern: /^\/entities$/, handler: handle_entities_list },
  { method: "GET", pattern: /^\/entities\/[a-z0-9-]+$/, handler: handle_entity_detail },
  { method: "POST", pattern: /^\/tasks$/, handler: handle_submit_task },
  { method: "GET", pattern: /^\/tasks$/, handler: handle_list_tasks },
  { method: "DELETE", pattern: /^\/tasks\/[a-f0-9-]+$/, handler: handle_cancel_task },
  { method: "POST", pattern: /^\/webhooks\/github$/, handler: handle_webhook_github },
  { method: "POST", pattern: /^\/webhooks\/sentry$/, handler: handle_webhook_sentry },
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
  port: number = DAEMON_PORT,
): Server {
  const ctx: ServerContext = { registry, config, session_manager, queue };

  const server = createServer((req, res) => {
    route_request(req, res, ctx);
  });

  server.listen(port, () => {
    console.log(`LobsterFarm daemon listening on http://localhost:${String(port)}`);
  });

  return server;
}
