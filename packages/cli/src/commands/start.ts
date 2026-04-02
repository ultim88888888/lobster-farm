import { Command } from "commander";
import { statSync } from "node:fs";
import { writeFile, mkdir, access, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import {
  pid_file_path,
  daemon_log_path,
  expand_home,
  LAUNCHD_LABEL,
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

/** Resolve the daemon entry point.
 *
 * Tries paths in order of likelihood:
 * 1. install.sh location: ~/.lobsterfarm/src/packages/daemon/dist/index.js
 * 2. Walk up from this CLI file (works when running from a dev checkout)
 * 3. Legacy entity-zero path (our own dev instance)
 */
export function resolve_daemon_path(): string {
  const home = homedir();

  // Primary: where install.sh clones the repo
  const install_path = join(home, ".lobsterfarm", "src", "packages", "daemon", "dist", "index.js");
  if (file_exists(install_path)) return install_path;

  // Walk up from this CLI file — works in dev checkouts and worktrees
  const this_file = fileURLToPath(import.meta.url);
  let dir = dirname(this_file);
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, "packages", "daemon", "dist", "index.js");
    if (file_exists(candidate)) return candidate;
    dir = dirname(dir);
  }

  // Fallback: legacy entity-zero repo location (our own dev instance)
  const legacy = join(home, ".lobsterfarm", "entities", "lobster-farm", "repos", "lobster-farm", "packages", "daemon", "dist", "index.js");
  if (file_exists(legacy)) return legacy;

  // Nothing found — return the install path so the error message is useful
  return install_path;
}

/** Check if a file exists on disk (synchronous). */
function file_exists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
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

/**
 * Generate all managed infrastructure files (wrapper, plist).
 * Always overwrites — these are managed, not user-customized.
 * Only skips env.sh if it already exists (user may have customized it).
 */
async function generate_infrastructure_files(): Promise<void> {
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
  await chmod(wrapper_path, 0o755);
  console.log(`Generated wrapper script at ${wrapper_path}`);

  // --- Generate and write the plist ---
  const plist_content = generate_plist(wrapper_path, log_path, working_dir);
  const plist = plist_path();
  await mkdir(dirname(plist), { recursive: true });
  await writeFile(plist, plist_content, "utf-8");
  console.log(`Generated plist at ${plist}`);
}

export const start_command = new Command("start")
  .description("Start the LobsterFarm daemon")
  .option("--upgrade", "Regenerate wrapper/plist and restart even if already running")
  .action(async (opts: { upgrade?: boolean }) => {
    const pid = await read_pid_file(pid_file_path());
    const running = pid !== null && is_process_running(pid);
    const loaded = await is_service_loaded();

    if (running && !opts.upgrade) {
      console.log(`LobsterFarm daemon is already running (PID ${pid}).`);
      console.log("Use 'lf start --upgrade' to regenerate wrapper scripts and restart.");
      return;
    }

    if (loaded && !running && !opts.upgrade) {
      // Service is loaded in launchd but the process isn't running —
      // likely a crash loop. Regenerate and kickstart automatically.
      console.log("Service is loaded but daemon is not running (crash loop?). Regenerating and restarting...");
      opts.upgrade = true;
    }

    // Always regenerate managed infrastructure files
    await generate_infrastructure_files();

    if (loaded) {
      // Service is already loaded — kickstart to pick up new wrapper
      const uid = process.getuid?.() ?? 501;
      execFileSync("launchctl", [
        "kickstart", "-k",
        `gui/${uid}/${LAUNCHD_LABEL}`,
      ]);
      console.log("LobsterFarm daemon restarted with updated wrapper.");
    } else {
      await load_service();
      console.log("LobsterFarm daemon started.");
    }

    console.log(`  Logs: ${daemon_log_path()}`);
    console.log(`  PID file: ${pid_file_path()}`);
  });
