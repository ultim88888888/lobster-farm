import { readFile, writeFile, unlink } from "node:fs/promises";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { pid_file_path } from "@lobster-farm/shared";

/** Write the current process PID to the PID file. */
export async function write_pid(config: LobsterFarmConfig): Promise<void> {
  const path = pid_file_path(config.paths);
  await writeFile(path, String(process.pid), "utf-8");
}

/** Remove the PID file. */
export async function remove_pid(config: LobsterFarmConfig): Promise<void> {
  const path = pid_file_path(config.paths);
  try {
    await unlink(path);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

/** Read and parse the PID from the PID file. Returns null if the file doesn't exist or is invalid. */
export async function read_pid(config: LobsterFarmConfig): Promise<number | null> {
  const path = pid_file_path(config.paths);
  try {
    const content = await readFile(path, "utf-8");
    const pid = parseInt(content.trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/** Check if the daemon is already running by reading the PID file and signalling the process. */
export async function is_daemon_running(config: LobsterFarmConfig): Promise<boolean> {
  const pid = await read_pid(config);
  if (pid === null) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
