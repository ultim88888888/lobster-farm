import type { Server } from "node:http";
import { load_config } from "./config.js";
import { EntityRegistry } from "./registry.js";
import { ClaudeSessionManager } from "./session.js";
import { TaskQueue } from "./queue.js";
import { FeatureManager } from "./features.js";
import { DiscordBot, resolve_bot_token } from "./discord.js";
import { set_discord_bot, set_feature_manager } from "./actions.js";
import { start_server } from "./server.js";
import { write_pid, remove_pid } from "./pid.js";
import { CommanderProcess } from "./commander-process.js";
import { BotPool } from "./pool.js";
import { PRReviewCron } from "./pr-cron.js";

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

  // Initialize session manager + task queue + feature manager
  const session_manager = new ClaudeSessionManager(config);
  const queue = new TaskQueue(session_manager, config);
  const feature_manager = new FeatureManager(registry, queue, config);
  await feature_manager.load_persisted();
  set_feature_manager(feature_manager);

  // Wire up session events to feature manager
  session_manager.on("session:started", (session) => {
    feature_manager.on_session_started(session);
  });
  session_manager.on("session:completed", (result) => {
    void feature_manager.on_session_completed(result);
  });
  session_manager.on("session:failed", (session_id: string, error: string) => {
    feature_manager.on_session_failed(session_id, error);
  });

  console.log(
    `Session manager ready (max ${String(config.concurrency.max_active_sessions)} concurrent sessions)`,
  );

  // Initialize bot pool and pre-assign planners to #general channels
  const pool = new BotPool(config);
  await pool.initialize();
  await pool.pre_assign_generals(registry);

  // Initialize Discord bot (optional — daemon works without it via HTTP API)
  const discord = new DiscordBot(config, registry);
  let discord_connected = false;

  const bot_token = await resolve_bot_token(config);
  if (bot_token) {
    try {
      discord.set_managers(feature_manager, queue);
      discord.set_pool(pool);
      set_discord_bot(discord);
      await discord.connect(bot_token);
      discord_connected = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[discord] Failed to connect: ${msg}`);
      console.log("[discord] Daemon will continue without Discord. HTTP API still available.");
    }
  } else {
    console.log(
      "[discord] No bot token found. Set DISCORD_BOT_TOKEN env var or configure 1Password reference.",
    );
    console.log("[discord] Daemon will run with HTTP API only.");
  }

  // Initialize Commander (persistent Claude Code session with Discord channel)
  const commander = new CommanderProcess(config);
  if (await commander.has_token()) {
    try {
      await commander.start();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[commander] Failed to start: ${msg}`);
    }
  } else {
    console.log("[commander] No token configured. Pat will not start.");
    console.log("[commander] Add token to ~/.lobsterfarm/channels/pat/.env and restart.");
  }

  // Start HTTP server
  const server = start_server(registry, config, session_manager, queue, feature_manager, commander, discord_connected ? discord : null, pool);

  // Start PR review cron
  const pr_cron = new PRReviewCron(
    registry,
    session_manager,
    config,
    discord_connected ? discord : null,
    feature_manager,
  );
  await pr_cron.start();

  // Write PID file
  await write_pid(config);
  console.log(`PID file written (pid: ${String(process.pid)})`);

  // Graceful shutdown handler
  let shutting_down = false;

  async function shutdown(signal: string): Promise<void> {
    if (shutting_down) {
      // Second signal = force kill
      console.log("[shutdown] Second signal received — forcing shutdown.");
      process.exit(1);
    }
    shutting_down = true;

    console.log(`\nReceived ${signal}. Shutting down gracefully...`);

    // Enter drain mode — no new work accepted
    pool.drain();
    pr_cron.stop();

    // Check for active work
    const work_check = pool.has_active_work();
    if (work_check.active) {
      const names = work_check.working_bots.map(b => `${b.archetype} (pool-${String(b.id)})`).join(", ");
      console.log(`[shutdown] Draining — ${String(work_check.working_bots.length)} agent(s) still working: ${names}`);

      // Notify command center
      if (discord_connected) {
        try {
          await discord.send(
            config.discord?.server_id ? "" : "",
            `Daemon shutting down — waiting for ${String(work_check.working_bots.length)} active agent(s) to finish: ${names}. Send another signal to force.`,
          );
        } catch { /* best effort */ }
      }

      // Wait indefinitely for agents to finish (second SIGTERM forces)
      while (true) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        const recheck = pool.has_active_work();
        if (!recheck.active) {
          console.log("[shutdown] All agents idle. Proceeding with shutdown.");
          break;
        }
        console.log(`[shutdown] ${String(recheck.working_bots.length)} still working...`);
      }
    }

    // Stop pool bots
    await pool.shutdown();

    // Stop Commander
    await commander.stop();

    // Disconnect Discord
    if (discord_connected) {
      await discord.disconnect();
    }

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
