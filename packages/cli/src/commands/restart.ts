import { Command } from "commander";
import { writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { generate_wrapper_sh } from "../lib/launchd.js";
import { is_service_loaded } from "../lib/launchd.js";
import { read_pid_file, is_process_running } from "../lib/process.js";
import { LAUNCHD_LABEL, pid_file_path } from "@lobster-farm/shared";
import { resolve_daemon_path } from "./start.js";

/** Resolve the absolute path to the node binary. */
function resolve_node_path(): string {
  try {
    return execFileSync("which", ["node"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "/opt/homebrew/bin/node";
  }
}

export const restart_command = new Command("restart")
  .description("Hot-restart the daemon (preserves tmux sessions)")
  .action(async () => {
    const loaded = await is_service_loaded();
    if (!loaded) {
      console.log("Daemon is not running. Use 'lf start' instead.");
      return;
    }

    // Regenerate the wrapper script before restarting so the new process
    // picks up any changes (heap size, op run integration, daemon path).
    const home = homedir();
    const wrapper_path = join(home, ".lobsterfarm", "bin", "start-daemon.sh");
    const wrapper_content = generate_wrapper_sh(resolve_node_path(), resolve_daemon_path());
    await writeFile(wrapper_path, wrapper_content, { encoding: "utf-8", mode: 0o755 });
    await chmod(wrapper_path, 0o755);
    console.log("Regenerated wrapper script.");

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

    // Poll for the new process to start and write its PID file.
    const POLL_INTERVAL_MS = 500;
    const TIMEOUT_MS = 10_000;
    const start = Date.now();
    let pid: number | null = null;

    while (Date.now() - start < TIMEOUT_MS) {
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
      pid = await read_pid_file(pid_file_path());
      if (pid !== null && is_process_running(pid)) {
        break;
      }
      pid = null;
    }

    if (pid !== null) {
      console.log(`Daemon is back online (PID ${pid}).`);
    } else {
      console.log("Warning: daemon may not have restarted. Check logs.");
    }
  });
