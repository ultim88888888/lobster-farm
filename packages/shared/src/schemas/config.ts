import { z } from "zod";
import { ModelNameSchema, ThinkLevelSchema } from "./enums.js";

export const ModelTierSchema = z.object({
  model: ModelNameSchema,
  think: ThinkLevelSchema,
});
export type ModelTier = z.infer<typeof ModelTierSchema>;

const AgentNameSchema = z.object({
  name: z.string(),
});

// Global LobsterFarm configuration (~/.lobsterfarm/config.yaml)
// Uses snake_case keys to match YAML file format.
export const LobsterFarmConfigSchema = z.object({
  version: z.number().int().default(1),

  paths: z.object({
    projects_dir: z.string().default("~/projects"),
    lobsterfarm_dir: z.string().default("~/.lobsterfarm"),
    claude_dir: z.string().default("~/.claude"),
  }).default({}),

  concurrency: z.object({
    max_active_sessions: z.number().int().min(1).default(3),
    max_queue_depth: z.number().int().min(1).default(20),
  }).default({}),

  defaults: z.object({
    models: z.object({
      planning: ModelTierSchema.default({ model: "opus", think: "high" }),
      design: ModelTierSchema.default({ model: "opus", think: "standard" }),
      building: ModelTierSchema.default({ model: "opus", think: "high" }),
      database: ModelTierSchema.default({ model: "opus", think: "high" }),
      review: ModelTierSchema.default({ model: "sonnet", think: "standard" }),
      operations: ModelTierSchema.default({ model: "sonnet", think: "standard" }),
      triage: ModelTierSchema.default({ model: "sonnet", think: "standard" }),
      classification: ModelTierSchema.default({ model: "haiku", think: "none" }),
    }).default({}),
  }).default({}),

  discord: z.object({
    server_id: z.string(),
    bot_token_ref: z.string().optional(),
  }).optional(),

  user: z.object({
    name: z.string(),
    email: z.string().optional(),
  }),

  machine: z.object({
    name: z.string().default(""),
    hardware: z.string().default(""),
  }).default({}),

  agents: z.object({
    planner: AgentNameSchema.default({ name: "Gary" }),
    designer: AgentNameSchema.default({ name: "Pearl" }),
    builder: AgentNameSchema.default({ name: "Bob" }),
    operator: AgentNameSchema.default({ name: "Ray" }),
  }).default({}),
});

export type LobsterFarmConfig = z.infer<typeof LobsterFarmConfigSchema>;
