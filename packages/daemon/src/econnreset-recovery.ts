/**
 * Auto-recovery for pool bots wedged on Anthropic API connectivity errors.
 *
 * When a pool bot hits a persistent ECONNRESET or "Unable to connect to API"
 * error, Claude Code enters an internal retry loop — the tmux pane stays alive
 * (so the crash-recovery monitor is satisfied) but the bot is functionally dead.
 * This module detects the wedged state by:
 *   1. Scraping the tmux pane for API-error signatures (cheap, synchronous).
 *   2. Requiring the error to persist across ≥ WEDGE_MIN_CHECKS consecutive
 *      health ticks spanning ≥ WEDGE_MIN_MINUTES minutes, AND the bot's
 *      `last_active` not advancing between checks.
 *
 * When confirmed wedged, the session is killed so the existing crash-recovery
 * path (`restart_crashed_session`) handles respawn with --resume — we never
 * implement a separate restart path here.
 *
 * Rate-limit / escalation logic (mirrors crash-loop guard):
 *   - At most 1 auto-recycle per bot per RECYCLE_WINDOW_MS (10 min).
 *   - If ≥ ESCALATE_THRESHOLD recycles within ESCALATE_WINDOW_MS (30 min),
 *     stop recycling and escalate instead — the API is genuinely down.
 *
 * References: issue #337, `rate-limit-recovery.ts` (template).
 * Pool only — Commander and failsafe are interactive, handled separately.
 */
import { execFileSync } from "node:child_process";
import type { PoolBot } from "./pool.js";

// ── Thresholds (named constants — make config-driven if config grows here) ──

/** Minimum consecutive wedge-positive checks before acting. */
export const WEDGE_MIN_CHECKS = 2;

/** Minimum minutes spanning the wedge-positive checks before acting. */
export const WEDGE_MIN_MINUTES = 3;

/** Per-bot: minimum ms between two auto-recycles. */
export const RECYCLE_COOLDOWN_MS = 10 * 60 * 1000; // 10 min

/** Per-bot: how many recycles within ESCALATE_WINDOW_MS trigger escalation. */
export const ESCALATE_THRESHOLD = 3;

/** Per-bot: the lookback window for escalation counting. */
export const ESCALATE_WINDOW_MS = 30 * 60 * 1000; // 30 min

// ── Detection ──

/**
 * Check whether pane output shows the Claude Code API-error retry signature.
 *
 * Matches any of:
 *   - "API Error: Unable to connect" (case-insensitive)
 *   - "ECONNRESET"
 *   - "attempt N/10" (Claude Code retry progress indicator)
 *
 * Pure function — no side effects.
 */
export function detect_api_wedge(pane_output: string): boolean {
  if (/API Error: Unable to connect/i.test(pane_output)) return true;
  if (pane_output.includes("ECONNRESET")) return true;
  if (/attempt \d+\/10/i.test(pane_output)) return true;
  return false;
}

// ── Per-bot wedge state ──

/**
 * Per-bot observation window. Tracks consecutive wedge-positive checks and
 * whether `last_active` has advanced between them.
 */
export interface WedgeObservation {
  /** Timestamp (epoch ms) of the first consecutive wedge-positive check. */
  first_seen_ms: number;
  /** Timestamp (epoch ms) of the most recent wedge-positive check. */
  last_seen_ms: number;
  /** Number of consecutive wedge-positive checks. */
  check_count: number;
  /** `last_active` ISO string captured at `first_seen_ms`. Used to detect
   * whether the bot sent any successful response between checks. */
  last_active_at_first_seen: string | null;
}

/**
 * Per-bot recycle history for rate-limit and escalation tracking.
 */
export interface RecycleRecord {
  /** Epoch ms timestamps of past recycles within the escalation window. */
  timestamps: number[];
}

// ── Tmux interaction (re-exported for testability) ──

/**
 * Capture the full content of a tmux pane.
 * Returns null if the pane can't be read (session dead, timeout, etc.).
 */
export function capture_tmux_pane(tmux_session: string): string | null {
  try {
    return execFileSync("tmux", ["capture-pane", "-t", tmux_session, "-p"], {
      encoding: "utf-8",
      timeout: 2000,
    });
  } catch {
    return null;
  }
}

// ── Wedge state machine (stateless tick function) ──

export type WedgeTick =
  | { action: "none" }
  | { action: "recycle"; reason: "wedge_confirmed" }
  | { action: "escalate"; reason: "too_many_recycles"; recycle_count: number };

/**
 * Process one health-check tick for a single bot.
 *
 * Mutates `observations` and `recycle_records` in-place — the caller owns these
 * maps and persists them across ticks (they live on BotPool).
 *
 * Returns the action the caller should take:
 *   - "none" — nothing to do
 *   - "recycle" — kill the tmux session (let crash-recovery respawn it)
 *   - "escalate" — post to alerts, do NOT recycle
 *
 * @param bot - the pool bot being inspected
 * @param pane_output - captured tmux pane content (null = pane unreadable, clear observation)
 * @param now_ms - current epoch ms (injectable for testing)
 * @param observations - mutable map: bot_id → WedgeObservation
 * @param recycle_records - mutable map: bot_id → RecycleRecord
 */
export function process_wedge_tick(
  bot: PoolBot,
  pane_output: string | null,
  now_ms: number,
  observations: Map<number, WedgeObservation>,
  recycle_records: Map<number, RecycleRecord>,
): WedgeTick {
  if (pane_output === null) {
    // Can't read pane — clear any pending observation (session may be restarting)
    observations.delete(bot.id);
    return { action: "none" };
  }

  const is_wedged = detect_api_wedge(pane_output);

  if (!is_wedged) {
    // Wedge signature absent — reset observation window
    observations.delete(bot.id);
    return { action: "none" };
  }

  // Wedge signature present — accumulate or start observation
  const existing = observations.get(bot.id);
  const last_active_str = bot.last_active?.toISOString() ?? null;

  if (!existing) {
    // First tick seeing the wedge — start the observation window
    observations.set(bot.id, {
      first_seen_ms: now_ms,
      last_seen_ms: now_ms,
      check_count: 1,
      last_active_at_first_seen: last_active_str,
    });
    return { action: "none" };
  }

  // Subsequent tick — check whether last_active has advanced (bot recovered)
  const last_active_advanced = last_active_str !== existing.last_active_at_first_seen;
  if (last_active_advanced) {
    // Bot sent a successful response — clear observation, not wedged
    observations.delete(bot.id);
    return { action: "none" };
  }

  // Update observation
  const updated: WedgeObservation = {
    ...existing,
    last_seen_ms: now_ms,
    check_count: existing.check_count + 1,
  };
  observations.set(bot.id, updated);

  // Check confirmation thresholds
  const elapsed_minutes = (now_ms - existing.first_seen_ms) / 60_000;
  const checks_met = updated.check_count >= WEDGE_MIN_CHECKS;
  const time_met = elapsed_minutes >= WEDGE_MIN_MINUTES;

  if (!checks_met || !time_met) {
    return { action: "none" };
  }

  // Confirmed wedge — check rate limits before acting
  const record = recycle_records.get(bot.id) ?? { timestamps: [] };

  // Prune old entries outside escalation window
  const window_start = now_ms - ESCALATE_WINDOW_MS;
  const recent_recycles = record.timestamps.filter((t) => t > window_start);

  // Check for escalation: too many recycles in the window
  if (recent_recycles.length >= ESCALATE_THRESHOLD) {
    // Don't recycle — escalate instead. Don't update recycle record.
    return {
      action: "escalate",
      reason: "too_many_recycles",
      recycle_count: recent_recycles.length,
    };
  }

  // Check per-bot cooldown (at most 1 recycle per RECYCLE_COOLDOWN_MS)
  const last_recycle = recent_recycles.at(-1) ?? 0;
  if (now_ms - last_recycle < RECYCLE_COOLDOWN_MS) {
    // Within cooldown window — wait. Don't clear the observation so we don't re-trigger too soon.
    return { action: "none" };
  }

  // All checks passed — recycle. Record the recycle and clear observation.
  recent_recycles.push(now_ms);
  recycle_records.set(bot.id, { timestamps: recent_recycles });
  observations.delete(bot.id);

  return { action: "recycle", reason: "wedge_confirmed" };
}

/**
 * Scan all assigned pool bots and determine which need action.
 *
 * Returns a list of scan results for callers to act on (kill tmux, alert, etc.).
 * Mutates `observations` and `recycle_records` via process_wedge_tick.
 *
 * @param bots - assigned pool bots to scan
 * @param observations - mutable map of wedge observations (owned by BotPool)
 * @param recycle_records - mutable map of recycle history (owned by BotPool)
 * @param capture_fn - tmux capture function (injectable for testing)
 * @param now_ms - current epoch ms (injectable for testing)
 */
export function scan_for_wedged_bots(
  bots: readonly PoolBot[],
  observations: Map<number, WedgeObservation>,
  recycle_records: Map<number, RecycleRecord>,
  capture_fn: (session: string) => string | null = capture_tmux_pane,
  now_ms: number = Date.now(),
): WedgeScanResult[] {
  const results: WedgeScanResult[] = [];

  for (const bot of bots) {
    if (bot.state !== "assigned") continue;

    const pane = capture_fn(bot.tmux_session);
    const tick = process_wedge_tick(bot, pane, now_ms, observations, recycle_records);

    if (tick.action !== "none") {
      results.push({ bot, tick });
    }
  }

  return results;
}

export interface WedgeScanResult {
  bot: PoolBot;
  tick: WedgeTick & { action: "recycle" | "escalate" };
}

/**
 * Prune stale observation and recycle entries for bots no longer assigned
 * (released, parked, etc.) to prevent memory growth.
 *
 * Call periodically from the health check loop.
 */
export function prune_wedge_state(
  observations: Map<number, WedgeObservation>,
  recycle_records: Map<number, RecycleRecord>,
  assigned_bot_ids: Set<number>,
  now_ms: number = Date.now(),
): void {
  // Clear observations for non-assigned bots
  for (const id of observations.keys()) {
    if (!assigned_bot_ids.has(id)) {
      observations.delete(id);
    }
  }

  // Prune old recycle timestamps; remove entries that are empty
  const window_start = now_ms - ESCALATE_WINDOW_MS;
  for (const [id, record] of recycle_records) {
    const fresh = record.timestamps.filter((t) => t > window_start);
    if (fresh.length === 0) {
      recycle_records.delete(id);
    } else {
      recycle_records.set(id, { timestamps: fresh });
    }
  }
}
