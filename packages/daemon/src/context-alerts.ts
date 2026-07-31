/**
 * Context-size threshold alerts (#353).
 *
 * Context is the dominant driver of subscription burn — the spend is re-reading
 * accumulated context, not generating tokens. A handful of long-lived pool
 * sessions can consume most of a weekly allowance, and today the first signal
 * is the allowance running out.
 *
 * This module sweeps the pool every 15 minutes, reads each session's context
 * size via the existing `/context` tmux query, and posts an alert through the
 * existing alert router when a session crosses a size threshold.
 *
 * Two properties matter more than anything else here:
 *
 *  1. **Once per breach, not once per sweep.** A threshold that has fired stays
 *     quiet while usage remains above it.
 *  2. **Hysteresis — re-arm on the way down.** A threshold is *armed* whenever
 *     current usage is below it, and fires on the upward crossing. Compacting a
 *     session re-arms its thresholds, so if the context regrows past one you get
 *     told again. That is the whole point: you compact, and you want to know if
 *     it comes back.
 *
 * Dedupe state is keyed by `session_id` (so a recycled session starts fully
 * armed) and persisted to `state/context-alerts.json` (so a daemon restart does
 * not re-fire every threshold for every session).
 *
 * This is a monitoring aid. It must never crash the sweep and must never become
 * a noise source: any session whose context can't be read is skipped silently,
 * with its dedupe state left untouched.
 */

import type { AlertPayload, AlertResult, AlertTier } from "./alert-router.js";
import { ALERT_COLOR_AMBER, ALERT_COLOR_RED } from "./alert-router.js";
import type { ContextAlertSession, ContextAlertState } from "./persistence.js";
import type { PoolBot } from "./pool.js";
import * as sentry from "./sentry.js";
import type { ContextUsage } from "./tmux-query.js";

// ── Thresholds ──

export interface ContextThreshold {
  /** Absolute context size, in tokens, that triggers the alert. */
  tokens: number;
  /** Human label used in alert copy, e.g. "500k". */
  label: string;
  /** Which alert tier this threshold warrants. */
  tier: AlertTier;
  /** Embed color for `action_required` alerts. */
  color: number;
  /** What to do about it, rendered into the alert body. */
  action: string;
}

/**
 * The thresholds, ascending. Tunable — this is the single place they live.
 *
 * Tiers escalate deliberately. 200k is informational and goes to the daily
 * activity thread; a top-level embed for every session that gets moderately
 * large would be exactly the noise this feature must not create. 500k and 800k
 * are top-level, because by then the session is materially expensive.
 *
 * Against the 1M window these are ~20% / 50% / 80%, but the comparison is
 * always against absolute tokens — `total_tokens` is only used for display.
 */
export const CONTEXT_ALERT_THRESHOLDS: readonly ContextThreshold[] = [
  {
    tokens: 200_000,
    label: "200k",
    tier: "routine",
    color: ALERT_COLOR_AMBER,
    action: "No action needed yet — worth a `/compact` at the next natural break.",
  },
  {
    tokens: 500_000,
    label: "500k",
    tier: "action_required",
    color: ALERT_COLOR_AMBER,
    action: "Run `/compact` in the channel, or recycle the bot if the thread is done.",
  },
  {
    tokens: 800_000,
    label: "800k",
    tier: "action_required",
    color: ALERT_COLOR_RED,
    action:
      "Recycle the bot, or `/compact` immediately — every further turn re-reads this whole context.",
  },
];

/** How often the sweep runs. Cheap — a local tmux query, no model call. */
export const CONTEXT_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Drop dedupe state for sessions the sweep hasn't seen in this long. Keyed on
 * *seen in the pool*, not *successfully read*, so a session that is merely busy
 * for a long stretch keeps its state and won't re-alert when it comes back.
 */
export const CONTEXT_ALERT_STATE_TTL_MS = 24 * 60 * 60 * 1000;

// ── Threshold evaluation (pure) ──

export interface ThresholdEvaluation {
  /** Thresholds newly crossed on this reading, ascending. */
  crossed: ContextThreshold[];
  /** The next `fired` set: breached thresholds, ascending. */
  fired: number[];
}

/**
 * Evaluate a context reading against the thresholds and the previously fired
 * set. Pure — this is the entire dedupe/hysteresis rule in one place.
 *
 * A threshold is breached when `used_tokens >= tokens` (an exact hit counts).
 * Breached and previously armed → crossed. Not breached → re-armed.
 */
export function evaluate_thresholds(
  used_tokens: number,
  fired: readonly number[],
  thresholds: readonly ContextThreshold[] = CONTEXT_ALERT_THRESHOLDS,
): ThresholdEvaluation {
  const previously_fired = new Set(fired);
  const crossed: ContextThreshold[] = [];
  const next_fired: number[] = [];

  for (const threshold of thresholds) {
    if (used_tokens < threshold.tokens) continue; // below → armed
    next_fired.push(threshold.tokens);
    if (!previously_fired.has(threshold.tokens)) crossed.push(threshold);
  }

  return { crossed, fired: next_fired.sort((a, b) => a - b) };
}

// ── Pool adapter ──

/** The slice of a pool bot the sweep needs. */
export interface ContextSweepBot {
  bot_id: number;
  session_id: string;
  entity_id: string;
  channel_id: string;
  tmux_session: string;
}

/**
 * Narrow pool bots to the ones the sweep can act on: a live session with an
 * entity and channel to route an alert to.
 */
export function context_bots_from_pool(bots: readonly PoolBot[]): ContextSweepBot[] {
  const sweepable: ContextSweepBot[] = [];
  for (const bot of bots) {
    if (!bot.session_id || !bot.entity_id || !bot.channel_id) continue;
    sweepable.push({
      bot_id: bot.id,
      session_id: bot.session_id,
      entity_id: bot.entity_id,
      channel_id: bot.channel_id,
      tmux_session: bot.tmux_session,
    });
  }
  return sweepable;
}

// ── Alert formatting ──

/** Render a token count the way `/context` does: 45k, 1.2m. */
export function format_tokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${(Math.round(m * 10) / 10).toString()}m`;
  }
  return `${Math.round(tokens / 1000).toString()}k`;
}

/**
 * Build the alert for a crossed threshold. Everything needed to act is in the
 * body: which channel, how big, which threshold, which session, what to do.
 */
export function format_context_alert(
  bot: ContextSweepBot,
  threshold: ContextThreshold,
  usage: ContextUsage,
): AlertPayload {
  const size = usage.summary || format_tokens(usage.used_tokens ?? threshold.tokens);

  return {
    entity_id: bot.entity_id,
    tier: threshold.tier,
    title: `\u{1f9e0} Context over ${threshold.label} — pool-${bot.bot_id.toString()}`,
    body: [
      `<#${bot.channel_id}> (\`${bot.entity_id}\`) is at **${size}** — crossed the **${threshold.label}** threshold.`,
      `Session \`${bot.session_id}\` on \`${bot.tmux_session}\`.`,
      threshold.action,
    ].join("\n"),
    embed_color: threshold.color,
  };
}

// ── Sweep ──

export interface ContextSweepDeps {
  /** Pool bots eligible for a context check. */
  list_bots: () => ContextSweepBot[];
  /** Read a session's context size. Returns null when unreadable or busy. */
  query_usage: (tmux_session: string) => Promise<ContextUsage | null>;
  post_alert: (payload: AlertPayload) => Promise<AlertResult | unknown>;
  load_state: () => Promise<ContextAlertState>;
  save_state: (state: ContextAlertState) => Promise<void>;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

/**
 * One sweep: check every eligible pool session, alert on newly crossed
 * thresholds, and persist the updated dedupe state.
 *
 * Sessions are checked serially — `query_usage` types `/context` into a live
 * tmux pane and waits for the render, so hammering ten panes at once buys
 * nothing on a 15-minute cycle.
 *
 * Never throws.
 */
export async function sweep_context_thresholds(deps: ContextSweepDeps): Promise<void> {
  const now = deps.now?.() ?? new Date();
  const now_iso = now.toISOString();

  let state: ContextAlertState;
  try {
    state = await deps.load_state();
  } catch (err) {
    console.error(`[context-alerts] Could not load state: ${String(err)}`);
    return;
  }

  const bots = deps.list_bots();
  const next_state: ContextAlertState = {};
  let alerted = 0;

  for (const bot of bots) {
    // Defensive: pool state is rehydrated from JSON, so the non-null type on
    // session_id is only as strong as whoever built the list. Keying state
    // under a missing id would merge unrelated bots into one dedupe entry.
    if (!bot.session_id) continue;

    const previous: ContextAlertSession | undefined = state[bot.session_id];

    // Seen in the pool this sweep — carry state forward and refresh the TTL,
    // whether or not the reading below succeeds.
    const entry: ContextAlertSession = {
      fired: previous?.fired ?? [],
      last_used_tokens: previous?.last_used_tokens ?? null,
      last_seen_at: now_iso,
    };
    next_state[bot.session_id] = entry;

    let usage: ContextUsage | null;
    try {
      usage = await deps.query_usage(bot.tmux_session);
    } catch {
      // Dead session, tmux gone, injection refused — skip silently. State for
      // this session is preserved above so nothing re-fires when it returns.
      continue;
    }

    if (!usage || usage.used_tokens === null) continue;

    const { crossed, fired } = evaluate_thresholds(usage.used_tokens, entry.fired);
    entry.fired = fired;
    entry.last_used_tokens = usage.used_tokens;

    if (crossed.length === 0) continue;

    // A single jump can clear several thresholds. Alert once, on the highest —
    // the lower ones are marked fired above so they stay quiet on the way up.
    const highest = crossed[crossed.length - 1]!;
    try {
      await deps.post_alert(format_context_alert(bot, highest, usage));
      alerted++;
    } catch (err) {
      // The threshold is still recorded as fired: a Discord outage must not
      // turn into a burst of duplicate alerts on the next sweep.
      console.error(
        `[context-alerts] Failed to post alert for ${bot.tmux_session}: ${String(err)}`,
      );
      sentry.captureException(err, {
        tags: { module: "context-alerts", action: "post_alert", entity: bot.entity_id },
      });
    }
  }

  // Carry forward sessions absent from this sweep until they age out, so a
  // transiently empty pool (mid-restart, say) can't wipe the dedupe state.
  const ttl_cutoff = now.getTime() - CONTEXT_ALERT_STATE_TTL_MS;
  for (const [session_id, entry] of Object.entries(state)) {
    if (session_id in next_state) continue;
    if (Date.parse(entry.last_seen_at) >= ttl_cutoff) next_state[session_id] = entry;
  }

  try {
    await deps.save_state(next_state);
  } catch (err) {
    console.error(`[context-alerts] Could not save state: ${String(err)}`);
    sentry.captureException(err, {
      tags: { module: "context-alerts", action: "save_state" },
    });
  }

  if (alerted > 0) {
    console.log(
      `[context-alerts] Sweep complete: ${alerted.toString()} threshold alert(s) across ${bots.length.toString()} session(s)`,
    );
  }
}
