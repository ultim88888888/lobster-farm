/**
 * Daemon environment validation and tmux propagation.
 *
 * Ensures the daemon's PATH contains all required tools and pushes
 * critical env vars into the tmux global environment so pool bots
 * inherit them even if the tmux server predates the daemon.
 */

import { execFileSync } from "node:child_process";

// Binaries required for daemon operation. Missing any of these is fatal.
const REQUIRED_BINARIES = ["node", "claude", "git", "gh", "tmux", "bun"] as const;

// Binaries that are useful but not strictly required. Missing triggers a warning.
const RECOMMENDED_BINARIES = ["op"] as const;

// Env vars that must be available in tmux sessions spawned by the pool.
const TMUX_PROPAGATED_VARS = ["PATH", "HOME", "BUN_INSTALL", "OP_SERVICE_ACCOUNT_TOKEN"] as const;

/**
 * Resolve a binary via `which`. Returns true if found, false otherwise.
 * Extracted for testability — tests can provide a mock resolver.
 */
type BinaryChecker = (name: string) => boolean;

function default_binary_checker(name: string): boolean {
  try {
    execFileSync("which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Set a tmux global environment variable. Returns true on success.
 * Extracted for testability.
 */
type TmuxSetter = (key: string, value: string) => boolean;

function default_tmux_setter(key: string, value: string): boolean {
  try {
    execFileSync("tmux", ["set-environment", "-g", key, value], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify that all required binaries are reachable in the current PATH.
 * Exits the process with a clear error message if any are missing.
 * Logs a warning for missing recommended binaries.
 */
export function check_required_binaries(
  checker: BinaryChecker = default_binary_checker,
): void {
  const missing_required: string[] = [];
  const missing_recommended: string[] = [];

  for (const bin of REQUIRED_BINARIES) {
    if (!checker(bin)) {
      missing_required.push(bin);
    }
  }

  for (const bin of RECOMMENDED_BINARIES) {
    if (!checker(bin)) {
      missing_recommended.push(bin);
    }
  }

  if (missing_required.length > 0) {
    console.error(`[env] FATAL: Required binaries not found in PATH: ${missing_required.join(", ")}`);
    console.error(`[env] Current PATH: ${process.env["PATH"] ?? "(unset)"}`);
    console.error("[env] Fix ~/.lobsterfarm/env.sh and restart.");
    process.exit(1);
  }

  if (missing_recommended.length > 0) {
    console.warn(`[env] Warning: Recommended binaries not found: ${missing_recommended.join(", ")}`);
  }

  console.log(`[env] All required binaries found: ${REQUIRED_BINARIES.join(", ")}`);
  if (missing_recommended.length === 0) {
    console.log(`[env] Recommended binaries also present: ${RECOMMENDED_BINARIES.join(", ")}`);
  }
}

/**
 * Propagate critical environment variables to the tmux global environment.
 * This ensures new tmux sessions inherit the daemon's env even if the
 * tmux server predates the daemon (started from a different context).
 *
 * Failures are non-fatal — if tmux isn't running yet, it'll inherit
 * from the daemon's process env when first created.
 */
export function propagate_tmux_env(
  env: Record<string, string | undefined> = process.env,
  setter: TmuxSetter = default_tmux_setter,
): void {
  let any_succeeded = false;

  for (const key of TMUX_PROPAGATED_VARS) {
    const value = env[key];
    if (!value) continue;

    if (setter(key, value)) {
      any_succeeded = true;
    }
  }

  if (any_succeeded) {
    console.log("[env] Propagated environment to tmux server");
  } else {
    console.log("[env] tmux server not running, will inherit daemon env");
  }
}
