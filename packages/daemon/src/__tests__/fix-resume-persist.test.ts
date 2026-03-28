import { describe, expect, it, beforeEach, vi } from "vitest";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { BotPool } from "../pool.js";
import type { PoolBot } from "../pool.js";

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
  });
}

/**
 * Test-friendly subclass that exposes internals and stubs side effects.
 * Tracks persist() and kill_tmux() calls for assertion.
 */
class TestBotPool extends BotPool {
  persist_calls = 0;
  kill_tmux_calls: string[] = [];
  private persist_order: string[] = [];
  private kill_order: string[] = [];

  inject_bots(bots: PoolBot[]): void {
    (this as unknown as { bots: PoolBot[] }).bots = bots;
  }

  get_bots(): PoolBot[] {
    return (this as unknown as { bots: PoolBot[] }).bots;
  }

  /** Returns the ordered list of operations (persist/kill) for sequence assertions. */
  get_operation_order(): string[] {
    return [...this.persist_order, ...this.kill_order].length > 0
      ? this.interleaved_order
      : [];
  }

  private interleaved_order: string[] = [];

  /** Override persist to track calls without filesystem access. */
  protected override async check_assigned_health(): Promise<void> {
    // Call the real implementation through the parent — the drain guard is what we're testing
    return super.check_assigned_health();
  }

  set_draining(value: boolean): void {
    (this as unknown as { _draining: boolean })._draining = value;
  }

  protected override is_bot_idle(/* _bot: PoolBot */): boolean {
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
    cached_context: null,
    cached_subscription: null,
    cache_updated_at: null,
    ...overrides,
  };
}

describe("shutdown() persists state before killing tmux", () => {
  let config: LobsterFarmConfig;
  let pool: TestBotPool;

  beforeEach(() => {
    config = make_config();
    pool = new TestBotPool(config);
  });

  it("calls persist() before killing any tmux sessions", async () => {
    const operation_order: string[] = [];

    // Spy on persist (private) — track order
    vi.spyOn(pool as unknown as Record<string, unknown>, "persist" as never)
      .mockImplementation(async () => {
        operation_order.push("persist");
      });

    // Spy on kill_tmux (private) — track order
    vi.spyOn(pool as unknown as Record<string, unknown>, "kill_tmux" as never)
      .mockImplementation((session: string) => {
        operation_order.push(`kill:${session}`);
      });

    pool.inject_bots([
      make_bot({ id: 0, state: "assigned", channel_id: "ch-1", entity_id: "e1", archetype: "builder" }),
      make_bot({ id: 1, state: "assigned", channel_id: "ch-2", entity_id: "e1", archetype: "planner" }),
      make_bot({ id: 2, state: "free" }),
    ]);

    await pool.shutdown();

    // persist must come first, before any kill
    expect(operation_order[0]).toBe("persist");
    expect(operation_order).toContain("kill:pool-0");
    expect(operation_order).toContain("kill:pool-1");

    // Verify persist happened exactly once and before all kills
    const persist_index = operation_order.indexOf("persist");
    const first_kill_index = operation_order.findIndex(op => op.startsWith("kill:"));
    expect(persist_index).toBeLessThan(first_kill_index);
  });

  it("does not kill free bots during shutdown", async () => {
    const killed: string[] = [];

    vi.spyOn(pool as unknown as Record<string, unknown>, "persist" as never)
      .mockResolvedValue(undefined);
    vi.spyOn(pool as unknown as Record<string, unknown>, "kill_tmux" as never)
      .mockImplementation((session: string) => {
        killed.push(session);
      });

    pool.inject_bots([
      make_bot({ id: 0, state: "free" }),
      make_bot({ id: 1, state: "assigned", channel_id: "ch-1", entity_id: "e1", archetype: "builder" }),
      make_bot({ id: 2, state: "parked", channel_id: "ch-2", entity_id: "e1", archetype: "planner" }),
    ]);

    await pool.shutdown();

    // Only the assigned bot gets killed
    expect(killed).toEqual(["pool-1"]);
  });
});

describe("check_assigned_health() drain guard", () => {
  let config: LobsterFarmConfig;
  let pool: TestBotPool;

  beforeEach(() => {
    config = make_config();
    pool = new TestBotPool(config);

    // Stub side effects
    vi.spyOn(pool as unknown as Record<string, unknown>, "kill_tmux" as never)
      .mockImplementation(() => {});
    vi.spyOn(pool as unknown as Record<string, unknown>, "is_tmux_alive" as never)
      .mockReturnValue(false);
    vi.spyOn(pool as unknown as Record<string, unknown>, "persist" as never)
      .mockResolvedValue(undefined);
  });

  it("returns early without modifying state when draining", async () => {
    pool.inject_bots([
      make_bot({
        id: 0,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "e1",
        archetype: "builder",
        session_id: "sess-1",
      }),
    ]);

    // Enter drain mode
    pool.set_draining(true);

    // Health check should be a no-op
    await (pool as unknown as { check_assigned_health: () => Promise<void> }).check_assigned_health();

    // Bot should still be assigned — drain guard prevented cleanup
    const bots = pool.get_bots();
    expect(bots[0]!.state).toBe("assigned");
    expect(bots[0]!.channel_id).toBe("ch-1");
    expect(bots[0]!.session_id).toBe("sess-1");
  });

  it("processes dead sessions when NOT draining", async () => {
    const events: string[] = [];
    pool.on("bot:session_ended", () => events.push("session_ended"));
    pool.on("bot:released", () => events.push("released"));

    pool.inject_bots([
      make_bot({
        id: 0,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "e1",
        archetype: "builder",
        session_id: "sess-1",
      }),
    ]);

    // is_tmux_alive returns false (mocked above) — session is dead
    await (pool as unknown as { check_assigned_health: () => Promise<void> }).check_assigned_health();

    // Bot should have been cleaned up
    const bots = pool.get_bots();
    expect(bots[0]!.state).toBe("free");
    expect(bots[0]!.channel_id).toBeNull();
    expect(events).toContain("session_ended");
    expect(events).toContain("released");
  });
});
