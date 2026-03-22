import { z } from "zod";

// Every {{PLACEHOLDER}} used in config templates.
// The setup wizard collects these values and passes them to the template engine.
export const TemplateVariablesSchema = z.object({
  // User
  USER_NAME: z.string(),
  USER_EMAIL: z.string().default(""),

  // GitHub (global defaults — can be overridden per entity)
  GITHUB_USERNAME: z.string().default(""),
  GITHUB_ORG: z.string().default(""),

  // Machine
  MACHINE_NAME: z.string(),
  MACHINE_HARDWARE: z.string(),
  SUDO_STATUS: z.string().default("not configured"),
  PERMISSIONS_STATUS: z.string().default("not configured"),

  // Agent names (title case — used in prose)
  PLANNER_NAME: z.string().default("Gary"),
  DESIGNER_NAME: z.string().default("Pearl"),
  BUILDER_NAME: z.string().default("Bob"),
  OPERATOR_NAME: z.string().default("Ray"),

  // Agent names (lowercase — used in agent file frontmatter `name:` field)
  PLANNER_NAME_LOWER: z.string().default("gary"),
  DESIGNER_NAME_LOWER: z.string().default("pearl"),
  BUILDER_NAME_LOWER: z.string().default("bob"),
  OPERATOR_NAME_LOWER: z.string().default("ray"),

  // Paths
  PROJECTS_DIR: z.string().default("~/projects"),

  // Block content (for {{#BLOCK}}...{{/BLOCK}} regions)
  SHARED_SERVICES: z.string().default(""),
});

export type TemplateVariables = z.infer<typeof TemplateVariablesSchema>;
