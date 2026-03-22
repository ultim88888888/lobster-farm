import { z } from "zod";
import {
  EntityStatusSchema,
  AgentModeSchema,
  ChannelTypeSchema,
  RepoStructureSchema,
} from "./enums.js";
import { ModelTierSchema } from "./config.js";

export const ChannelMappingSchema = z.object({
  type: ChannelTypeSchema,
  id: z.string(),
  purpose: z.string().optional(),
  assigned_feature: z.string().nullable().optional(),
});
export type ChannelMapping = z.infer<typeof ChannelMappingSchema>;

// Per-entity configuration (~/.lobsterfarm/entities/{id}/config.yaml)
// Uses snake_case keys to match YAML file format.
export const EntityConfigSchema = z.object({
  entity: z.object({
    id: z.string().regex(/^[a-z0-9-]+$/, "Entity ID must be lowercase alphanumeric with hyphens"),
    name: z.string(),
    description: z.string().default(""),
    status: EntityStatusSchema.default("active"),

    repo: z.object({
      url: z.string(),
      path: z.string(),
      structure: RepoStructureSchema.default("monorepo"),
    }),

    accounts: z.object({
      github: z.object({
        org: z.string().optional(),
        user: z.string().optional(),
      }).optional(),
      vercel: z.object({
        project: z.string().optional(),
      }).optional(),
      sentry: z.object({
        project: z.string().optional(),
      }).optional(),
    }).default({}),

    channels: z.array(ChannelMappingSchema).default([]),

    agent_mode: AgentModeSchema.default("hybrid"),

    models: z.object({
      planning: ModelTierSchema.optional(),
      design: ModelTierSchema.optional(),
      building: ModelTierSchema.optional(),
      database: ModelTierSchema.optional(),
      review: ModelTierSchema.optional(),
      operations: ModelTierSchema.optional(),
    }).default({}),

    budget: z.object({
      monthly_warning_pct: z.number().min(0).max(100).default(80),
      monthly_limit: z.number().nullable().default(null),
    }).default({}),

    memory: z.object({
      path: z.string(),
      auto_extract: z.boolean().default(true),
    }),

    active_sops: z.array(z.string()).default([
      "feature-lifecycle",
      "pr-review-merge",
      "sentry-triage",
      "repo-scaffolding",
      "secrets-management",
      "readme-maintenance",
    ]),

    secrets: z.object({
      vault: z.string().default("1password"),
      vault_name: z.string(),
    }),
  }),
});

export type EntityConfig = z.infer<typeof EntityConfigSchema>;
