/**
 * Tests for the ECONNRESET / API-wedge recovery module (issue #337).
 *
 * Tests are organized into:
 *   1. Pure detection (detect_api_wedge)
 *   2. Tick state machine (process_wedge_tick)
 *   3. Scanner (scan_for_wedged_bots)
 *   4. Pool integration (check_api_wedges via TestBotPool subclass)
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ESCALATE_THRESHOLD,
  ESCALATE_WINDOW_MS,
  RECYCLE_COOLDOWN_MS,
  WEDGE_MIN_CHECKS,
  WEDGE_MIN_MINUTES,
  detect_api_wedge,
  process_wedge_tick,
  type scan_for_wedged_bots,
} from "../econnreset-recovery.js";
import type { RecycleRecord, WedgeObservation } from "../econnreset-recovery.js";
import type { PoolBot } from "../pool.js";
import { BotPoolTestBase } from "./helpers/test-bot-pool-base.js";

// ── Module mocks ──

vi.mock("../actions.js", () => ({
  notify: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../persistence.js", () => ({
  save_pool_state: vi.fn().mockResolvedValue(undefined),
  load_pool_state: vi.fn().mockResolvedValue({
    bots: [],
    session_history: {},
    avatar_state: {},
  }),
}));

vi.mock("../sentry.js", () => ({
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

// Mock econnreset-recovery so pool integration tests can inject scan results
vi.mock("../econnreset-recovery.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../econnreset-recovery.js")>();
  return {
    ...original,
    // Keep all constants and pure functions from the original
    scan_for_wedged_bots: vi.fn().mockReturnValue([]),
    prune_wedge_state: vi.fn(),
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
    last_active: new Date("2026-06-23T10:00:00Z"),
    assigned_at: new Date("2026-06-23T09:00:00Z"),
    state_dir: `/tmp/test-pool-${String(overrides.id)}`,
    model: null,
    effort: null,
    last_avatar_archetype: null,
    last_avatar_set_at: null,
    ...overrides,
  };
}

// ── 1. Pure detection ──

describe("detect_api_wedge", () => {
  it("detects 'API Error: Unable to connect' (case-insensitive)", () => {
    expect(detect_api_wedge("API Error: Unable to connect to API")).toBe(true);
    expect(detect_api_wedge("api error: unable to connect to api")).toBe(true);
    expect(detect_api_wedge("API ERROR: UNABLE TO CONNECT")).toBe(true);
  });

  it("detects ECONNRESET", () => {
    expect(detect_api_wedge("Error: ECONNRESET")).toBe(true);
    expect(detect_api_wedge("socket hang up (ECONNRESET)")).toBe(true);
  });

  it("detects 'attempt N/10' retry indicator", () => {
    expect(detect_api_wedge("✻ API error · Retrying in 10s · attempt 3/10")).toBe(true);
    expect(detect_api_wedge("attempt 1/10")).toBe(true);
    expect(detect_api_wedge("Attempt 9/10")).toBe(true);
  });

  it("returns false for normal working output", () => {
    expect(detect_api_wedge("Reading file: /src/pool.ts")).toBe(false);
    expect(detect_api_wedge("esc to interrupt")).toBe(false);
    expect(detect_api_wedge("❯")).toBe(false);
    expect(detect_api_wedge("")).toBe(false);
  });

  it("returns false for rate-limit modal (different failure mode)", () => {
    expect(detect_api_wedge("Switch to extra usage\nEsc to cancel")).toBe(false);
    expect(detect_api_wedge("You've exceeded your usage limit.")).toBe(false);
  });

  it("returns false when only 'attempt' without /10 suffix", () => {
    // Don't false-positive on unrelated "attempt" mentions
    expect(detect_api_wedge("First attempt succeeded")).toBe(false);
    expect(detect_api_wedge("attempt to fix the bug")).toBe(false);
  });
});

// ── 2. Tick state machine ──

describe("process_wedge_tick", () => {
  const BASE_TIME = new Date("2026-06-23T10:00:00Z").getTime();
  const WEDGE_OUTPUT = "API Error: Unable to connect to API";
  const CLEAN_OUTPUT = "❯ ";

  function fresh_maps(): {
    obs: Map<number, WedgeObservation>;
    rec: Map<number, RecycleRecord>;
  } {
    return {
      obs: new Map(),
      rec: new Map(),
    };
  }

  it("returns none on clean pane", () => {
    const { obs, rec } = fresh_maps();
    const bot = make_bot({ id: 1, state: "assigned" });
    const result = process_wedge_tick(bot, CLEAN_OUTPUT, BASE_TIME, obs, rec);
    expect(result.action).toBe("none");
    expect(obs.size).toBe(0);
  });

  it("returns none when pane is null (unreadable)", () => {
    const { obs, rec } = fresh_maps();
    const bot = make_bot({ id: 1, state: "assigned" });
    // Seed an observation first
    obs.set(1, {
      first_seen_ms: BASE_TIME - 5 * 60_000,
      last_seen_ms: BASE_TIME - 30_000,
      check_count: 2,
      last_active_at_first_seen: bot.last_active?.toISOString() ?? null,
    });
    const result = process_wedge_tick(bot, null, BASE_TIME, obs, rec);
    expect(result.action).toBe("none");
    // Observation cleared since pane is unreadable
    expect(obs.has(1)).toBe(false);
  });

  it("starts observation on first wedge tick", () => {
    const { obs, rec } = fresh_maps();
    const bot = make_bot({ id: 1, state: "assigned" });
    const result = process_wedge_tick(bot, WEDGE_OUTPUT, BASE_TIME, obs, rec);
    expect(result.action).toBe("none");
    expect(obs.has(1)).toBe(true);
    expect(obs.get(1)!.check_count).toBe(1);
    expect(obs.get(1)!.first_seen_ms).toBe(BASE_TIME);
  });

  it("clears observation when last_active advances (bot recovered)", () => {
    const { obs, rec } = fresh_maps();
    const bot = make_bot({
      id: 1,
      state: "assigned",
      last_active: new Date("2026-06-23T10:05:00Z"), // advanced
    });
    obs.set(1, {
      first_seen_ms: BASE_TIME,
      last_seen_ms: BASE_TIME,
      check_count: 2,
      last_active_at_first_seen: "2026-06-23T10:00:00.000Z", // old value
    });
    const result = process_wedge_tick(bot, WEDGE_OUTPUT, BASE_TIME + 4 * 60_000, obs, rec);
    expect(result.action).toBe("none");
    expect(obs.has(1)).toBe(false); // cleared — bot recovered
  });

  it("does NOT act before WEDGE_MIN_CHECKS is met (0 prior checks, 1 after this tick)", () => {
    const { obs, rec } = fresh_maps();
    const bot = make_bot({ id: 1, state: "assigned" });
    // No prior observation — first tick starts window with check_count=1
    // WEDGE_MIN_CHECKS=2, so we need at least one more tick before acting
    const result = process_wedge_tick(bot, WEDGE_OUTPUT, BASE_TIME, obs, rec);
    expect(result.action).toBe("none");
    // check_count is 1 after this first tick
    expect(obs.get(1)!.check_count).toBe(1);
  });

  it("does NOT act before WEDGE_MIN_MINUTES has elapsed (time threshold not met)", () => {
    const { obs, rec } = fresh_maps();
    const bot = make_bot({ id: 1, state: "assigned" });
    // Seed: 2+ checks, but only 1 minute elapsed (below WEDGE_MIN_MINUTES=3)
    obs.set(1, {
      first_seen_ms: BASE_TIME - 1 * 60_000,
      last_seen_ms: BASE_TIME - 30_000,
      check_count: WEDGE_MIN_CHECKS - 1,
      last_active_at_first_seen: bot.last_active?.toISOString() ?? null,
    });
    const result = process_wedge_tick(bot, WEDGE_OUTPUT, BASE_TIME, obs, rec);
    expect(result.action).toBe("none");
  });

  it("returns recycle when both thresholds met and no recycle cooldown active", () => {
    const { obs, rec } = fresh_maps();
    const bot = make_bot({ id: 1, state: "assigned" });
    const elapsed_ms = (WEDGE_MIN_MINUTES + 1) * 60_000;
    obs.set(1, {
      first_seen_ms: BASE_TIME - elapsed_ms,
      last_seen_ms: BASE_TIME - 30_000,
      check_count: WEDGE_MIN_CHECKS - 1, // will become WEDGE_MIN_CHECKS on this tick
      last_active_at_first_seen: bot.last_active?.toISOString() ?? null,
    });
    const result = process_wedge_tick(bot, WEDGE_OUTPUT, BASE_TIME, obs, rec);
    expect(result.action).toBe("recycle");
    // Observation cleared after recycle
    expect(obs.has(1)).toBe(false);
    // Recycle recorded
    expect(rec.get(1)!.timestamps).toHaveLength(1);
  });

  it("returns none when within recycle cooldown window", () => {
    const { obs, rec } = fresh_maps();
    const bot = make_bot({ id: 1, state: "assigned" });
    const elapsed_ms = (WEDGE_MIN_MINUTES + 1) * 60_000;
    obs.set(1, {
      first_seen_ms: BASE_TIME - elapsed_ms,
      last_seen_ms: BASE_TIME - 30_000,
      check_count: WEDGE_MIN_CHECKS - 1,
      last_active_at_first_seen: bot.last_active?.toISOString() ?? null,
    });
    // A recent recycle (2 min ago — within 10 min cooldown)
    rec.set(1, { timestamps: [BASE_TIME - 2 * 60_000] });

    const result = process_wedge_tick(bot, WEDGE_OUTPUT, BASE_TIME, obs, rec);
    expect(result.action).toBe("none");
  });

  it("returns escalate when recycle count >= ESCALATE_THRESHOLD in window", () => {
    const { obs, rec } = fresh_maps();
    const bot = make_bot({ id: 1, state: "assigned" });
    const elapsed_ms = (WEDGE_MIN_MINUTES + 1) * 60_000;
    obs.set(1, {
      first_seen_ms: BASE_TIME - elapsed_ms,
      last_seen_ms: BASE_TIME - 30_000,
      check_count: WEDGE_MIN_CHECKS - 1,
      last_active_at_first_seen: bot.last_active?.toISOString() ?? null,
    });
    // ESCALATE_THRESHOLD recycles within the window, all cooldown-expired
    const recycle_times = Array.from(
      { length: ESCALATE_THRESHOLD },
      (_, i) => BASE_TIME - ESCALATE_WINDOW_MS / 2 + i * RECYCLE_COOLDOWN_MS,
    );
    rec.set(1, { timestamps: recycle_times });

    const result = process_wedge_tick(bot, WEDGE_OUTPUT, BASE_TIME, obs, rec);
    expect(result.action).toBe("escalate");
    if (result.action === "escalate") {
      expect(result.recycle_count).toBe(ESCALATE_THRESHOLD);
    }
  });

  it("does not escalate when recycles are outside the 30 min window", () => {
    const { obs, rec } = fresh_maps();
    const bot = make_bot({ id: 1, state: "assigned" });
    const elapsed_ms = (WEDGE_MIN_MINUTES + 1) * 60_000;
    obs.set(1, {
      first_seen_ms: BASE_TIME - elapsed_ms,
      last_seen_ms: BASE_TIME - 30_000,
      check_count: WEDGE_MIN_CHECKS - 1,
      last_active_at_first_seen: bot.last_active?.toISOString() ?? null,
    });
    // ESCALATE_THRESHOLD recycles all older than 30 min (outside window)
    const old_recycles = Array.from(
      { length: ESCALATE_THRESHOLD },
      (_, i) => BASE_TIME - ESCALATE_WINDOW_MS - (i + 1) * 60_000,
    );
    rec.set(1, { timestamps: old_recycles });

    const result = process_wedge_tick(bot, WEDGE_OUTPUT, BASE_TIME, obs, rec);
    // Stale recycles pruned → below threshold → should recycle
    expect(result.action).toBe("recycle");
  });

  it("single transient retry that recovers does NOT trigger recycle", () => {
    const { obs, rec } = fresh_maps();
    const bot_v1 = make_bot({ id: 1, state: "assigned" });

    // Tick 1: wedge seen → start observation
    process_wedge_tick(bot_v1, WEDGE_OUTPUT, BASE_TIME, obs, rec);
    expect(obs.has(1)).toBe(true);

    // Tick 2: bot recovered (last_active advanced) → clear observation
    const bot_v2 = make_bot({
      id: 1,
      state: "assigned",
      last_active: new Date(BASE_TIME + 5_000), // advanced
    });
    const result = process_wedge_tick(bot_v2, WEDGE_OUTPUT, BASE_TIME + 30_000, obs, rec);
    expect(result.action).toBe("none");
    expect(obs.has(1)).toBe(false);

    // No recycle recorded
    expect(rec.has(1)).toBe(false);
  });
});

// ── 3. Scanner ──

describe("scan_for_wedged_bots", () => {
  // Use the REAL scan_for_wedged_bots, not the mock used by pool integration tests
  let real_scan: typeof scan_for_wedged_bots;

  beforeEach(async () => {
    const original = await vi.importActual<typeof import("../econnreset-recovery.js")>(
      "../econnreset-recovery.js",
    );
    real_scan = original.scan_for_wedged_bots;
  });

  it("skips non-assigned bots", () => {
    const obs = new Map<number, WedgeObservation>();
    const rec = new Map<number, RecycleRecord>();
    const bot = make_bot({ id: 1, state: "parked" });
    const mock_capture = vi.fn().mockReturnValue("ECONNRESET");

    const results = real_scan([bot], obs, rec, mock_capture);

    expect(results).toHaveLength(0);
    expect(mock_capture).not.toHaveBeenCalled();
  });

  it("accumulates observations across calls without acting prematurely", () => {
    const obs = new Map<number, WedgeObservation>();
    const rec = new Map<number, RecycleRecord>();
    const bot = make_bot({ id: 1, state: "assigned" });
    const mock_capture = vi.fn().mockReturnValue("API Error: Unable to connect to API");
    const base = Date.now();

    // First tick — starts observation, no action
    const r1 = real_scan([bot], obs, rec, mock_capture, base);
    expect(r1).toHaveLength(0);
    expect(obs.has(1)).toBe(true);

    // Second tick 1 minute later — time threshold not met (need 3 min)
    const r2 = real_scan([bot], obs, rec, mock_capture, base + 60_000);
    expect(r2).toHaveLength(0);
  });

  it("returns recycle action when both thresholds are met", () => {
    const obs = new Map<number, WedgeObservation>();
    const rec = new Map<number, RecycleRecord>();
    const bot = make_bot({ id: 1, state: "assigned" });
    const mock_capture = vi.fn().mockReturnValue("ECONNRESET");
    const base = Date.now();

    // Tick 1
    real_scan([bot], obs, rec, mock_capture, base);
    // Tick 2 after 4 minutes
    const results = real_scan([bot], obs, rec, mock_capture, base + 4 * 60_000);

    expect(results).toHaveLength(1);
    expect(results[0].tick.action).toBe("recycle");
    expect(results[0].bot.id).toBe(1);
  });

  it("returns escalate action when recycle threshold exceeded", () => {
    const obs = new Map<number, WedgeObservation>();
    const rec = new Map<number, RecycleRecord>();
    const bot = make_bot({ id: 1, state: "assigned" });
    const mock_capture = vi.fn().mockReturnValue("ECONNRESET");
    const base = Date.now();

    // Pre-seed ESCALATE_THRESHOLD recycles in window, all past cooldown
    rec.set(1, {
      timestamps: Array.from(
        { length: ESCALATE_THRESHOLD },
        (_, i) => base - ESCALATE_WINDOW_MS / 2 + i * RECYCLE_COOLDOWN_MS,
      ),
    });

    // Establish wedge observation
    real_scan([bot], obs, rec, mock_capture, base);
    // Trigger after enough time
    const results = real_scan([bot], obs, rec, mock_capture, base + 4 * 60_000);

    expect(results).toHaveLength(1);
    expect(results[0].tick.action).toBe("escalate");
  });
});

// ── 4. Pool integration (check_api_wedges) ──

class TestBotPool extends BotPoolTestBase {
  inject_bots(bots: PoolBot[]): void {
    (this as unknown as { bots: PoolBot[] }).bots = bots;
  }

  get_bots(): PoolBot[] {
    return (this as unknown as { bots: PoolBot[] }).bots;
  }

  /** Expose check_api_wedges for direct invocation in tests. */
  async run_wedge_check(): Promise<void> {
    await this.check_api_wedges();
  }

  /** Override is_bot_idle — not relevant for wedge tests. */
  protected override is_bot_idle(): boolean {
    return true;
  }
}

describe("pool API-wedge integration (check_api_wedges)", () => {
  let config: LobsterFarmConfig;
  let pool: TestBotPool;
  let mock_notify: ReturnType<typeof vi.fn>;
  let mock_scan: ReturnType<typeof vi.fn>;
  let mock_kill_tmux: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    temp_dir = await mkdtemp(join(tmpdir(), "wedge-test-"));
    config = make_config();
    pool = new TestBotPool(config);

    const actions = await import("../actions.js");
    mock_notify = actions.notify as unknown as ReturnType<typeof vi.fn>;
    mock_notify.mockClear();

    const recovery = await import("../econnreset-recovery.js");
    mock_scan = recovery.scan_for_wedged_bots as unknown as ReturnType<typeof vi.fn>;
    mock_scan.mockClear();

    mock_kill_tmux = vi
      .spyOn(pool as unknown as Record<string, unknown>, "kill_tmux" as never)
      .mockImplementation(() => {}) as unknown as ReturnType<typeof vi.fn>;

    vi.spyOn(
      pool as unknown as Record<string, unknown>,
      "write_access_json" as never,
    ).mockResolvedValue(undefined);
  });

  afterEach(async () => {
    pool.stop_wedge_monitor();
    vi.restoreAllMocks();
    await rm(temp_dir, { recursive: true, force: true });
  });

  it("skips scan when draining", async () => {
    pool.drain();
    pool.inject_bots([make_bot({ id: 1, state: "assigned", entity_id: "e1", channel_id: "ch-1" })]);

    await pool.run_wedge_check();

    expect(mock_scan).not.toHaveBeenCalled();
  });

  it("skips scan when no assigned bots", async () => {
    pool.inject_bots([make_bot({ id: 1, state: "free" })]);

    await pool.run_wedge_check();

    expect(mock_scan).not.toHaveBeenCalled();
  });

  it("passes only assigned bots to scanner", async () => {
    pool.inject_bots([
      make_bot({ id: 1, state: "assigned", entity_id: "e1", channel_id: "ch-1" }),
      make_bot({ id: 2, state: "free" }),
      make_bot({ id: 3, state: "assigned", entity_id: "e2", channel_id: "ch-2" }),
    ]);
    mock_scan.mockReturnValue([]);

    await pool.run_wedge_check();

    expect(mock_scan).toHaveBeenCalledTimes(1);
    const passed_bots = mock_scan.mock.calls[0][0] as PoolBot[];
    expect(passed_bots).toHaveLength(2);
    expect(passed_bots.map((b) => b.id)).toEqual([1, 3]);
  });

  it("kills tmux session and posts alert when bot is wedge-confirmed (recycle action)", async () => {
    const bot = make_bot({
      id: 1,
      state: "assigned",
      entity_id: "test-entity",
      channel_id: "ch-1",
      archetype: "planner",
    });
    pool.inject_bots([bot]);

    mock_scan.mockReturnValue([
      {
        bot,
        tick: { action: "recycle", reason: "wedge_confirmed" },
      },
    ]);

    await pool.run_wedge_check();

    // Tmux killed so crash-recovery can respawn
    expect(mock_kill_tmux).toHaveBeenCalledWith("pool-1");

    // Alert posted
    expect(mock_notify).toHaveBeenCalledTimes(1);
    const [channel_type, message] = mock_notify.mock.calls[0] as [string, string];
    expect(channel_type).toBe("alerts");
    expect(message).toContain("Pool bot 1");
    expect(message).toContain("planner");
    expect(message).toContain("wedged on API retries");
    expect(message).toContain("auto-recycled");
    expect(message).toContain("test-entity");
  });

  it("does NOT kill tmux when action is escalate — posts escalation alert instead", async () => {
    const bot = make_bot({
      id: 2,
      state: "assigned",
      entity_id: "test-entity",
      channel_id: "ch-2",
      archetype: "builder",
    });
    pool.inject_bots([bot]);

    mock_scan.mockReturnValue([
      {
        bot,
        tick: { action: "escalate", reason: "too_many_recycles", recycle_count: 3 },
      },
    ]);

    await pool.run_wedge_check();

    expect(mock_kill_tmux).not.toHaveBeenCalled();

    expect(mock_notify).toHaveBeenCalledTimes(1);
    const [channel_type, message] = mock_notify.mock.calls[0] as [string, string];
    expect(channel_type).toBe("alerts");
    expect(message).toContain("3x in 30 min");
    expect(message).toContain("auto-recycle suspended");
  });

  it("tolerates notify failure without crashing on recycle path", async () => {
    const bot = make_bot({
      id: 1,
      state: "assigned",
      entity_id: "e1",
      channel_id: "ch-1",
      archetype: "planner",
    });
    pool.inject_bots([bot]);
    mock_scan.mockReturnValue([{ bot, tick: { action: "recycle", reason: "wedge_confirmed" } }]);
    mock_notify.mockRejectedValue(new Error("Discord down"));

    // Should not throw — notify failure is non-fatal
    await expect(pool.run_wedge_check()).resolves.toBeUndefined();
    expect(mock_kill_tmux).toHaveBeenCalledWith("pool-1");
  });

  it("tolerates notify failure without crashing on escalate path", async () => {
    const bot = make_bot({
      id: 1,
      state: "assigned",
      entity_id: "e1",
      channel_id: "ch-1",
      archetype: "planner",
    });
    pool.inject_bots([bot]);
    mock_scan.mockReturnValue([
      { bot, tick: { action: "escalate", reason: "too_many_recycles", recycle_count: 4 } },
    ]);
    mock_notify.mockRejectedValue(new Error("Discord down"));

    await expect(pool.run_wedge_check()).resolves.toBeUndefined();
    expect(mock_kill_tmux).not.toHaveBeenCalled();
  });

  it("processes multiple bots in one scan — recycles each wedged bot", async () => {
    const bots = [
      make_bot({
        id: 1,
        state: "assigned",
        entity_id: "e1",
        channel_id: "ch-1",
        archetype: "planner",
      }),
      make_bot({
        id: 2,
        state: "assigned",
        entity_id: "e2",
        channel_id: "ch-2",
        archetype: "builder",
      }),
    ];
    pool.inject_bots(bots);

    mock_scan.mockReturnValue([
      { bot: bots[0], tick: { action: "recycle", reason: "wedge_confirmed" } },
      { bot: bots[1], tick: { action: "recycle", reason: "wedge_confirmed" } },
    ]);

    await pool.run_wedge_check();

    expect(mock_kill_tmux).toHaveBeenCalledTimes(2);
    expect(mock_kill_tmux).toHaveBeenCalledWith("pool-1");
    expect(mock_kill_tmux).toHaveBeenCalledWith("pool-2");
    expect(mock_notify).toHaveBeenCalledTimes(2);
  });

  it("start_health_monitor also starts wedge monitor", () => {
    const spy = vi.spyOn(pool, "start_wedge_monitor");
    pool.start_health_monitor();
    expect(spy).toHaveBeenCalledTimes(1);
    pool.stop_health_monitor();
  });

  it("stop_health_monitor also stops wedge monitor", () => {
    const spy = vi.spyOn(pool, "stop_wedge_monitor");
    pool.start_health_monitor();
    pool.stop_health_monitor();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("alert includes entity/channel-purpose label from registry", async () => {
    const bot = make_bot({
      id: 5,
      state: "assigned",
      channel_id: "ch-work-123",
      entity_id: "canal-street",
      archetype: "planner",
    });
    pool.inject_bots([bot]);

    // Inject a fake registry with channel purpose
    const fake_registry = {
      get: (eid: string) =>
        eid === "canal-street"
          ? {
              entity: {
                id: "canal-street",
                channels: {
                  category_id: "",
                  list: [{ type: "work_room", id: "ch-work-123", purpose: "onboarding" }],
                },
                secrets: {},
                repos: [{ path: "/tmp/test" }],
              },
            }
          : undefined,
    };
    (pool as unknown as { registry: unknown }).registry = fake_registry;

    mock_scan.mockReturnValue([{ bot, tick: { action: "recycle", reason: "wedge_confirmed" } }]);

    await pool.run_wedge_check();

    const [, message] = mock_notify.mock.calls[0] as [string, string];
    expect(message).toContain("canal-street/onboarding");
  });
});
