import { Command } from "commander";
import { read_pid_file, is_process_running } from "../lib/process.js";
import { pid_file_path, DAEMON_PORT } from "@lobster-farm/shared";

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
        const data = (await response.json()) as Record<string, unknown>;
        if (data["entities"] !== undefined) {
          console.log(`  Entities: ${data["entities"]}`);
        }
        if (data["queue_depth"] !== undefined) {
          console.log(`  Queue depth: ${data["queue_depth"]}`);
        }
        if (data["active_sessions"] !== undefined) {
          console.log(`  Active sessions: ${data["active_sessions"]}`);
        }
        if (data["uptime"] !== undefined) {
          console.log(`  Uptime: ${data["uptime"]}`);
        }
      } else {
        console.log(`  HTTP status endpoint returned ${response.status}`);
      }
    } catch {
      console.log("  Could not reach daemon HTTP endpoint.");
      console.log(`  (Expected at http://localhost:${DAEMON_PORT}/status)`);
    }
  });
