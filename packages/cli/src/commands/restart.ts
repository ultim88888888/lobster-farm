import { Command } from "commander";
import { execFileSync } from "node:child_process";
import { is_service_loaded } from "../lib/launchd.js";
import { read_pid_file, is_process_running } from "../lib/process.js";
import { LAUNCHD_LABEL, pid_file_path } from "@lobster-farm/shared";

export const restart_command = new Command("restart")
  .description("Hot-restart the daemon (preserves tmux sessions)")
  .action(async () => {
    const loaded = await is_service_loaded();
    if (!loaded) {
      console.log("Daemon is not running. Use 'lf start' instead.");
      return;
    }

    // launchctl kickstart -k sends SIGTERM to the running process and
    // immediately starts a fresh one.  Because the daemon's shutdown handler
    // no longer kills tmux sessions, pool bots survive the restart and are
    // rediscovered on startup via pool-state.json + tmux has-session checks.
    const uid = process.getuid?.() ?? 501;
    execFileSync("launchctl", [
      "kickstart", "-k",
      `gui/${uid}/${LAUNCHD_LABEL}`,
    ]);

    console.log("Daemon restarting... tmux sessions preserved.");

    // Give the new process a moment to start and write its PID file.
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Verify the daemon came back
    const pid = await read_pid_file(pid_file_path());
    if (pid !== null && is_process_running(pid)) {
      console.log(`Daemon is back online (PID ${pid}).`);
    } else {
      console.log("Warning: daemon may not have restarted. Check logs.");
    }
  });
