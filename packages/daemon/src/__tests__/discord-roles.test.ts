import type { Server } from "node:http";
import { EntityConfigSchema, LobsterFarmConfigSchema } from "@lobster-farm/shared";
import { afterEach, describe, expect, it } from "vitest";
import { is_lf_bot } from "../discord.js";
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
