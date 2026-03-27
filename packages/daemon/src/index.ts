import type { Server } from "node:http";
import { load_config } from "./config.js";
import { EntityRegistry } from "./registry.js";
import { ClaudeSessionManager } from "./session.js";
import type { ActiveSession, SessionResult } from "./session.js";
import { TaskQueue } from "./queue.js";
import { FeatureManager } from "./features.js";
import { DiscordBot, resolve_bot_token } from "./discord.js";
import { set_discord_bot, set_feature_manager, reset_idle_work_room_topics } from "./actions.js";
import { start_server } from "./server.js";
import { write_pid, remove_pid } from "./pid.js";
import { CommanderProcess } from "./commander-process.js";
import { BotPool } from "./pool.js";
import { PRReviewCron } from "./pr-cron.js";
import { check_required_binaries, propagate_tmux_env } from "./env.js";
import type { Phase } from "@lobster-farm/shared";
import { append_session_log } from "./persistence.js";

async function main(): Promise<void> {
  console.log("Starting LobsterFarm daemon...");

  // Verify environment before any initialization
  check_required_binaries();

  // Load global config
  const config = await load_config();

  // Propagate env to tmux (after config load, before pool init)
  propagate_tmux_env();

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

  // Wire up session events to feature manager + session history logging.
  // Track session metadata at start so completion/failure handlers have full context
  // even after the feature manager cleans up its session-to-feature mapping.
  interface QueueSessionMeta {
    start_ms: number;
    entity_id: string;
    feature_id: string;
    archetype: ActiveSession["archetype"];
    phase: Phase | null;
    started_at: string;
    resume: boolean;
  }
  const queue_session_meta = new Map<string, QueueSessionMeta>();

  session_manager.on("session:started", (session: ActiveSession) => {
    feature_manager.on_session_started(session);

    // Capture metadata for completion/failure logging
    const feature = feature_manager.get_feature(session.feature_id);
    const meta: QueueSessionMeta = {
      start_ms: Date.now(),
      entity_id: session.entity_id,
      feature_id: session.feature_id,
      archetype: session.archetype,
      phase: feature?.phase ?? null,
      started_at: session.started_at.toISOString(),
      resume: session.resume,
    };
    queue_session_meta.set(session.session_id, meta);

    // Log session start
    void append_session_log(session.entity_id, {
      session_id: session.session_id,
      entity_id: session.entity_id,
      feature_id: session.feature_id,
      archetype: session.archetype,
      phase: meta.phase,
      source: "queue",
      started_at: meta.started_at,
      ended_at: null,
      exit_code: null,
      duration_ms: null,
      bot_id: null,
      resume: session.resume,
    }, config);
  });

  session_manager.on("session:completed", (result: SessionResult) => {
    // Look up metadata before feature manager cleans up
    const meta = queue_session_meta.get(result.session_id);
    queue_session_meta.delete(result.session_id);

    void feature_manager.on_session_completed(result);

    // Log session completion
    if (meta) {
      const now = new Date().toISOString();
      void append_session_log(meta.entity_id, {
        session_id: result.session_id,
        entity_id: meta.entity_id,
        feature_id: meta.feature_id,
        archetype: meta.archetype,
        phase: meta.phase,
        source: "queue",
        started_at: meta.started_at,
        ended_at: now,
        exit_code: result.exit_code,
        duration_ms: Date.now() - meta.start_ms,
        bot_id: null,
        resume: meta.resume,
      }, config);
    }
  });

  session_manager.on("session:failed", (session_id: string, error: string) => {
    // Look up metadata before feature manager cleans up
    const meta = queue_session_meta.get(session_id);
    queue_session_meta.delete(session_id);

    feature_manager.on_session_failed(session_id, error);

    // Log session failure
    if (meta) {
      const now = new Date().toISOString();
      void append_session_log(meta.entity_id, {
        session_id,
        entity_id: meta.entity_id,
        feature_id: meta.feature_id,
        archetype: meta.archetype,
        phase: meta.phase,
        source: "queue",
        started_at: meta.started_at,
        ended_at: now,
        exit_code: 1,
        duration_ms: Date.now() - meta.start_ms,
        bot_id: null,
        resume: meta.resume,
      }, config);
    }
  });

  console.log(
    `Session manager ready (max ${String(config.concurrency.max_active_sessions)} concurrent sessions)`,
  );

  // Initialize bot pool — bots are assigned on first message, not on startup.
  // Pass registry so persisted state can be validated against current entities/channels.
  const pool = new BotPool(config);
  await pool.initialize(registry);

  // Wire pool to feature manager for interactive builder sessions
  feature_manager.set_pool(pool);

  // Start health monitor for detecting dead tmux sessions
  pool.start_health_monitor();

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

  // Reset stale work room topics from previous daemon runs
  if (discord_connected) {
    await reset_idle_work_room_topics(registry);
  }

  // Proactively resume bots that were assigned before shutdown.
  // Must happen after Discord connects so we can send "back online" notifications.
  // Listen for bot:resumed events and notify each channel via the daemon bot.
  pool.on("bot:resumed", ({ channel_id }: { channel_id: string }) => {
    if (discord_connected) {
      void discord.send(channel_id, "Session restored after daemon restart.");
    }
  });

  if (discord_connected) {
    await pool.resume_parked_bots();
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

    // Kill all pool bot tmux sessions. Assigned bots are persisted to
    // pool-state.json on every mutation, so on restart they'll be restored
    // as parked and resumed with --resume {session_id} — no context lost.
    // Previous approach (preserving tmux) caused state desync between
    // surviving tmux sessions and the daemon's pool metadata.
    await pool.shutdown();

    // Drain the feature persist queue so pending state writes complete before exit
    await feature_manager.drain_persist();

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
