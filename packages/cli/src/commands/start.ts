import { Command } from "commander";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  pid_file_path,
  daemon_log_path,
  expand_home,
} from "@lobster-farm/shared";
import {
  generate_plist,
  plist_path,
  load_service,
  is_service_loaded,
} from "../lib/launchd.js";
import { read_pid_file, is_process_running } from "../lib/process.js";

/** Resolve the daemon entry point relative to this CLI package. */
function resolve_daemon_path(): string {
  const this_file = fileURLToPath(import.meta.url);
  // From packages/cli/dist/commands/start.js -> packages/daemon/dist/index.js
  const cli_dist = dirname(dirname(this_file));
  return join(dirname(dirname(cli_dist)), "daemon", "dist", "index.js");
}

export const start_command = new Command("start")
  .description("Start the LobsterFarm daemon")
  .action(async () => {
    // Check if already running
    const pid = await read_pid_file(pid_file_path());
    if (pid !== null && is_process_running(pid)) {
      console.log(`LobsterFarm daemon is already running (PID ${pid}).`);
      return;
    }

    const loaded = await is_service_loaded();
    if (loaded) {
      console.log("LobsterFarm service is already loaded in launchctl.");
      return;
    }

    const daemon_path = resolve_daemon_path();
    const log_path = daemon_log_path();
    const working_dir = expand_home("~/.lobsterfarm");

    // Ensure log directory exists
    await mkdir(dirname(log_path), { recursive: true });

    // Generate and write the plist
    const plist_content = await generate_plist(daemon_path, log_path, working_dir);
    const plist = plist_path();
    await mkdir(dirname(plist), { recursive: true });
    await writeFile(plist, plist_content, "utf-8");

    console.log(`Generated plist at ${plist}`);

    // Load the service
    await load_service();

    console.log("LobsterFarm daemon started.");
    console.log(`  Logs: ${log_path}`);
    console.log(`  PID file: ${pid_file_path()}`);
  });
