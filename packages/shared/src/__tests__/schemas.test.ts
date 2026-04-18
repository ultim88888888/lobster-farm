import { describe, expect, it } from "vitest";
import {
  ArchetypeRoleSchema,
  ChannelTypeSchema,
  EntityConfigSchema,
  LobsterFarmConfigSchema,
  TemplateVariablesSchema,
} from "../schemas/index.js";

describe("enums", () => {
  it("validates archetype roles", () => {
    expect(ArchetypeRoleSchema.parse("planner")).toBe("planner");
    expect(ArchetypeRoleSchema.parse("builder")).toBe("builder");
    expect(() => ArchetypeRoleSchema.parse("invalid")).toThrow();
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

  it("accepts discord config with user_id", () => {
    const config = LobsterFarmConfigSchema.parse({
      user: { name: "Jax" },
      discord: { server_id: "123456789", user_id: "999888777666555" },
    });
    expect(config.discord?.server_id).toBe("123456789");
    expect(config.discord?.user_id).toBe("999888777666555");
  });

  it("allows discord.user_id to be omitted (backward compatible)", () => {
    const config = LobsterFarmConfigSchema.parse({
      user: { name: "Jax" },
      discord: { server_id: "123456789" },
    });
    expect(config.discord?.user_id).toBeUndefined();
  });

  it("rejects missing user name", () => {
    expect(() => LobsterFarmConfigSchema.parse({})).toThrow();
    expect(() => LobsterFarmConfigSchema.parse({ user: {} })).toThrow();
  });

  it("accepts pr_cron config with enabled: false", () => {
    const config = LobsterFarmConfigSchema.parse({
      user: { name: "Jax" },
      pr_cron: { enabled: false },
    });
    expect(config.pr_cron?.enabled).toBe(false);
  });

  it("accepts pr_cron config with enabled: true", () => {
    const config = LobsterFarmConfigSchema.parse({
      user: { name: "Jax" },
      pr_cron: { enabled: true },
    });
    expect(config.pr_cron?.enabled).toBe(true);
  });

  it("defaults pr_cron.enabled to true when pr_cron object is present", () => {
    const config = LobsterFarmConfigSchema.parse({
      user: { name: "Jax" },
      pr_cron: {},
    });
    expect(config.pr_cron?.enabled).toBe(true);
  });

  it("allows pr_cron to be omitted (backward compatible)", () => {
    const config = LobsterFarmConfigSchema.parse({
      user: { name: "Jax" },
    });
    expect(config.pr_cron).toBeUndefined();
  });
});

describe("EntityConfigSchema", () => {
  const MINIMAL_ENTITY = {
    entity: {
      id: "alpha",
      name: "Trading Platform",
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
    expect(config.entity.repos).toEqual([]);
    expect(config.entity.channels.category_id).toBe("");
    expect(config.entity.channels.list).toEqual([]);
    expect(config.entity.secrets.vault).toBe("1password");
  });

  it("accepts repos array", () => {
    const config = EntityConfigSchema.parse({
      ...MINIMAL_ENTITY,
      entity: {
        ...MINIMAL_ENTITY.entity,
        repos: [
          { name: "alpha", url: "git@github.com:org/alpha.git", path: "/repos/alpha" },
          {
            name: "alpha-dashboard",
            url: "git@github.com:org/alpha-dashboard.git",
            path: "/repos/alpha-dashboard",
          },
        ],
      },
    });
    expect(config.entity.repos).toHaveLength(2);
    expect(config.entity.repos[0]!.name).toBe("alpha");
    expect(config.entity.repos[0]!.structure).toBe("monorepo");
    expect(config.entity.repos[1]!.name).toBe("alpha-dashboard");
  });

  it("accepts channels with category and list", () => {
    const config = EntityConfigSchema.parse({
      ...MINIMAL_ENTITY,
      entity: {
        ...MINIMAL_ENTITY.entity,
        channels: {
          category_id: "cat-123",
          list: [
            { type: "general", id: "discord-123", purpose: "Main channel" },
            { type: "work_room", id: "discord-456", assigned_feature: "alpha-42" },
            { type: "work_log", id: "discord-789" },
            { type: "alerts", id: "discord-101" },
          ],
        },
      },
    });
    expect(config.entity.channels.category_id).toBe("cat-123");
    expect(config.entity.channels.list).toHaveLength(4);
    expect(config.entity.channels.list[0]!.type).toBe("general");
    expect(config.entity.channels.list[1]!.assigned_feature).toBe("alpha-42");
  });

  it("accepts channels with role_id (#295)", () => {
    const config = EntityConfigSchema.parse({
      ...MINIMAL_ENTITY,
      entity: {
        ...MINIMAL_ENTITY.entity,
        channels: {
          category_id: "cat-123",
          role_id: "role-456",
          list: [{ type: "general", id: "discord-123" }],
        },
      },
    });
    expect(config.entity.channels.category_id).toBe("cat-123");
    expect(config.entity.channels.role_id).toBe("role-456");
    expect(config.entity.channels.list).toHaveLength(1);
  });

  it("defaults role_id to undefined when omitted (#295)", () => {
    const config = EntityConfigSchema.parse({
      ...MINIMAL_ENTITY,
      entity: {
        ...MINIMAL_ENTITY.entity,
        channels: {
          category_id: "cat-123",
          list: [],
        },
      },
    });
    expect(config.entity.channels.role_id).toBeUndefined();
  });

  it("accepts per-entity accounts", () => {
    const config = EntityConfigSchema.parse({
      ...MINIMAL_ENTITY,
      entity: {
        ...MINIMAL_ENTITY.entity,
        accounts: {
          github: { org: "test-org", user: "test-org" },
          vercel: { project: "alpha-platform" },
          sentry: { project: "alpha" },
        },
      },
    });
    expect(config.entity.accounts.github?.org).toBe("test-org");
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

  // pr_lifecycle feature flag (#257)
  it("defaults pr_lifecycle to v1", () => {
    const config = EntityConfigSchema.parse(MINIMAL_ENTITY);
    expect(config.entity.pr_lifecycle).toBe("v1");
  });

  it("accepts pr_lifecycle: v2", () => {
    const config = EntityConfigSchema.parse({
      ...MINIMAL_ENTITY,
      entity: { ...MINIMAL_ENTITY.entity, pr_lifecycle: "v2" },
    });
    expect(config.entity.pr_lifecycle).toBe("v2");
  });

  it("rejects unknown pr_lifecycle values", () => {
    expect(() =>
      EntityConfigSchema.parse({
        ...MINIMAL_ENTITY,
        entity: { ...MINIMAL_ENTITY.entity, pr_lifecycle: "v3" },
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
    expect(vars.PROJECTS_DIR).toBe("~/entities");
    expect(vars.SHARED_SERVICES).toBe("");
  });

  it("rejects missing required fields", () => {
    expect(() => TemplateVariablesSchema.parse({})).toThrow();
    expect(() => TemplateVariablesSchema.parse({ USER_NAME: "Jax" })).toThrow(); // missing MACHINE_NAME, MACHINE_HARDWARE
  });
});
