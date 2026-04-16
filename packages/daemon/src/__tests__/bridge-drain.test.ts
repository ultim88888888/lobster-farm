import { tmpdir } from "node:os";
import { join } from "node:path";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PoolBot, pending_file_path } from "../pool.js";
import { BotPoolTestBase } from "./helpers/test-bot-pool-base.js";

// ── Mocks ──

// Mock actions.ts — notify is imported by pool.ts for alerting
vi.mock("../actions.js", () => ({
  notify: vi.fn().mockResolvedValue(undefined),
}));

// Mock persistence to avoid filesystem side effects
vi.mock("../persistence.js", () => ({
  save_pool_state: vi.fn().mockResolvedValue(undefined),
  load_pool_state: vi.fn().mockResolvedValue({
    bots: [],
    session_history: {},
    avatar_state: {},
  }),
}));

// Mock sentry
vi.mock("../sentry.js", () => ({
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

// Mock rate-limit-recovery (imported by pool.ts)
vi.mock("../rate-limit-recovery.js", () => ({
  scan_and_recover: vi.fn().mockReturnValue([]),
}));

// Mock node:fs/promises — we need control over access() and unlink()
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    access: vi.fn().mockRejectedValue(new Error("ENOENT")),
    unlink: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue("{}"),
    readdir: vi.fn().mockResolvedValue([]),
    mkdir: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockRejectedValue(new Error("ENOENT")),
  };
});

import { access, unlink } from "node:fs/promises";

// ── Test helpers ──

let temp_dir: string;

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    paths: { lobsterfarm_dir: temp_dir },
  });
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

/**
 * Test-friendly subclass that exposes internals for health check testing.
 */
class TestBotPool extends BotPoolTestBase {
  inject_bots(bots: PoolBot[]): void {
    (this as unknown as { bots: PoolBot[] }).bots = bots;
  }

  get_bots(): PoolBot[] {
    return (this as unknown as { bots: PoolBot[] }).bots;
  }

  /** Expose protected method for direct testing. */
  async run_health_check(): Promise<void> {
    return this.check_assigned_health();
  }
}

// ── Tests ──

describe("drain_pending_files (issue #278)", () => {
  let config: LobsterFarmConfig;
  let pool: TestBotPool;
  let mock_is_tmux_alive: ReturnType<typeof vi.fn>;
  let mock_is_at_prompt: ReturnType<typeof vi.fn>;
  let mock_send_via_tmux: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    temp_dir = join(tmpdir(), `bridge-drain-test-${Date.now()}`);
    config = make_config();
    pool = new TestBotPool(config);

    // Stub side effects that check_assigned_health calls
    vi.spyOn(pool as unknown as Record<string, unknown>, "kill_tmux" as never).mockImplementation(
      () => {},
    );

    // Default: all tmux sessions are alive
    mock_is_tmux_alive = vi
      .spyOn(pool as unknown as Record<string, unknown>, "is_tmux_alive" as never)
      .mockReturnValue(true) as unknown as ReturnType<typeof vi.fn>;

    // Default: bot is at prompt (ready to receive)
    mock_is_at_prompt = vi
      .spyOn(pool as unknown as Record<string, unknown>, "is_at_prompt" as never)
      .mockReturnValue(true) as unknown as ReturnType<typeof vi.fn>;

    // Spy on send_via_tmux to verify delivery
    mock_send_via_tmux = vi
      .spyOn(pool as unknown as Record<string, unknown>, "send_via_tmux" as never)
      .mockImplementation(() => {}) as unknown as ReturnType<typeof vi.fn>;

    // Stub check_cwd_health to prevent real filesystem work
    vi.spyOn(
      pool as unknown as Record<string, unknown>,
      "check_cwd_health" as never,
    ).mockResolvedValue(undefined);

    // Default: no pending files exist
    (access as Mock).mockRejectedValue(new Error("ENOENT"));
    (unlink as Mock).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("delivers pending file when bot is assigned, alive, and at prompt", async () => {
    const bot = make_bot({
      id: 1,
      state: "assigned",
      channel_id: "ch-1",
      entity_id: "e1",
      archetype: "planner",
      session_id: "sess-1",
    });
    pool.inject_bots([bot]);

    // Pending file exists for this bot
    (access as Mock).mockImplementation(async (path: unknown) => {
      if (path === pending_file_path("pool-1")) return;
      throw new Error("ENOENT");
    });

    await pool.run_health_check();

    // Verify delivery via tmux
    expect(mock_send_via_tmux).toHaveBeenCalledWith(
      "pool-1",
      expect.stringContaining(pending_file_path("pool-1")),
    );
    // unlink is delayed (setTimeout 5s) to give Claude time to read the file —
    // verify it's not called synchronously after send_via_tmux
    expect(unlink).not.toHaveBeenCalled();
  });

  it("does not deliver when bot is not assigned", async () => {
    const bot = make_bot({ id: 2, state: "free" });
    pool.inject_bots([bot]);

    (access as Mock).mockResolvedValue(undefined);

    await pool.run_health_check();

    // send_via_tmux should not have been called for this bot at all
    const calls_for_bot = mock_send_via_tmux.mock.calls.filter(
      (c: unknown[]) => (c[0] as string) === "pool-2",
    );
    expect(calls_for_bot).toHaveLength(0);
  });

  it("does not deliver when bot is not at prompt", async () => {
    const bot = make_bot({
      id: 3,
      state: "assigned",
      channel_id: "ch-3",
      entity_id: "e1",
      archetype: "planner",
      session_id: "sess-3",
    });
    pool.inject_bots([bot]);

    (access as Mock).mockImplementation(async (path: unknown) => {
      if (path === pending_file_path("pool-3")) return;
      throw new Error("ENOENT");
    });
    mock_is_at_prompt.mockReturnValue(false);

    await pool.run_health_check();

    // send_via_tmux should not have been called for drain delivery
    const drain_calls = mock_send_via_tmux.mock.calls.filter(
      (c: unknown[]) =>
        (c[0] as string) === "pool-3" &&
        typeof c[1] === "string" &&
        (c[1] as string).includes("lf-pending"),
    );
    expect(drain_calls).toHaveLength(0);
    expect(unlink).not.toHaveBeenCalledWith(pending_file_path("pool-3"));
  });

  it("does not deliver when tmux session is dead", async () => {
    const bot = make_bot({
      id: 4,
      state: "assigned",
      channel_id: "ch-4",
      entity_id: "e1",
      archetype: "planner",
      session_id: "sess-4",
    });
    pool.inject_bots([bot]);

    (access as Mock).mockImplementation(async (path: unknown) => {
      if (path === pending_file_path("pool-4")) return;
      throw new Error("ENOENT");
    });
    // Session dead — regular health check will try to restart, but drain won't fire
    mock_is_tmux_alive.mockReturnValue(false);

    // Stub restart path to avoid hitting real tmux
    vi.spyOn(
      pool as unknown as Record<string, unknown>,
      "restart_crashed_session" as never,
    ).mockResolvedValue(undefined);

    await pool.run_health_check();

    // send_via_tmux should not have been called for drain delivery
    const drain_calls = mock_send_via_tmux.mock.calls.filter(
      (c: unknown[]) =>
        (c[0] as string) === "pool-4" &&
        typeof c[1] === "string" &&
        (c[1] as string).includes("lf-pending"),
    );
    expect(drain_calls).toHaveLength(0);
  });

  it("does not attempt delivery when no pending file exists", async () => {
    const bot = make_bot({
      id: 5,
      state: "assigned",
      channel_id: "ch-5",
      entity_id: "e1",
      archetype: "planner",
      session_id: "sess-5",
    });
    pool.inject_bots([bot]);

    // No pending files (access always throws)
    (access as Mock).mockRejectedValue(new Error("ENOENT"));

    await pool.run_health_check();

    // send_via_tmux should not have been called for drain delivery
    const drain_calls = mock_send_via_tmux.mock.calls.filter(
      (c: unknown[]) => typeof c[1] === "string" && (c[1] as string).includes("lf-pending"),
    );
    expect(drain_calls).toHaveLength(0);
    expect(unlink).not.toHaveBeenCalledWith(pending_file_path("pool-5"));
  });

  it("handles send_via_tmux failure gracefully", async () => {
    const bot = make_bot({
      id: 6,
      state: "assigned",
      channel_id: "ch-6",
      entity_id: "e1",
      archetype: "planner",
      session_id: "sess-6",
    });
    pool.inject_bots([bot]);

    (access as Mock).mockImplementation(async (path: unknown) => {
      if (path === pending_file_path("pool-6")) return;
      throw new Error("ENOENT");
    });
    mock_send_via_tmux.mockImplementation(() => {
      throw new Error("tmux send failed");
    });

    // Should not throw — error is caught internally
    await expect(pool.run_health_check()).resolves.toBeUndefined();
  });
});
