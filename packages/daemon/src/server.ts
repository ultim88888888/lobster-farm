import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { DAEMON_PORT } from "@lobster-farm/shared";
import type { EntityRegistry } from "./registry.js";

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  registry: EntityRegistry,
  config: LobsterFarmConfig,
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

const handle_status: RouteHandler = (_req, res, registry) => {
  const uptime_seconds = Math.floor((Date.now() - start_time) / 1000);
  json_response(res, 200, {
    running: true,
    uptime_seconds,
    entities: {
      total: registry.count(),
      active: registry.get_active().length,
    },
    active_sessions: 0,
    queue_depth: 0,
  });
};

const handle_entities_list: RouteHandler = (_req, res, registry) => {
  const entities = registry.get_all().map((e) => ({
    id: e.entity.id,
    name: e.entity.name,
    status: e.entity.status,
  }));
  json_response(res, 200, entities);
};

const handle_entity_detail: RouteHandler = (req, res, registry) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const match = url.pathname.match(/^\/entities\/([a-z0-9-]+)$/);
  const entity_id = match?.[1];
  if (!entity_id) {
    json_response(res, 400, { error: "Invalid entity ID" });
    return;
  }

  const entity = registry.get(entity_id);
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

// ── Router ──

const routes: Route[] = [
  { method: "GET", pattern: /^\/status$/, handler: handle_status },
  { method: "GET", pattern: /^\/entities$/, handler: handle_entities_list },
  { method: "GET", pattern: /^\/entities\/[a-z0-9-]+$/, handler: handle_entity_detail },
  { method: "POST", pattern: /^\/webhooks\/github$/, handler: handle_webhook_github },
  { method: "POST", pattern: /^\/webhooks\/sentry$/, handler: handle_webhook_sentry },
];

function route_request(
  req: IncomingMessage,
  res: ServerResponse,
  registry: EntityRegistry,
  config: LobsterFarmConfig,
): void {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const method = req.method ?? "GET";

  for (const route of routes) {
    if (route.method === method && route.pattern.test(url.pathname)) {
      void Promise.resolve(route.handler(req, res, registry, config)).catch((err: unknown) => {
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
  port: number = DAEMON_PORT,
): Server {
  const server = createServer((req, res) => {
    route_request(req, res, registry, config);
  });

  server.listen(port, () => {
    console.log(`LobsterFarm daemon listening on http://localhost:${String(port)}`);
  });

  return server;
}
