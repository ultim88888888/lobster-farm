import { describe, expect, it, vi } from "vitest";
import {
  MCP_GIVEUP_THRESHOLD,
  MCP_GRACE_PERIOD_MS,
  MCP_MAX_RECONNECT_ATTEMPTS,
  MCP_RECOVERY_COOLDOWN_MS,
  attempt_mcp_reconnect,
  classify_mcp_failure,
  encode_cache_slug,
  has_mcp_child,
  process_mcp_health_tick,
  prune_mcp_state,
  record_cycle_outcome,
  run_mcp_recovery_cycle,
  selection_line,
  wait_for_mcp_child,
} from "../mcp-health.js";
import type { McpDriver, McpRecoveryState } from "../mcp-health.js";

// ── has_mcp_child (process-level detection) ──

describe("has_mcp_child", () => {
  it("returns true when the pane PID has a bun child process", () => {
    const pane_pid_fn = vi.fn().mockReturnValue(4242);
    const has_children_fn = vi.fn().mockReturnValue(true);

    expect(has_mcp_child("pool-1", pane_pid_fn, has_children_fn)).toBe(true);
    expect(pane_pid_fn).toHaveBeenCalledWith("pool-1");
    expect(has_children_fn).toHaveBeenCalledWith(4242);
  });

  it("returns false when the pane has no children", () => {
    const pane_pid_fn = vi.fn().mockReturnValue(4242);
    const has_children_fn = vi.fn().mockReturnValue(false);

    expect(has_mcp_child("pool-1", pane_pid_fn, has_children_fn)).toBe(false);
  });

  it("returns false when the pane PID can't be resolved (dead/unreadable session)", () => {
    const pane_pid_fn = vi.fn().mockReturnValue(null);
    const has_children_fn = vi.fn();

    expect(has_mcp_child("pool-1", pane_pid_fn, has_children_fn)).toBe(false);
    expect(has_children_fn).not.toHaveBeenCalled();
  });
});

// ── classify_mcp_failure (corroborating signal, diagnosis only) ──

describe("classify_mcp_failure", () => {
  it("classifies as never-spawned when the MCP log dir is absent", () => {
    const exists_fn = vi.fn().mockReturnValue(false);
    expect(classify_mcp_failure("/Users/farm/entities/acme", exists_fn)).toBe("never-spawned");
  });

  it("classifies as died when the MCP log dir exists but the process is gone", () => {
    const exists_fn = vi.fn().mockReturnValue(true);
    expect(classify_mcp_failure("/Users/farm/entities/acme", exists_fn)).toBe("died");
  });
});

describe("encode_cache_slug", () => {
  it("replaces every slash and dot with a dash, matching the real cache dir naming", () => {
    expect(encode_cache_slug("/Users/farm/.lobsterfarm/entities/lobster-farm")).toBe(
      "-Users-farm--lobsterfarm-entities-lobster-farm",
    );
  });
});

// ── selection_line ──

describe("selection_line", () => {
  it("finds the line containing the ❯ selection cursor", () => {
    const pane = [
      "Manage MCP servers",
      "  computer-use",
      "❯ plugin:discord",
      "  claude-design",
    ].join("\n");
    expect(selection_line(pane)).toBe("❯ plugin:discord");
  });

  it("returns null when no line has a selection cursor", () => {
    expect(selection_line("nothing here\njust text")).toBeNull();
  });
});

// ── process_mcp_health_tick (continuous-monitoring state machine) ──

describe("process_mcp_health_tick", () => {
  it("does not flag a session younger than the grace period", () => {
    const state = new Map<number, McpRecoveryState>();
    const result = process_mcp_health_tick(1, false, true, MCP_GRACE_PERIOD_MS - 1, 0, state);
    expect(result).toEqual({ action: "none" });
  });

  it("does not act on a single failed tick — requires consecutive fails", () => {
    const state = new Map<number, McpRecoveryState>();
    const result = process_mcp_health_tick(1, false, true, MCP_GRACE_PERIOD_MS, 0, state);
    expect(result).toEqual({ action: "none" });
    expect(state.get(1)?.consecutive_fails).toBe(1);
  });

  it("returns recover after the min-consecutive-fails threshold, when idle", () => {
    const state = new Map<number, McpRecoveryState>();
    process_mcp_health_tick(1, false, true, MCP_GRACE_PERIOD_MS, 0, state); // 1st fail
    const result = process_mcp_health_tick(1, false, true, MCP_GRACE_PERIOD_MS, 1000, state); // 2nd fail
    expect(result).toEqual({ action: "recover" });
  });

  it("clears all state when the bot is healthy", () => {
    const state = new Map<number, McpRecoveryState>();
    process_mcp_health_tick(1, false, true, MCP_GRACE_PERIOD_MS, 0, state);
    process_mcp_health_tick(1, false, true, MCP_GRACE_PERIOD_MS, 1000, state); // now failing, would recover
    const result = process_mcp_health_tick(1, true, true, MCP_GRACE_PERIOD_MS, 2000, state);
    expect(result).toEqual({ action: "none" });
    expect(state.get(1)).toEqual({
      consecutive_fails: 0,
      last_action_ms: null,
      cycle_fail_timestamps: [],
      given_up: false,
    });
  });

  it("defers to the next tick when mid-turn (not idle) — does not spend cooldown budget", () => {
    const state = new Map<number, McpRecoveryState>();
    process_mcp_health_tick(1, false, true, MCP_GRACE_PERIOD_MS, 0, state);
    const result = process_mcp_health_tick(1, false, false, MCP_GRACE_PERIOD_MS, 1000, state);
    expect(result).toEqual({ action: "none" });
    expect(state.get(1)!.last_action_ms).toBeNull();

    // Becomes idle on the next tick — should now fire recover immediately
    // (consecutive fails already satisfied the threshold).
    const next = process_mcp_health_tick(1, false, true, MCP_GRACE_PERIOD_MS, 2000, state);
    expect(next).toEqual({ action: "recover" });
  });

  it("honors the per-bot cooldown between recovery cycles", () => {
    const state = new Map<number, McpRecoveryState>();
    process_mcp_health_tick(1, false, true, MCP_GRACE_PERIOD_MS, 0, state);
    const first = process_mcp_health_tick(1, false, true, MCP_GRACE_PERIOD_MS, 1000, state);
    expect(first).toEqual({ action: "recover" });

    // Immediately after — still within cooldown, must not act again.
    const second = process_mcp_health_tick(1, false, true, MCP_GRACE_PERIOD_MS, 2000, state);
    expect(second).toEqual({ action: "none" });

    // After the cooldown elapses, the next cycle fires.
    const third = process_mcp_health_tick(
      1,
      false,
      true,
      MCP_GRACE_PERIOD_MS,
      1000 + MCP_RECOVERY_COOLDOWN_MS + 1,
      state,
    );
    expect(third).toEqual({ action: "recover" });
  });

  it("3 cycles at the 10-minute cooldown pace fit inside the 30-minute give-up window", () => {
    // This is the core anti-thrash compatibility the design depends on:
    // MCP_GIVEUP_THRESHOLD cycles x MCP_RECOVERY_COOLDOWN_MS must fit within
    // MCP_GIVEUP_WINDOW_MS, since each cycle only consumes one cooldown slot
    // (not one slot per Reconnect sub-attempt).
    expect(MCP_GIVEUP_THRESHOLD * MCP_RECOVERY_COOLDOWN_MS).toBeLessThanOrEqual(30 * 60 * 1000);
  });
});

// ── record_cycle_outcome (give-up bookkeeping after a cycle completes) ──

describe("record_cycle_outcome", () => {
  it("returns null and records nothing for a reconnected outcome", () => {
    const state = new Map<number, McpRecoveryState>();
    const result = record_cycle_outcome(1, "reconnected", 1000, state);
    expect(result).toBeNull();
    expect(state.has(1)).toBe(false);
  });

  it("gives up after MCP_GIVEUP_THRESHOLD failed cycles within the window", () => {
    const state = new Map<number, McpRecoveryState>();
    let now = 0;
    let last: ReturnType<typeof record_cycle_outcome> = null;
    for (let i = 0; i < MCP_GIVEUP_THRESHOLD; i++) {
      now += MCP_RECOVERY_COOLDOWN_MS;
      last = record_cycle_outcome(1, "fell_back", now, state);
    }
    expect(last).toEqual({ cycle_fail_count: MCP_GIVEUP_THRESHOLD });
    expect(state.get(1)?.given_up).toBe(true);
  });

  it("does not give up before the threshold is reached", () => {
    const state = new Map<number, McpRecoveryState>();
    const result = record_cycle_outcome(1, "fell_back", 1000, state);
    expect(result).toBeNull();
    expect(state.get(1)?.given_up).toBe(false);
  });

  it("only counts failed cycles within the give-up window", () => {
    const state = new Map<number, McpRecoveryState>();
    record_cycle_outcome(1, "fell_back", 0, state);
    // Far outside the window — should be pruned, not counted.
    const now = 1_000_000 * 60 * 60; // 1000 hours later
    const result = record_cycle_outcome(1, "fell_back", now, state);
    expect(result).toBeNull();
    expect(state.get(1)?.cycle_fail_timestamps).toEqual([now]);
  });

  it("propagates through process_mcp_health_tick: given_up silences further recover actions", () => {
    const state = new Map<number, McpRecoveryState>();
    let now = 0;
    process_mcp_health_tick(1, false, true, MCP_GRACE_PERIOD_MS, now, state); // 1st fail
    for (let i = 0; i < MCP_GIVEUP_THRESHOLD; i++) {
      now += MCP_RECOVERY_COOLDOWN_MS + 1;
      const tick = process_mcp_health_tick(1, false, true, MCP_GRACE_PERIOD_MS, now, state);
      expect(tick).toEqual({ action: "recover" });
      record_cycle_outcome(1, "fell_back", now, state);
    }

    now += MCP_RECOVERY_COOLDOWN_MS + 1;
    const after_giveup = process_mcp_health_tick(1, false, true, MCP_GRACE_PERIOD_MS, now, state);
    expect(after_giveup).toEqual({ action: "none" });
  });

  it("resets given_up once the bot is observed healthy again", () => {
    const state = new Map<number, McpRecoveryState>();
    state.set(1, {
      consecutive_fails: 5,
      last_action_ms: 1000,
      cycle_fail_timestamps: [100, 200, 300],
      given_up: true,
    });
    const result = process_mcp_health_tick(1, true, true, MCP_GRACE_PERIOD_MS, 2000, state);
    expect(result).toEqual({ action: "none" });
    expect(state.get(1)?.given_up).toBe(false);
  });
});

describe("prune_mcp_state", () => {
  it("removes state entries for bots no longer assigned", () => {
    const state = new Map<number, McpRecoveryState>();
    const blank: McpRecoveryState = {
      consecutive_fails: 1,
      last_action_ms: null,
      cycle_fail_timestamps: [],
      given_up: false,
    };
    state.set(1, { ...blank });
    state.set(2, { ...blank });
    prune_mcp_state(state, new Set([1]));
    expect(state.has(1)).toBe(true);
    expect(state.has(2)).toBe(false);
  });
});

// ── run_mcp_recovery_cycle (Step 1 x N, then Step 2 fallback) ──

describe("run_mcp_recovery_cycle", () => {
  it("returns reconnected as soon as one attempt succeeds, without falling back", async () => {
    const kill_fn = vi.fn();
    const scripted_driver = make_scripted_success_driver();

    const outcome = await run_mcp_recovery_cycle("pool-1", kill_fn, scripted_driver);

    expect(outcome).toBe("reconnected");
    expect(kill_fn).not.toHaveBeenCalled();
  });

  it("falls back (kills tmux) after MCP_MAX_RECONNECT_ATTEMPTS failed attempts", async () => {
    const driver = make_driver({ capture: vi.fn().mockReturnValue("unrelated pane text") });
    const kill_fn = vi.fn();

    const outcome = await run_mcp_recovery_cycle("pool-1", kill_fn, driver);

    expect(outcome).toBe("fell_back");
    expect(kill_fn).toHaveBeenCalledTimes(1);
    // One attempt_mcp_reconnect call per MCP_MAX_RECONNECT_ATTEMPTS — each
    // sends /mcp once, so count the /mcp sends as a proxy for attempt count.
    const mcp_sends = (driver.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[1] === "/mcp",
    );
    expect(mcp_sends).toHaveLength(MCP_MAX_RECONNECT_ATTEMPTS);
  });
});

function make_scripted_success_driver(): McpDriver {
  const panel = "Manage MCP servers";
  const captures = [
    panel,
    `${panel}\n❯ plugin:discord`,
    `${panel}\n❯ plugin:discord`,
    "❯ 1. Reconnect",
  ];
  return {
    capture: vi.fn(() => captures.shift() ?? null),
    send: vi.fn(),
    sleep: vi.fn().mockResolvedValue(undefined),
    is_healthy: vi.fn().mockReturnValue(true),
  };
}

// ── attempt_mcp_reconnect (scripted /mcp Reconnect driver) ──

function make_driver(overrides: Partial<McpDriver> = {}): McpDriver {
  return {
    capture: vi.fn().mockReturnValue(""),
    send: vi.fn(),
    sleep: vi.fn().mockResolvedValue(undefined),
    is_healthy: vi.fn().mockReturnValue(true),
    ...overrides,
  };
}

describe("attempt_mcp_reconnect", () => {
  it("aborts with Escape when the Manage MCP servers panel never opens", async () => {
    const driver = make_driver({ capture: vi.fn().mockReturnValue("some unrelated pane text") });

    const result = await attempt_mcp_reconnect("pool-1", driver);

    expect(result).toEqual({ ok: false, reason: "panel_not_open" });
    expect(driver.send).toHaveBeenCalledWith("pool-1", "Escape");
    // Never pressed Down/Enter beyond the initial /mcp — no blind navigation.
    expect(driver.send).not.toHaveBeenCalledWith("pool-1", "Down");
  });

  it("hunts with Down until the selection line contains plugin:discord, never counting keystrokes", async () => {
    const panel = "Manage MCP servers";
    const captures = [
      panel, // after /mcp
      `${panel}\n❯ computer-use`, // 1st nav check — wrong server first (per spec)
      `${panel}\n  computer-use\n❯ plugin:discord`, // 2nd nav check — found it
      `${panel}\n  computer-use\n❯ plugin:discord`, // re-confirm before Enter
      "Manage MCP servers\n❯ 1. Reconnect", // detail menu
    ];
    const capture = vi.fn(() => captures.shift() ?? null);
    const driver = make_driver({ capture, is_healthy: vi.fn().mockReturnValue(true) });

    const result = await attempt_mcp_reconnect("pool-1", driver);

    expect(result).toEqual({ ok: true });
    // One Down press to skip past "computer-use" before landing on plugin:discord.
    expect(driver.send).toHaveBeenCalledWith("pool-1", "Down");
    expect(driver.send).toHaveBeenCalledWith("pool-1", "Enter");
    // Final step returns to the prompt.
    expect(driver.send).toHaveBeenLastCalledWith("pool-1", "Escape");
  });

  it("aborts without pressing Enter when the selection line is wrong right before select", async () => {
    const panel = "Manage MCP servers";
    const captures = [
      panel, // after /mcp
      `${panel}\n❯ plugin:discord`, // nav check — found immediately
      `${panel}\n❯ something-else`, // re-confirm — selection moved (stray key)
    ];
    const capture = vi.fn(() => captures.shift() ?? null);
    const send = vi.fn();
    const driver = make_driver({ capture, send });

    const result = await attempt_mcp_reconnect("pool-1", driver);

    expect(result).toEqual({ ok: false, reason: "wrong_selection" });
    // Enter must never be sent when the pre-Enter guard fails.
    expect(send).not.toHaveBeenCalledWith("pool-1", "Enter");
    expect(send).toHaveBeenCalledWith("pool-1", "Escape");
  });

  it("aborts when the detail menu doesn't show Reconnect selected", async () => {
    const panel = "Manage MCP servers";
    const captures = [
      panel,
      `${panel}\n❯ plugin:discord`,
      `${panel}\n❯ plugin:discord`,
      "some other detail menu\n❯ 2. Disable", // wrong item selected
    ];
    const capture = vi.fn(() => captures.shift() ?? null);
    const send = vi.fn();
    const driver = make_driver({ capture, send });

    const result = await attempt_mcp_reconnect("pool-1", driver);

    expect(result).toEqual({ ok: false, reason: "detail_menu_not_shown" });
    // The failing capture was after the plugin:discord Enter — that Enter did fire...
    expect(send).toHaveBeenCalledWith("pool-1", "Enter");
    // ...but the final Reconnect-confirming Enter must never fire.
    expect(send.mock.calls.filter((c) => c[1] === "Enter")).toHaveLength(1);
    expect(send).toHaveBeenCalledWith("pool-1", "Escape");
  });

  it("reports child_still_missing when the process signal doesn't recover after Reconnect", async () => {
    const panel = "Manage MCP servers";
    const captures = [
      panel,
      `${panel}\n❯ plugin:discord`,
      `${panel}\n❯ plugin:discord`,
      "❯ 1. Reconnect",
    ];
    const capture = vi.fn(() => captures.shift() ?? null);
    const driver = make_driver({ capture, is_healthy: vi.fn().mockReturnValue(false) });

    const result = await attempt_mcp_reconnect("pool-1", driver);

    expect(result).toEqual({ ok: false, reason: "child_still_missing" });
  });

  it("happy path: full sequence confirms reconnect and re-verifies the process signal", async () => {
    const panel = "Manage MCP servers";
    const captures = [
      panel,
      `${panel}\n❯ plugin:discord`,
      `${panel}\n❯ plugin:discord`,
      "❯ 1. Reconnect",
    ];
    const capture = vi.fn(() => captures.shift() ?? null);
    const is_healthy = vi.fn().mockReturnValue(true);
    const driver = make_driver({ capture, is_healthy });

    const result = await attempt_mcp_reconnect("pool-1", driver);

    expect(result).toEqual({ ok: true });
    expect(is_healthy).toHaveBeenCalledWith("pool-1");
  });
});

// ── wait_for_mcp_child (post-spawn grace poll) ──

describe("wait_for_mcp_child", () => {
  it("resolves immediately when the child is already present", async () => {
    const has_child_fn = vi.fn().mockReturnValue(true);
    const result = await wait_for_mcp_child(
      "pool-1",
      { timeout_ms: 1000, poll_ms: 10 },
      has_child_fn,
    );
    expect(result).toBe(true);
    expect(has_child_fn).toHaveBeenCalledTimes(1);
  });

  it("polls until the child appears within the timeout", async () => {
    let calls = 0;
    const has_child_fn = vi.fn(() => {
      calls++;
      return calls >= 3;
    });
    const result = await wait_for_mcp_child(
      "pool-1",
      { timeout_ms: 1000, poll_ms: 5 },
      has_child_fn,
    );
    expect(result).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it("gives up after the timeout when the child never appears", async () => {
    const has_child_fn = vi.fn().mockReturnValue(false);
    const result = await wait_for_mcp_child(
      "pool-1",
      { timeout_ms: 30, poll_ms: 10 },
      has_child_fn,
    );
    expect(result).toBe(false);
  });
});
