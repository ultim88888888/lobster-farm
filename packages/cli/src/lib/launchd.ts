import { join } from "node:path";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { exec_command } from "./process.js";
import { LAUNCHD_LABEL } from "@lobster-farm/shared";

/** Read env vars from ~/.lobsterfarm/.env for the plist. */
async function read_env_file(): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  try {
    const content = await readFile(join(homedir(), ".lobsterfarm", ".env"), "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq > 0) {
        env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
      }
    }
  } catch {
    // .env doesn't exist — that's fine
  }
  return env;
}

/** Generate a macOS launchd plist XML string for the LobsterFarm daemon. */
export async function generate_plist(
  daemon_path: string,
  log_path: string,
  working_dir: string,
): Promise<string> {
  const home = homedir();

  // Find node binary
  const { stdout: node_path } = await exec_command("which node");
  const node = node_path.trim() || "/opt/homebrew/bin/node";

  // Read .env for secrets (bot token, OP token, etc.)
  const env_vars = await read_env_file();

  // Build environment variables section
  const env_entries = [
    `    <key>PATH</key>`,
    `    <string>/usr/local/bin:/opt/homebrew/bin:${home}/.local/bin:/usr/bin:/bin</string>`,
    `    <key>HOME</key>`,
    `    <string>${home}</string>`,
  ];

  for (const [key, value] of Object.entries(env_vars)) {
    env_entries.push(`    <key>${key}</key>`);
    env_entries.push(`    <string>${value}</string>`);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${daemon_path}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${working_dir}</string>
  <key>StandardOutPath</key>
  <string>${log_path}</string>
  <key>StandardErrorPath</key>
  <string>${log_path}</string>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
${env_entries.join("\n")}
  </dict>
</dict>
</plist>`;
}

/** Return the standard path for the LobsterFarm launchd plist. */
export function plist_path(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

/** Load the LobsterFarm service via launchctl. */
export async function load_service(): Promise<void> {
  const uid = process.getuid?.() ?? 501;
  const { exitCode, stderr } = await exec_command(
    `launchctl bootstrap gui/${uid} "${plist_path()}"`,
  );
  if (exitCode !== 0 && !stderr.includes("already bootstrapped")) {
    throw new Error(`Failed to load service: ${stderr.trim()}`);
  }
}

/** Unload the LobsterFarm service via launchctl. */
export async function unload_service(): Promise<void> {
  const uid = process.getuid?.() ?? 501;
  const { exitCode, stderr } = await exec_command(
    `launchctl bootout gui/${uid}/${LAUNCHD_LABEL}`,
  );
  if (exitCode !== 0 && !stderr.includes("not find")) {
    throw new Error(`Failed to unload service: ${stderr.trim()}`);
  }
}

/** Check if the LobsterFarm service is currently loaded in launchctl. */
export async function is_service_loaded(): Promise<boolean> {
  const uid = process.getuid?.() ?? 501;
  const { exitCode } = await exec_command(
    `launchctl print gui/${uid}/${LAUNCHD_LABEL} 2>/dev/null`,
  );
  return exitCode === 0;
}
