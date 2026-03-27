import { execFile, exec as execCb } from "node:child_process";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";
import type { FeatureState, EntityConfig, ChannelType, ArchetypeRole, ChannelMapping } from "@lobster-farm/shared";
import { expand_home, entity_config_path, write_yaml } from "@lobster-farm/shared";
import type { DiscordBot } from "./discord.js";
import type { FeatureManager } from "./features.js";
import type { BotPool } from "./pool.js";
import type { EntityRegistry } from "./registry.js";

const exec = promisify(execFile);
const exec_shell = promisify(execCb);

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
  const repo_path = expand_home(entity_config.entity.repos[0]?.path ?? ".");
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

  const repo_path = expand_home(entity_config.entity.repos[0]?.path ?? ".");

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
  const repo_path = expand_home(entity_config.entity.repos[0]?.path ?? ".");
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

/** Merge a pull request. Idempotent — treats "already merged" as success. */
export async function merge_pr(
  feature: FeatureState,
  _entity_config: EntityConfig,
): Promise<void> {
  if (!feature.prNumber) {
    throw new Error(`Feature ${feature.id} has no PR number`);
  }

  const cwd = feature.worktreePath ?? ".";

  try {
    await run("gh", [
      "pr",
      "merge",
      String(feature.prNumber),
      "--squash",
      "--delete-branch",
    ], cwd);
    console.log(`[actions] Merged PR #${String(feature.prNumber)} for ${feature.id}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // PR may have been merged by the reviewer already — treat as success
    if (msg.includes("already been merged") || msg.includes("MERGED")) {
      console.log(`[actions] PR #${String(feature.prNumber)} already merged — treating as success`);
    } else {
      throw err;
    }
  }
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
    // Use shell execution so commands with spaces, pipes, and quotes work correctly
    await exec_shell(command, {
      cwd: feature.worktreePath,
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    console.log(`[actions] Tests passed for ${feature.id}`);
    return true;
  } catch {
    console.log(`[actions] Tests failed for ${feature.id}`);
    return false;
  }
}

// ── Notifications ──

// TODO: Refactor module globals (_discord, _features) to explicit parameter passing.
// These are set once at daemon startup and used implicitly by action functions.
// Moving to a context object or dependency injection would improve testability.

/** Global Discord bot reference, set by the daemon on startup. */
let _discord: DiscordBot | null = null;

/** Global feature manager reference, set by the daemon on startup. */
let _features: FeatureManager | null = null;

/** Global bot pool reference, set by the daemon on startup. */
let _pool: BotPool | null = null;

export function set_discord_bot(bot: DiscordBot | null): void {
  _discord = bot;
}

export function set_feature_manager(fm: FeatureManager | null): void {
  _features = fm;
}

export function set_pool(pool: BotPool | null): void {
  _pool = pool;
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
      (archetype as ArchetypeRole) ?? "system",
    );
  }
}

/**
 * Send a feature-scoped notification. Routes to work room if assigned.
 * No fallback — if no work room is assigned, the notification is not sent to Discord.
 * Phase transitions are still logged to console via the log line below.
 */
export async function notify_feature(
  feature: FeatureState,
  message: string,
  entity_config?: EntityConfig,
  options?: { also_alerts?: boolean; also_general?: boolean },
): Promise<void> {
  const archetype = (feature.activeArchetype ?? "system") as ArchetypeRole | "system";

  // Primary: send to work room (by channel ID). No work_log fallback —
  // interactive builders post their own progress in work rooms.
  if (feature.discordWorkRoom && _discord) {
    await _discord.send_as_agent(feature.discordWorkRoom, message, archetype);
    console.log(`[actions:notify] [work_room:${feature.discordWorkRoom}] ${message}`);
  } else {
    // Still log to console so phase transitions appear in daily logs
    console.log(`[actions:notify] [no_room] ${message}`);
  }

  // Secondary channels
  if (options?.also_alerts) {
    await notify("alerts", message, entity_config, archetype);
  }
  if (options?.also_general) {
    await notify("general", message, entity_config, archetype);
  }
}

// ── Entity config persistence ──

/** Persist an entity's config back to YAML. Used after modifying dynamic channels. */
export async function persist_entity_config(
  entity_config: EntityConfig,
): Promise<void> {
  // The config object contains the full entity config; write it back to its YAML path.
  // entity_config_path needs the paths config — extract from the path convention.
  const config_path = entity_config_path(undefined, entity_config.entity.id);
  await write_yaml(config_path, entity_config);
  console.log(`[actions] Persisted entity config for ${entity_config.entity.id}`);
}

// ── Work room management ──

/** Assign a work room to a feature. Finds a free static room or creates a dynamic one. */
export async function assign_work_room(
  feature: FeatureState,
  entity_config: EntityConfig,
): Promise<string | null> {
  // If already assigned (e.g., review→build bounce), return existing room
  if (feature.discordWorkRoom) {
    console.log(`[actions] Work room ${feature.discordWorkRoom} already assigned to ${feature.id}`);
    return feature.discordWorkRoom;
  }

  const channels = entity_config.entity.channels;
  const work_rooms = channels.list.filter((c: ChannelMapping) => c.type === "work_room");

  // Find rooms not assigned to an active (non-done) feature
  const active = _features?.get_features_by_entity(feature.entity)
    .filter(f => f.phase !== "done" && f.id !== feature.id) ?? [];
  const occupied = new Set(
    active.map(f => f.discordWorkRoom).filter((id): id is string => Boolean(id)),
  );

  // Also mark rooms with active pool assignments as occupied.
  // This prevents feature deployments from overwriting manual pool sessions
  // (e.g., an interactive planner assigned via POST /pool/assign).
  if (_pool) {
    for (const room of work_rooms) {
      const assignment = _pool.get_assignment(room.id);
      if (assignment) {
        occupied.add(room.id);
      }
    }
  }

  const free_room = work_rooms.find((r: ChannelMapping) => !occupied.has(r.id));

  let channel_id: string | null = null;

  if (free_room) {
    channel_id = free_room.id;
    free_room.assigned_feature = feature.id;
  } else {
    // Overflow: create a dynamic room
    const room_number = work_rooms.length + 1;
    const name = `work-room-${String(room_number)}`;
    const category_id = channels.category_id;

    if (!_discord || !category_id) {
      console.log("[actions] Cannot create dynamic room — no discord or category_id");
      return null;
    }

    channel_id = await _discord.create_channel(
      category_id, name, `Overflow for ${feature.id}`,
    );
    if (!channel_id) return null;

    // Register in entity config
    channels.list.push({
      type: "work_room",
      id: channel_id,
      purpose: `Dynamic workspace for ${feature.id}`,
      assigned_feature: feature.id,
      dynamic: true,
    });

    // Persist entity config change to YAML
    await persist_entity_config(entity_config);
  }

  // Set channel topic with truncated title
  if (_discord && channel_id) {
    const short_title = feature.title.length > 60
      ? feature.title.slice(0, 57) + "..."
      : feature.title;
    await _discord.set_channel_topic(
      channel_id,
      `🔨 #${String(feature.githubIssue)}: ${short_title}`,
    );
  }

  // Rebuild channel map so Discord bot routes messages correctly
  _discord?.build_channel_map();

  console.log(`[actions] Assigned work room ${channel_id} to ${feature.id}`);
  return channel_id;
}

/** Release a work room from a feature. Resets static rooms, deletes dynamic ones. */
export async function release_work_room(
  feature: FeatureState,
  entity_config: EntityConfig,
): Promise<void> {
  if (!feature.discordWorkRoom) return;

  const channel_id = feature.discordWorkRoom;
  const channels = entity_config.entity.channels;
  const entry = channels.list.find((c: ChannelMapping) => c.id === channel_id);

  if (entry?.dynamic) {
    // Dynamic room — farewell message, then delete
    if (_discord) {
      await _discord.send(
        channel_id,
        `Feature ${feature.id} complete. Cleaning up this work room.`,
      );
      await _discord.delete_channel(channel_id);
    }
    channels.list = channels.list.filter((c: ChannelMapping) => c.id !== channel_id);
    await persist_entity_config(entity_config);
  } else if (entry) {
    // Static room — reset topic and clear assignment
    entry.assigned_feature = null;
    if (_discord) {
      await _discord.set_channel_topic(channel_id, "🟢 Available");
      await _discord.send(
        channel_id,
        `Feature ${feature.id} complete. This work room is now available.`,
      );
    }
  }

  // Rebuild channel map
  _discord?.build_channel_map();

  console.log(`[actions] Released work room ${channel_id} from ${feature.id}`);
}

// ── Review outcome detection ──

export type ReviewOutcome = "approved" | "changes_requested" | "pending";

/**
 * Detect the review outcome for a PR by querying GitHub.
 * Returns "approved", "changes_requested", or "pending".
 * An already-merged PR is treated as "approved".
 */
export async function detect_review_outcome(
  pr_number: number,
  repo_path: string,
): Promise<ReviewOutcome> {
  try {
    // Check if PR is already merged
    const state = await run("gh", [
      "pr", "view", String(pr_number),
      "--json", "state",
      "--jq", ".state",
    ], repo_path);

    if (state === "MERGED") {
      return "approved";
    }

    // Check review decision
    const decision = await run("gh", [
      "pr", "view", String(pr_number),
      "--json", "reviewDecision",
      "--jq", ".reviewDecision",
    ], repo_path);

    switch (decision.toUpperCase()) {
      case "APPROVED": return "approved";
      case "CHANGES_REQUESTED": return "changes_requested";
      default: return "pending";
    }
  } catch (err) {
    console.error(`[actions] Failed to detect review outcome for PR #${String(pr_number)}: ${String(err)}`);
    return "pending";
  }
}

/** Update the topic of a feature's work room. */
export async function update_work_room_topic(
  feature: FeatureState,
  topic: string,
): Promise<void> {
  if (!feature.discordWorkRoom || !_discord) return;
  await _discord.set_channel_topic(feature.discordWorkRoom, topic);
}

// ── Merge error classification ──

export type MergeErrorKind = "conflict" | "other";

/** Patterns in gh/GitHub error output that indicate a merge conflict. */
const CONFLICT_PATTERNS = [
  "merge conflict",
  "not mergeable",
  "conflicting",
  "conflicts must be resolved",
  "pull request is not mergeable",
] as const;

/**
 * Classify a merge error as a resolvable conflict or an unrecoverable failure.
 * Checks the error message (case-insensitive) for known conflict patterns.
 */
export function classify_merge_error(error: string): MergeErrorKind {
  const lower = error.toLowerCase();
  for (const pattern of CONFLICT_PATTERNS) {
    if (lower.includes(pattern)) {
      return "conflict";
    }
  }
  return "other";
}

// ── Startup cleanup ──

/**
 * Reset topics on unoccupied work rooms to "Available".
 * Called on daemon startup to clear stale topics from previous runs.
 * Rooms with active (non-done) features keep their current topic.
 */
export async function reset_idle_work_room_topics(
  registry: EntityRegistry,
): Promise<void> {
  if (!_discord || !_features) return;

  // Collect work rooms that have an active feature
  const active_rooms = new Set<string>();
  for (const feature of _features.list_features()) {
    if (feature.discordWorkRoom && feature.phase !== "done") {
      active_rooms.add(feature.discordWorkRoom);
    }
  }

  // Reset unoccupied work rooms
  let reset_count = 0;
  for (const entity_config of registry.get_active()) {
    for (const channel of entity_config.entity.channels.list) {
      if (channel.type === "work_room" && !active_rooms.has(channel.id)) {
        await _discord.set_channel_topic(channel.id, "🟢 Available");
        reset_count++;
      }
    }
  }

  if (reset_count > 0) {
    console.log(`[actions] Reset ${String(reset_count)} idle work room topic(s) to Available`);
  }
}
