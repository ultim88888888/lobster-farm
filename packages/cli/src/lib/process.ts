import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";

/** Read a PID file and return the PID, or null if the file doesn't exist / is invalid. */
export async function read_pid_file(path: string): Promise<number | null> {
  try {
    const content = await readFile(path, "utf-8");
    const pid = parseInt(content.trim(), 10);
    if (Number.isNaN(pid) || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
}

/** Check if a process with the given PID is currently running. */
export function is_process_running(pid: number): boolean {
  try {
    // Signal 0 doesn't kill the process — just checks if it exists.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Execute a shell command and return stdout, stderr, and exit code. */
export function exec_command(
  cmd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile("/bin/sh", ["-c", cmd], (error, stdout, stderr) => {
      const exitCode =
        error && "code" in error && typeof error.code === "number"
          ? error.code
          : error
            ? 1
            : 0;
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "", exitCode });
    });
  });
}
