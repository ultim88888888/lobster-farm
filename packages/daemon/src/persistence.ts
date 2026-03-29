import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LobsterFarmConfig, ArchetypeRole, ChannelType } from "@lobster-farm/shared";
import { lobsterfarm_dir, entity_dir } from "@lobster-farm/shared";

const STATE_DIR = "state";
const PR_REVIEWS_FILE = "pr-reviews.json";
const POOL_STATE_FILE = "pool-state.json";

function state_dir(config: LobsterFarmConfig): string {
  return join(lobsterfarm_dir(config.paths), STATE_DIR);
}

function pr_reviews_path(config: LobsterFarmConfig): string {
  return join(state_dir(config), PR_REVIEWS_FILE);
}

function pool_state_path(config: LobsterFarmConfig): string {
  return join(state_dir(config), POOL_STATE_FILE);
}

// ── PR Review State ──

export interface ProcessedPR {
  entity_id: string;
  pr_number: number;
  reviewed_at: string;       // ISO timestamp
  outcome: "approved" | "changes_requested" | "pending";
}

/** Keyed by "entity_id:pr_number" */
export type PRReviewState = Record<string, ProcessedPR>;

/** Save PR review state to disk. */
export async function save_pr_reviews(
  state: PRReviewState,
  config: LobsterFarmConfig,
): Promise<void> {
  const path = pr_reviews_path(config);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2), "utf-8");
}

/** Load PR review state from disk. Returns empty object if file doesn't exist. */
export async function load_pr_reviews(
  config: LobsterFarmConfig,
): Promise<PRReviewState> {
  const path = pr_reviews_path(config);
  try {
    const content = await readFile(path, "utf-8");
    const data: unknown = JSON.parse(content);
    if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
    return data as PRReviewState;
  } catch {
    return {};
  }
}

// ── Pool State ──

export interface PersistedPoolBot {
  id: number;
  state: "assigned" | "parked";  // free bots are not persisted
  channel_id: string;
  entity_id: string;
  archetype: ArchetypeRole;
  channel_type: ChannelType | null;
  session_id: string | null;
  /** Claude CLI model ID (e.g., "claude-opus-4-6"). Added in #101. */
  model?: string | null;
  /** Claude CLI effort level (e.g., "high"). Added in #101. */
  effort?: string | null;
  last_active: string | null;  // ISO timestamp
  assigned_at?: string | null;  // ISO timestamp — when the bot was assigned to its current channel
  /** The archetype whose avatar is currently set on this bot's Discord profile.
   * Persisted so we don't redundantly set avatars on restart. */
  last_avatar_archetype?: ArchetypeRole | null;
}

/** Per-bot avatar state, persisted for ALL bots (including free ones).
 * A bot's Discord profile avatar persists even when the bot is released from
 * the pool — we need to track it across assignment cycles. */
export interface PersistedBotAvatarState {
  archetype: ArchetypeRole;
  set_at: string;  // ISO timestamp
}

/** Persisted pool state: bots + session history for cross-eviction resume. */
export interface PersistedPoolState {
  bots: PersistedPoolBot[];
  /** Maps "{entity_id}:{channel_id}" → session_id. Preserved across evictions
   * so a channel can resume its old session when a bot is reassigned to it. */
  session_history: Record<string, string>;
  /** Per-bot avatar state, keyed by bot ID string. Persisted for ALL bots
   * (including free ones) because the Discord profile avatar persists
   * independently of pool assignment. */
  avatar_state?: Record<string, PersistedBotAvatarState>;
}

/** Save pool state (bots + session history + avatar state) to disk. */
export async function save_pool_state(
  bots: PersistedPoolBot[],
  config: LobsterFarmConfig,
  session_history?: Record<string, string>,
  avatar_state?: Record<string, PersistedBotAvatarState>,
): Promise<void> {
  const path = pool_state_path(config);
  await mkdir(dirname(path), { recursive: true });
  const state: PersistedPoolState = {
    bots,
    session_history: session_history ?? {},
    avatar_state: avatar_state ?? {},
  };
  await writeFile(path, JSON.stringify(state, null, 2), "utf-8");
}

/**
 * Load pool state from disk.
 * Backward-compatible: if the file contains a plain array (old format),
 * treats it as bots-only with empty session history.
 */
export async function load_pool_state(
  config: LobsterFarmConfig,
): Promise<PersistedPoolState> {
  const path = pool_state_path(config);
  try {
    const content = await readFile(path, "utf-8");
    const data: unknown = JSON.parse(content);

    // Old format: plain array of bots
    if (Array.isArray(data)) {
      console.log(`[pool] Loaded pool-state.json (old array format, ${String(data.length)} entries)`);
      return { bots: data as PersistedPoolBot[], session_history: {}, avatar_state: {} };
    }

    // New format: { bots, session_history, avatar_state? }
    if (typeof data === "object" && data !== null && "bots" in data) {
      const obj = data as Record<string, unknown>;
      const bots = Array.isArray(obj["bots"]) ? (obj["bots"] as PersistedPoolBot[]) : [];
      const history = (typeof obj["session_history"] === "object" && obj["session_history"] !== null && !Array.isArray(obj["session_history"]))
        ? (obj["session_history"] as Record<string, string>)
        : {};
      const avatars = (typeof obj["avatar_state"] === "object" && obj["avatar_state"] !== null && !Array.isArray(obj["avatar_state"]))
        ? (obj["avatar_state"] as Record<string, PersistedBotAvatarState>)
        : {};
      console.log(
        `[pool] Loaded pool-state.json (${String(bots.length)} bots, ` +
        `${String(Object.keys(history).length)} history entries, ` +
        `${String(Object.keys(avatars).length)} avatar entries)`,
      );
      return { bots, session_history: history, avatar_state: avatars };
    }

    console.log("[pool] pool-state.json has unexpected format — starting fresh");
    return { bots: [], session_history: {}, avatar_state: {} };
  } catch (err) {
    const msg = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? "file not found"
      : String(err);
    console.log(`[pool] Could not load pool-state.json: ${msg} — starting fresh`);
    return { bots: [], session_history: {}, avatar_state: {} };
  }
}

// ── Session Log ──

const SESSION_LOG_FILE = "session-log.jsonl";

export interface SessionLogEntry {
  session_id: string;
  entity_id: string;
  feature_id: string | null;
  archetype: ArchetypeRole;
  phase: string | null;
  source: "queue" | "pool";
  started_at: string;           // ISO timestamp
  ended_at: string | null;      // ISO timestamp, null if still running
  exit_code: number | null;     // null if still running
  duration_ms: number | null;   // computed from start/end
  bot_id: number | null;        // pool bot ID if pool-sourced
  resume: boolean;              // was this a resumed session?
}

function session_log_path(config: LobsterFarmConfig, entity_id: string): string {
  return join(entity_dir(config.paths, entity_id), SESSION_LOG_FILE);
}

/**
 * Append a session log entry to the entity's JSONL log file.
 * Creates the file and parent directories if they don't exist.
 */
export async function append_session_log(
  entity_id: string,
  entry: SessionLogEntry,
  config: LobsterFarmConfig,
): Promise<void> {
  const path = session_log_path(config, entity_id);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(entry) + "\n", "utf-8");
}

/**
 * Read session log entries for an entity.
 * Skips malformed lines gracefully. Supports optional `since` date filter and `limit`.
 *
 * Note: `since` filters entries before collecting, while `limit` truncates after.
 * When both are provided, `limit` applies to the already-filtered result set.
 * The entire file is read into memory first. For large files, consider implementing
 * JSONL rotation (e.g., daily segments) to bound memory usage.
 */
export async function read_session_log(
  entity_id: string,
  config: LobsterFarmConfig,
  opts?: { since?: Date; limit?: number },
): Promise<SessionLogEntry[]> {
  const path = session_log_path(config, entity_id);
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch {
    return [];
  }

  const lines = content.split("\n").filter(Boolean);
  const entries: SessionLogEntry[] = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as SessionLogEntry;

      if (opts?.since) {
        const entry_time = entry.ended_at ?? entry.started_at;
        if (new Date(entry_time) < opts.since) continue;
      }

      entries.push(entry);
    } catch {
      // Skip malformed lines -- append-only log may have partial writes
    }
  }

  if (opts?.limit && entries.length > opts.limit) {
    return entries.slice(-opts.limit);
  }

  return entries;
}
