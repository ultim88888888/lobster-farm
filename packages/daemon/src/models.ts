import type { ModelTier, ThinkLevel } from "@lobster-farm/shared";

/**
 * Map think levels to Claude CLI effort flags.
 * "none" maps to "low" (not null) because Claude CLI's --effort low is the
 * correct way to suppress extended thinking. Omitting --effort entirely would
 * leave it at the model's default (which may include thinking).
 */
const EFFORT_MAP: Record<ThinkLevel, string | null> = {
  none: "low",
  standard: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

/**
 * Resolve a ModelTier to a Claude CLI --model value.
 *
 * Returns the bare tier alias ("opus"/"sonnet"/"haiku") rather than a pinned
 * version ID. The Claude CLI treats these aliases as "the latest model" in each
 * family, so sessions always track the current default — e.g. `opus` resolves
 * to the latest Opus with its 1M context window — without us having to bump a
 * hardcoded version string here whenever a new model ships.
 */
export function resolve_model_id(tier: ModelTier): string {
  return tier.model;
}

/** Resolve a ThinkLevel to a Claude CLI effort flag value, or null if not applicable. */
export function resolve_effort(think: ThinkLevel): string | null {
  return EFFORT_MAP[think];
}

/** Build the model-related CLI flags for a given ModelTier. */
export function build_model_flags(tier: ModelTier): string[] {
  const flags = ["--model", resolve_model_id(tier)];
  const effort = resolve_effort(tier.think);
  if (effort) {
    flags.push("--effort", effort);
  }
  return flags;
}
