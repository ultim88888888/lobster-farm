import type { Server } from "node:http";
import { load_config } from "./config.js";
import { EntityRegistry } from "./registry.js";
import { ClaudeSessionManager } from "./session.js";
import { TaskQueue } from "./queue.js";
import { start_server } from "./server.js";
import { write_pid, remove_pid } from "./pid.js";

async function main(): Promise<void> {
  console.log("Starting LobsterFarm daemon...");

  // Load global config
  const config = await load_config();

  // Initialize entity registry
  const registry = new EntityRegistry(config);
  await registry.load_all();

  console.log(
    `Loaded ${String(registry.count())} entities ` +
      `(${String(registry.get_active().length)} active)`,
  );

  // Initialize session manager + task queue
  const session_manager = new ClaudeSessionManager(config);
  const queue = new TaskQueue(session_manager, config);

  console.log(
    `Session manager ready (max ${String(config.concurrency.max_active_sessions)} concurrent sessions)`,
  );

  // Start HTTP server
  const server = start_server(registry, config, session_manager, queue);

  // Write PID file
  await write_pid(config);
  console.log(`PID file written (pid: ${String(process.pid)})`);

  // Graceful shutdown handler
  let shutting_down = false;

  async function shutdown(signal: string): Promise<void> {
    if (shutting_down) return;
    shutting_down = true;

    console.log(`\nReceived ${signal}. Shutting down gracefully...`);

    // Kill all active sessions
    const active = session_manager.get_active();
    if (active.length > 0) {
      console.log(`Stopping ${String(active.length)} active sessions...`);
      await session_manager.kill_all();
    }

    await new Promise<void>((resolve) => {
      (server as Server).close(() => {
        console.log("HTTP server closed.");
        resolve();
      });
    });

    await remove_pid(config);
    console.log("PID file removed. Goodbye.");
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main();
