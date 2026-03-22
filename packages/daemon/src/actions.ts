import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";
import type { FeatureState, LobsterFarmConfig, EntityConfig, ChannelType } from "@lobster-farm/shared";
import { expand_home } from "@lobster-farm/shared";
import type { DiscordBot } from "./discord.js";

const exec = promisify(execFile);

/** Run a shell command and return stdout. Throws on non-zero exit. */
async function run(
  command: string,
  args: string[],
  cwd?: string,
): Promise<string> {
  const { stdout } = await exec(command, args, {
    cwd,
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

// ── Git operations ──

/** Create a git worktree for a feature branch. */
export async function create_worktree(
  feature: FeatureState,
  entity_config: EntityConfig,
): Promise<string> {
  const repo_path = expand_home(entity_config.entity.repo.path);
  const worktree_path = `${repo_path}/worktrees/${feature.branch.replace("feature/", "")}`;

  try {
    // Create branch if it doesn't exist
    await run("git", ["branch", feature.branch], repo_path).catch(() => {
      // Branch may already exist — that's fine
    });

    // Create worktree
    await run(
      "git",
      ["worktree", "add", worktree_path, feature.branch],
      repo_path,
    );
    console.log(`[actions] Created worktree at ${worktree_path}`);
  } catch (err) {
    // Worktree may already exist
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("already exists")) {
      throw err;
    }
    console.log(`[actions] Worktree already exists at ${worktree_path}`);
  }

  return worktree_path;
}

/** Remove a git worktree. */
export async function cleanup_worktree(
  feature: FeatureState,
  entity_config: EntityConfig,
): Promise<void> {
  if (!feature.worktreePath) return;

  const repo_path = expand_home(entity_config.entity.repo.path);

  try {
    await run("git", ["worktree", "remove", feature.worktreePath, "--force"], repo_path);
    console.log(`[actions] Removed worktree at ${feature.worktreePath}`);
  } catch {
    // If git worktree remove fails, try direct removal
    try {
      await rm(feature.worktreePath, { recursive: true, force: true });
      await run("git", ["worktree", "prune"], repo_path);
      console.log(`[actions] Force-removed worktree at ${feature.worktreePath}`);
    } catch (err) {
      console.error(`[actions] Failed to clean up worktree: ${String(err)}`);
    }
  }
}

// ── GitHub operations (via gh CLI) ──

/** Create a pull request for a feature. Returns the PR number. */
export async function create_pr(
  feature: FeatureState,
  entity_config: EntityConfig,
): Promise<number> {
  const repo_path = expand_home(entity_config.entity.repo.path);
  const cwd = feature.worktreePath ?? repo_path;

  const output = await run("gh", [
    "pr",
    "create",
    "--base", "main",
    "--head", feature.branch,
    "--title", feature.title,
    "--body", `Closes #${String(feature.githubIssue)}`,
  ], cwd);

  // gh pr create outputs the PR URL, extract the number
  const match = output.match(/\/pull\/(\d+)/);
  const pr_number = match ? parseInt(match[1]!, 10) : 0;

  console.log(`[actions] Created PR #${String(pr_number)} for ${feature.id}`);
  return pr_number;
}

/** Merge a pull request. */
export async function merge_pr(
  feature: FeatureState,
  _entity_config: EntityConfig,
): Promise<void> {
  if (!feature.prNumber) {
    throw new Error(`Feature ${feature.id} has no PR number`);
  }

  const cwd = feature.worktreePath ?? ".";

  await run("gh", [
    "pr",
    "merge",
    String(feature.prNumber),
    "--squash",
    "--delete-branch",
  ], cwd);

  console.log(`[actions] Merged PR #${String(feature.prNumber)} for ${feature.id}`);
}

/** Run tests in a worktree. Returns true if tests pass. */
export async function run_tests(
  feature: FeatureState,
  command: string = "npm test",
): Promise<boolean> {
  if (!feature.worktreePath) {
    console.log(`[actions] No worktree path for ${feature.id}, skipping tests`);
    return true;
  }

  try {
    const [cmd, ...args] = command.split(" ");
    await run(cmd!, args, feature.worktreePath);
    console.log(`[actions] Tests passed for ${feature.id}`);
    return true;
  } catch {
    console.log(`[actions] Tests failed for ${feature.id}`);
    return false;
  }
}

// ── Notifications ──

/** Global Discord bot reference, set by the daemon on startup. */
let _discord: DiscordBot | null = null;

export function set_discord_bot(bot: DiscordBot | null): void {
  _discord = bot;
}

/** Send a notification to an entity's Discord channel (or log if not connected). */
export async function notify(
  channel_type: string,
  message: string,
  entity_config?: EntityConfig,
  archetype?: string,
): Promise<void> {
  console.log(`[actions:notify] [${channel_type}] ${message}`);

  if (_discord && entity_config) {
    await _discord.send_to_entity(
      entity_config.entity.id,
      channel_type as ChannelType,
      message,
      (archetype as import("@lobster-farm/shared").ArchetypeRole) ?? "system",
    );
  }
}

/** Stub: assign a work room to a feature. */
export async function assign_work_room(
  feature: FeatureState,
  _entity_config: EntityConfig,
): Promise<string | null> {
  console.log(`[actions:stub] Would assign work room for ${feature.id}`);
  return null;
}

/** Stub: release a work room. */
export async function release_work_room(
  feature: FeatureState,
  _entity_config: EntityConfig,
): Promise<void> {
  console.log(`[actions:stub] Would release work room for ${feature.id}`);
}
