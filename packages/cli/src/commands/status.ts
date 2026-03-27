import { Command } from "commander";
import { read_pid_file, is_process_running } from "../lib/process.js";
import { pid_file_path, DAEMON_PORT } from "@lobster-farm/shared";

/** Shape returned by the daemon's GET /status endpoint. */
interface DaemonStatus {
  running: boolean;
  uptime_seconds: number;
  entities: { total: number; active: number };
  sessions: {
    active: number;
    active_details: Array<{
      session_id: string;
      entity_id: string;
      feature_id: string | null;
      archetype: string;
      started_at: string;
      pid: number;
    }>;
  };
  queue: {
    pending: number;
    active: number;
    completed_total: number;
    failed_total: number;
  };
  commander: {
    state: string;
    pid: number | null;
    uptime_ms: number | null;
    restart_count: number;
    last_started_at: string | null;
    tmux_session: string;
  };
}

/** Format seconds into a human-readable string like "2d 5h 13m 4s". */
export function format_uptime(total_seconds: number): string {
  const days = Math.floor(total_seconds / 86400);
  const hours = Math.floor((total_seconds % 86400) / 3600);
  const minutes = Math.floor((total_seconds % 3600) / 60);
  const seconds = total_seconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (parts.length === 0 || seconds > 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

export const status_command = new Command("status")
  .description("Show LobsterFarm daemon status")
  .action(async () => {
    // Check PID file
    const pid = await read_pid_file(pid_file_path());
    const running = pid !== null && is_process_running(pid);

    if (!running) {
      console.log("LobsterFarm daemon: not running");
      if (pid !== null) {
        console.log(`  (stale PID file references PID ${pid})`);
      }
      return;
    }

    console.log(`LobsterFarm daemon: running (PID ${pid})`);

    // Try to fetch status from the daemon's HTTP endpoint
    try {
      const url = `http://localhost:${DAEMON_PORT}/status`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);

      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (response.ok) {
        const data = (await response.json()) as DaemonStatus;
        console.log(`  Uptime:     ${format_uptime(data.uptime_seconds)}`);
        console.log(
          `  Entities:   ${data.entities.active} active / ${data.entities.total} total`,
        );
        console.log(`  Sessions:   ${data.sessions.active} active`);
        console.log(
          `  Queue:      ${data.queue.pending} pending, ${data.queue.active} active`,
        );
        console.log(`  Commander:  ${data.commander.state}`);
      } else {
        console.log(`  HTTP status endpoint returned ${response.status}`);
      }
    } catch {
      console.log("  Could not reach daemon HTTP endpoint.");
      console.log(`  (Expected at http://localhost:${DAEMON_PORT}/status)`);
    }
  });
