/**
 * Fetch subscription usage from Anthropic's OAuth API on demand.
 *
 * Reads the OAuth access token from the macOS Keychain (same credential
 * Claude Code itself stores) and calls the usage endpoint. The token is
 * used immediately for the API call and never stored in daemon memory.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as sentry from "./sentry.js";

const exec = promisify(execFile);

// ── Types ──

export interface UsageWindow {
  utilization: number;
  resets_at: string;
}

export interface ExtraUsage {
  is_enabled: boolean;
  monthly_limit: number;
  used_credits: number;
  utilization: number;
}

export interface SubscriptionUsageResponse {
  five_hour?: UsageWindow;
  seven_day?: UsageWindow;
  seven_day_opus?: UsageWindow;
  seven_day_sonnet?: UsageWindow;
  extra_usage?: ExtraUsage;
}

/** Formatted summary for display in /status. */
export interface SubscriptionUsageSummary {
  /** Raw API response for callers that want fine-grained data. */
  raw: SubscriptionUsageResponse;
  /** e.g., "5h: 5% | Weekly: 29% (resets in 3d 13h)" */
  summary: string;
}

// ── Keychain credential read ──

interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  scopes: string[];
  rateLimitTier: string;
}

/**
 * Read OAuth credentials from the macOS Keychain.
 *
 * SECURITY: The access token is a secret. It is returned only so the caller
 * can pass it to the HTTP request immediately. Never log, persist, or cache it.
 */
export async function read_oauth_credentials(): Promise<OAuthCredentials> {
  const { stdout } = await exec(
    "security",
    ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
    { timeout: 5000 },
  );

  const blob = JSON.parse(stdout.trim()) as Record<string, unknown>;
  const oauth = blob["claudeAiOauth"] as OAuthCredentials | undefined;
  if (!oauth?.accessToken) {
    throw new Error("No claudeAiOauth.accessToken found in Keychain credentials");
  }
  return oauth;
}

// ── API call ──

/**
 * Fetch subscription usage from the Anthropic OAuth API.
 *
 * Best-effort: returns null on any failure (network, auth, parse).
 * Errors are logged and sent to Sentry but never thrown.
 */
export async function fetch_subscription_usage(): Promise<SubscriptionUsageSummary | null> {
  try {
    const creds = await read_oauth_credentials();

    const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${creds.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "claude-code/1.0.0",
      },
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      console.error(`[usage-api] API returned ${String(response.status)}: ${response.statusText}`);
      return null;
    }

    const data = await response.json() as SubscriptionUsageResponse;
    return {
      raw: data,
      summary: format_usage_summary(data),
    };
  } catch (err) {
    // Don't log the full error object — it might contain the token in stack traces
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error(`[usage-api] Failed to fetch subscription usage: ${msg}`);
    sentry.captureException(err, {
      tags: { module: "usage-api" },
    });
    return null;
  }
}

// ── Formatting ──

/**
 * Format the usage response into a human-readable summary for Discord.
 * Shows the most relevant windows: 5-hour and 7-day totals.
 */
function format_usage_summary(data: SubscriptionUsageResponse): string {
  const parts: string[] = [];

  if (data.five_hour) {
    const pct = Math.round(data.five_hour.utilization);
    parts.push(`5h: ${String(pct)}%`);
  }

  if (data.seven_day) {
    const pct = Math.round(data.seven_day.utilization);
    const resets_label = format_resets_in(data.seven_day.resets_at);
    parts.push(`Weekly: ${String(pct)}%${resets_label}`);
  }

  if (data.extra_usage?.is_enabled) {
    const spent = data.extra_usage.used_credits.toFixed(2);
    const limit = data.extra_usage.monthly_limit.toFixed(0);
    parts.push(`Extra: $${spent}/$${limit}`);
  }

  return parts.length > 0 ? parts.join(" | ") : "No usage data available";
}

/** Format "resets in X" from an ISO timestamp. Returns empty string if unparseable. */
function format_resets_in(resets_at: string): string {
  try {
    const reset_time = new Date(resets_at).getTime();
    const remaining_ms = reset_time - Date.now();
    if (remaining_ms <= 0) return " (resetting)";

    const hours = Math.floor(remaining_ms / 3_600_000);
    const days = Math.floor(hours / 24);
    const remaining_hours = hours % 24;

    if (days > 0) {
      return ` (resets in ${String(days)}d ${String(remaining_hours)}h)`;
    }
    return ` (resets in ${String(hours)}h)`;
  } catch {
    return "";
  }
}
