/**
 * Tests for per-entity Claude subscription injection (CLAUDE_CONFIG_DIR).
 *
 * Verifies that:
 * - CLAUDE_CONFIG_DIR is injected into tmux env + command when entity has subscription.claude_config_dir
 * - CLAUDE_CONFIG_DIR is omitted when entity has no subscription config
 * - CLAUDE_CONFIG_DIR is injected into queue session spawn env when configured
 * - CLAUDE_CONFIG_DIR is omitted from queue session spawn env when not configured
 * - Backward compatibility: entities without subscription field work unchanged
 *
 * Issue: #296
 */

import { EventEmitter } from "node:events";
import { EntityConfigSchema, LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { EntityConfig, LobsterFarmConfig } from "@lobster-farm/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BotPool } from "../pool.js";
import type { PoolBot } from "../pool.js";
import { ClaudeSessionManager } from "../session.js";

// ── Module-level mocks ──

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
      // Return a minimal process-like object for session.ts (needs stdin, stdout, stderr)
      const mock_proc = Object.assign(spawn_emitter, {
        stdin: Object.assign(new EventEmitter(), {
          write: vi.fn(),
          end: vi.fn(),
        }),
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        pid: 12345,
        kill: vi.fn(),
      });
      return mock_proc;
    }),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: vi.fn(async () => {}),
    readFile: vi.fn(actual.readFile),
  };
});

vi.mock("../env.js", () => ({
  resolve_binary: vi.fn((name: string) => `/usr/local/bin/${name}`),
}));

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

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
  });
}

// ── Pool test subclass ──

class SubscriptionTestPool extends BotPool {
  inject_bots(bots: PoolBot[]): void {
    (this as unknown as { bots: PoolBot[] }).bots = bots;
  }

  inject_registry(registry: MockRegistry): void {
    (this as unknown as { registry: MockRegistry }).registry = registry;
  }

  override_resolve_op_secret(mock: (ref: string) => Promise<string>): void {
    (this as unknown as { resolve_op_secret: (ref: string) => Promise<string> }).resolve_op_secret =
      mock;
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

// ── Pool tests: CLAUDE_CONFIG_DIR injection ──

describe("per-entity CLAUDE_CONFIG_DIR injection — pool path", () => {
  let config: LobsterFarmConfig;
  let pool: SubscriptionTestPool;
  let registry: MockRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    spawn_calls = [];

    config = make_config();
    pool = new SubscriptionTestPool(config);
    registry = new MockRegistry();

    // Stub pool side effects unrelated to start_tmux
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
  });

  describe("entity WITH subscription.claude_config_dir", () => {
    const CONFIG_DIR = "/Users/farm/.lobsterfarm/entities/alpha/.claude-config";

    it("injects CLAUDE_CONFIG_DIR into tmux command and spawn env", async () => {
      registry.add(make_entity_config({ id: "alpha-sub", claude_config_dir: CONFIG_DIR }));
      pool.inject_registry(registry);
      pool.inject_bots([make_bot({ id: 1, state: "free" })]);

      await pool.assign("ch-test", "alpha-sub", "builder", undefined, "work_room");

      const tmux_call = spawn_calls.find((c) => c.command === "tmux");
      expect(tmux_call).toBeDefined();

      // The tmux command string (last element in the args array)
      const cmd_string = tmux_call!.args[tmux_call!.args.length - 1];
      expect(cmd_string).toContain("CLAUDE_CONFIG_DIR=");
      expect(cmd_string).toContain(CONFIG_DIR);

      // Spawn env should have CLAUDE_CONFIG_DIR
      const spawn_env = tmux_call!.options.env as Record<string, string>;
      expect(spawn_env.CLAUDE_CONFIG_DIR).toBe(CONFIG_DIR);
    });
  });

  describe("entity WITH tilde path in subscription.claude_config_dir", () => {
    it("expands tilde to absolute path in tmux command and spawn env", async () => {
      const TILDE_PATH = "~/.lobsterfarm/entities/alpha/.claude-config";
      const EXPANDED_PATH = `${process.env.HOME}/.lobsterfarm/entities/alpha/.claude-config`;
      registry.add(make_entity_config({ id: "alpha-tilde", claude_config_dir: TILDE_PATH }));
      pool.inject_registry(registry);
      pool.inject_bots([make_bot({ id: 4, state: "free" })]);

      await pool.assign("ch-test", "alpha-tilde", "builder", undefined, "work_room");

      const tmux_call = spawn_calls.find((c) => c.command === "tmux");
      expect(tmux_call).toBeDefined();

      // The resolved path should be expanded — no tilde
      const spawn_env = tmux_call!.options.env as Record<string, string>;
      expect(spawn_env.CLAUDE_CONFIG_DIR).toBe(EXPANDED_PATH);
      expect(spawn_env.CLAUDE_CONFIG_DIR).not.toContain("~");
    });
  });

  describe("entity WITHOUT subscription.claude_config_dir", () => {
    it("does NOT include CLAUDE_CONFIG_DIR in tmux command or spawn env", async () => {
      registry.add(make_entity_config({ id: "no-sub" }));
      pool.inject_registry(registry);
      pool.inject_bots([make_bot({ id: 2, state: "free" })]);

      await pool.assign("ch-test", "no-sub", "builder", undefined, "work_room");

      const tmux_call = spawn_calls.find((c) => c.command === "tmux");
      expect(tmux_call).toBeDefined();

      // The tmux command string (last element in the args array)
      const cmd_string = tmux_call!.args[tmux_call!.args.length - 1];
      expect(cmd_string).not.toContain("CLAUDE_CONFIG_DIR=");

      // Spawn env should not have CLAUDE_CONFIG_DIR
      const spawn_env = tmux_call!.options.env as Record<string, string>;
      expect(spawn_env.CLAUDE_CONFIG_DIR).toBeUndefined();
    });
  });

  describe("backward compatibility — no registry", () => {
    it("works without CLAUDE_CONFIG_DIR when no registry is set", async () => {
      pool.inject_bots([make_bot({ id: 3, state: "free" })]);

      await pool.assign("ch-test", "some-entity", "builder", undefined, "work_room");

      const tmux_call = spawn_calls.find((c) => c.command === "tmux");
      expect(tmux_call).toBeDefined();

      const cmd_string = tmux_call!.args[tmux_call!.args.length - 1];
      expect(cmd_string).not.toContain("CLAUDE_CONFIG_DIR=");

      const spawn_env = tmux_call!.options.env as Record<string, string>;
      expect(spawn_env.CLAUDE_CONFIG_DIR).toBeUndefined();
    });
  });
});

// ── Session tests: CLAUDE_CONFIG_DIR injection ──

describe("per-entity CLAUDE_CONFIG_DIR injection — session (queue) path", () => {
  let config: LobsterFarmConfig;
  let mgr: ClaudeSessionManager;
  let registry: MockRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    spawn_calls = [];

    config = make_config();
    mgr = new ClaudeSessionManager(config);
    registry = new MockRegistry();
  });

  describe("entity WITH subscription.claude_config_dir", () => {
    const CONFIG_DIR = "/Users/farm/.lobsterfarm/entities/beta/.claude-config";

    it("injects CLAUDE_CONFIG_DIR into spawn env", async () => {
      registry.add(make_entity_config({ id: "beta-sub", claude_config_dir: CONFIG_DIR }));
      mgr.set_registry(registry);

      // spawn() will call child_process.spawn which is mocked
      await mgr.spawn({
        entity_id: "beta-sub",
        feature_id: "review-42",
        archetype: "reviewer",
        dna: [],
        model: { model: "sonnet", think: "standard" },
        worktree_path: "/tmp/test-worktree",
        prompt: "Review PR #42",
        interactive: false,
      });

      // Find the claude spawn call (not tmux — session.ts spawns claude directly)
      expect(spawn_calls.length).toBeGreaterThanOrEqual(1);
      const claude_call = spawn_calls[0]!;

      const spawn_env = claude_call.options.env as Record<string, string>;
      expect(spawn_env.CLAUDE_CONFIG_DIR).toBe(CONFIG_DIR);
    });
  });

  describe("entity WITH tilde path in subscription.claude_config_dir", () => {
    it("expands tilde to absolute path in spawn env", async () => {
      const TILDE_PATH = "~/.lobsterfarm/entities/beta/.claude-config";
      const EXPANDED_PATH = `${process.env.HOME}/.lobsterfarm/entities/beta/.claude-config`;
      registry.add(make_entity_config({ id: "beta-tilde", claude_config_dir: TILDE_PATH }));
      mgr.set_registry(registry);

      await mgr.spawn({
        entity_id: "beta-tilde",
        feature_id: "review-tilde",
        archetype: "reviewer",
        dna: [],
        model: { model: "sonnet", think: "standard" },
        worktree_path: "/tmp/test-worktree",
        prompt: "Review PR with tilde path",
        interactive: false,
      });

      expect(spawn_calls.length).toBeGreaterThanOrEqual(1);
      const claude_call = spawn_calls[0]!;

      const spawn_env = claude_call.options.env as Record<string, string>;
      expect(spawn_env.CLAUDE_CONFIG_DIR).toBe(EXPANDED_PATH);
      expect(spawn_env.CLAUDE_CONFIG_DIR).not.toContain("~");
    });
  });

  describe("entity WITHOUT subscription.claude_config_dir", () => {
    it("does NOT include CLAUDE_CONFIG_DIR in spawn env", async () => {
      registry.add(make_entity_config({ id: "no-sub-session" }));
      mgr.set_registry(registry);

      await mgr.spawn({
        entity_id: "no-sub-session",
        feature_id: "review-99",
        archetype: "reviewer",
        dna: [],
        model: { model: "sonnet", think: "standard" },
        worktree_path: "/tmp/test-worktree",
        prompt: "Review PR #99",
        interactive: false,
      });

      expect(spawn_calls.length).toBeGreaterThanOrEqual(1);
      const claude_call = spawn_calls[0]!;

      const spawn_env = claude_call.options.env as Record<string, string>;
      expect(spawn_env.CLAUDE_CONFIG_DIR).toBeUndefined();
    });
  });

  describe("no registry set (backward compatible)", () => {
    it("does NOT include CLAUDE_CONFIG_DIR when no registry is available", async () => {
      // Don't call set_registry — simulates pre-#296 behavior
      await mgr.spawn({
        entity_id: "legacy-entity",
        feature_id: "review-1",
        archetype: "reviewer",
        dna: [],
        model: { model: "sonnet", think: "standard" },
        worktree_path: "/tmp/test-worktree",
        prompt: "Review PR #1",
        interactive: false,
      });

      expect(spawn_calls.length).toBeGreaterThanOrEqual(1);
      const claude_call = spawn_calls[0]!;

      const spawn_env = claude_call.options.env as Record<string, string>;
      expect(spawn_env.CLAUDE_CONFIG_DIR).toBeUndefined();
    });
  });

  describe("caller-provided env vars are preserved", () => {
    it("merges CLAUDE_CONFIG_DIR alongside caller env vars", async () => {
      const CONFIG_DIR = "/Users/farm/.lobsterfarm/entities/gamma/.claude-config";
      registry.add(make_entity_config({ id: "gamma-sub", claude_config_dir: CONFIG_DIR }));
      mgr.set_registry(registry);

      await mgr.spawn({
        entity_id: "gamma-sub",
        feature_id: "fix-99",
        archetype: "builder",
        dna: [],
        model: { model: "opus", think: "high" },
        worktree_path: "/tmp/test-worktree",
        prompt: "Fix issue #99",
        interactive: false,
        env: { GH_TOKEN: "ghp_test_token", CUSTOM_VAR: "custom_value" },
      });

      expect(spawn_calls.length).toBeGreaterThanOrEqual(1);
      const claude_call = spawn_calls[0]!;

      const spawn_env = claude_call.options.env as Record<string, string>;
      expect(spawn_env.CLAUDE_CONFIG_DIR).toBe(CONFIG_DIR);
      expect(spawn_env.GH_TOKEN).toBe("ghp_test_token");
      expect(spawn_env.CUSTOM_VAR).toBe("custom_value");
    });
  });
});
