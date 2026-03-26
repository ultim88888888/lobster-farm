import { z } from "zod";
import {
  EntityStatusSchema,
  ChannelTypeSchema,
  RepoStructureSchema,
} from "./enums.js";

export const ChannelMappingSchema = z.object({
  type: ChannelTypeSchema,
  id: z.string(),
  purpose: z.string().optional(),
  assigned_feature: z.string().nullable().optional(),
});
export type ChannelMapping = z.infer<typeof ChannelMappingSchema>;

export const ChannelsSchema = z.object({
  category_id: z.string().default(""),
  list: z.array(ChannelMappingSchema).default([]),
}).default({ category_id: "", list: [] });
export type Channels = z.infer<typeof ChannelsSchema>;

// Per-entity configuration (~/.lobsterfarm/entities/{id}/config.yaml)
// Uses snake_case keys to match YAML file format.
export const EntityConfigSchema = z.object({
  entity: z.object({
    id: z.string().regex(/^[a-z0-9-]+$/, "Entity ID must be lowercase alphanumeric with hyphens"),
    name: z.string(),
    description: z.string().default(""),
    status: EntityStatusSchema.default("active"),

    // Blueprint this entity follows. Defines archetypes, SOPs, guidelines,
    // channel structure, model defaults. Entity config only needs overrides.
    blueprint: z.string().optional(),

    repos: z.array(z.object({
      name: z.string(),
      url: z.string(),
      path: z.string(),
      structure: RepoStructureSchema.default("monorepo"),
    })).default([]),

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

    channels: ChannelsSchema,

    memory: z.object({
      path: z.string(),
      auto_extract: z.boolean().default(true),
    }),

    // SOPs and guidelines come from the blueprint. Only list overrides here.
    sop_overrides: z.object({
      add: z.array(z.string()).default([]),
      remove: z.array(z.string()).default([]),
    }).optional(),

    guideline_overrides: z.object({
      add: z.array(z.string()).default([]),
      remove: z.array(z.string()).default([]),
    }).optional(),

    secrets: z.object({
      vault: z.string().default("1password"),
      vault_name: z.string(),
    }),
  }),
});

export type EntityConfig = z.infer<typeof EntityConfigSchema>;
