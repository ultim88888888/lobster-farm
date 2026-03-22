import { join } from "node:path";
import { homedir } from "node:os";
import { exec_command } from "./process.js";
import { LAUNCHD_LABEL } from "@lobster-farm/shared";

/** Generate a macOS launchd plist XML string for the LobsterFarm daemon. */
export function generate_plist(
  daemon_path: string,
  log_path: string,
  working_dir: string,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
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
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
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
