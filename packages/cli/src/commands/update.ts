import { Command } from "commander";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

/**
 * Resolve the monorepo root directory.
 *
 * Strategy: walk up from this file's location until we find a directory
 * that contains `pnpm-workspace.yaml` (the monorepo marker). This works
 * whether the CLI is running from source or from `dist/`.
 */
function resolve_repo_root(): string {
  const this_file = fileURLToPath(import.meta.url);
  let dir = dirname(this_file);

  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  // Fallback: ask git (works if git is available and we're inside the repo)
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dirname(this_file),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error(
      "Could not resolve LobsterFarm repo root. " +
      "Is the CLI running from within the repository?",
    );
  }
}

/** Run a git command in the repo directory, returning stdout. */
function git(repo_dir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo_dir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export const update_command = new Command("update")
  .description("Pull latest code and rebuild")
  .action(() => {
    let repo_dir: string;
    try {
      repo_dir = resolve_repo_root();
    } catch (err) {
      console.error(
        err instanceof Error ? err.message : "Failed to resolve repo root.",
      );
      process.exit(1);
    }

    console.log("Checking for updates...");

    // Fetch latest from origin
    try {
      execFileSync("git", ["fetch", "origin"], {
        cwd: repo_dir,
        stdio: "inherit",
      });
    } catch {
      console.error("Failed to fetch from origin. Check your network connection.");
      process.exit(1);
    }

    // Check if the local main branch is behind origin/main
    const status = git(repo_dir, ["status", "-uno"]);
    if (status.includes("Your branch is up to date")) {
      console.log("Already up to date.");
      return;
    }

    // Pull from origin/main
    console.log("Pulling latest from origin/main...");
    try {
      execFileSync("git", ["pull", "origin", "main"], {
        cwd: repo_dir,
        stdio: "inherit",
      });
    } catch {
      console.error(
        "Pull failed. You may have local changes that conflict.\n" +
        "Resolve conflicts manually, then re-run: lf update",
      );
      process.exit(1);
    }

    // Rebuild
    console.log("Rebuilding...");
    try {
      execFileSync("pnpm", ["install"], {
        cwd: repo_dir,
        stdio: "inherit",
      });
      execFileSync("pnpm", ["build"], {
        cwd: repo_dir,
        stdio: "inherit",
      });
    } catch {
      console.error(
        "Build failed. Check the output above for errors.\n" +
        "You can retry the build manually: cd " + repo_dir + " && pnpm install && pnpm build",
      );
      process.exit(1);
    }

    // Report success with the new commit hash
    const hash = git(repo_dir, ["rev-parse", "--short", "HEAD"]);
    console.log(`\nLobsterFarm updated to commit ${hash}`);
    console.log("Restart the daemon to apply: lf restart");
  });
