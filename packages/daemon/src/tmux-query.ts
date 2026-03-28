/**
 * Query Claude Code session slash commands (/context, /usage) via tmux injection.
 *
 * Pattern: send a slash command to a tmux pane, wait for output, capture and parse.
 * Only injects when the session is idle (prompt visible) to avoid interference.
 */
import { execFileSync } from "node:child_process";

// ── Types ──

export interface ContextUsage {
  /** e.g., "45k / 1m (4.5%)" */
  summary: string;
  /** Raw token count (e.g., 45000) */
  used_tokens: number | null;
  /** Total context window (e.g., 1000000) */
  total_tokens: number | null;
  /** Percentage (e.g., 4.5) */
  percent: number | null;
}

export interface SubscriptionUsage {
  /** e.g., "62% weekly" */
  summary: string;
  /** Weekly percentage (e.g., 62) */
  weekly_percent: number | null;
}

// ── Pane state check ──

/**
 * Check if the tmux pane is at the Claude Code prompt (idle).
 * Returns false if the session is working, not found, or unreadable.
 */
function is_session_at_prompt(tmux_session: string): boolean {
  try {
    const output = execFileSync(
      "tmux", ["capture-pane", "-t", tmux_session, "-p"],
      { encoding: "utf-8", timeout: 2000 },
    );
    const lines = output.trim().split("\n");
    const last_line = lines[lines.length - 1] ?? "";
    return last_line.includes("\u276F"); // ❯ prompt character
  } catch {
    return false;
  }
}

// ── Core query helper ──

/**
 * Send a slash command to a Claude Code tmux session and capture the output.
 *
 * Safety: only injects when the session is idle at the prompt. If the session
 * is actively working, returns null to avoid interference.
 *
 * @param tmux_session - tmux session name (e.g., "pool-3")
 * @param command - slash command to send (e.g., "/context" or "/usage")
 * @param wait_ms - how long to wait for output (default 2000ms)
 * @returns raw captured pane output, or null if injection was unsafe or failed
 */
export async function query_session_slash_command(
  tmux_session: string,
  command: string,
  wait_ms: number = 2000,
): Promise<string | null> {
  // Guard: only inject when session is idle at the prompt
  if (!is_session_at_prompt(tmux_session)) {
    return null;
  }

  try {
    // Send the command
    execFileSync("tmux", ["send-keys", "-t", tmux_session, command, "Enter"], {
      timeout: 2000,
    });

    // Wait for the command to produce output
    await new Promise(resolve => setTimeout(resolve, wait_ms));

    // Capture the pane content
    const output = execFileSync(
      "tmux", ["capture-pane", "-t", tmux_session, "-p", "-S", "-100"],
      { encoding: "utf-8", timeout: 2000 },
    );

    return output;
  } catch {
    return null;
  }
}

// ── Parsers ──

/**
 * Parse /context output to extract token usage.
 *
 * Expected format includes a line like:
 *   "Tokens: 19k / 1m (2%)"
 * or
 *   "Tokens: 145,234 / 1,048,576 (14%)"
 */
export function parse_context_usage(output: string): ContextUsage | null {
  // Look for the token summary line: "Tokens: <used> / <total> (<percent>%)"
  const token_line = output.match(/Tokens:\s*([0-9,.]+[km]?)\s*\/\s*([0-9,.]+[km]?)\s*\(([0-9.]+)%\)/i);
  if (!token_line) return null;

  const [, used_str, total_str, percent_str] = token_line;
  if (!used_str || !total_str || !percent_str) return null;

  return {
    summary: `${used_str} / ${total_str} (${percent_str}%)`,
    used_tokens: parse_token_count(used_str),
    total_tokens: parse_token_count(total_str),
    percent: parseFloat(percent_str),
  };
}

/**
 * Parse /usage output to extract subscription usage.
 *
 * Expected format includes lines like:
 *   "Weekly usage: 62%"
 * or
 *   "Usage: 62% of weekly limit"
 * or table-style output with percentage values.
 */
export function parse_subscription_usage(output: string): SubscriptionUsage | null {
  // Try "Usage: XX% of weekly" or "Weekly usage: XX%"
  const weekly_match = output.match(/(?:weekly\s+usage|usage).*?(\d+(?:\.\d+)?)%/i);
  if (weekly_match?.[1]) {
    const percent = parseFloat(weekly_match[1]);
    return {
      summary: `${String(percent)}% weekly`,
      weekly_percent: percent,
    };
  }

  // Fallback: look for any prominent percentage in the output
  // (e.g., "62.3%  of your Opus limit")
  const pct_match = output.match(/(\d+(?:\.\d+)?)%\s*(?:of\s+(?:your|the)|weekly|limit)/i);
  if (pct_match?.[1]) {
    const percent = parseFloat(pct_match[1]);
    return {
      summary: `${String(percent)}% weekly`,
      weekly_percent: percent,
    };
  }

  return null;
}

// ── Token count normalization ──

/** Parse a human-readable token count like "19k", "1m", "145,234" to a number. */
export function parse_token_count(s: string): number | null {
  const clean = s.replace(/,/g, "").trim().toLowerCase();
  if (clean.endsWith("k")) {
    const n = parseFloat(clean.slice(0, -1));
    return isNaN(n) ? null : Math.round(n * 1000);
  }
  if (clean.endsWith("m")) {
    const n = parseFloat(clean.slice(0, -1));
    return isNaN(n) ? null : Math.round(n * 1_000_000);
  }
  const n = parseFloat(clean);
  return isNaN(n) ? null : Math.round(n);
}

// ── High-level queries ──

/**
 * Query a Claude Code session's context usage via /context.
 * Returns null if the session is busy or the query fails.
 */
export async function query_context_usage(
  tmux_session: string,
): Promise<ContextUsage | null> {
  const output = await query_session_slash_command(tmux_session, "/context");
  if (!output) return null;
  return parse_context_usage(output);
}

/**
 * Query a Claude Code session's subscription usage via /usage.
 * Returns null if the session is busy or the query fails.
 */
export async function query_subscription_usage(
  tmux_session: string,
): Promise<SubscriptionUsage | null> {
  const output = await query_session_slash_command(tmux_session, "/usage");
  if (!output) return null;
  return parse_subscription_usage(output);
}
