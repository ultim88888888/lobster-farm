import { z } from "zod";
import { ArchetypeRoleSchema, PrioritySchema } from "./enums.js";
import { ModelTierSchema } from "./config.js";

export const TaskStatusSchema = z.enum([
  "queued",
  "active",
  "completed",
  "failed",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const QueuedTaskSchema = z.object({
  id: z.string().uuid(),
  entity_id: z.string(),
  feature_id: z.string(),
  archetype: ArchetypeRoleSchema,
  dna: z.array(z.string()).default([]),
  model: ModelTierSchema,
  prompt: z.string(),
  interactive: z.boolean().default(false),
  priority: PrioritySchema.default("medium"),
  submitted_at: z.string().datetime(),
  status: TaskStatusSchema.default("queued"),
  // Set when task completes or fails
  completed_at: z.string().datetime().nullable().default(null),
  exit_code: z.number().int().nullable().default(null),
  error: z.string().nullable().default(null),
  session_id: z.string().nullable().default(null),
});

export type QueuedTask = z.infer<typeof QueuedTaskSchema>;
