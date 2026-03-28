/**
 * Read context window usage from Claude Code JSONL session transcripts.
 *
 * Session files live at ~/.claude/projects/<project-slug>/<session-id>.jsonl.
 * Each line with type === "assistant" contains message.usage with token counts.
 * We sum all usage entries to approximate total context consumed.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import * as sentry from "./sentry.js";

// ── Types ──

export interface SessionContextUsage {
  /** Total tokens consumed across all assistant turns. */
  used_tokens: number;
  /** Model context window size (200k for opus/sonnet). */
  total_tokens: number;
  /** Percentage of context used, e.g. 22.5 */
  percent: number;
  /** Formatted summary, e.g. "45k / 200k (22.5%)" */
  summary: string;
}

/** Token usage fields from a single assistant message in the JSONL transcript. */
interface MessageUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

// ── Constants ──

/** Default context window size for Claude opus/sonnet models. */
const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Root directory for Claude Code project sessions.
 * Resolved lazily via function so tests can mock homedir(). */
function claude_projects_dir(): string {
  return join(homedir(), ".claude", "projects");
}

// ── JSONL file discovery ──

/**
 * Find the JSONL transcript file for a session ID.
 *
 * Session files are stored in project-slug subdirectories. Since we don't
 * know which project a session belongs to, we search all project dirs.
 * Returns the first match found, or null if the session file doesn't exist.
 */
export async function find_session_file(session_id: string): Promise<string | null> {
  const filename = `${session_id}.jsonl`;
  const projects_dir = claude_projects_dir();

  try {
    const project_dirs = await readdir(projects_dir, { withFileTypes: true });

    for (const entry of project_dirs) {
      if (!entry.isDirectory()) continue;

      const candidate = join(projects_dir, entry.name, filename);
      try {
        await stat(candidate);
        return candidate;
      } catch {
        // File doesn't exist in this project dir — continue
      }
    }
  } catch {
    // ~/.claude/projects doesn't exist or isn't readable
  }

  return null;
}

// ── JSONL parsing ──

/**
 * Read a session's JSONL transcript and sum all token usage.
 *
 * Parses each line, filters for assistant messages with usage data,
 * and sums the token counts. The last assistant message's input_tokens
 * (+ cache tokens) represents the current context window fill level,
 * since input_tokens is cumulative per turn in Claude's streaming API.
 *
 * We use the LAST assistant turn's input_tokens as the context fill indicator,
 * since each turn's input_tokens includes all prior context.
 */
async function parse_session_usage(file_path: string): Promise<{ used_tokens: number; model: string | null }> {
  const content = await readFile(file_path, "utf-8");
  const lines = content.split("\n").filter(Boolean);

  let last_input_tokens = 0;
  let last_cache_creation = 0;
  let last_cache_read = 0;
  let model: string | null = null;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry["type"] !== "assistant") continue;

      const message = entry["message"] as Record<string, unknown> | undefined;
      if (!message) continue;

      // Track model if available
      if (typeof message["model"] === "string") {
        model = message["model"];
      }

      const usage = message["usage"] as MessageUsage | undefined;
      if (!usage) continue;

      // Each assistant turn's input_tokens is cumulative — the last one
      // represents the full context window fill level.
      if (typeof usage.input_tokens === "number") {
        last_input_tokens = usage.input_tokens;
      }
      if (typeof usage.cache_creation_input_tokens === "number") {
        last_cache_creation = usage.cache_creation_input_tokens;
      }
      if (typeof usage.cache_read_input_tokens === "number") {
        last_cache_read = usage.cache_read_input_tokens;
      }
    } catch {
      // Skip malformed lines
    }
  }

  // Total context used = input_tokens + cache tokens from the last turn.
  // input_tokens counts non-cached tokens; cache_creation + cache_read
  // count the cached portion. Together they represent the full prompt.
  const used_tokens = last_input_tokens + last_cache_creation + last_cache_read;
  return { used_tokens, model };
}

// ── Public API ──

/**
 * Read context window usage for a Claude Code session.
 *
 * Best-effort: returns null on any failure (file not found, parse error).
 * Errors are logged and sent to Sentry but never thrown.
 *
 * @param session_id - The Claude Code session UUID
 */
export async function read_session_context(session_id: string): Promise<SessionContextUsage | null> {
  try {
    const file_path = await find_session_file(session_id);
    if (!file_path) {
      return null;
    }

    const { used_tokens, model } = await parse_session_usage(file_path);
    if (used_tokens === 0) {
      return null;
    }

    // Determine context window from model. Default 200k for opus/sonnet.
    const total_tokens = resolve_context_window(model);
    const percent = Math.round((used_tokens / total_tokens) * 1000) / 10; // one decimal

    return {
      used_tokens,
      total_tokens,
      percent,
      summary: format_context_summary(used_tokens, total_tokens, percent),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error(`[session-context] Failed to read context for session ${session_id.slice(0, 8)}: ${msg}`);
    sentry.captureException(err, {
      tags: { module: "session-context" },
      contexts: { session: { session_id: session_id.slice(0, 8) } },
    });
    return null;
  }
}

// ── Helpers ──

/** Resolve the context window size based on model name. */
function resolve_context_window(model: string | null): number {
  // All current Claude models (opus, sonnet) have 200k context windows.
  // If a model string contains a known identifier, we could differentiate,
  // but for now 200k is the universal default.
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  return DEFAULT_CONTEXT_WINDOW;
}

/** Format token counts into a human-readable summary. */
function format_context_summary(used: number, total: number, percent: number): string {
  return `${format_token_count(used)} / ${format_token_count(total)} (${String(percent)}%)`;
}

/** Format a token count into shorthand (e.g., 45000 -> "45k", 200000 -> "200k"). */
function format_token_count(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return m === Math.floor(m) ? `${String(Math.floor(m))}m` : `${m.toFixed(1)}m`;
  }
  if (n >= 1_000) {
    const k = n / 1_000;
    return k === Math.floor(k) ? `${String(Math.floor(k))}k` : `${k.toFixed(1)}k`;
  }
  return String(n);
}
