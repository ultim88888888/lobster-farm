import { spawn, execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { lobsterfarm_dir } from "@lobster-farm/shared";
import { resolve_model_id } from "./models.js";
import { sq } from "./shell.js";

export interface CommanderHealth {
  state: "stopped" | "starting" | "running" | "crashed";
  pid: number | null;
  uptime_ms: number | null;
  restart_count: number;
  last_started_at: string | null;
  tmux_session: string;
}

const TMUX_SESSION = "pat";
const BACKOFF_SCHEDULE = [0, 5_000, 15_000, 60_000, 300_000];
const BACKOFF_RESET_MS = 10 * 60 * 1000; // 10 min stable → reset counter
const MAX_RESTARTS = 5;
const HEALTH_INTERVAL_MS = 10_000; // check every 10s

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

  constructor(private config: LobsterFarmConfig) {
    super();
  }

  /** State directory for Pat's Discord channel plugin. */
  private state_dir(): string {
    return join(lobsterfarm_dir(this.config.paths), "channels", "pat");
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
      execFileSync("tmux", ["has-session", "-t", TMUX_SESSION], {
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
        ["list-panes", "-t", TMUX_SESSION, "-F", "#{pane_pid}"],
        { encoding: "utf-8" },
      ).trim();
      const pid = parseInt(out, 10);
      return isNaN(pid) ? null : pid;
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
        execFileSync("tmux", ["kill-session", "-t", TMUX_SESSION], {
          stdio: "ignore",
        });
      } catch { /* ignore */ }
    }

    this.state = "starting";
    const claude_bin = process.env["CLAUDE_BIN"] ?? "claude";
    const agent_name = this.config.agents.commander.name.toLowerCase();
    const working_dir = lobsterfarm_dir(this.config.paths);

    const claude_cmd = [
      sq(claude_bin),
      "--channels", "plugin:discord@claude-plugins-official",
      "--agent", sq(agent_name),
      "--model", resolve_model_id(this.config.defaults.models.planning),
      "--permission-mode", "bypassPermissions",
      "--add-dir", sq(working_dir),
      "--add-dir", sq(homedir()),
    ].join(" ");

    console.log(`[commander] Starting ${agent_name} in tmux session "${TMUX_SESSION}"...`);

    // Create a detached tmux session running Claude Code.
    // DISCORD_STATE_DIR is set so the channel plugin reads from the right dir.
    const proc = spawn("tmux", [
      "new-session", "-d",
      "-s", TMUX_SESSION,
      "-x", "200", "-y", "50",
      `DISCORD_STATE_DIR=${sq(this.state_dir())} GIT_AUTHOR_NAME=${sq("Pat (LobsterFarm)")} GIT_AUTHOR_EMAIL=${sq("pat@lobsterfarm.dev")} GIT_COMMITTER_NAME=${sq("Pat (LobsterFarm)")} GIT_COMMITTER_EMAIL=${sq("pat@lobsterfarm.dev")} ${claude_cmd}`,
    ], {
      cwd: working_dir,
      stdio: "ignore",
      env: {
        ...process.env,
        DISCORD_STATE_DIR: this.state_dir(),
        GIT_AUTHOR_NAME: "Pat (LobsterFarm)",
        GIT_AUTHOR_EMAIL: "pat@lobsterfarm.dev",
        GIT_COMMITTER_NAME: "Pat (LobsterFarm)",
        GIT_COMMITTER_EMAIL: "pat@lobsterfarm.dev",
      },
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        console.error(`[commander] tmux new-session failed with code ${String(code)}`);
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
            execFileSync("tmux", ["send-keys", "-t", TMUX_SESSION, "Enter"], {
              stdio: "ignore",
            });
          } catch { /* ignore — dialog may not appear if already trusted */ }
        }, 3000);

        this.state = "running";
        this.last_started_at = new Date();
        const pid = this.get_tmux_pid();
        console.log(`[commander] ${agent_name} running in tmux (pane pid: ${String(pid)})`);
        this.emit("started", pid);

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
        this.state = "crashed";
        this.schedule_restart();
      }
    });

    proc.on("error", (err) => {
      this.state = "crashed";
      console.error(`[commander] Failed to spawn tmux: ${err.message}`);
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
        this.emit("crashed", 1);
        this.schedule_restart();
      }
    }, HEALTH_INTERVAL_MS);
  }

  private stop_health_polling(): void {
    if (this.health_timer) {
      clearInterval(this.health_timer);
      this.health_timer = null;
    }
  }

  private schedule_restart(): void {
    this.restart_count++;

    if (this.restart_count > MAX_RESTARTS) {
      console.error(
        `[commander] Max restarts (${String(MAX_RESTARTS)}) exceeded. Giving up.`,
      );
      this.emit("gave_up", this.restart_count);
      return;
    }

    const delay =
      BACKOFF_SCHEDULE[
        Math.min(this.restart_count - 1, BACKOFF_SCHEDULE.length - 1)
      ]!;
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

    this.state = "stopped";

    if (this.is_tmux_alive()) {
      console.log("[commander] Stopping tmux session...");
      try {
        execFileSync("tmux", ["kill-session", "-t", TMUX_SESSION], {
          stdio: "ignore",
        });
      } catch { /* ignore */ }
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
      tmux_session: TMUX_SESSION,
    };
  }
}
