import type { Server } from "node:http";
import { EntityConfigSchema, LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { EntityConfig } from "@lobster-farm/shared";
import type { Guild, GuildMember } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AmbiguousUserError,
  DiscordBot,
  EntityRoleNotConfiguredError,
  NotFoundError,
  UserNotFoundError,
} from "../discord.js";
import type { EntityRegistry } from "../registry.js";
import { start_server } from "../server.js";

// ─────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────

const ENTITY_ROLE_ID = "444444444444444444";
const VALID_USER_ID = "123456789012345678";

/**
 * Build an entity config for tests. Pass `role_id: null` to omit the role_id
 * field entirely — simulates an entity that hasn't been through lockdown yet.
 */
function make_entity(id: string, role_id: string | null = ENTITY_ROLE_ID): EntityConfig {
  return EntityConfigSchema.parse({
    entity: {
      id,
      name: id,
      memory: { path: `~/.lobsterfarm/entities/${id}` },
      secrets: { vault_name: `entity-${id}` },
      channels:
        role_id === null
          ? { category_id: "111111111111111111", list: [] }
          : { category_id: "111111111111111111", role_id, list: [] },
    },
  });
}

function make_registry(entities: EntityConfig[]): EntityRegistry {
  return {
    get: (id: string) => entities.find((e) => e.entity.id === id),
    get_all: () => entities,
    get_active: () => entities,
    count: () => entities.length,
  } as unknown as EntityRegistry;
}

/**
 * Build a DiscordBot with a mocked guild — bypasses the real Discord client.
 * Tests inject specific behavior for member fetch, search, role add/remove.
 */
function make_bot(entities: EntityConfig[], guild: Partial<Guild> | null): DiscordBot {
  const config = LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    discord: { server_id: "1485323605331017859" },
  });
  const registry = make_registry(entities);
  const bot = new DiscordBot(config, registry);
  (bot as unknown as Record<string, unknown>).get_guild = () => Promise.resolve(guild);
  return bot;
}

/**
 * Minimal mock guild. member_by_id and search_results drive behavior.
 * add/remove spies are attached so tests can assert on them.
 */
function make_guild(opts: {
  members_by_id?: Map<string, GuildMember>;
  search_results?: GuildMember[];
  fetch_rejects?: unknown;
}): {
  guild: Partial<Guild>;
  add_spy: ReturnType<typeof vi.fn>;
  remove_spy: ReturnType<typeof vi.fn>;
  search_spy: ReturnType<typeof vi.fn>;
} {
  const add_spy = vi.fn().mockResolvedValue(undefined);
  const remove_spy = vi.fn().mockResolvedValue(undefined);
  const search_spy = vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve(new Map((opts.search_results ?? []).map((m) => [m.user.id, m]))),
    );

  const guild: Partial<Guild> = {
    members: {
      fetch: (id: string) => {
        if (opts.fetch_rejects) return Promise.reject(opts.fetch_rejects);
        const m = opts.members_by_id?.get(id);
        if (!m) return Promise.reject(new Error(`Member ${id} not found`));
        // Attach spies to the specific member being fetched.
        const member = m as unknown as {
          roles: { add: typeof add_spy; remove: typeof remove_spy };
        };
        member.roles = { add: add_spy, remove: remove_spy };
        return Promise.resolve(m);
      },
      search: (args: { query: string; limit?: number }) => search_spy(args),
    },
  } as unknown as Partial<Guild>;

  return { guild, add_spy, remove_spy, search_spy };
}

function make_member(id: string, username: string, global_name: string | null = null): GuildMember {
  return {
    user: { id, username, globalName: global_name, bot: false, tag: `${username}#0000` },
  } as unknown as GuildMember;
}

// ─────────────────────────────────────────────────────────────────────────
// DiscordBot.resolve_user_id
// ─────────────────────────────────────────────────────────────────────────

describe("DiscordBot.resolve_user_id (#308)", () => {
  it("resolves exact username match (single result)", async () => {
    const { guild } = make_guild({
      search_results: [make_member("111111111111111111", "alice")],
    });
    const bot = make_bot([], guild);
    const id = await bot.resolve_user_id("alice");
    expect(id).toBe("111111111111111111");
  });

  it("case-insensitive match on username", async () => {
    const { guild } = make_guild({
      search_results: [make_member("111111111111111111", "Alice")],
    });
    const bot = make_bot([], guild);
    const id = await bot.resolve_user_id("ALICE");
    expect(id).toBe("111111111111111111");
  });

  it("falls back to global_name when username does not match", async () => {
    const { guild } = make_guild({
      search_results: [make_member("222222222222222222", "other_user", "Bob")],
    });
    const bot = make_bot([], guild);
    const id = await bot.resolve_user_id("bob");
    expect(id).toBe("222222222222222222");
  });

  it("prefers username match over global_name match when both present", async () => {
    const { guild } = make_guild({
      search_results: [
        // This member has global_name "target" — but not a username match
        make_member("999999999999999999", "unrelated", "target"),
        // This member has username "target" — should win
        make_member("111111111111111111", "target", "Something Else"),
      ],
    });
    const bot = make_bot([], guild);
    const id = await bot.resolve_user_id("target");
    expect(id).toBe("111111111111111111");
  });

  it("throws UserNotFoundError on no matches", async () => {
    const { guild } = make_guild({ search_results: [] });
    const bot = make_bot([], guild);
    await expect(bot.resolve_user_id("nobody")).rejects.toBeInstanceOf(UserNotFoundError);
  });

  it("throws UserNotFoundError when prefix-match returns non-exact results only", async () => {
    const { guild } = make_guild({
      search_results: [make_member("111111111111111111", "alicia")], // prefix-match but not exact
    });
    const bot = make_bot([], guild);
    await expect(bot.resolve_user_id("alice")).rejects.toBeInstanceOf(UserNotFoundError);
  });

  it("throws AmbiguousUserError when multiple exact username matches exist", async () => {
    const { guild } = make_guild({
      search_results: [
        make_member("111111111111111111", "alice"),
        make_member("222222222222222222", "alice"),
      ],
    });
    const bot = make_bot([], guild);
    await expect(bot.resolve_user_id("alice")).rejects.toMatchObject({
      name: "AmbiguousUserError",
      candidates: expect.arrayContaining([
        expect.objectContaining({ id: "111111111111111111" }),
        expect.objectContaining({ id: "222222222222222222" }),
      ]),
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// DiscordBot.assign_entity_role / remove_entity_role
// ─────────────────────────────────────────────────────────────────────────

describe("DiscordBot.assign_entity_role (#308)", () => {
  it("adds the entity role to the member and returns the role_id", async () => {
    const entity = make_entity("alpha");
    const member = make_member(VALID_USER_ID, "alice");
    const { guild, add_spy } = make_guild({
      members_by_id: new Map([[VALID_USER_ID, member]]),
    });
    const bot = make_bot([entity], guild);

    const role_id = await bot.assign_entity_role("alpha", VALID_USER_ID);

    expect(role_id).toBe(ENTITY_ROLE_ID);
    expect(add_spy).toHaveBeenCalledTimes(1);
    expect(add_spy).toHaveBeenCalledWith(ENTITY_ROLE_ID, expect.stringContaining("alpha"));
  });

  it("throws NotFoundError when the entity is unknown", async () => {
    const { guild } = make_guild({});
    const bot = make_bot([], guild);
    await expect(bot.assign_entity_role("ghost", VALID_USER_ID)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("throws EntityRoleNotConfiguredError when the entity has no role_id", async () => {
    const entity = make_entity("no-role", null);
    const { guild } = make_guild({});
    const bot = make_bot([entity], guild);
    await expect(bot.assign_entity_role("no-role", VALID_USER_ID)).rejects.toBeInstanceOf(
      EntityRoleNotConfiguredError,
    );
  });
});

describe("DiscordBot.remove_entity_role (#308)", () => {
  it("removes the entity role from the member", async () => {
    const entity = make_entity("alpha");
    const member = make_member(VALID_USER_ID, "alice");
    const { guild, remove_spy } = make_guild({
      members_by_id: new Map([[VALID_USER_ID, member]]),
    });
    const bot = make_bot([entity], guild);

    await bot.remove_entity_role("alpha", VALID_USER_ID);

    expect(remove_spy).toHaveBeenCalledTimes(1);
    expect(remove_spy).toHaveBeenCalledWith(ENTITY_ROLE_ID, expect.stringContaining("alpha"));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// HTTP routes — POST /entities/:id/members  /  DELETE /entities/:id/members/:user_id
// ─────────────────────────────────────────────────────────────────────────

describe("POST /entities/:id/members (#308)", () => {
  let server: Server;
  let port: number;

  async function start(
    entities: EntityConfig[],
    discord: Partial<DiscordBot> | null,
  ): Promise<void> {
    const registry = make_registry(entities);
    const config = LobsterFarmConfigSchema.parse({ user: { name: "Test" } });
    const session_manager = { get_active: () => [] } as never;
    const queue = {
      get_stats: () => ({ pending: 0, active: 0, total: 0 }),
      get_pending: () => [],
      get_active: () => [],
    } as never;

    server = start_server(
      registry,
      config,
      session_manager,
      queue,
      null,
      discord as never,
      null,
      null,
      null,
      null,
      0,
    );
    await new Promise<void>((resolve) => server.on("listening", resolve));
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

  it("200 — happy path with user_id → role assigned, response includes role_id + assigned_at", async () => {
    const assign = vi.fn().mockResolvedValue(ENTITY_ROLE_ID);
    const discord = { assign_entity_role: assign, resolve_user_id: vi.fn() };
    await start([make_entity("alpha")], discord);

    const res = await fetch(`http://localhost:${String(port)}/entities/alpha/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: VALID_USER_ID }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      user_id: string;
      role_id: string;
      assigned_at: string;
    };
    expect(body.ok).toBe(true);
    expect(body.user_id).toBe(VALID_USER_ID);
    expect(body.role_id).toBe(ENTITY_ROLE_ID);
    // ISO-8601 with milliseconds + Z suffix
    expect(body.assigned_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(assign).toHaveBeenCalledWith("alpha", VALID_USER_ID);
  });

  it("200 — happy path with username → resolved then assigned", async () => {
    const assign = vi.fn().mockResolvedValue(ENTITY_ROLE_ID);
    const resolve = vi.fn().mockResolvedValue(VALID_USER_ID);
    const discord = { assign_entity_role: assign, resolve_user_id: resolve };
    await start([make_entity("alpha")], discord);

    const res = await fetch(`http://localhost:${String(port)}/entities/alpha/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { role_id: string; assigned_at: string };
    expect(body.role_id).toBe(ENTITY_ROLE_ID);
    expect(body.assigned_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(resolve).toHaveBeenCalledWith("alice");
    expect(assign).toHaveBeenCalledWith("alpha", VALID_USER_ID);
  });

  it("502 — Discord API failure surfaces as Bad Gateway", async () => {
    const assign = vi.fn().mockRejectedValue(new Error("Discord API unavailable"));
    const discord = { assign_entity_role: assign, resolve_user_id: vi.fn() };
    await start([make_entity("alpha")], discord);

    const res = await fetch(`http://localhost:${String(port)}/entities/alpha/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: VALID_USER_ID }),
    });

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Discord API/);
  });

  it("404 — entity not found", async () => {
    const discord = { assign_entity_role: vi.fn(), resolve_user_id: vi.fn() };
    await start([], discord);

    const res = await fetch(`http://localhost:${String(port)}/entities/ghost/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: VALID_USER_ID }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/ghost/);
  });

  it("409 — entity has no role_id configured", async () => {
    const assign = vi.fn().mockRejectedValue(new EntityRoleNotConfiguredError("alpha"));
    const discord = { assign_entity_role: assign, resolve_user_id: vi.fn() };
    await start([make_entity("alpha")], discord);

    const res = await fetch(`http://localhost:${String(port)}/entities/alpha/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: VALID_USER_ID }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/lockdown/);
  });

  it("404 — user not found in guild (resolve_user_id throws)", async () => {
    const resolve = vi.fn().mockRejectedValue(new UserNotFoundError("nobody"));
    const discord = { assign_entity_role: vi.fn(), resolve_user_id: resolve };
    await start([make_entity("alpha")], discord);

    const res = await fetch(`http://localhost:${String(port)}/entities/alpha/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "nobody" }),
    });

    expect(res.status).toBe(404);
  });

  it("400 — neither username nor user_id provided", async () => {
    const discord = { assign_entity_role: vi.fn(), resolve_user_id: vi.fn() };
    await start([make_entity("alpha")], discord);

    const res = await fetch(`http://localhost:${String(port)}/entities/alpha/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/exactly one/);
  });

  it("400 — both username and user_id provided", async () => {
    const discord = { assign_entity_role: vi.fn(), resolve_user_id: vi.fn() };
    await start([make_entity("alpha")], discord);

    const res = await fetch(`http://localhost:${String(port)}/entities/alpha/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", user_id: VALID_USER_ID }),
    });

    expect(res.status).toBe(400);
  });

  it("400 — ambiguous username returns candidates", async () => {
    const candidates = [
      { id: "111111111111111111", username: "alice", global_name: null },
      { id: "222222222222222222", username: "alice", global_name: null },
    ];
    const resolve = vi.fn().mockRejectedValue(new AmbiguousUserError("alice", candidates));
    const discord = { assign_entity_role: vi.fn(), resolve_user_id: resolve };
    await start([make_entity("alpha")], discord);

    const res = await fetch(`http://localhost:${String(port)}/entities/alpha/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice" }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; candidates: unknown[] };
    expect(body.candidates).toHaveLength(2);
    expect(body.error).toMatch(/Multiple/);
  });

  it("400 — invalid user_id (not a snowflake)", async () => {
    const discord = { assign_entity_role: vi.fn(), resolve_user_id: vi.fn() };
    await start([make_entity("alpha")], discord);

    const res = await fetch(`http://localhost:${String(port)}/entities/alpha/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: "not-a-snowflake" }),
    });

    expect(res.status).toBe(400);
  });

  it("503 — Discord bot not connected", async () => {
    await start([make_entity("alpha")], null);

    const res = await fetch(`http://localhost:${String(port)}/entities/alpha/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: VALID_USER_ID }),
    });

    expect(res.status).toBe(503);
  });
});

describe("DELETE /entities/:id/members/:user_id (#308)", () => {
  let server: Server;
  let port: number;

  async function start(
    entities: EntityConfig[],
    discord: Partial<DiscordBot> | null,
  ): Promise<void> {
    const registry = make_registry(entities);
    const config = LobsterFarmConfigSchema.parse({ user: { name: "Test" } });
    const session_manager = { get_active: () => [] } as never;
    const queue = {
      get_stats: () => ({ pending: 0, active: 0, total: 0 }),
      get_pending: () => [],
      get_active: () => [],
    } as never;

    server = start_server(
      registry,
      config,
      session_manager,
      queue,
      null,
      discord as never,
      null,
      null,
      null,
      null,
      0,
    );
    await new Promise<void>((resolve) => server.on("listening", resolve));
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

  it("200 — removes the entity role", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const discord = { remove_entity_role: remove };
    await start([make_entity("alpha")], discord);

    const res = await fetch(
      `http://localhost:${String(port)}/entities/alpha/members/${VALID_USER_ID}`,
      { method: "DELETE" },
    );

    expect(res.status).toBe(200);
    expect(remove).toHaveBeenCalledWith("alpha", VALID_USER_ID);
  });

  it("404 — entity not found", async () => {
    const discord = { remove_entity_role: vi.fn() };
    await start([], discord);

    const res = await fetch(
      `http://localhost:${String(port)}/entities/ghost/members/${VALID_USER_ID}`,
      { method: "DELETE" },
    );

    expect(res.status).toBe(404);
  });

  it("409 — entity has no role_id configured", async () => {
    const remove = vi.fn().mockRejectedValue(new EntityRoleNotConfiguredError("alpha"));
    const discord = { remove_entity_role: remove };
    await start([make_entity("alpha")], discord);

    const res = await fetch(
      `http://localhost:${String(port)}/entities/alpha/members/${VALID_USER_ID}`,
      { method: "DELETE" },
    );

    expect(res.status).toBe(409);
  });

  it("404 — route shape rejects non-snowflake user_id", async () => {
    const discord = { remove_entity_role: vi.fn() };
    await start([make_entity("alpha")], discord);

    const res = await fetch(`http://localhost:${String(port)}/entities/alpha/members/bogus`, {
      method: "DELETE",
    });

    // Route pattern requires a snowflake — non-matching URL falls through to 404 "Not found"
    expect(res.status).toBe(404);
  });
});
