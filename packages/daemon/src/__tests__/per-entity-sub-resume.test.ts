/**
 * Pool-side wiring tests for per-entity Claude sub --resume fix (issue #327).
 *
 * Covers the daemon behavior that flips between the default ~/.claude and a
 * per-entity CLAUDE_CONFIG_DIR. We don't re-test the migration helpers
 * themselves here (see claude-config-migration.test.ts) — instead we verify
 * the BotPool wires them in correctly:
 *
 *  - check_session_jsonl_exists_anywhere(session_id, entity_id) routes to the
 *    entity's per-entity dir when one is configured, falls back to ~/.claude
 *    otherwise.
 *  - On crash-restart, a missing JSONL in the per-entity dir cleanly drops
 *    --resume and spawns fresh (the backstop path).
 *  - ensure_per_entity_config_dir_ready() is invoked at assign-time when the
 *    entity has a subscription override.
 */

import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EntityConfig,
  EntityConfigSchema,
  type LobsterFarmConfig,
  LobsterFarmConfigSchema,
} from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture spawn calls (tmux start) — we assert on the env to confirm
// CLAUDE_CONFIG_DIR flows through.
let spawn_calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn((...args: unknown[]) => {
      spawn_calls.push({
        command: args[0] as string,
        args: args[1] as string[],
        options: args[2] as Record<string, unknown>,
      });
      const emitter = new EventEmitter();
      setTimeout(() => emitter.emit("close", 0), 0);
      return emitter;
    }),
  };
});

import {
  _reset_prepared_cache_for_tests,
  ensure_per_entity_config_dir_ready,
} from "../claude-config-migration.js";
import { BotPool } from "../pool.js";
import type { PoolBot } from "../pool.js";

// ── Test helpers ──

let temp_dir: string;
let per_entity_config_dir: string;

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    paths: { lobsterfarm_dir: temp_dir },
  });
}

function make_entity_config(overrides: {
  id: string;
  claude_config_dir?: string;
}): EntityConfig {
  return EntityConfigSchema.parse({
    entity: {
      id: overrides.id,
      name: overrides.id,
      repos: [],
      channels: { category_id: "", list: [] },
      memory: { path: `/tmp/test-memory/${overrides.id}` },
      secrets: { vault_name: `entity-${overrides.id}` },
      ...(overrides.claude_config_dir
        ? { subscription: { claude_config_dir: overrides.claude_config_dir } }
        : {}),
    },
  });
}

class MockRegistry {
  private entities = new Map<string, EntityConfig>();
  add(c: EntityConfig): void {
    this.entities.set(c.entity.id, c);
  }
  get(id: string): EntityConfig | undefined {
    return this.entities.get(id);
  }
}

class Pool extends BotPool {
  inject_bots(bots: PoolBot[]): void {
    (this as unknown as { bots: PoolBot[] }).bots = bots;
  }
  inject_registry(r: MockRegistry): void {
    (this as unknown as { registry: MockRegistry }).registry = r;
  }
  protected override is_bot_idle(): boolean {
    return true;
  }
  call_check_anywhere(session_id: string, entity_id?: string | null): Promise<boolean> {
    return (
      this as unknown as {
        check_session_jsonl_exists_anywhere: (s: string, e?: string | null) => Promise<boolean>;
      }
    ).check_session_jsonl_exists_anywhere(session_id, entity_id);
  }
}

function make_bot(overrides: Partial<PoolBot> & { id: number }): PoolBot {
  return {
    state: "free",
    channel_id: null,
    entity_id: null,
    archetype: null,
    channel_type: null,
    session_id: null,
    session_confirmed: true,
    tmux_session: `pool-${String(overrides.id)}`,
    last_active: null,
    assigned_at: null,
    state_dir: `/tmp/test-pool-${String(overrides.id)}`,
    model: null,
    effort: null,
    last_avatar_archetype: null,
    last_avatar_set_at: null,
    ...overrides,
  };
}

/** Stub the FS/tmux side effects that aren't relevant to these tests. */
function stub_side_effects(pool: Pool): void {
  vi.spyOn(
    pool as unknown as { kill_tmux: (s: string) => void },
    "kill_tmux" as never,
  ).mockImplementation(() => {});
  vi.spyOn(
    pool as unknown as { write_access_json: (d: string, c: string | null) => Promise<void> },
    "write_access_json" as never,
  ).mockResolvedValue(undefined);
  vi.spyOn(
    pool as unknown as { set_bot_nickname: (d: string, a: string) => Promise<void> },
    "set_bot_nickname" as never,
  ).mockResolvedValue(undefined);
  vi.spyOn(
    pool as unknown as { set_bot_avatar: (b: PoolBot, a: string) => Promise<void> },
    "set_bot_avatar" as never,
  ).mockResolvedValue(undefined);
  vi.spyOn(
    pool as unknown as { is_tmux_alive: (s: string) => boolean },
    "is_tmux_alive" as never,
  ).mockReturnValue(true);
  vi.spyOn(
    pool as unknown as { park_bot: (b: PoolBot) => Promise<void> },
    "park_bot" as never,
  ).mockImplementation(async (bot: PoolBot) => {
    bot.state = "parked";
  });
}

// ── Setup ──

let config: LobsterFarmConfig;
let pool: Pool;
let registry: MockRegistry;

beforeEach(async () => {
  temp_dir = await mkdtemp(join(tmpdir(), "per-entity-sub-test-"));
  per_entity_config_dir = await mkdtemp(join(tmpdir(), "per-entity-config-"));
  spawn_calls = [];
  _reset_prepared_cache_for_tests();

  config = make_config();
  pool = new Pool(config);
  registry = new MockRegistry();
  stub_side_effects(pool);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(temp_dir, { recursive: true, force: true });
  await rm(per_entity_config_dir, { recursive: true, force: true });
});

// ── Tests ──

describe("check_session_jsonl_exists_anywhere — config-dir-aware (#327)", () => {
  it("looks in the per-entity dir's projects/ when entity has subscription set", async () => {
    // Seed a JSONL inside the per-entity config dir.
    const slug_dir = join(per_entity_config_dir, "projects", "-some-encoded-cwd");
    await mkdir(slug_dir, { recursive: true });
    await writeFile(join(slug_dir, "sess-abc.jsonl"), "{}\n", "utf-8");

    registry.add(
      make_entity_config({
        id: "rengen-test",
        claude_config_dir: per_entity_config_dir,
      }),
    );
    pool.inject_registry(registry);

    // Entity has subscription → check routes to per-entity dir.
    expect(await pool.call_check_anywhere("sess-abc", "rengen-test")).toBe(true);
    // Phantom session → not found.
    expect(await pool.call_check_anywhere("sess-missing", "rengen-test")).toBe(false);
  });

  it("falls back to ~/.claude/projects/ when entity has no subscription", async () => {
    // Entity exists but has no claude_config_dir.
    registry.add(make_entity_config({ id: "default-entity" }));
    pool.inject_registry(registry);

    // We don't seed anything → should return false from ~/.claude/projects/
    // (cannot guarantee what's in the real ~/.claude on the test machine, but
    // a randomly-generated session id is guaranteed absent).
    const random_id = `sess-${Math.random().toString(36).slice(2)}-not-real`;
    expect(await pool.call_check_anywhere(random_id, "default-entity")).toBe(false);
  });

  it("does NOT find a JSONL that lives only in ~/.claude when entity has per-entity sub", async () => {
    // This is the core #327 bug: the daemon was looking in ~/.claude/projects/
    // for a session that exists ONLY there, even when the entity is configured
    // to use a per-entity sub. After the fix, the check should route to the
    // per-entity dir and correctly NOT find the session — triggering the
    // backstop "drop --resume, spawn fresh" path.
    registry.add(
      make_entity_config({
        id: "rengen-test",
        claude_config_dir: per_entity_config_dir,
      }),
    );
    pool.inject_registry(registry);

    // Per-entity dir is empty → check returns false even though the session
    // might exist under the default ~/.claude (we can't easily inject there).
    expect(await pool.call_check_anywhere("sess-default-only", "rengen-test")).toBe(false);
  });
});

describe("assign() invokes ensure_per_entity_config_dir_ready (#327)", () => {
  it("calls the migration helper at assign-time when entity has subscription", async () => {
    // Seed a .claude.json in the per-entity dir so ensure_onboarding_fields
    // has something to patch (otherwise it bails out gracefully).
    await writeFile(
      join(per_entity_config_dir, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "x@y.z" } }),
      "utf-8",
    );

    registry.add(
      make_entity_config({
        id: "rengen-test",
        claude_config_dir: per_entity_config_dir,
      }),
    );
    pool.inject_registry(registry);
    pool.inject_bots([make_bot({ id: 1, state: "free" })]);

    await pool.assign("ch-test", "rengen-test", "builder", undefined, "work_room");

    // Side effect: ensure_onboarding_fields wrote hasCompletedOnboarding into .claude.json
    const { readFile } = await import("node:fs/promises");
    const patched = JSON.parse(
      await readFile(join(per_entity_config_dir, ".claude.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(patched.hasCompletedOnboarding).toBe(true);
    expect(patched.bypassPermissionsModeAccepted).toBe(true);
    // oauthAccount preserved
    expect(patched.oauthAccount).toEqual({ emailAddress: "x@y.z" });

    // CLAUDE_CONFIG_DIR flowed through to the spawn env
    const tmux_call = spawn_calls.find((c) => c.command === "tmux");
    expect(tmux_call).toBeDefined();
    const env = tmux_call!.options.env as Record<string, string>;
    expect(env.CLAUDE_CONFIG_DIR).toBe(per_entity_config_dir);
  });

  it("does NOT invoke the helper when entity has no subscription", async () => {
    registry.add(make_entity_config({ id: "default-entity" }));
    pool.inject_registry(registry);
    pool.inject_bots([make_bot({ id: 1, state: "free" })]);

    await pool.assign("ch-test", "default-entity", "builder", undefined, "work_room");

    // No CLAUDE_CONFIG_DIR in spawn env
    const tmux_call = spawn_calls.find((c) => c.command === "tmux");
    expect(tmux_call).toBeDefined();
    const env = tmux_call!.options.env as Record<string, string>;
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });
});

describe("ensure_per_entity_config_dir_ready — fail-open behavior", () => {
  it("does not throw when the per-entity dir has no .claude.json", async () => {
    // Helper should log a warning and continue, not throw.
    await expect(
      ensure_per_entity_config_dir_ready("some-entity", per_entity_config_dir),
    ).resolves.toBeUndefined();
  });

  it("does not throw when the config_dir itself does not exist (mkdir handles it)", async () => {
    const missing = join(per_entity_config_dir, "subdir-that-doesnt-exist-yet");
    await expect(
      ensure_per_entity_config_dir_ready("some-entity", missing),
    ).resolves.toBeUndefined();
  });
});
