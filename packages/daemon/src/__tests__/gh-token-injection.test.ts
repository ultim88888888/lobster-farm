/**
 * Tests for per-entity GitHub token injection via 1Password.
 *
 * Verifies that start_tmux():
 * - Wraps the claude command with `op run` when entity has github_token_ref
 * - Leaves the command unchanged when entity has no github_token_ref
 * - Writes correct .env.op file content (reference only, never the token)
 * - Cleans up temp .env.op files after tmux starts
 * - Gracefully falls back if op run setup fails
 */

import { EventEmitter } from "node:events";
import { describe, expect, it, beforeEach, vi, type Mock } from "vitest";
import { LobsterFarmConfigSchema, EntityConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig, EntityConfig } from "@lobster-farm/shared";
import { BotPool } from "../pool.js";
import type { PoolBot } from "../pool.js";

// ── Module-level mocks ──

// Track spawn calls for assertions
let spawn_calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
let spawn_emitter: EventEmitter;

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
      spawn_emitter = new EventEmitter();
      // Emit close with code 0 on next tick
      setTimeout(() => spawn_emitter.emit("close", 0), 0);
      return spawn_emitter;
    }),
  };
});

// Track writeFile and unlink calls
let write_file_calls: Array<{ path: string; content: string }> = [];
let write_file_should_fail = false;

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: vi.fn(async (path: string, content: string) => {
      if (write_file_should_fail && typeof path === "string" && path.includes("lf-env-pool")) {
        throw new Error("Permission denied");
      }
      write_file_calls.push({ path, content: String(content) });
    }),
    readFile: vi.fn(actual.readFile),
    unlink: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../env.js", () => ({
  resolve_binary: vi.fn((name: string) => `/usr/local/bin/${name}`),
}));

import { unlink } from "node:fs/promises";
import { resolve_binary } from "../env.js";

// ── Minimal mock registry ──

class MockRegistry {
  private entities = new Map<string, EntityConfig>();

  add(config: EntityConfig): void {
    this.entities.set(config.entity.id, config);
  }

  get(id: string): EntityConfig | undefined {
    return this.entities.get(id);
  }
}

function make_entity_config(overrides: {
  id: string;
  github_token_ref?: string;
}): EntityConfig {
  return EntityConfigSchema.parse({
    entity: {
      id: overrides.id,
      name: overrides.id,
      repos: [],
      channels: { category_id: "", list: [] },
      memory: { path: `/tmp/test-memory/${overrides.id}` },
      secrets: {
        vault_name: `entity-${overrides.id}`,
        ...(overrides.github_token_ref
          ? { github_token_ref: overrides.github_token_ref }
          : {}),
      },
    },
  });
}

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
  });
}

/** Test subclass that stubs tmux-dependent behavior and exposes internals. */
class GhTokenTestPool extends BotPool {
  inject_bots(bots: PoolBot[]): void {
    (this as unknown as { bots: PoolBot[] }).bots = bots;
  }

  inject_registry(registry: MockRegistry): void {
    (this as unknown as { registry: MockRegistry }).registry = registry;
  }

  protected override is_bot_idle(): boolean {
    return true;
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

describe("per-entity GitHub token injection", () => {
  let config: LobsterFarmConfig;
  let pool: GhTokenTestPool;
  let registry: MockRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    spawn_calls = [];
    write_file_calls = [];
    write_file_should_fail = false;

    config = make_config();
    pool = new GhTokenTestPool(config);
    registry = new MockRegistry();

    // Stub pool side effects unrelated to start_tmux
    vi.spyOn(pool as unknown as { kill_tmux: (s: string) => void }, "kill_tmux" as never)
      .mockImplementation(() => {});
    vi.spyOn(pool as unknown as { write_access_json: (d: string, c: string | null) => Promise<void> }, "write_access_json" as never)
      .mockResolvedValue(undefined);
    vi.spyOn(pool as unknown as { set_bot_nickname: (d: string, a: string) => Promise<void> }, "set_bot_nickname" as never)
      .mockResolvedValue(undefined);
    vi.spyOn(pool as unknown as { set_bot_avatar: (b: PoolBot, a: string) => Promise<void> }, "set_bot_avatar" as never)
      .mockResolvedValue(undefined);
    // is_tmux_alive must return true AFTER spawn so start_tmux resolves successfully
    vi.spyOn(pool as unknown as { is_tmux_alive: (s: string) => boolean }, "is_tmux_alive" as never)
      .mockReturnValue(true);
    vi.spyOn(pool as unknown as { park_bot: (b: PoolBot) => Promise<void> }, "park_bot" as never)
      .mockImplementation(async (bot: PoolBot) => {
        bot.state = "parked";
      });
  });

  describe("resolve_github_token_ref", () => {
    it("returns null when registry is not set", () => {
      const resolve = (pool as unknown as { resolve_github_token_ref: (id: string) => string | null })
        .resolve_github_token_ref.bind(pool);
      expect(resolve("some-entity")).toBeNull();
    });

    it("returns null when entity is not in registry", () => {
      pool.inject_registry(registry);
      const resolve = (pool as unknown as { resolve_github_token_ref: (id: string) => string | null })
        .resolve_github_token_ref.bind(pool);
      expect(resolve("nonexistent")).toBeNull();
    });

    it("returns null when entity has no github_token_ref", () => {
      registry.add(make_entity_config({ id: "no-token" }));
      pool.inject_registry(registry);
      const resolve = (pool as unknown as { resolve_github_token_ref: (id: string) => string | null })
        .resolve_github_token_ref.bind(pool);
      expect(resolve("no-token")).toBeNull();
    });

    it("returns the reference when entity has github_token_ref", () => {
      const ref = "op://entity-my-app/github/credential";
      registry.add(make_entity_config({ id: "with-token", github_token_ref: ref }));
      pool.inject_registry(registry);
      const resolve = (pool as unknown as { resolve_github_token_ref: (id: string) => string | null })
        .resolve_github_token_ref.bind(pool);
      expect(resolve("with-token")).toBe(ref);
    });
  });

  describe("tmux command without github_token_ref", () => {
    it("does NOT wrap with op run", async () => {
      registry.add(make_entity_config({ id: "no-gh-token" }));
      pool.inject_registry(registry);
      pool.inject_bots([make_bot({ id: 3, state: "free" })]);

      await pool.assign("ch-test", "no-gh-token", "builder", undefined, "work_room");

      // Find the tmux spawn call
      const tmux_call = spawn_calls.find(c => c.command === "tmux");
      expect(tmux_call).toBeDefined();

      // The tmux command string (last element in the args array)
      const cmd_string = tmux_call!.args[tmux_call!.args.length - 1];
      expect(cmd_string).not.toContain("op' run");
      expect(cmd_string).toContain("claude");
    });

    it("does not write a .env.op file", async () => {
      registry.add(make_entity_config({ id: "no-env-op" }));
      pool.inject_registry(registry);
      pool.inject_bots([make_bot({ id: 1, state: "free" })]);

      await pool.assign("ch-test", "no-env-op", "builder", undefined, "work_room");

      const env_op_writes = write_file_calls.filter(c => c.path.includes("lf-env-pool"));
      expect(env_op_writes).toHaveLength(0);
    });

    it("does not call unlink", async () => {
      registry.add(make_entity_config({ id: "no-cleanup" }));
      pool.inject_registry(registry);
      pool.inject_bots([make_bot({ id: 8, state: "free" })]);

      await pool.assign("ch-test", "no-cleanup", "builder", undefined, "work_room");

      // Wait for the close handler to run
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(unlink).not.toHaveBeenCalled();
    });
  });

  describe("tmux command with github_token_ref", () => {
    it("wraps with op run", async () => {
      const ref = "op://entity-client/github/credential";
      registry.add(make_entity_config({ id: "gh-token-entity", github_token_ref: ref }));
      pool.inject_registry(registry);
      pool.inject_bots([make_bot({ id: 5, state: "free" })]);

      await pool.assign("ch-test", "gh-token-entity", "builder", undefined, "work_room");

      const tmux_call = spawn_calls.find(c => c.command === "tmux");
      expect(tmux_call).toBeDefined();
      const cmd_string = tmux_call!.args[tmux_call!.args.length - 1];

      // op binary is shell-quoted by sq(), so look for the resolved path + "run"
      expect(cmd_string).toContain("/usr/local/bin/op' run");
      expect(cmd_string).toContain("--env-file");
      expect(cmd_string).toContain("lf-env-pool-5.op");
      // claude command should come after the op run wrapper (after --)
      expect(cmd_string).toContain("-- ");
      expect(cmd_string).toContain("claude");
    });

    it("writes correct .env.op file content", async () => {
      const ref = "op://entity-client/github/credential";
      registry.add(make_entity_config({ id: "env-op-entity", github_token_ref: ref }));
      pool.inject_registry(registry);
      pool.inject_bots([make_bot({ id: 7, state: "free" })]);

      await pool.assign("ch-test", "env-op-entity", "builder", undefined, "work_room");

      const env_op_write = write_file_calls.find(c => c.path.includes("lf-env-pool-7.op"));
      expect(env_op_write).toBeDefined();
      expect(env_op_write!.path).toBe("/tmp/lf-env-pool-7.op");
      expect(env_op_write!.content).toBe(`GH_TOKEN=${ref}\n`);
    });

    it("cleans up temp .env.op file after tmux starts", async () => {
      const ref = "op://entity-cleanup/github/credential";
      registry.add(make_entity_config({ id: "cleanup-entity", github_token_ref: ref }));
      pool.inject_registry(registry);
      pool.inject_bots([make_bot({ id: 2, state: "free" })]);

      await pool.assign("ch-test", "cleanup-entity", "builder", undefined, "work_room");

      // Wait for the close handler's unlink call
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(unlink).toHaveBeenCalledWith("/tmp/lf-env-pool-2.op");
    });

    it("resolves op binary path via resolve_binary", async () => {
      const ref = "op://entity-resolve/github/credential";
      registry.add(make_entity_config({ id: "resolve-entity", github_token_ref: ref }));
      pool.inject_registry(registry);
      pool.inject_bots([make_bot({ id: 4, state: "free" })]);

      await pool.assign("ch-test", "resolve-entity", "builder", undefined, "work_room");

      expect(resolve_binary).toHaveBeenCalledWith("op");

      const tmux_call = spawn_calls.find(c => c.command === "tmux");
      const cmd_string = tmux_call!.args[tmux_call!.args.length - 1];
      expect(cmd_string).toContain("/usr/local/bin/op");
    });
  });

  describe("graceful fallback", () => {
    it("session starts without op run when .env.op write fails", async () => {
      const ref = "op://entity-fail/github/credential";
      registry.add(make_entity_config({ id: "fail-entity", github_token_ref: ref }));
      pool.inject_registry(registry);
      pool.inject_bots([make_bot({ id: 6, state: "free" })]);

      write_file_should_fail = true;

      // Should NOT throw — session starts without GH_TOKEN
      await pool.assign("ch-test", "fail-entity", "builder", undefined, "work_room");

      const tmux_call = spawn_calls.find(c => c.command === "tmux");
      expect(tmux_call).toBeDefined();
      const cmd_string = tmux_call!.args[tmux_call!.args.length - 1];

      // Should NOT contain "op run" since setup failed
      expect(cmd_string).not.toContain("op' run");
      // But should still contain claude
      expect(cmd_string).toContain("claude");
    });

    it("backward compatible — no registry means no op run wrapping", async () => {
      // Pool without a registry (legacy path)
      pool.inject_bots([make_bot({ id: 9, state: "free" })]);

      await pool.assign("ch-test", "some-entity", "builder", undefined, "work_room");

      const tmux_call = spawn_calls.find(c => c.command === "tmux");
      expect(tmux_call).toBeDefined();
      const cmd_string = tmux_call!.args[tmux_call!.args.length - 1];

      expect(cmd_string).not.toContain("op' run");
      expect(cmd_string).toContain("claude");
    });
  });
});
