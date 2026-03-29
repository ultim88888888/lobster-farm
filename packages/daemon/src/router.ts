import type { ArchetypeRole, ChannelType } from "@lobster-farm/shared";

// ── Types ──

export interface RoutedMessage {
  entity_id: string;
  channel_type: ChannelType;
  content: string;
  author: string;
  channel_id: string;
  assigned_feature?: string | null;
}

export type RouteAction =
  | { type: "command"; name: string; args: string[] }
  | { type: "classify"; archetype: ArchetypeRole; prompt: string }
  | { type: "route_to_session"; feature_id: string; content: string }
  | { type: "approval_response"; content: string }
  | { type: "ask_clarification"; message: string }
  | { type: "ignore" };

// ── Command parsing ──

const COMMAND_PREFIX = "!lf";

interface ParsedCommand {
  name: string;
  args: string[];
}

function parse_command(content: string): ParsedCommand | null {
  const trimmed = content.trim();
  // Must start with "!lf " (with space) or be exactly "!lf"
  if (!trimmed.startsWith(COMMAND_PREFIX + " ") && trimmed !== COMMAND_PREFIX) return null;

  const after_prefix = trimmed.slice(COMMAND_PREFIX.length).trim();
  if (!after_prefix) return { name: "help", args: [] };

  // Parse args, respecting quoted strings
  const args: string[] = [];
  let current = "";
  let in_quotes = false;
  let quote_char = "";

  for (const ch of after_prefix) {
    if (in_quotes) {
      if (ch === quote_char) {
        in_quotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      in_quotes = true;
      quote_char = ch;
    } else if (ch === " ") {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);

  const name = args.shift();
  if (!name) return null;

  return { name, args };
}

// ── Intent classification (keyword-based, Phase 1) ──

interface Classification {
  archetype: ArchetypeRole;
  confidence: number;
}

const INTENT_KEYWORDS: Record<ArchetypeRole, string[]> = {
  planner: ["plan", "spec", "scope", "architecture", "design doc", "requirements", "project", "roadmap"],
  designer: ["design", "ui", "ux", "brand", "visual", "mockup", "prototype", "animation", "layout", "component"],
  builder: ["build", "implement", "code", "fix", "bug", "feature", "test", "refactor", "api", "endpoint"],
  reviewer: ["review", "pr", "pull request", "audit", "check"],
  operator: ["deploy", "infra", "ci", "cd", "monitor", "ops", "server", "docker", "pipeline", "sentry"],
};

function classify_intent(content: string): Classification | null {
  const lower = content.toLowerCase();
  let best_role: ArchetypeRole | null = null;
  let best_score = 0;

  for (const [role, keywords] of Object.entries(INTENT_KEYWORDS) as [ArchetypeRole, string[]][]) {
    let score = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        score += kw.includes(" ") ? 2 : 1; // Multi-word matches score higher
      }
    }
    if (score > best_score) {
      best_score = score;
      best_role = role;
    }
  }

  if (!best_role || best_score === 0) return null;

  const confidence = Math.min(best_score / 3, 1); // Normalize roughly
  return { archetype: best_role, confidence };
}

// ── Router ──

/**
 * Deterministic message router.
 * Takes a message with entity/channel context and returns the action to take.
 */
export function route_message(msg: RoutedMessage): RouteAction {
  const { content, channel_type, assigned_feature } = msg;

  // Rule 1: Command prefix
  const command = parse_command(content);
  if (command) {
    return { type: "command", name: command.name, args: command.args };
  }

  // Rule 2: Alerts channel — human responding to an agent question
  if (channel_type === "alerts") {
    return { type: "approval_response", content };
  }

  // Rule 3: Work room with assigned feature
  if (channel_type === "work_room" && assigned_feature) {
    return {
      type: "route_to_session",
      feature_id: assigned_feature,
      content,
    };
  }

  // Rule 4: General channel — classify intent
  if (channel_type === "general") {
    const classification = classify_intent(content);
    if (classification && classification.confidence >= 0.3) {
      return {
        type: "classify",
        archetype: classification.archetype,
        prompt: content,
      };
    }

    return {
      type: "ask_clarification",
      message:
        "I'm not sure what you'd like me to do. Try:\n" +
        "• `/plan <title>` — start planning a feature\n" +
        "• `/features` ��� list active features\n" +
        "• `/status` — check daemon status\n" +
        "• Or describe what you need (e.g., \"build the login page\")",
    };
  }

  // Rule 5: Work log — read only, ignore messages
  if (channel_type === "work_log") {
    return { type: "ignore" };
  }

  return { type: "ignore" };
}

// Export for testing
export { parse_command, classify_intent };
