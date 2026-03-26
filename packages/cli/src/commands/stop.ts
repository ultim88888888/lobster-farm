import { Command } from "commander";
import { execFileSync } from "node:child_process";
import { unload_service, is_service_loaded } from "../lib/launchd.js";
import { read_pid_file, is_process_running } from "../lib/process.js";
import { pid_file_path } from "@lobster-farm/shared";

export const stop_command = new Command("stop")
  .description("Stop the LobsterFarm daemon")
  .action(async () => {
    const loaded = await is_service_loaded();
    if (!loaded) {
      console.log("LobsterFarm daemon is not running.");
      return;
    }

    // Kill all pool-N tmux sessions before stopping the daemon.
    // The daemon no longer kills tmux on SIGTERM (to support hot restart),
    // so `lf stop` is responsible for full cleanup.
    for (let i = 0; i < 10; i++) {
      try {
        execFileSync("tmux", ["kill-session", "-t", `pool-${i}`], { stdio: "ignore" });
      } catch { /* session may not exist */ }
    }

    // Unload the launchd service
    await unload_service();

    // Verify the process stopped
    const pid = await read_pid_file(pid_file_path());
    if (pid !== null && is_process_running(pid)) {
      console.warn(
        `Warning: Process ${pid} may still be running. You can kill it manually: kill ${pid}`,
      );
    } else {
      console.log("LobsterFarm daemon stopped.");
    }
  });
