import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { lobsterfarm_dir } from "@lobster-farm/shared";
import {
  has_mcp_child,
  process_mcp_health_tick,
  record_cycle_outcome,
  run_mcp_recovery_cycle,
  wait_for_mcp_child,
} from "./mcp-health.js";
import type { McpRecoveryState } from "./mcp-health.js";
import { resolve_model_id } from "./models.js";
import { is_tmux_session_idle } from "./pool.js";
import * as sentry from "./sentry.js";
import { sq } from "./shell.js";

export interface CommanderHealth {
  state: "stopped" | "starting" | "running" | "crashed";
  pid: number | null;
  uptime_ms: number | null;
  restart_count: number;
  last_started_at: string | null;
  tmux_session: string;
}

export const PAT_TMUX_SESSION = "pat";
const BACKOFF_SCHEDULE = [0, 5_000, 15_000, 60_000, 300_000];
const BACKOFF_RESET_MS = 10 * 60 * 1000; // 10 min stable → reset counter
const MAX_RESTARTS = 5;
const HEALTH_INTERVAL_MS = 10_000; // check every 10s

/** Single-instance key into the mcp_state map — Pat has exactly one session,
 * unlike the pool bots (indexed by numeric bot id in pool.ts). */
const PAT_MCP_STATE_KEY = 0;

/**
 * Manages a persistent Claude Code session connected to Discord via the
 * channel plugin, running inside a tmux session for proper TTY support.
 * The daemon's only job: spawn, health check, restart on crash.
 */
export class CommanderProcess extends EventEmitter {
  private state: "stopped" | "starting" | "running" | "crashed" = "stopped";
  private restart_count = 0;
  private last_started_at: Date | null = null;
  private restart_timer: ReturnType<typeof setTimeout> | null = null;
  private backoff_reset_timer: ReturnType<typeof setTimeout> | null = null;
  private health_timer: ReturnType<typeof setInterval> | null = null;
  /** MCP connection health state for Pat's session (issue #345). Keyed by
   * PAT_MCP_STATE_KEY since there's only ever one Commander session. */
  private mcp_state = new Map<number, McpRecoveryState>();
  /** True while a check_mcp_health() cycle is in flight — prevents two
   * overlapping recovery cycles if a health tick fires mid-cycle. */
  private mcp_check_running = false;

  constructor(private config: LobsterFarmConfig) {
    super();
  }

  /** State directory for Pat's Discord channel plugin. */
  private state_dir(): string {
    return join(lobsterfarm_dir(this.config.paths), "channels", "pat");
  }

  /** Path to the session state file (persists session_id across restarts). */
  private session_state_path(): string {
    return join(this.state_dir(), "session-state.json");
  }

  /** Read the persisted session_id, if any. Returns null on missing or corrupt file. */
  private async read_session_id(): Promise<string | null> {
    try {
      const content = await readFile(this.session_state_path(), "utf-8");
      const state = JSON.parse(content) as { session_id?: string };
      return state.session_id ?? null;
    } catch {
      return null;
    }
  }

  /** Persist the session_id so future restarts can resume. */
  private async write_session_id(session_id: string): Promise<void> {
    await writeFile(this.session_state_path(), JSON.stringify({ session_id }, null, 2), "utf-8");
  }

  /** Clear persisted session state so the next startup begins fresh. */
  private async clear_session_id(): Promise<void> {
    try {
      await unlink(this.session_state_path());
    } catch {
      /* ignore — file may not exist */
    }
  }

  /** Check if Pat's bot token is configured. */
  async has_token(): Promise<boolean> {
    try {
      const env_path = join(this.state_dir(), ".env");
      const content = await readFile(env_path, "utf-8");
      return content.includes("DISCORD_BOT_TOKEN=");
    } catch {
      return false;
    }
  }

  /** Check if the tmux session is alive. */
  private is_tmux_alive(): boolean {
    try {
      execFileSync("tmux", ["has-session", "-t", PAT_TMUX_SESSION], {
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Get the PID of the main process inside the tmux session. */
  private get_tmux_pid(): number | null {
    try {
      const out = execFileSync(
        "tmux",
        ["list-panes", "-t", PAT_TMUX_SESSION, "-F", "#{pane_pid}"],
        {
          encoding: "utf-8",
        },
      ).trim();
      const pid = Number.parseInt(out, 10);
      return Number.isNaN(pid) ? null : pid;
    } catch {
      return null;
    }
  }

  /** Start the persistent Commander session in a tmux session. */
  async start(): Promise<void> {
    if (this.state === "running" || this.state === "starting") {
      return;
    }

    if (!(await this.has_token())) {
      console.log("[commander] No bot token at", join(this.state_dir(), ".env"));
      console.log("[commander] Pat will not start. Add the token and restart the daemon.");
      return;
    }

    // Kill any stale tmux session
    if (this.is_tmux_alive()) {
      try {
        execFileSync("tmux", ["kill-session", "-t", PAT_TMUX_SESSION], {
          stdio: "ignore",
        });
      } catch {
        /* ignore */
      }
    }

    this.state = "starting";
    const claude_bin = process.env.CLAUDE_BIN ?? "claude";
    const agent_name = this.config.agents.commander.name.toLowerCase();
    const working_dir = lobsterfarm_dir(this.config.paths);

    // Resolve session ID for resume support. If we have a persisted session_id
    // from a previous run, use --resume to restore conversation context.
    // Otherwise generate a fresh ID and use --session-id to establish it.
    const existing_session_id = await this.read_session_id();
    const is_resume = existing_session_id !== null;
    const session_id = existing_session_id ?? randomUUID();

    const claude_args = [
      sq(claude_bin),
      "--channels",
      "plugin:discord@claude-plugins-official",
      "--agent",
      sq(agent_name),
      "--model",
      resolve_model_id(this.config.defaults.models.planning),
      "--permission-mode",
      "bypassPermissions",
      "--add-dir",
      sq(working_dir),
      "--add-dir",
      sq(homedir()),
    ];

    if (is_resume) {
      claude_args.push("--resume", sq(session_id));
      console.log(`[commander] Resuming session ${session_id.slice(0, 8)}...`);
    } else {
      claude_args.push("--session-id", sq(session_id));
      console.log(`[commander] Starting fresh session ${session_id.slice(0, 8)}...`);
    }

    const claude_cmd = claude_args.join(" ");

    console.log(`[commander] Starting ${agent_name} in tmux session "${PAT_TMUX_SESSION}"...`);

    // Create a detached tmux session running Claude Code.
    // DISCORD_STATE_DIR is set so the channel plugin reads from the right dir.
    const proc = spawn(
      "tmux",
      [
        "new-session",
        "-d",
        "-s",
        PAT_TMUX_SESSION,
        "-x",
        "200",
        "-y",
        "50",
        `DISCORD_STATE_DIR=${sq(this.state_dir())} GIT_AUTHOR_NAME=${sq("Pat")} GIT_COMMITTER_NAME=${sq("Pat")} ${claude_cmd}`,
      ],
      {
        cwd: working_dir,
        stdio: "ignore",
        env: {
          ...process.env,
          DISCORD_STATE_DIR: this.state_dir(),
          GIT_AUTHOR_NAME: "Pat",
          GIT_COMMITTER_NAME: "Pat",
        },
      },
    );

    proc.on("close", (code) => {
      if (code !== 0) {
        console.error(`[commander] tmux new-session failed with code ${String(code)}`);
        sentry.captureException(
          new Error(`Commander tmux new-session failed with code ${String(code)}`),
          {
            tags: { module: "commander" },
          },
        );
        this.state = "crashed";
        this.schedule_restart();
        return;
      }

      // tmux new-session exits immediately (detached). Check the session exists.
      if (this.is_tmux_alive()) {
        // Claude Code shows a workspace trust dialog in interactive mode.
        // Auto-accept it after a brief delay for the UI to render.
        setTimeout(() => {
          try {
            execFileSync("tmux", ["send-keys", "-t", PAT_TMUX_SESSION, "Enter"], {
              stdio: "ignore",
            });
          } catch {
            /* ignore — dialog may not appear if already trusted */
          }
        }, 3000);

        this.state = "running";
        this.last_started_at = new Date();
        const pid = this.get_tmux_pid();
        console.log(`[commander] ${agent_name} running in tmux (pane pid: ${String(pid)})`);
        this.emit("started", pid);

        // Post-spawn MCP verification gate (issue #345), fire-and-forget —
        // mirrors pool.ts's verify_mcp_post_spawn: wait for the MCP child,
        // fall back to one scripted /mcp Reconnect attempt if it doesn't
        // appear. Not awaited — start() shouldn't block server startup.
        void this.verify_mcp_post_spawn();

        // Persist session_id so future restarts can resume the conversation
        void this.write_session_id(session_id).catch((err) => {
          console.error(`[commander] Failed to persist session_id: ${String(err)}`);
        });

        // Start health check polling
        this.start_health_polling();

        // Reset backoff after 10 min of stable running
        this.backoff_reset_timer = setTimeout(() => {
          if (this.state === "running") {
            this.restart_count = 0;
          }
        }, BACKOFF_RESET_MS);
      } else {
        console.error("[commander] tmux session did not start");
        sentry.captureException(new Error("Commander tmux session did not start"), {
          tags: { module: "commander" },
        });
        this.state = "crashed";
        this.schedule_restart();
      }
    });

    proc.on("error", (err) => {
      this.state = "crashed";
      console.error(`[commander] Failed to spawn tmux: ${err.message}`);
      sentry.captureException(err, {
        tags: { module: "commander" },
      });
      this.emit("error", err);
      this.schedule_restart();
    });
  }

  /** Poll tmux session health. If it dies, trigger restart. */
  private start_health_polling(): void {
    this.stop_health_polling();
    this.health_timer = setInterval(() => {
      if (this.state !== "running") return;

      if (!this.is_tmux_alive()) {
        console.log("[commander] tmux session died");
        this.state = "crashed";
        this.stop_health_polling();
        if (this.backoff_reset_timer) {
          clearTimeout(this.backoff_reset_timer);
          this.backoff_reset_timer = null;
        }
        this.mcp_state.delete(PAT_MCP_STATE_KEY);
        this.emit("crashed", 1);
        this.schedule_restart();
        return;
      }

      // Tmux alive — verify the Discord plugin MCP server is actually
      // connected (issue #345). Pane text alone doesn't prove it.
      void this.check_mcp_health();
    }, HEALTH_INTERVAL_MS);
  }

  private stop_health_polling(): void {
    if (this.health_timer) {
      clearInterval(this.health_timer);
      this.health_timer = null;
    }
  }

  /** Check if Pat's tmux pane is idle at the prompt (reuses pool.ts's
   * detector — same signal, no need for a second implementation). */
  private is_idle(): boolean {
    return is_tmux_session_idle(PAT_TMUX_SESSION);
  }

  /**
   * Verify Pat's Discord plugin MCP connection and drive recovery if it's
   * confirmed dead (issue #345). Mirrors pool.ts's check_mcp_health() —
   * same detection/anti-thrash state machine, single-session key. Kill +
   * resume fallback reuses the existing crash-restart path: killing the
   * tmux session here is picked up by this same interval's next tick via
   * the dead-tmux branch, which already calls schedule_restart() with its
   * own backoff — Pat has no separate "crash-loop guard" to preserve.
   */
  private async check_mcp_health(): Promise<void> {
    if (this.mcp_check_running) return;
    this.mcp_check_running = true;

    try {
      const healthy = has_mcp_child(PAT_TMUX_SESSION);
      const age_ms = this.last_started_at ? Date.now() - this.last_started_at.getTime() : 0;
      const idle = this.is_idle();
      const now = Date.now();

      const tick = process_mcp_health_tick(
        PAT_MCP_STATE_KEY,
        healthy,
        idle,
        age_ms,
        now,
        this.mcp_state,
      );
      if (tick.action === "notify_recovered") {
        // One-shot recovery notice after a Step 2 fallback (spec: alert on
        // give-up and on successful recovery after a fallback; silent for
        // routine Step 1 reconnects). Pat is platform-level with no entity
        // config, so this reports through sentry + console — the same
        // channel its give-up escalation uses.
        console.log("[commander] MCP recovered after kill+resume fallback");
        sentry.captureMessage("Commander MCP recovered after kill+resume fallback", "info", {
          tags: { module: "commander", action: "mcp_recovery_recovered" },
        });
        return;
      }
      if (tick.action === "none") return;

      console.warn("[commander] MCP connection dead — running recovery cycle");
      sentry.addBreadcrumb({
        category: "daemon.commander",
        message: "Commander MCP recovery cycle starting",
      });

      const outcome = await run_mcp_recovery_cycle(PAT_TMUX_SESSION, () => {
        console.warn(
          "[commander] MCP Reconnect exhausted — killing tmux for crash-restart to pick up",
        );
        try {
          execFileSync("tmux", ["kill-session", "-t", PAT_TMUX_SESSION], { stdio: "ignore" });
        } catch {
          /* already dead */
        }
      });

      if (outcome === "reconnected") {
        console.log("[commander] MCP reconnected via scripted /mcp Reconnect");
        return;
      }

      const escalation = record_cycle_outcome(PAT_MCP_STATE_KEY, outcome, now, this.mcp_state);
      if (!escalation) return;

      console.error(
        `[commander] MCP recovery gave up after ${String(escalation.cycle_fail_count)} failed cycles`,
      );
      sentry.captureMessage("Commander MCP recovery gave up", "error", {
        tags: { module: "commander", action: "mcp_recovery_giveup" },
        contexts: { mcp_recovery: { cycle_fail_count: escalation.cycle_fail_count } },
      });
    } finally {
      this.mcp_check_running = false;
    }
  }

  /**
   * Post-spawn MCP verification gate (issue #345). Waits for the MCP child
   * to appear after a fresh spawn/resume; if still absent, runs the
   * scripted `/mcp` Reconnect inline. Does not kill on failure here — that
   * escalation is owned by check_mcp_health() on the next health tick, same
   * division of responsibility as pool.ts's verify_mcp_post_spawn().
   */
  private async verify_mcp_post_spawn(): Promise<boolean> {
    if (await wait_for_mcp_child(PAT_TMUX_SESSION)) return true;

    console.warn(
      "[commander] Spawned but MCP child not detected within grace window — attempting scripted reconnect",
    );
    const result = await run_mcp_recovery_cycle(PAT_TMUX_SESSION, () => {
      /* post-spawn recovery is reconnect-only; see check_mcp_health() for the kill+resume escalation */
    });

    if (result === "reconnected") {
      console.log("[commander] MCP reconnected post-spawn via scripted /mcp Reconnect");
      return true;
    }
    console.warn("[commander] MCP still unconfirmed post-spawn — health monitor will retry");
    return false;
  }

  private schedule_restart(): void {
    this.restart_count++;

    if (this.restart_count > MAX_RESTARTS) {
      console.error(`[commander] Max restarts (${String(MAX_RESTARTS)}) exceeded. Giving up.`);
      sentry.captureMessage(
        `Commander exceeded ${String(MAX_RESTARTS)} restarts -- giving up`,
        "error",
        {
          tags: { module: "commander" },
        },
      );
      // Clear persisted session so the next daemon startup gets a fresh session
      // instead of re-entering a resume loop on an expired session ID.
      void this.clear_session_id().catch(() => {});
      this.emit("gave_up", this.restart_count);
      return;
    }

    const delay = BACKOFF_SCHEDULE[Math.min(this.restart_count - 1, BACKOFF_SCHEDULE.length - 1)]!;
    console.log(
      `[commander] Restart ${String(this.restart_count)}/${String(MAX_RESTARTS)} in ${String(delay / 1000)}s...`,
    );

    this.restart_timer = setTimeout(() => {
      void this.start();
    }, delay);
  }

  /** Gracefully stop the Commander session. */
  async stop(): Promise<void> {
    if (this.restart_timer) {
      clearTimeout(this.restart_timer);
      this.restart_timer = null;
    }
    if (this.backoff_reset_timer) {
      clearTimeout(this.backoff_reset_timer);
      this.backoff_reset_timer = null;
    }
    this.stop_health_polling();
    this.mcp_state.delete(PAT_MCP_STATE_KEY);

    this.state = "stopped";

    if (this.is_tmux_alive()) {
      console.log("[commander] Stopping tmux session...");
      try {
        execFileSync("tmux", ["kill-session", "-t", PAT_TMUX_SESSION], {
          stdio: "ignore",
        });
      } catch {
        /* ignore */
      }
    }
  }

  /** Get health status. */
  health_check(): CommanderHealth {
    const now = Date.now();
    // Sync state with tmux reality
    if (this.state === "running" && !this.is_tmux_alive()) {
      this.state = "crashed";
    }
    return {
      state: this.state,
      pid: this.state === "running" ? this.get_tmux_pid() : null,
      uptime_ms:
        this.last_started_at && this.state === "running"
          ? now - this.last_started_at.getTime()
          : null,
      restart_count: this.restart_count,
      last_started_at: this.last_started_at?.toISOString() ?? null,
      tmux_session: PAT_TMUX_SESSION,
    };
  }
}
