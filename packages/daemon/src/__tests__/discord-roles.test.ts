import type { Server } from "node:http";
import { EntityConfigSchema, LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { EntityConfig } from "@lobster-farm/shared";
import {
  DiscordAPIError,
  ChannelType as DiscordChannelType,
  type Guild,
  RESTJSONErrorCodes,
  type Role,
} from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordBot, is_lf_bot } from "../discord.js";
import type { EntityRegistry } from "../registry.js";
import { start_server } from "../server.js";

// ── Schema tests ──

describe("ChannelsSchema role_id field (#295)", () => {
  const MINIMAL_ENTITY = {
    entity: {
      id: "test-entity",
      name: "Test Entity",
      memory: { path: "~/.lobsterfarm/entities/test-entity" },
      secrets: { vault_name: "entity-test-entity" },
    },
  };

  it("accepts role_id in channels", () => {
    const config = EntityConfigSchema.parse({
      ...MINIMAL_ENTITY,
      entity: {
        ...MINIMAL_ENTITY.entity,
        channels: {
          category_id: "cat-123456789012345678",
          role_id: "role-123456789012345678",
          list: [{ type: "general", id: "ch-123456789012345678" }],
        },
      },
    });
    expect(config.entity.channels.role_id).toBe("role-123456789012345678");
    expect(config.entity.channels.category_id).toBe("cat-123456789012345678");
  });

  it("defaults role_id to undefined when omitted", () => {
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

  it("existing channels config without role_id still parses (backward compat)", () => {
    const config = EntityConfigSchema.parse(MINIMAL_ENTITY);
    expect(config.entity.channels.category_id).toBe("");
    expect(config.entity.channels.role_id).toBeUndefined();
    expect(config.entity.channels.list).toEqual([]);
  });
});

// ── Config schema: discord.user_id is required for lockdown ──

describe("LobsterFarmConfig discord.user_id (#295)", () => {
  it("parses config with discord.user_id set", () => {
    const config = LobsterFarmConfigSchema.parse({
      user: { name: "Test" },
      discord: {
        server_id: "1485323605331017859",
        user_id: "732686813856006245",
      },
    });
    expect(config.discord?.user_id).toBe("732686813856006245");
  });

  it("allows discord.user_id to be omitted", () => {
    const config = LobsterFarmConfigSchema.parse({
      user: { name: "Test" },
      discord: { server_id: "1485323605331017859" },
    });
    expect(config.discord?.user_id).toBeUndefined();
  });
});

// ── is_lf_bot — ensures only LobsterFarm bots receive the Administrator role ──

describe("is_lf_bot (#295)", () => {
  it("matches LobsterFarm pool bots (lf-0 through lf-14)", () => {
    expect(is_lf_bot("lf-0")).toBe(true);
    expect(is_lf_bot("lf-9")).toBe(true);
    expect(is_lf_bot("lf-14")).toBe(true);
  });

  it("matches lobsterfarm-prefixed bots", () => {
    expect(is_lf_bot("lobsterfarm")).toBe(true);
    expect(is_lf_bot("lobsterfarm-daemon")).toBe(true);
    expect(is_lf_bot("LobsterFarm-Failsafe")).toBe(true);
  });

  it("matches lobster-farm-prefixed bots", () => {
    expect(is_lf_bot("lobster-farm")).toBe(true);
    expect(is_lf_bot("Lobster-Farm-Pat")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(is_lf_bot("LF-0")).toBe(true);
    expect(is_lf_bot("LOBSTERFARM")).toBe(true);
  });

  it("rejects non-LobsterFarm bots", () => {
    expect(is_lf_bot("MEE6")).toBe(false);
    expect(is_lf_bot("Dyno")).toBe(false);
    expect(is_lf_bot("GitHub")).toBe(false);
    expect(is_lf_bot("some-random-bot")).toBe(false);
  });
});

// ── is_lf_bot — infrastructure bot allowlist (#302) ──
//
// Pat, daemon, failsafe, and merm do not share a username prefix with pool bots,
// so the original prefix-match check locked them out during lockdown. Callers pass
// a config-driven allowlist of exact usernames to include alongside the prefix set.

describe("is_lf_bot infrastructure allowlist (#302)", () => {
  const INFRA = ["pat", "daemon", "failsafe", "merm"];

  it("matches configured infrastructure bot names (pat)", () => {
    expect(is_lf_bot("pat", INFRA)).toBe(true);
  });

  it("matches configured infrastructure bot names (daemon)", () => {
    expect(is_lf_bot("daemon", INFRA)).toBe(true);
  });

  it("matches configured infrastructure bot names (failsafe)", () => {
    expect(is_lf_bot("failsafe", INFRA)).toBe(true);
  });

  it("matches configured infrastructure bot names (merm)", () => {
    expect(is_lf_bot("merm", INFRA)).toBe(true);
  });

  it("still matches pool bots when an allowlist is provided (regression)", () => {
    expect(is_lf_bot("lf-3", INFRA)).toBe(true);
  });

  it("rejects random bots when an allowlist is provided (no false positives)", () => {
    expect(is_lf_bot("random-bot", INFRA)).toBe(false);
  });

  it("uses exact match for infrastructure names to avoid prefix collisions", () => {
    // "pat" is short — "patrick" must not match just because it starts with "pat".
    expect(is_lf_bot("patrick", INFRA)).toBe(false);
    expect(is_lf_bot("daemonic", INFRA)).toBe(false);
  });

  it("matches infrastructure names case-insensitively", () => {
    expect(is_lf_bot("Pat", INFRA)).toBe(true);
    expect(is_lf_bot("DAEMON", INFRA)).toBe(true);
  });

  it("omitting the allowlist preserves legacy prefix-only behaviour", () => {
    expect(is_lf_bot("pat")).toBe(false);
    expect(is_lf_bot("lf-0")).toBe(true);
  });
});

// ── Config schema: discord.infrastructure_bots default (#302) ──

describe("LobsterFarmConfig discord.infrastructure_bots (#302)", () => {
  it("defaults to the canonical infrastructure bot list", () => {
    const config = LobsterFarmConfigSchema.parse({
      user: { name: "Test" },
      discord: { server_id: "1485323605331017859" },
    });
    expect(config.discord?.infrastructure_bots).toEqual(["pat", "daemon", "failsafe", "merm"]);
  });

  it("accepts a custom infrastructure_bots list", () => {
    const config = LobsterFarmConfigSchema.parse({
      user: { name: "Test" },
      discord: {
        server_id: "1485323605331017859",
        infrastructure_bots: ["pat", "daemon", "failsafe", "merm", "bouncer"],
      },
    });
    expect(config.discord?.infrastructure_bots).toContain("bouncer");
  });
});

// ── /lockdown route guard tests (#295) ──

describe("/lockdown route guards (#295)", () => {
  let server: Server;
  let port: number;

  /** Minimal mocks — just enough to start the server and test route guards. */
  function make_server_deps(discord: unknown = null) {
    const registry = {
      get_all: () => [],
      get_active: () => [],
      count: () => 0,
      get: () => null,
    } as never;
    const config = LobsterFarmConfigSchema.parse({ user: { name: "Test" } });
    const session_manager = { get_active: () => [] } as never;
    const queue = {
      get_stats: () => ({ pending: 0, active: 0, total: 0 }),
      get_pending: () => [],
      get_active: () => [],
    } as never;
    return { registry, config, session_manager, queue, discord };
  }

  async function start_test_server(discord: unknown = null): Promise<void> {
    const deps = make_server_deps(discord);
    // Use port 0 so the OS assigns a free port
    server = start_server(
      deps.registry,
      deps.config,
      deps.session_manager,
      deps.queue,
      null,
      deps.discord as never,
      null,
      null,
      null,
      null,
      0,
    );
    // Wait for listen
    await new Promise<void>((resolve) => {
      server.on("listening", resolve);
    });
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
  }

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("returns 503 when discord is not connected", async () => {
    await start_test_server(null);

    const res = await fetch(`http://localhost:${String(port)}/lockdown`, { method: "POST" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Discord bot not connected/);
  });

  it("returns 409 when lockdown is already in progress", async () => {
    // Mock discord with a lockdown that never resolves (simulates long-running migration)
    const discord = {
      lockdown: () => new Promise<void>(() => {}), // never resolves
    };

    await start_test_server(discord);

    // First request: should return 202 (accepted, fire-and-forget)
    const first = await fetch(`http://localhost:${String(port)}/lockdown`, { method: "POST" });
    expect(first.status).toBe(202);

    // Second request while first is still in progress: should return 409
    const second = await fetch(`http://localhost:${String(port)}/lockdown`, { method: "POST" });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: string };
    expect(body.error).toMatch(/already in progress/);
  });
});

// ── process_entity_lockdown — stale category handling (#303) ──

describe("process_entity_lockdown stale category handling (#303)", () => {
  const VALID_CATEGORY_ID = "111111111111111111";
  const STALE_CATEGORY_ID = "222222222222222222";
  const BOT_ROLE_ID = "333333333333333333";
  const ENTITY_ROLE_ID = "444444444444444444";

  function make_entity(id: string, category_id: string): EntityConfig {
    return EntityConfigSchema.parse({
      entity: {
        id,
        name: id,
        memory: { path: `~/.lobsterfarm/entities/${id}` },
        secrets: { vault_name: `entity-${id}` },
        channels: {
          category_id,
          // Pre-set role_id so persist_entity_config is not triggered in
          // the processed-path test (see factory below for how this works
          // with the mocked find_or_create_entity_role).
          role_id: ENTITY_ROLE_ID,
          list: [],
        },
      },
    });
  }

  function make_bot_role(): Role {
    return { id: BOT_ROLE_ID, name: "LobsterFarm Bot" } as unknown as Role;
  }

  function make_bot_with_mocks(spies: {
    fetch_category: (id: string) => Promise<unknown>;
    find_or_create_entity_role: ReturnType<typeof vi.fn>;
    set_permissions: ReturnType<typeof vi.fn>;
  }): DiscordBot {
    const config = LobsterFarmConfigSchema.parse({ user: { name: "Test" } });
    const registry = { get_all: () => [] } as unknown as EntityRegistry;
    const bot = new DiscordBot(config, registry);

    // Override role + permission methods — these should NOT be called for the
    // stale-category case, and they need mocks for the processed case.
    (bot as unknown as Record<string, unknown>).find_or_create_entity_role =
      spies.find_or_create_entity_role;
    (bot as unknown as Record<string, unknown>).set_entity_category_permissions =
      spies.set_permissions;
    return bot;
  }

  /**
   * Build a mock Guild whose channels.fetch(id) delegates to the caller-supplied
   * resolver. Minimal surface — only what process_entity_lockdown touches.
   */
  function make_guild(fetch_category: (id: string) => Promise<unknown>): Guild {
    return {
      channels: {
        fetch: (id: string) => fetch_category(id),
      },
    } as unknown as Guild;
  }

  /**
   * Build a mock CategoryChannel with an empty children cache (no child sync work).
   */
  function make_category(id: string) {
    return {
      id,
      name: "mock-category",
      type: DiscordChannelType.GuildCategory,
      children: { cache: new Map() },
    };
  }

  it("skips entity with stale category_id — no role created, returns skipped_missing_category", async () => {
    const entity = make_entity("alpha", STALE_CATEGORY_ID);
    const bot_role = make_bot_role();

    const find_or_create_entity_role = vi.fn();
    const set_permissions = vi.fn();
    const fetch_category = vi.fn(async (id: string) => {
      if (id === STALE_CATEGORY_ID) {
        // Emulate Discord's "Unknown Channel" response for a deleted category.
        throw new DiscordAPIError(
          { code: RESTJSONErrorCodes.UnknownChannel, message: "Unknown Channel" },
          RESTJSONErrorCodes.UnknownChannel,
          404,
          "GET",
          `/channels/${id}`,
          {},
        );
      }
      throw new Error(`unexpected fetch: ${id}`);
    });

    const bot = make_bot_with_mocks({
      fetch_category,
      find_or_create_entity_role,
      set_permissions,
    });
    const guild = make_guild(fetch_category);

    const result = await bot.process_entity_lockdown(guild, entity, bot_role);

    expect(result.status).toBe("skipped_missing_category");
    // Critical invariant from #303: no orphan role should be created on the guild.
    expect(find_or_create_entity_role).not.toHaveBeenCalled();
    expect(set_permissions).not.toHaveBeenCalled();
    expect(fetch_category).toHaveBeenCalledWith(STALE_CATEGORY_ID);
  });

  it("processes entity with valid category — role created, permissions set (regression)", async () => {
    const entity = make_entity("beta", VALID_CATEGORY_ID);
    const bot_role = make_bot_role();
    const category = make_category(VALID_CATEGORY_ID);

    const entity_role = { id: ENTITY_ROLE_ID, name: "beta" } as unknown as Role;
    const find_or_create_entity_role = vi.fn().mockResolvedValue(entity_role);
    const set_permissions = vi.fn().mockResolvedValue(undefined);
    const fetch_category = vi.fn(async (id: string) => {
      if (id === VALID_CATEGORY_ID) return category;
      throw new Error(`unexpected fetch: ${id}`);
    });

    const bot = make_bot_with_mocks({
      fetch_category,
      find_or_create_entity_role,
      set_permissions,
    });
    const guild = make_guild(fetch_category);

    const result = await bot.process_entity_lockdown(guild, entity, bot_role);

    expect(result.status).toBe("processed");
    expect(find_or_create_entity_role).toHaveBeenCalledWith(guild, "beta");
    expect(set_permissions).toHaveBeenCalledWith(category, entity_role, bot_role);
  });

  it("skips entity with no valid category_id — no fetch attempted, no role created", async () => {
    // category_id intentionally blank → short-circuits before any Discord call
    const entity = make_entity("gamma", "");
    const bot_role = make_bot_role();

    const find_or_create_entity_role = vi.fn();
    const set_permissions = vi.fn();
    const fetch_category = vi.fn();

    const bot = make_bot_with_mocks({
      fetch_category,
      find_or_create_entity_role,
      set_permissions,
    });
    const guild = make_guild(fetch_category);

    const result = await bot.process_entity_lockdown(guild, entity, bot_role);

    expect(result.status).toBe("skipped_no_category_id");
    expect(fetch_category).not.toHaveBeenCalled();
    expect(find_or_create_entity_role).not.toHaveBeenCalled();
  });
});
