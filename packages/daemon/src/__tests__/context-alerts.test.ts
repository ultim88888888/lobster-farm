import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AlertPayload } from "../alert-router.js";
import {
  CONTEXT_ALERT_STATE_TTL_MS,
  CONTEXT_ALERT_THRESHOLDS,
  CONTEXT_SWEEP_INTERVAL_MS,
  type ContextSweepBot,
  type ContextSweepDeps,
  context_bots_from_pool,
  evaluate_thresholds,
  sweep_context_thresholds,
} from "../context-alerts.js";
import { load_context_alerts, save_context_alerts } from "../persistence.js";
import type { ContextAlertState } from "../persistence.js";
import type { PoolBot } from "../pool.js";
import type { ContextUsage } from "../tmux-query.js";

// ── Helpers ──

const T200 = 200_000;
const T500 = 500_000;
const T800 = 800_000;

function make_config(lf_dir: string): LobsterFarmConfig {
  return {
    paths: { lobsterfarm_dir: lf_dir, projects_dir: "/tmp", claude_dir: "/tmp" },
  } as LobsterFarmConfig;
}

/** Build a ContextUsage as `query_context_usage` would return it. */
function usage(used_tokens: number): ContextUsage {
  const total = 1_000_000;
  const percent = Math.round((used_tokens / total) * 1000) / 10;
  return {
    summary: `${String(Math.round(used_tokens / 1000))}k / 1m (${String(percent)}%)`,
    used_tokens,
    total_tokens: total,
    percent,
  };
}

function make_bot(overrides: Partial<ContextSweepBot> = {}): ContextSweepBot {
  return {
    bot_id: 3,
    session_id: "session-aaa",
    entity_id: "acme",
    channel_id: "chan-1",
    tmux_session: "pool-3",
    ...overrides,
  };
}

/**
 * A test harness that drives `sweep_context_thresholds` over a scripted
 * sequence of readings, capturing every alert that was posted.
 *
 * `state_store` is a mutable in-memory stand-in for the on-disk state file, so
 * a "restart" can be simulated by building a fresh harness over the same store.
 */
interface Harness {
  deps: ContextSweepDeps;
  alerts: AlertPayload[];
  /** Set the reading that the next sweep will observe for a tmux session. */
  set_reading(tmux_session: string, reading: ContextUsage | null | Error): void;
  set_bots(bots: ContextSweepBot[]): void;
  sweep(): Promise<void>;
}

function make_harness(options: {
  bots?: ContextSweepBot[];
  state?: { current: ContextAlertState };
  now?: () => Date;
}): Harness {
  const alerts: AlertPayload[] = [];
  const readings = new Map<string, ContextUsage | null | Error>();
  const store = options.state ?? { current: {} };
  let bots = options.bots ?? [make_bot()];

  const deps: ContextSweepDeps = {
    list_bots: () => bots,
    query_usage: (tmux_session: string) => {
      const reading = readings.get(tmux_session);
      if (reading instanceof Error) return Promise.reject(reading);
      return Promise.resolve(reading ?? null);
    },
    post_alert: (payload: AlertPayload) => {
      alerts.push(payload);
      return Promise.resolve({ message_id: null });
    },
    load_state: () => Promise.resolve(structuredClone(store.current)),
    save_state: (next: ContextAlertState) => {
      store.current = structuredClone(next);
      return Promise.resolve();
    },
    now: options.now,
  };

  return {
    deps,
    alerts,
    set_reading: (tmux_session, reading) => readings.set(tmux_session, reading),
    set_bots: (next) => {
      bots = next;
    },
    sweep: () => sweep_context_thresholds(deps),
  };
}

/** Sweep once with a single bot reporting `used` tokens. */
async function sweep_at(h: Harness, used: number, tmux_session = "pool-3"): Promise<void> {
  h.set_reading(tmux_session, usage(used));
  await h.sweep();
}

// ── Thresholds constant ──

describe("CONTEXT_ALERT_THRESHOLDS", () => {
  it("declares 200k / 500k / 800k in ascending order", () => {
    expect(CONTEXT_ALERT_THRESHOLDS.map((t) => t.tokens)).toEqual([T200, T500, T800]);
  });

  it("gives every threshold a human label and an alert tier", () => {
    for (const t of CONTEXT_ALERT_THRESHOLDS) {
      expect(t.label).toBeTruthy();
      expect(t.tier).toBeTruthy();
    }
  });

  it("sweeps every 15 minutes", () => {
    expect(CONTEXT_SWEEP_INTERVAL_MS).toBe(15 * 60 * 1000);
  });
});

// ── evaluate_thresholds (pure hysteresis core) ──

describe("evaluate_thresholds", () => {
  it("reports no crossing below the lowest threshold", () => {
    const result = evaluate_thresholds(199_999, []);
    expect(result.crossed).toEqual([]);
    expect(result.fired).toEqual([]);
  });

  it("fires on the upward crossing of a threshold", () => {
    const result = evaluate_thresholds(T200, []);
    expect(result.crossed.map((t) => t.tokens)).toEqual([T200]);
    expect(result.fired).toEqual([T200]);
  });

  it("does not re-fire a threshold that is still breached", () => {
    const result = evaluate_thresholds(350_000, [T200]);
    expect(result.crossed).toEqual([]);
    expect(result.fired).toEqual([T200]);
  });

  it("re-arms a threshold once usage drops back below it", () => {
    const result = evaluate_thresholds(150_000, [T200]);
    expect(result.crossed).toEqual([]);
    expect(result.fired).toEqual([]);
  });

  it("fires again after a re-arm", () => {
    const rearmed = evaluate_thresholds(150_000, [T200]);
    const recrossed = evaluate_thresholds(210_000, rearmed.fired);
    expect(recrossed.crossed.map((t) => t.tokens)).toEqual([T200]);
  });

  it("reports every threshold crossed when usage jumps past several at once", () => {
    const result = evaluate_thresholds(600_000, []);
    expect(result.crossed.map((t) => t.tokens)).toEqual([T200, T500]);
    expect(result.fired).toEqual([T200, T500]);
  });

  it("re-arms only the thresholds usage actually fell below", () => {
    const result = evaluate_thresholds(300_000, [T200, T500]);
    expect(result.crossed).toEqual([]);
    expect(result.fired).toEqual([T200]);
  });

  it("treats an exact threshold value as a breach", () => {
    expect(evaluate_thresholds(T800, [T200, T500]).crossed.map((t) => t.tokens)).toEqual([T800]);
  });
});

// ── Sweep: fire-once-per-breach ──

describe("sweep_context_thresholds — once per breach", () => {
  it("alerts exactly once for each threshold as usage climbs", async () => {
    const h = make_harness({});

    await sweep_at(h, 100_000);
    expect(h.alerts).toHaveLength(0);

    await sweep_at(h, 250_000);
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]?.body).toContain("200k");

    await sweep_at(h, 550_000);
    expect(h.alerts).toHaveLength(2);
    expect(h.alerts[1]?.body).toContain("500k");

    await sweep_at(h, 850_000);
    expect(h.alerts).toHaveLength(3);
    expect(h.alerts[2]?.body).toContain("800k");
  });

  it("does not re-alert while a session stays above a threshold", async () => {
    const h = make_harness({});

    await sweep_at(h, 250_000);
    expect(h.alerts).toHaveLength(1);

    // Ten more sweeps, all still above 200k but below 500k.
    for (const used of [260_000, 300_000, 310_000, 400_000, 490_000, 499_999, 250_000, 260_000]) {
      await sweep_at(h, used);
    }
    expect(h.alerts).toHaveLength(1);
  });

  it("posts a single alert naming the highest threshold when several cross at once", async () => {
    const h = make_harness({});

    await sweep_at(h, 600_000);
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]?.body).toContain("500k");

    // 200k was consumed by the same jump — it must not fire later on the way up.
    await sweep_at(h, 700_000);
    expect(h.alerts).toHaveLength(1);
  });
});

// ── Sweep: re-arm on the way down ──

describe("sweep_context_thresholds — re-arming", () => {
  it("re-alerts after a compaction drops usage below the threshold", async () => {
    const h = make_harness({});

    await sweep_at(h, 250_000);
    expect(h.alerts).toHaveLength(1);

    // /compact
    await sweep_at(h, 40_000);
    expect(h.alerts).toHaveLength(1);

    // regrowth back over 200k
    await sweep_at(h, 210_000);
    expect(h.alerts).toHaveLength(2);
    expect(h.alerts[1]?.body).toContain("200k");
  });

  it("re-arms higher thresholds independently", async () => {
    const h = make_harness({});

    await sweep_at(h, 850_000); // crosses all three, alerts on 800k
    expect(h.alerts).toHaveLength(1);

    await sweep_at(h, 600_000); // 800k re-armed, 500k/200k still fired
    expect(h.alerts).toHaveLength(1);

    await sweep_at(h, 810_000); // 800k crosses again
    expect(h.alerts).toHaveLength(2);
    expect(h.alerts[1]?.body).toContain("800k");
  });
});

// ── Sweep: session identity ──

describe("sweep_context_thresholds — session identity", () => {
  it("starts a recycled session with every threshold armed", async () => {
    const h = make_harness({ bots: [make_bot({ session_id: "session-old" })] });

    await sweep_at(h, 850_000);
    expect(h.alerts).toHaveLength(1);

    // Same bot, same channel, brand-new session after a recycle.
    h.set_bots([make_bot({ session_id: "session-new" })]);
    await sweep_at(h, 250_000);
    expect(h.alerts).toHaveLength(2);
    expect(h.alerts[1]?.body).toContain("200k");

    await sweep_at(h, 550_000);
    expect(h.alerts).toHaveLength(3);
    expect(h.alerts[2]?.body).toContain("500k");
  });

  it("tracks sessions independently of one another", async () => {
    const h = make_harness({
      bots: [
        make_bot({ bot_id: 1, session_id: "s1", tmux_session: "pool-1", channel_id: "c1" }),
        make_bot({ bot_id: 2, session_id: "s2", tmux_session: "pool-2", channel_id: "c2" }),
      ],
    });

    h.set_reading("pool-1", usage(250_000));
    h.set_reading("pool-2", usage(10_000));
    await h.sweep();
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]?.body).toContain("c1");

    h.set_reading("pool-2", usage(250_000));
    await h.sweep();
    expect(h.alerts).toHaveLength(2);
    expect(h.alerts[1]?.body).toContain("c2");
  });

  it("skips bots that have no session id yet", async () => {
    const h = make_harness({ bots: [make_bot({ session_id: null as unknown as string })] });
    await sweep_at(h, 900_000);
    expect(h.alerts).toHaveLength(0);
  });
});

// ── Sweep: restart durability ──

describe("sweep_context_thresholds — restart durability", () => {
  let tmp_dir: string;

  beforeEach(async () => {
    tmp_dir = await mkdtemp(join(tmpdir(), "lf-ctx-alerts-"));
  });

  afterEach(async () => {
    await rm(tmp_dir, { recursive: true, force: true });
  });

  it("does not re-fire thresholds after a daemon restart", async () => {
    const config = make_config(tmp_dir);
    const bots = [make_bot()];

    const build = (): Harness => {
      const alerts: AlertPayload[] = [];
      const deps: ContextSweepDeps = {
        list_bots: () => bots,
        query_usage: () => Promise.resolve(usage(620_000)),
        post_alert: (payload) => {
          alerts.push(payload);
          return Promise.resolve({ message_id: null });
        },
        load_state: () => load_context_alerts(config),
        save_state: (state) => save_context_alerts(state, config),
      };
      return {
        deps,
        alerts,
        set_reading: () => undefined,
        set_bots: () => undefined,
        sweep: () => sweep_context_thresholds(deps),
      };
    };

    const before = build();
    await before.sweep();
    expect(before.alerts).toHaveLength(1);

    // State must be on disk, not just in memory.
    const persisted = await load_context_alerts(config);
    expect(persisted["session-aaa"]?.fired).toEqual([T200, T500]);

    // Simulated restart: brand-new deps, same state file.
    const after = build();
    await after.sweep();
    await after.sweep();
    expect(after.alerts).toHaveLength(0);
  });

  it("forgets sessions that have not been seen for longer than the TTL", async () => {
    const store = { current: {} as ContextAlertState };
    const stale = new Date(Date.now() - CONTEXT_ALERT_STATE_TTL_MS - 60_000).toISOString();
    store.current = {
      "session-gone": { fired: [T200, T500], last_used_tokens: 600_000, last_seen_at: stale },
      "session-aaa": { fired: [T200], last_used_tokens: 250_000, last_seen_at: stale },
    };

    const h = make_harness({ state: store });
    await sweep_at(h, 250_000);

    // The absent session is pruned; the live one is refreshed, not pruned,
    // and its still-breached threshold does not re-fire.
    expect(Object.keys(store.current)).toEqual(["session-aaa"]);
    expect(h.alerts).toHaveLength(0);
  });
});

// ── Sweep: unreadable context ──

describe("sweep_context_thresholds — unreadable context", () => {
  it("skips a session whose context cannot be read", async () => {
    const h = make_harness({});
    h.set_reading("pool-3", null);
    await expect(h.sweep()).resolves.toBeUndefined();
    expect(h.alerts).toHaveLength(0);
  });

  it("skips a session whose query throws", async () => {
    const h = make_harness({});
    h.set_reading("pool-3", new Error("no server running on /tmp/tmux-501/default"));
    await expect(h.sweep()).resolves.toBeUndefined();
    expect(h.alerts).toHaveLength(0);
  });

  it("skips a reading with an unparseable token count", async () => {
    const h = make_harness({});
    h.set_reading("pool-3", {
      summary: "??",
      used_tokens: null,
      total_tokens: null,
      percent: null,
    });
    await h.sweep();
    expect(h.alerts).toHaveLength(0);
  });

  it("preserves dedupe state for a session that becomes unreadable", async () => {
    const store = { current: {} as ContextAlertState };
    const h = make_harness({ state: store });

    await sweep_at(h, 250_000);
    expect(h.alerts).toHaveLength(1);

    h.set_reading("pool-3", null);
    await h.sweep();
    expect(store.current["session-aaa"]?.fired).toEqual([T200]);

    // Still breached when readable again — must not re-alert.
    await sweep_at(h, 260_000);
    expect(h.alerts).toHaveLength(1);
  });

  it("keeps sweeping other bots after one of them fails", async () => {
    const h = make_harness({
      bots: [
        make_bot({ bot_id: 1, session_id: "s1", tmux_session: "pool-1", channel_id: "c1" }),
        make_bot({ bot_id: 2, session_id: "s2", tmux_session: "pool-2", channel_id: "c2" }),
      ],
    });

    h.set_reading("pool-1", new Error("tmux gone"));
    h.set_reading("pool-2", usage(250_000));
    await h.sweep();

    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]?.body).toContain("c2");
  });

  it("still persists state when posting the alert fails", async () => {
    const store = { current: {} as ContextAlertState };
    const h = make_harness({ state: store });
    h.deps.post_alert = () => Promise.reject(new Error("discord down"));

    await sweep_at(h, 250_000);
    expect(store.current["session-aaa"]?.fired).toEqual([T200]);
  });
});

// ── Alert content ──

describe("context alert content", () => {
  it("carries entity, channel, usage, session id and a suggested action", async () => {
    const h = make_harness({});
    await sweep_at(h, 520_000);

    const alert = h.alerts[0];
    expect(alert).toBeDefined();
    expect(alert?.entity_id).toBe("acme");
    expect(alert?.body).toContain("chan-1");
    expect(alert?.body).toContain("520k / 1m");
    expect(alert?.body).toContain("500k");
    expect(alert?.body).toContain("session-aaa");
    expect(alert?.body).toContain("/compact");
  });

  it("uses the tier declared on the threshold that fired", async () => {
    const h = make_harness({});
    const tier_of = (tokens: number) =>
      CONTEXT_ALERT_THRESHOLDS.find((t) => t.tokens === tokens)?.tier;

    await sweep_at(h, 250_000);
    expect(h.alerts[0]?.tier).toBe(tier_of(T200));

    await sweep_at(h, 850_000);
    expect(h.alerts[1]?.tier).toBe(tier_of(T800));
  });
});

// ── Pool adapter ──

describe("context_bots_from_pool", () => {
  function pool_bot(overrides: Partial<PoolBot> = {}): PoolBot {
    return {
      id: 4,
      state: "assigned",
      channel_id: "chan-9",
      entity_id: "acme",
      archetype: "builder",
      channel_type: "work_room",
      session_id: "sess-9",
      session_confirmed: true,
      tmux_session: "pool-4",
      last_active: null,
      assigned_at: null,
      state_dir: "/tmp",
      model: null,
      effort: null,
      last_avatar_archetype: null,
      last_avatar_set_at: null,
      ...overrides,
    } as PoolBot;
  }

  it("maps assigned bots that have a session", () => {
    expect(context_bots_from_pool([pool_bot()])).toEqual([
      {
        bot_id: 4,
        session_id: "sess-9",
        entity_id: "acme",
        channel_id: "chan-9",
        tmux_session: "pool-4",
      },
    ]);
  });

  it("drops bots with no session, entity, or channel", () => {
    const bots = [
      pool_bot({ session_id: null }),
      pool_bot({ entity_id: null }),
      pool_bot({ channel_id: null }),
    ];
    expect(context_bots_from_pool(bots)).toEqual([]);
  });
});
