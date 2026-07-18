import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { EntityConfig, LobsterFarmConfig } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MCP_GIVEUP_THRESHOLD,
  MCP_GRACE_PERIOD_MS,
  MCP_RECOVERY_COOLDOWN_MS,
} from "../mcp-health.js";
import { BotPool } from "../pool.js";
import type { PoolBot } from "../pool.js";
import type { EntityRegistry } from "../registry.js";

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
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

// Partially mock mcp-health.js: keep the pure state-machine functions real
// (already covered by mcp-health.test.ts) but replace the tmux/pgrep-driving
// functions with controllable mocks so these integration tests never touch
// real tmux sessions or real wall-clock waits.
vi.mock("../mcp-health.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../mcp-health.js")>();
  return {
    ...original,
    has_mcp_child: vi.fn().mockReturnValue(true),
    run_mcp_recovery_cycle: vi.fn().mockResolvedValue("reconnected"),
    wait_for_mcp_child: vi.fn().mockResolvedValue(true),
  };
});

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

function make_entity_config(entity_id: string, channel_ids: string[]): EntityConfig {
  return {
    entity: {
      id: entity_id,
      name: `Test ${entity_id}`,
      description: "",
      status: "active",
      repos: [],
      accounts: {},
      channels: {
        category_id: "",
        list: channel_ids.map((id) => ({ type: "general" as const, id })),
      },
      memory: { path: "/tmp/memory", auto_extract: true },
      secrets: { vault: "1password", vault_name: `entity-${entity_id}` },
    },
  };
}

function make_registry(entities: EntityConfig[]): EntityRegistry {
  const map = new Map<string, EntityConfig>();
  for (const e of entities) map.set(e.entity.id, e);
  return {
    get: (id: string) => map.get(id),
    get_all: () => [...map.values()],
    get_active: () => [...map.values()].filter((e) => e.entity.status === "active"),
    count: () => map.size,
  } as unknown as EntityRegistry;
}

/** Test subclass exposing internals; keeps JSONL/idle/confirmation stubbed
 * to their happy-path defaults (mirrors BotPoolTestBase) but leaves
 * check_mcp_health / verify_mcp_post_spawn wired to the real implementation
 * under test, driven by the mocked mcp-health.js functions above. */
class TestBotPool extends BotPool {
  private idle_overrides = new Map<number, boolean>();

  protected override check_session_jsonl_exists_anywhere(): Promise<boolean> {
    return Promise.resolve(true);
  }
  protected override check_session_jsonl_exists(): Promise<boolean> {
    return Promise.resolve(true);
  }
  protected override watch_session_confirmation(bot: PoolBot): void {
    bot.session_confirmed = true;
  }
  set_bot_idle(bot_id: number, idle: boolean): void {
    this.idle_overrides.set(bot_id, idle);
  }
  protected override is_bot_idle(bot: PoolBot): boolean {
    return this.idle_overrides.get(bot.id) ?? true;
  }

  inject_bots(bots: PoolBot[]): void {
    (this as unknown as { bots: PoolBot[] }).bots = bots;
  }
  get_bots(): PoolBot[] {
    return (this as unknown as { bots: PoolBot[] }).bots;
  }
  get_mcp_state(): Map<number, unknown> {
    return (this as unknown as { mcp_state: Map<number, unknown> }).mcp_state;
  }
  async run_check_mcp_health(bot: PoolBot): Promise<void> {
    await (this as unknown as { check_mcp_health(b: PoolBot): Promise<void> }).check_mcp_health(
      bot,
    );
  }
  async run_verify_mcp_post_spawn(bot: PoolBot): Promise<boolean> {
    return (
      this as unknown as { verify_mcp_post_spawn(b: PoolBot): Promise<boolean> }
    ).verify_mcp_post_spawn(bot);
  }
}

describe("check_mcp_health integration", () => {
  let config: LobsterFarmConfig;
  let pool: TestBotPool;
  let mock_notify: ReturnType<typeof vi.fn>;
  let mock_has_mcp_child: ReturnType<typeof vi.fn>;
  let mock_run_cycle: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    temp_dir = await mkdtemp(join(tmpdir(), "mcp-health-pool-test-"));
    config = make_config();
    pool = new TestBotPool(config);

    const actions = await import("../actions.js");
    mock_notify = actions.notify as unknown as ReturnType<typeof vi.fn>;
    mock_notify.mockClear();

    const mcp_health = await import("../mcp-health.js");
    mock_has_mcp_child = mcp_health.has_mcp_child as unknown as ReturnType<typeof vi.fn>;
    mock_run_cycle = mcp_health.run_mcp_recovery_cycle as unknown as ReturnType<typeof vi.fn>;
    mock_has_mcp_child.mockReturnValue(true);
    mock_run_cycle.mockReset().mockResolvedValue("reconnected");

    vi.spyOn(pool as unknown as Record<string, unknown>, "kill_tmux" as never).mockImplementation(
      () => {},
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(temp_dir, { recursive: true, force: true });
  });

  function old_bot(overrides: Partial<PoolBot> & { id: number }): PoolBot {
    return make_bot({
      state: "assigned",
      assigned_at: new Date(Date.now() - MCP_GRACE_PERIOD_MS - 1000),
      ...overrides,
    });
  }

  it("does nothing when the MCP child is present", async () => {
    mock_has_mcp_child.mockReturnValue(true);
    const bot = old_bot({ id: 1, entity_id: "e1", channel_id: "ch-1" });
    pool.inject_bots([bot]);

    await pool.run_check_mcp_health(bot);
    await pool.run_check_mcp_health(bot);

    expect(mock_run_cycle).not.toHaveBeenCalled();
  });

  it("does not act on a session younger than the grace period even if unhealthy", async () => {
    mock_has_mcp_child.mockReturnValue(false);
    const bot = make_bot({ id: 1, state: "assigned", assigned_at: new Date(), entity_id: "e1" });
    pool.inject_bots([bot]);

    await pool.run_check_mcp_health(bot);

    expect(mock_run_cycle).not.toHaveBeenCalled();
  });

  it("does not act on a single failed tick — requires consecutive fails", async () => {
    mock_has_mcp_child.mockReturnValue(false);
    const bot = old_bot({ id: 1, entity_id: "e1" });
    pool.inject_bots([bot]);

    await pool.run_check_mcp_health(bot);

    expect(mock_run_cycle).not.toHaveBeenCalled();
  });

  it("runs a recovery cycle once consecutive fails cross the threshold, while idle", async () => {
    mock_has_mcp_child.mockReturnValue(false);
    const bot = old_bot({ id: 1, entity_id: "e1", channel_id: "ch-1" });
    pool.inject_bots([bot]);
    pool.set_bot_idle(1, true);

    await pool.run_check_mcp_health(bot); // 1st fail — no action
    await pool.run_check_mcp_health(bot); // 2nd fail — fires

    expect(mock_run_cycle).toHaveBeenCalledTimes(1);
    expect(mock_run_cycle.mock.calls[0][0]).toBe("pool-1");
  });

  it("defers the recovery cycle while the bot is mid-turn (not idle)", async () => {
    mock_has_mcp_child.mockReturnValue(false);
    const bot = old_bot({ id: 1, entity_id: "e1" });
    pool.inject_bots([bot]);
    pool.set_bot_idle(1, false);

    await pool.run_check_mcp_health(bot);
    await pool.run_check_mcp_health(bot);
    await pool.run_check_mcp_health(bot);

    expect(mock_run_cycle).not.toHaveBeenCalled();
  });

  it("stays silent (no #alerts) on a routine reconnected outcome", async () => {
    mock_has_mcp_child.mockReturnValue(false);
    mock_run_cycle.mockResolvedValue("reconnected");
    const bot = old_bot({ id: 1, entity_id: "e1" });
    pool.inject_bots([bot]);

    await pool.run_check_mcp_health(bot);
    await pool.run_check_mcp_health(bot);

    expect(mock_notify).not.toHaveBeenCalled();
  });

  it("stays silent on a single fell_back outcome (below give-up threshold)", async () => {
    mock_has_mcp_child.mockReturnValue(false);
    mock_run_cycle.mockResolvedValue("fell_back");
    const bot = old_bot({ id: 1, entity_id: "e1" });
    pool.inject_bots([bot]);

    await pool.run_check_mcp_health(bot);
    await pool.run_check_mcp_health(bot);

    expect(mock_notify).not.toHaveBeenCalled();
    expect(bot.state).toBe("assigned"); // never released
  });

  it("gives up and alerts #alerts after MCP_GIVEUP_THRESHOLD failed cycles, without releasing the bot", async () => {
    mock_has_mcp_child.mockReturnValue(false);
    mock_run_cycle.mockResolvedValue("fell_back");
    const bot = old_bot({
      id: 1,
      entity_id: "test-entity",
      channel_id: "ch-1",
      archetype: "builder",
    });
    pool.inject_bots([bot]);
    const registry = make_registry([make_entity_config("test-entity", ["ch-1"])]);
    (pool as unknown as { registry: EntityRegistry }).registry = registry;

    let now = Date.now();
    const real_now = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    await pool.run_check_mcp_health(bot); // 1st fail
    for (let i = 0; i < MCP_GIVEUP_THRESHOLD; i++) {
      now += MCP_RECOVERY_COOLDOWN_MS + 1000;
      await pool.run_check_mcp_health(bot);
    }

    vi.spyOn(Date, "now").mockImplementation(real_now);

    expect(mock_run_cycle).toHaveBeenCalledTimes(MCP_GIVEUP_THRESHOLD);
    expect(mock_notify).toHaveBeenCalledTimes(1);
    const [channel_type, message] = mock_notify.mock.calls[0] as [string, string];
    expect(channel_type).toBe("alerts");
    expect(message).toContain("Pool bot 1");
    expect(message).toContain("NOT released");
    expect(bot.state).toBe("assigned"); // still never released
  });

  it("resets to a fresh anti-thrash slate once the bot is observed healthy again", async () => {
    mock_has_mcp_child.mockReturnValue(false);
    mock_run_cycle.mockResolvedValue("fell_back");
    const bot = old_bot({ id: 1, entity_id: "e1" });
    pool.inject_bots([bot]);

    await pool.run_check_mcp_health(bot);
    await pool.run_check_mcp_health(bot); // triggers a cycle, records a failure

    mock_has_mcp_child.mockReturnValue(true);
    await pool.run_check_mcp_health(bot); // healthy now

    // process_mcp_health_tick resets to a zeroed state object on a healthy
    // reading (not a deleted map entry — the entry only disappears once
    // prune_mcp_state removes it for a no-longer-assigned bot).
    const state = pool.get_mcp_state() as Map<
      number,
      { given_up: boolean; consecutive_fails: number }
    >;
    expect(state.get(1)).toMatchObject({ given_up: false, consecutive_fails: 0 });
  });
});

describe("verify_mcp_post_spawn integration", () => {
  let config: LobsterFarmConfig;
  let pool: TestBotPool;
  let mock_wait: ReturnType<typeof vi.fn>;
  let mock_run_cycle: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    temp_dir = await mkdtemp(join(tmpdir(), "mcp-postspawn-test-"));
    config = make_config();
    pool = new TestBotPool(config);

    const mcp_health = await import("../mcp-health.js");
    mock_wait = mcp_health.wait_for_mcp_child as unknown as ReturnType<typeof vi.fn>;
    mock_run_cycle = mcp_health.run_mcp_recovery_cycle as unknown as ReturnType<typeof vi.fn>;
    mock_wait.mockReset();
    mock_run_cycle.mockReset();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(temp_dir, { recursive: true, force: true });
  });

  it("returns true immediately when the MCP child appears within the grace wait", async () => {
    mock_wait.mockResolvedValue(true);
    const bot = make_bot({ id: 1 });

    const result = await pool.run_verify_mcp_post_spawn(bot);

    expect(result).toBe(true);
    expect(mock_run_cycle).not.toHaveBeenCalled();
  });

  it("falls through to a scripted reconnect when the grace wait times out, and succeeds", async () => {
    mock_wait.mockResolvedValue(false);
    mock_run_cycle.mockResolvedValue("reconnected");
    const bot = make_bot({ id: 1 });

    const result = await pool.run_verify_mcp_post_spawn(bot);

    expect(result).toBe(true);
    expect(mock_run_cycle).toHaveBeenCalledTimes(1);
    expect(mock_run_cycle.mock.calls[0][0]).toBe("pool-1");
  });

  it("returns false when both the grace wait and the reconnect attempt fail", async () => {
    mock_wait.mockResolvedValue(false);
    mock_run_cycle.mockResolvedValue("fell_back");
    const bot = make_bot({ id: 1 });

    const result = await pool.run_verify_mcp_post_spawn(bot);

    expect(result).toBe(false);
  });

  it("does not kill the bot's tmux as part of the post-spawn reconnect fallback", async () => {
    mock_wait.mockResolvedValue(false);
    // Simulate run_mcp_recovery_cycle's real contract: it invokes kill_fn on
    // exhaustion. verify_mcp_post_spawn must pass a no-op kill_fn (a bot that
    // was *just* spawned shouldn't be killed again by its own readiness check).
    mock_run_cycle.mockImplementation(async (_session: string, kill_fn: () => void) => {
      kill_fn();
      return "fell_back";
    });
    const kill_spy = vi
      .spyOn(pool as unknown as Record<string, unknown>, "kill_tmux" as never)
      .mockImplementation(() => {});
    const bot = make_bot({ id: 1 });

    await pool.run_verify_mcp_post_spawn(bot);

    expect(kill_spy).not.toHaveBeenCalled();
  });
});

describe("resume_parked_bots() boot stagger (issue #345)", () => {
  let config: LobsterFarmConfig;

  beforeEach(async () => {
    temp_dir = await mkdtemp(join(tmpdir(), "mcp-boot-stagger-test-"));
    config = make_config();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(temp_dir, { recursive: true, force: true });
  });

  class StaggerTestPool extends BotPool {
    protected override check_session_jsonl_exists_anywhere(): Promise<boolean> {
      return Promise.resolve(true);
    }
    protected override check_session_jsonl_exists(): Promise<boolean> {
      return Promise.resolve(true);
    }
    protected override watch_session_confirmation(): void {
      /* no-op */
    }

    /** Records the interleaving of start_tmux vs verify_mcp_post_spawn calls
     * so tests can assert strict serialization (each verify completes before
     * the next start_tmux begins). */
    call_log: string[] = [];
    /** bot_id → simulated verification delay in ms. Bots with no entry
     * resolve immediately. */
    verify_delay_ms = new Map<number, number>();

    protected override async start_tmux(bot: PoolBot): Promise<void> {
      this.call_log.push(`start_tmux:${String(bot.id)}`);
    }

    protected override async verify_mcp_post_spawn(bot: PoolBot): Promise<boolean> {
      this.call_log.push(`verify_start:${String(bot.id)}`);
      const delay = this.verify_delay_ms.get(bot.id) ?? 0;
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      this.call_log.push(`verify_end:${String(bot.id)}`);
      return true;
    }

    set_resume_candidates(
      candidates: Array<{
        id: number;
        channel_id: string;
        entity_id: string;
        archetype: "builder" | "planner";
        session_id: string;
      }>,
    ): void {
      (
        this as unknown as {
          resume_candidates: Array<Record<string, unknown>>;
        }
      ).resume_candidates = candidates.map((c) => ({
        ...c,
        state: "assigned",
        channel_type: null,
        last_active: null,
      }));
    }

    inject_bot(bot: PoolBot): void {
      (this as unknown as { bots: PoolBot[] }).bots.push(bot);
    }

    /** Shrunk to a few ms so the cap test doesn't need real 45s waits or the
     * fake-timers/real-fs-IO interleaving hazard that comes with mixing
     * vi.useFakeTimers() and resume_parked_bots()'s real filesystem writes. */
    protected override boot_stagger_cap_ms(): number {
      return 20;
    }
  }

  async function setup(bot_ids: number[]): Promise<StaggerTestPool> {
    const p = new StaggerTestPool(config);
    for (const id of bot_ids) {
      // channel_id must match the corresponding resume candidate — the real
      // resume_parked_bots() only matches a candidate to a bot with the same
      // id AND channel_id (see pool.ts's `this.bots.find(...)`).
      p.inject_bot(make_bot({ id, state: "parked", channel_id: `ch-${String(id)}` }));
    }
    vi.spyOn(
      p as unknown as Record<string, unknown>,
      "write_access_json" as never,
    ).mockResolvedValue(undefined);
    vi.spyOn(
      p as unknown as Record<string, unknown>,
      "set_bot_nickname" as never,
    ).mockResolvedValue(undefined);
    vi.spyOn(p as unknown as Record<string, unknown>, "set_bot_avatar" as never).mockResolvedValue(
      undefined,
    );
    vi.spyOn(p as unknown as Record<string, unknown>, "kill_tmux" as never).mockImplementation(
      () => {},
    );
    vi.spyOn(p as unknown as Record<string, unknown>, "persist" as never).mockResolvedValue(
      undefined,
    );
    return p;
  }

  it("gates each resume's start_tmux on the previous candidate's MCP verification completing first", async () => {
    const p = await setup([1, 2, 3]);
    p.set_resume_candidates([
      { id: 1, channel_id: "ch-1", entity_id: "e1", archetype: "builder", session_id: "s1" },
      { id: 2, channel_id: "ch-2", entity_id: "e2", archetype: "builder", session_id: "s2" },
      { id: 3, channel_id: "ch-3", entity_id: "e3", archetype: "builder", session_id: "s3" },
    ]);

    await p.resume_parked_bots();

    // Each candidate's verify must fully complete (verify_end) before the
    // next candidate's start_tmux begins — this is what "serializes cold
    // starts" means structurally.
    const start_indices = [1, 2, 3].map((id) => p.call_log.indexOf(`start_tmux:${String(id)}`));
    const verify_end_indices = [1, 2, 3].map((id) =>
      p.call_log.indexOf(`verify_end:${String(id)}`),
    );

    expect(start_indices[1]).toBeGreaterThan(verify_end_indices[0]!);
    expect(start_indices[2]).toBeGreaterThan(verify_end_indices[1]!);
  });

  it("caps a stuck candidate's verification so it doesn't stall the whole queue", async () => {
    const p = await setup([1, 2]);
    p.set_resume_candidates([
      { id: 1, channel_id: "ch-1", entity_id: "e1", archetype: "builder", session_id: "s1" },
      { id: 2, channel_id: "ch-2", entity_id: "e2", archetype: "builder", session_id: "s2" },
    ]);
    // Bot 1's verification never resolves within the (shrunk) cap — only
    // the cap inside resume_parked_bots() can unblock the queue. Bot 2
    // resolves immediately, so it's the queue-progress signal.
    p.verify_delay_ms.set(1, 10_000);

    await p.resume_parked_bots();

    expect(p.call_log).toContain("start_tmux:2");
    const bots = (p as unknown as { bots: PoolBot[] }).bots;
    expect(bots.find((b) => b.id === 2)!.state).toBe("assigned");
  });
});
