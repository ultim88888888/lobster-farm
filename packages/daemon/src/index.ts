import type { Server } from "node:http";
import { set_discord_bot, set_pool } from "./actions.js";
import { AlertRouter } from "./alert-router.js";
import { AuthWatchdog } from "./auth-watchdog.js";
import { CommanderProcess } from "./commander-process.js";
import { load_config } from "./config.js";
import {
  CONTEXT_SWEEP_INTERVAL_MS,
  context_bots_from_pool,
  sweep_context_thresholds,
} from "./context-alerts.js";
import { DiscordBot, resolve_bot_token } from "./discord.js";
import { check_required_binaries, propagate_tmux_env } from "./env.js";
import { init_github_app_from_env } from "./github-app.js";
import { prune_daily_logs } from "./memory-pruning.js";
import {
  PARK_SWEEP_INTERVAL_MS,
  make_parked_approval_deps,
  sweep_parked_approvals,
} from "./parked-approvals.js";
import { append_session_log, load_context_alerts, save_context_alerts } from "./persistence.js";
import { remove_pid, write_pid } from "./pid.js";
import { BotPool } from "./pool.js";
import { PRReviewCron } from "./pr-cron.js";
import { PRWatchStore } from "./pr-watches.js";
import { TaskQueue } from "./queue.js";
import { EntityRegistry } from "./registry.js";
import * as sentry from "./sentry.js";
import { start_server } from "./server.js";
import { ClaudeSessionManager } from "./session.js";
import type { ActiveSession, SessionResult } from "./session.js";
import { query_context_usage } from "./tmux-query.js";
import { sweep_stale_worktrees } from "./worktree-cleanup.js";
import { reap_stale_worktree_locks } from "./worktree-lock-reaper.js";

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

  // Initialize session manager + task queue
  const session_manager = new ClaudeSessionManager(config);
  session_manager.set_registry(registry);
  const queue = new TaskQueue(session_manager, config);

  // Wire up session events for session history logging.
  interface QueueSessionMeta {
    start_ms: number;
    entity_id: string;
    feature_id: string;
    archetype: ActiveSession["archetype"];
    started_at: string;
    resume: boolean;
  }
  const queue_session_meta = new Map<string, QueueSessionMeta>();

  session_manager.on("session:started", (session: ActiveSession) => {
    const meta: QueueSessionMeta = {
      start_ms: Date.now(),
      entity_id: session.entity_id,
      feature_id: session.feature_id,
      archetype: session.archetype,
      started_at: session.started_at.toISOString(),
      resume: session.resume,
    };
    queue_session_meta.set(session.session_id, meta);

    // Log session start
    void append_session_log(
      session.entity_id,
      {
        session_id: session.session_id,
        entity_id: session.entity_id,
        feature_id: session.feature_id,
        archetype: session.archetype,
        phase: null,
        source: "queue",
        started_at: meta.started_at,
        ended_at: null,
        exit_code: null,
        duration_ms: null,
        bot_id: null,
        resume: session.resume,
      },
      config,
    );
  });

  session_manager.on("session:completed", (result: SessionResult) => {
    const meta = queue_session_meta.get(result.session_id);
    queue_session_meta.delete(result.session_id);

    // Log session completion
    if (meta) {
      const now = new Date().toISOString();
      void append_session_log(
        meta.entity_id,
        {
          session_id: result.session_id,
          entity_id: meta.entity_id,
          feature_id: meta.feature_id,
          archetype: meta.archetype,
          phase: null,
          source: "queue",
          started_at: meta.started_at,
          ended_at: now,
          exit_code: result.exit_code,
          duration_ms: Date.now() - meta.start_ms,
          bot_id: null,
          resume: meta.resume,
        },
        config,
      );
    }
  });

  session_manager.on("session:failed", (session_id: string, _error: string) => {
    const meta = queue_session_meta.get(session_id);
    queue_session_meta.delete(session_id);

    // Log session failure
    if (meta) {
      const now = new Date().toISOString();
      void append_session_log(
        meta.entity_id,
        {
          session_id,
          entity_id: meta.entity_id,
          feature_id: meta.feature_id,
          archetype: meta.archetype,
          phase: null,
          source: "queue",
          started_at: meta.started_at,
          ended_at: now,
          exit_code: 1,
          duration_ms: Date.now() - meta.start_ms,
          bot_id: null,
          resume: meta.resume,
        },
        config,
      );
    }
  });

  console.log(
    `Session manager ready (max ${String(config.concurrency.max_active_sessions)} concurrent sessions)`,
  );

  // Initialize bot pool — bots are assigned on first message, not on startup.
  // Pass registry so persisted state can be validated against current entities/channels.
  const pool = new BotPool(config);
  await pool.initialize(registry);

  // Wire pool to actions module so assign_work_room() checks pool state
  set_pool(pool);

  // Start health monitor for detecting dead tmux sessions
  pool.start_health_monitor();

  // Start rate-limit modal recovery monitor (issue #270)
  pool.start_rate_limit_monitor();

  // Initialize Discord bot (optional — daemon works without it via HTTP API)
  const discord = new DiscordBot(config, registry);
  let discord_connected = false;

  const bot_token = await resolve_bot_token(config);
  if (bot_token) {
    try {
      discord.set_managers(queue);
      discord.set_pool(pool);
      set_discord_bot(discord);
      await discord.connect(bot_token);
      discord_connected = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[discord] Failed to connect: ${msg}`);
      console.log("[discord] Daemon will continue without Discord. HTTP API still available.");
      sentry.captureException(err, {
        tags: { module: "startup", phase: "discord" },
      });
    }
  } else {
    console.log(
      "[discord] No bot token found. Set DISCORD_BOT_TOKEN env var or configure 1Password reference.",
    );
    console.log("[discord] Daemon will run with HTTP API only.");
  }

  // Upload agent avatars to Discord CDN (cached — only uploads on first run)
  if (discord_connected) {
    try {
      await discord.upload_avatars();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[discord:avatars] Avatar upload failed: ${msg}`);
      sentry.captureException(err, {
        tags: { module: "startup", phase: "avatars" },
      });
    }
  }

  // Proactively resume bots that were assigned before shutdown.
  // Must happen after Discord connects so we can send "back online" notifications.
  // Listen for bot:resumed events and notify each channel via the daemon bot.
  pool.on("bot:resumed", ({ channel_id }: { channel_id: string }) => {
    // Disabled: too noisy — every daemon restart floods all channels.
    // if (discord_connected) {
    //   void discord.send(channel_id, "Session restored after daemon restart.");
    // }
    void channel_id; // suppress unused warning
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
      sentry.captureException(err, {
        tags: { module: "startup", phase: "commander" },
      });
    }
  } else {
    console.log("[commander] No token configured. Pat will not start.");
    console.log("[commander] Add token to ~/.lobsterfarm/channels/pat/.env and restart.");
  }

  // Initialize GitHub App auth (optional — graceful if not configured)
  const github_app = init_github_app_from_env();
  if (github_app) {
    console.log("[github-app] Webhook-driven PR reviews enabled");
  } else {
    console.log(
      "[github-app] Not configured — webhook endpoint will accept but not process events",
    );
  }

  // Initialize PR watch store (persisted across restarts)
  const pr_watches = new PRWatchStore(config);
  await pr_watches.initialize();

  // Initialize tiered alert router (#253)
  const discord_for_routing = discord_connected ? discord : null;
  const alert_router = new AlertRouter(discord_for_routing, config);

  // Start HTTP server
  const server = start_server(
    registry,
    config,
    session_manager,
    queue,
    commander,
    discord_for_routing,
    pool,
    github_app,
    pr_watches,
    alert_router,
  );

  // Start PR review cron (safety net — 30 min when webhooks are active, 5 min otherwise)
  const pr_cron = new PRReviewCron(
    registry,
    session_manager,
    config,
    discord_for_routing,
    github_app,
    pr_watches,
    alert_router,
  );
  const pr_cron_enabled = config.pr_cron?.enabled !== false; // default true for backward compat
  if (pr_cron_enabled) {
    const cron_interval_ms = github_app ? 30 * 60 * 1000 : 5 * 60 * 1000;
    await pr_cron.start(cron_interval_ms);
  } else {
    console.log("[pr-cron] Disabled via config (pr_cron.enabled: false)");
  }

  // Start the auth-recovery watchdog (#343) — detects stale/expired shared
  // Claude OAuth creds, quarantines poisoned sessions, alerts the owner with a
  // re-login URL, accepts the pasted code via Discord, and recycles the bots.
  const auth_watchdog = new AuthWatchdog({
    config,
    registry,
    pool,
    discord: discord_for_routing,
  });
  if (discord_connected) {
    discord.set_auth_watchdog(auth_watchdog);
  }
  auth_watchdog.start();

  // Start periodic worktree cleanup (hourly) — cleans up stale worktrees from
  // merged PRs that the webhook handler missed or from manual merges.
  //
  // Two passes, in this order and never in parallel (#370):
  //
  //  1. The reaper releases locks whose owning session is gone. It releases
  //     and nothing else — no worktree is removed, no branch deleted.
  //  2. The sweep decides what to remove, with every #357/#358 guard intact.
  //
  // Sequential because the sweep reads lock state from its own `git worktree
  // list`: releasing first means a lock cleared this hour is honoured by the
  // same hour's sweep instead of waiting for the next one. The reaper's grace
  // (2h) is deliberately shorter than the sweep's (6h), so nothing is ever
  // removed on the strength of a release that just happened.
  const WORKTREE_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  const worktree_sweep_timer = setInterval(() => {
    void (async () => {
      await reap_stale_worktree_locks(registry);
      await sweep_stale_worktrees(registry);
    })().catch((err) => {
      console.error(`[worktree-cleanup] Sweep failed: ${String(err)}`);
      sentry.captureException(err, {
        tags: { module: "worktree-cleanup", action: "sweep" },
      });
    });
  }, WORKTREE_SWEEP_INTERVAL_MS);
  console.log(
    "[worktree-cleanup] Orphaned lock reaper and stale worktree sweep scheduled (every 60 min)",
  );

  // Start periodic context-size sweep (#353) — alerts when a pool session's
  // context crosses 200k/500k/800k tokens, so a runaway session can be
  // compacted before it dominates the weekly subscription burn.
  const context_sweep_timer = setInterval(() => {
    void sweep_context_thresholds({
      list_bots: () => context_bots_from_pool(pool.get_assigned_bots()),
      query_usage: query_context_usage,
      post_alert: (payload) => alert_router.post_alert(payload),
      load_state: () => load_context_alerts(config),
      save_state: (state) => save_context_alerts(state, config),
    }).catch((err) => {
      console.error(`[context-alerts] Sweep failed: ${String(err)}`);
      sentry.captureException(err, {
        tags: { module: "context-alerts", action: "sweep" },
      });
    });
  }, CONTEXT_SWEEP_INTERVAL_MS);
  console.log("[context-alerts] Context threshold sweep scheduled (every 15 min)");

  // Start the parked-approval resolver (#372) — finishes v1 merges that were
  // parked behind running CI. `check_suite.completed` releases a park only when
  // it arrives after the park was written, which is usually not the case, and
  // there is no pr-cron safety net. Runs once at startup so a restart mid-park
  // resolves immediately, then every two minutes.
  let park_sweep_timer: NodeJS.Timeout | undefined;
  if (github_app) {
    const app = github_app;
    const run_park_sweep = (): void => {
      void sweep_parked_approvals(
        make_parked_approval_deps({
          config,
          github_app: app,
          post_alert: (payload) => alert_router.post_alert(payload),
        }),
      ).catch((err) => {
        console.error(`[parked-approvals] Sweep failed: ${String(err)}`);
        sentry.captureException(err, {
          tags: { module: "parked-approvals", action: "sweep" },
        });
      });
    };
    run_park_sweep();
    park_sweep_timer = setInterval(run_park_sweep, PARK_SWEEP_INTERVAL_MS);
    console.log("[parked-approvals] Parked-approval resolver scheduled (every 2 min)");
  } else {
    console.log("[parked-approvals] No GitHub App configured — resolver disabled");
  }

  // Start weekly memory pruning — archives daily logs older than 30 days.
  // Runs once on startup (catches up if daemon was down) then weekly.
  const MEMORY_PRUNE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 1 week
  void prune_daily_logs(config).catch((err) => {
    console.error(`[memory] Startup pruning failed: ${String(err)}`);
    sentry.captureException(err, {
      tags: { module: "memory-pruning", action: "startup" },
    });
  });
  const memory_prune_timer = setInterval(() => {
    void prune_daily_logs(config).catch((err) => {
      console.error(`[memory] Pruning failed: ${String(err)}`);
      sentry.captureException(err, {
        tags: { module: "memory-pruning", action: "scheduled" },
      });
    });
  }, MEMORY_PRUNE_INTERVAL_MS);
  console.log("[memory] Weekly daily-log pruning scheduled");

  // Write PID file
  await write_pid(config);
  console.log(`PID file written (pid: ${String(process.pid)})`);

  // Record startup breadcrumb for Sentry context
  sentry.addBreadcrumb({
    category: "daemon.lifecycle",
    message: "Daemon startup complete",
    data: {
      entities: registry.count(),
      discord: discord_connected,
      github_app: !!github_app,
      pool_bots: pool.get_status().total,
    },
  });

  // Notify #system-status that the daemon has started
  if (discord_connected) {
    try {
      const status_channel = await discord.find_system_status_channel();
      if (status_channel) {
        const active = registry.get_active().length;
        const total = registry.count();
        const pool_status = pool.get_status();
        await discord.send(
          status_channel,
          `☑ Daemon started (pid ${String(process.pid)}) — ${String(active)}/${String(total)} entities, ${String(pool_status.total)} pool bots, GitHub App ${github_app ? "active" : "inactive"}`,
        );
      }
    } catch (err) {
      console.error(`[startup] Failed to notify system-status: ${String(err)}`);
      sentry.captureException(err, {
        tags: { module: "discord", action: "startup_notification" },
      });
    }
  }

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
    auth_watchdog.stop();
    clearInterval(worktree_sweep_timer);
    clearInterval(context_sweep_timer);
    if (park_sweep_timer) clearInterval(park_sweep_timer);
    clearInterval(memory_prune_timer);

    // Check for active work
    const work_check = pool.has_active_work();
    if (work_check.active) {
      const names = work_check.working_bots
        .map((b) => `${b.archetype} (pool-${String(b.id)})`)
        .join(", ");
      console.log(
        `[shutdown] Draining — ${String(work_check.working_bots.length)} agent(s) still working: ${names}`,
      );

      // Notify command center
      if (discord_connected) {
        try {
          await discord.send(
            config.discord?.server_id ? "" : "",
            `Daemon shutting down — waiting for ${String(work_check.working_bots.length)} active agent(s) to finish: ${names}. Send another signal to force.`,
          );
        } catch {
          /* best effort */
        }
      }

      // Wait indefinitely for agents to finish (second SIGTERM forces)
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
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

    // Flush pending Sentry events before exit
    await sentry.flush(2000);

    await remove_pid(config);
    console.log("PID file removed. Goodbye.");
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// ── Global unhandled error handlers ──

process.on("uncaughtException", (err) => {
  console.error("[fatal] Uncaught exception:", err);
  sentry.captureException(err, { tags: { severity: "fatal" } });
  void sentry.flush(2000).finally(() => process.exit(1));
});

process.on("unhandledRejection", (reason) => {
  console.error("[fatal] Unhandled rejection:", reason);
  sentry.captureException(reason, { tags: { severity: "unhandled_rejection" } });
});

void main();
