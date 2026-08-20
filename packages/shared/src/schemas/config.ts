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

  paths: z
    .object({
      projects_dir: z.string().default("~/projects"),
      lobsterfarm_dir: z.string().default("~/.lobsterfarm"),
      claude_dir: z.string().default("~/.claude"),
    })
    .default({}),

  concurrency: z
    .object({
      max_active_sessions: z.number().int().min(1).default(3),
      max_queue_depth: z.number().int().min(1).default(20),
    })
    .default({}),

  defaults: z
    .object({
      models: z
        .object({
          planning: ModelTierSchema.default({ model: "opus", think: "high" }),
          design: ModelTierSchema.default({ model: "opus", think: "standard" }),
          building: ModelTierSchema.default({ model: "opus", think: "high" }),
          database: ModelTierSchema.default({ model: "opus", think: "high" }),
          review: ModelTierSchema.default({ model: "sonnet", think: "standard" }),
          operations: ModelTierSchema.default({ model: "sonnet", think: "standard" }),
          triage: ModelTierSchema.default({ model: "sonnet", think: "standard" }),
          classification: ModelTierSchema.default({ model: "haiku", think: "none" }),
        })
        .default({}),
    })
    .default({}),

  discord: z
    .object({
      server_id: z.string(),
      bot_token_ref: z.string().optional(),
      /** The owner's Discord user ID — used for pool bot access control. */
      user_id: z.string().optional(),
      /**
       * Usernames of non-pool infrastructure bots (Pat, daemon, failsafe, merm).
       * During lockdown these are assigned the "LobsterFarm Bot" role alongside
       * the pool bots (lf-*), which would otherwise lock them out of locked
       * channels because they don't share the pool prefix (#302).
       */
      infrastructure_bots: z.array(z.string()).default(["pat", "daemon", "failsafe", "merm"]),
    })
    .optional(),

  user: z.object({
    name: z.string(),
    email: z.string().optional(),
  }),

  machine: z
    .object({
      name: z.string().default(""),
      hardware: z.string().default(""),
    })
    .default({}),

  agents: z
    .object({
      planner: AgentNameSchema.default({ name: "Gary" }),
      designer: AgentNameSchema.default({ name: "Pearl" }),
      builder: AgentNameSchema.default({ name: "Bob" }),
      operator: AgentNameSchema.default({ name: "Ray" }),
      commander: AgentNameSchema.default({ name: "Pat" }),
    })
    .default({}),

  pr_cron: z
    .object({
      enabled: z.boolean().default(true),
    })
    .optional(),

  // Auth-recovery watchdog (#343). Detects stale/expired shared Claude OAuth
  // credentials (per CLAUDE_CONFIG_DIR), auto-quarantines poisoned sessions,
  // alerts the owner with a re-login URL, accepts the pasted code, and recycles
  // affected pool bots.
  auth_watchdog: z
    .object({
      enabled: z.boolean().default(true),
      interval_minutes: z.number().int().min(1).default(5),
      /**
       * Proactively warn when a credential is within this many minutes of needing
       * a *human re-login* — i.e. of its refresh token expiring, after which no
       * silent refresh can save it.
       *
       * This is deliberately NOT measured against the access token, which rolls
       * over every few hours on its own; doing so kept two healthy accounts under
       * a permanent alarm (#363). Refresh tokens last weeks, so the default gives
       * a day of notice rather than the half hour that suited the old meaning.
       */
      expiry_warn_minutes: z
        .number()
        .int()
        .min(1)
        .default(24 * 60),
      /** Channel to post alerts to. When unset, resolves to #command-center at runtime. */
      alert_channel_id: z.string().optional(),
    })
    .default({}),

  tools: z
    .object({
      tailscale: z
        .object({
          installed: z.boolean().default(false),
          hostname: z.string().optional(),
          ip: z.string().optional(),
        })
        .optional(),
      docker: z
        .object({
          installed: z.boolean().default(false),
          runtime: z.enum(["colima", "docker-desktop", "other"]).optional(),
        })
        .optional(),
      vercel: z
        .object({
          installed: z.boolean().default(false),
          username: z.string().optional(),
        })
        .optional(),
      supabase: z
        .object({
          installed: z.boolean().default(false),
        })
        .optional(),
      sentry: z
        .object({
          installed: z.boolean().default(false),
          org: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});

export type LobsterFarmConfig = z.infer<typeof LobsterFarmConfigSchema>;
