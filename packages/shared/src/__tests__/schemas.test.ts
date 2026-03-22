import { describe, expect, it } from "vitest";
import {
  LobsterFarmConfigSchema,
  EntityConfigSchema,
  FeatureStateSchema,
  TemplateVariablesSchema,
  ArchetypeRoleSchema,
  PhaseSchema,
  ChannelTypeSchema,
} from "../schemas/index.js";

describe("enums", () => {
  it("validates archetype roles", () => {
    expect(ArchetypeRoleSchema.parse("planner")).toBe("planner");
    expect(ArchetypeRoleSchema.parse("builder")).toBe("builder");
    expect(() => ArchetypeRoleSchema.parse("invalid")).toThrow();
  });

  it("validates phases", () => {
    expect(PhaseSchema.parse("plan")).toBe("plan");
    expect(PhaseSchema.parse("done")).toBe("done");
    expect(() => PhaseSchema.parse("invalid")).toThrow();
  });

  it("validates channel types", () => {
    expect(ChannelTypeSchema.parse("general")).toBe("general");
    expect(ChannelTypeSchema.parse("work_room")).toBe("work_room");
    expect(() => ChannelTypeSchema.parse("dm")).toThrow();
  });
});

describe("LobsterFarmConfigSchema", () => {
  it("parses minimal config with defaults", () => {
    const config = LobsterFarmConfigSchema.parse({
      user: { name: "Jax" },
    });
    expect(config.user.name).toBe("Jax");
    expect(config.version).toBe(1);
    expect(config.paths.projects_dir).toBe("~/projects");
    expect(config.paths.lobsterfarm_dir).toBe("~/.lobsterfarm");
    expect(config.concurrency.max_active_sessions).toBe(3);
    expect(config.defaults.models.planning.model).toBe("opus");
    expect(config.defaults.models.planning.think).toBe("high");
    expect(config.defaults.models.review.model).toBe("sonnet");
    expect(config.agents.planner.name).toBe("Gary");
    expect(config.agents.designer.name).toBe("Pearl");
    expect(config.agents.builder.name).toBe("Bob");
    expect(config.agents.operator.name).toBe("Ray");
  });

  it("accepts custom agent names", () => {
    const config = LobsterFarmConfigSchema.parse({
      user: { name: "Alice" },
      agents: {
        planner: { name: "Planny" },
        designer: { name: "Desi" },
        builder: { name: "Buildo" },
        operator: { name: "Opsy" },
      },
    });
    expect(config.agents.planner.name).toBe("Planny");
    expect(config.agents.operator.name).toBe("Opsy");
  });

  it("accepts discord config", () => {
    const config = LobsterFarmConfigSchema.parse({
      user: { name: "Jax" },
      discord: { server_id: "123456789" },
    });
    expect(config.discord?.server_id).toBe("123456789");
  });

  it("rejects missing user name", () => {
    expect(() => LobsterFarmConfigSchema.parse({})).toThrow();
    expect(() => LobsterFarmConfigSchema.parse({ user: {} })).toThrow();
  });
});

describe("EntityConfigSchema", () => {
  const MINIMAL_ENTITY = {
    entity: {
      id: "alpha",
      name: "Trading Platform",
      repo: {
        url: "git@github.com:org/alpha.git",
        path: "/repos/alpha",
      },
      memory: {
        path: "~/.lobsterfarm/entities/alpha",
      },
      secrets: {
        vault_name: "entity-alpha",
      },
    },
  };

  it("parses minimal entity config with defaults", () => {
    const config = EntityConfigSchema.parse(MINIMAL_ENTITY);
    expect(config.entity.id).toBe("alpha");
    expect(config.entity.status).toBe("active");
    expect(config.entity.repo.structure).toBe("monorepo");
    expect(config.entity.agent_mode).toBe("hybrid");
    expect(config.entity.channels).toEqual([]);
    expect(config.entity.budget.monthly_warning_pct).toBe(80);
    expect(config.entity.budget.monthly_limit).toBeNull();
    expect(config.entity.active_sops).toContain("feature-lifecycle");
    expect(config.entity.secrets.vault).toBe("1password");
  });

  it("accepts channels with abstract types", () => {
    const config = EntityConfigSchema.parse({
      ...MINIMAL_ENTITY,
      entity: {
        ...MINIMAL_ENTITY.entity,
        channels: [
          { type: "general", id: "discord-123", purpose: "Main channel" },
          { type: "work_room", id: "discord-456", assigned_feature: "alpha-42" },
          { type: "work_log", id: "discord-789" },
          { type: "alerts", id: "discord-101" },
        ],
      },
    });
    expect(config.entity.channels).toHaveLength(4);
    expect(config.entity.channels[0]!.type).toBe("general");
    expect(config.entity.channels[1]!.assigned_feature).toBe("alpha-42");
  });

  it("accepts per-entity accounts", () => {
    const config = EntityConfigSchema.parse({
      ...MINIMAL_ENTITY,
      entity: {
        ...MINIMAL_ENTITY.entity,
        accounts: {
          github: { org: "spacelobsterfarm", user: "ultim88888888" },
          vercel: { project: "alpha-platform" },
          sentry: { project: "alpha" },
        },
      },
    });
    expect(config.entity.accounts.github?.org).toBe("spacelobsterfarm");
    expect(config.entity.accounts.vercel?.project).toBe("alpha-platform");
  });

  it("rejects invalid entity ID format", () => {
    expect(() =>
      EntityConfigSchema.parse({
        entity: { ...MINIMAL_ENTITY.entity, id: "UPPERCASE" },
      }),
    ).toThrow();
    expect(() =>
      EntityConfigSchema.parse({
        entity: { ...MINIMAL_ENTITY.entity, id: "has spaces" },
      }),
    ).toThrow();
  });
});

describe("FeatureStateSchema", () => {
  it("parses a complete feature state", () => {
    const now = new Date().toISOString();
    const state = FeatureStateSchema.parse({
      id: "alpha-42",
      entity: "alpha",
      githubIssue: 42,
      title: "Candlestick chart module",
      phase: "build",
      branch: "feature/42-candlestick-chart",
      createdAt: now,
      updatedAt: now,
    });
    expect(state.id).toBe("alpha-42");
    expect(state.priority).toBe("medium");
    expect(state.blocked).toBe(false);
    expect(state.activeDna).toEqual([]);
    expect(state.sessionId).toBeNull();
  });

  it("rejects invalid phase", () => {
    expect(() =>
      FeatureStateSchema.parse({
        id: "x",
        entity: "x",
        githubIssue: 1,
        title: "x",
        phase: "invalid",
        branch: "x",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    ).toThrow();
  });
});

describe("TemplateVariablesSchema", () => {
  it("parses with required fields and defaults", () => {
    const vars = TemplateVariablesSchema.parse({
      USER_NAME: "Jax",
      MACHINE_NAME: "farm",
      MACHINE_HARDWARE: "Mac mini, arm64",
    });
    expect(vars.USER_NAME).toBe("Jax");
    expect(vars.PLANNER_NAME).toBe("Gary");
    expect(vars.PLANNER_NAME_LOWER).toBe("gary");
    expect(vars.PROJECTS_DIR).toBe("~/projects");
    expect(vars.SHARED_SERVICES).toBe("");
  });

  it("rejects missing required fields", () => {
    expect(() => TemplateVariablesSchema.parse({})).toThrow();
    expect(() =>
      TemplateVariablesSchema.parse({ USER_NAME: "Jax" }),
    ).toThrow(); // missing MACHINE_NAME, MACHINE_HARDWARE
  });
});
