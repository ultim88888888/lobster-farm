import type { ArchetypeRole, ModelName, Phase, ThinkLevel } from "./schemas/enums.js";

export interface ArchetypeDefaults {
  default_name: string;
  model: ModelName;
  think: ThinkLevel;
  primary_dna: string;
  additional_dna: string[];
}

export const DEFAULT_ARCHETYPES: Record<ArchetypeRole, ArchetypeDefaults> = {
  planner: {
    default_name: "Gary",
    model: "opus",
    think: "high",
    primary_dna: "planning-dna",
    additional_dna: [],
  },
  designer: {
    default_name: "Pearl",
    model: "opus",
    think: "standard",
    primary_dna: "design-dna",
    additional_dna: ["coding-dna"],
  },
  builder: {
    default_name: "Bob",
    model: "opus",
    think: "high",
    primary_dna: "coding-dna",
    additional_dna: ["design-dna", "database-dna"],
  },
  reviewer: {
    default_name: "Reviewer",
    model: "sonnet",
    think: "standard",
    primary_dna: "review-guideline",
    additional_dna: [],
  },
  operator: {
    default_name: "Ray",
    model: "sonnet",
    think: "standard",
    primary_dna: "operator-dna",
    additional_dna: [],
  },
  commander: {
    default_name: "Pat",
    model: "opus",
    think: "high",
    primary_dna: "commander-dna",
    additional_dna: [],
  },
} as const;

/** Valid phase transitions. Keys are current phase, values are allowed next phases. */
export const PHASE_TRANSITIONS: Record<Phase, Phase[]> = {
  plan: ["design", "build"],
  design: ["build"],
  build: ["review"],
  review: ["ship", "build"],
  ship: ["done", "build"],
  done: [],
} as const;

export const DEFAULT_SOPS = [
  "feature-lifecycle",
  "pr-review-merge",
  "sentry-triage",
  "repo-scaffolding",
  "secrets-management",
  "readme-maintenance",
  "dna-evolution",
] as const;

export const CHANNEL_TYPES = {
  general: "Entity-level discussion, PM conversations",
  work_room: "Feature workspace (dynamically assigned)",
  work_log: "Agent activity feed",
  alerts: "Approvals, blockers, questions from agents",
} as const;

export const DAEMON_PORT = 7749;
export const LAUNCHD_LABEL = "com.lobsterfarm.daemon";
