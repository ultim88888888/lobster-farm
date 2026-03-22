import { z } from "zod";
import { PhaseSchema, PrioritySchema } from "./enums.js";

// In-memory feature state managed by the daemon.
// Uses camelCase because this is never serialized to YAML — it's a runtime object.
export const FeatureStateSchema = z.object({
  id: z.string(),
  entity: z.string(),
  githubIssue: z.number().int(),
  title: z.string(),
  phase: PhaseSchema,
  priority: PrioritySchema.default("medium"),
  branch: z.string(),
  worktreePath: z.string().nullable().default(null),
  discordWorkRoom: z.string().nullable().default(null),
  activeArchetype: z.string().nullable().default(null),
  activeDna: z.array(z.string()).default([]),
  sessionId: z.string().nullable().default(null),
  blocked: z.boolean().default(false),
  blockedReason: z.string().nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type FeatureState = z.infer<typeof FeatureStateSchema>;
