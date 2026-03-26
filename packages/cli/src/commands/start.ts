import { Command } from "commander";
import { writeFile, mkdir, access, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import {
  pid_file_path,
  daemon_log_path,
  expand_home,
} from "@lobster-farm/shared";
import {
  generate_env_sh,
  generate_wrapper_sh,
  generate_plist,
  plist_path,
  load_service,
  is_service_loaded,
} from "../lib/launchd.js";
import { read_pid_file, is_process_running } from "../lib/process.js";

/** Resolve the daemon entry point. */
function resolve_daemon_path(): string {
  // Primary: look in ~/.lobsterfarm/src (standard install location)
  const home = homedir();
  const standard = join(home, ".lobsterfarm", "src", "packages", "daemon", "dist", "index.js");
  try {
    require.resolve(standard);
    return standard;
  } catch {
    // noop
  }

  // Fallback: resolve relative to this CLI file
  const this_file = fileURLToPath(import.meta.url);
  let dir = dirname(this_file);
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, "packages", "daemon", "dist", "index.js");
    try {
      require.resolve(candidate);
      return candidate;
    } catch {
      // noop
    }
    dir = dirname(dir);
  }

  // Last resort
  return standard;
}

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

    const home = homedir();
    const lf_dir = join(home, ".lobsterfarm");
    const daemon_path = resolve_daemon_path();
    const node_path = resolve_node_path();
    const log_path = daemon_log_path();
    const working_dir = expand_home("~/.lobsterfarm");

    // Ensure directories exist
    await mkdir(dirname(log_path), { recursive: true });
    await mkdir(join(lf_dir, "bin"), { recursive: true });

    // --- Generate env.sh (skip if already exists — user may have customized) ---
    const env_sh_path = join(lf_dir, "env.sh");
    try {
      await access(env_sh_path);
      console.log("env.sh already exists, skipping. Delete and re-run to regenerate.");
    } catch {
      const env_content = generate_env_sh();
      await writeFile(env_sh_path, env_content, { encoding: "utf-8", mode: 0o600 });
      console.log(`Generated env.sh at ${env_sh_path}`);
    }

    // --- Generate wrapper script (always overwrite — managed infrastructure) ---
    const wrapper_path = join(lf_dir, "bin", "start-daemon.sh");
    const wrapper_content = generate_wrapper_sh(node_path, daemon_path);
    await writeFile(wrapper_path, wrapper_content, { encoding: "utf-8", mode: 0o755 });
    // Ensure executable even if umask stripped the bit
    await chmod(wrapper_path, 0o755);
    console.log(`Generated wrapper script at ${wrapper_path}`);

    // --- Generate and write the plist ---
    const plist_content = generate_plist(wrapper_path, log_path, working_dir);
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
