import { describe, expect, it, vi } from "vitest";
import {
  MCP_GIVEUP_THRESHOLD,
  MCP_GRACE_PERIOD_MS,
  MCP_MAX_DOWN_PRESSES,
  MCP_MAX_RECONNECT_ATTEMPTS,
  MCP_RECOVERY_COOLDOWN_MS,
  attempt_mcp_reconnect,
  classify_mcp_failure,
  encode_cache_slug,
  has_bun_descendant,
  has_mcp_child,
  is_discord_mcp_bun_process,
  process_mcp_health_tick,
  prune_mcp_state,
  record_cycle_outcome,
  run_mcp_recovery_cycle,
  selection_line,
  snapshot_processes,
  wait_for_mcp_child,
} from "../mcp-health.js";
import type { McpDriver, McpRecoveryState, ProcessNode } from "../mcp-health.js";
import {
  REAL_PANE_DETAIL_MENU,
  REAL_PANE_DISCORD_SELECTED,
  REAL_PANE_SERVER_LIST,
  real_pane_showing,
} from "./helpers/mcp-pane-fixtures.js";

// ── has_mcp_child (process-level detection, delegates to has_bun_descendant) ──

describe("has_mcp_child", () => {
  it("returns true when a discord-plugin bun descendant is found under the pane PID", () => {
    const pane_pid_fn = vi.fn().mockReturnValue(4242);
    const has_bun_descendant_fn = vi.fn().mockReturnValue(true);

    expect(has_mcp_child("pool-1", pane_pid_fn, has_bun_descendant_fn)).toBe(true);
    expect(pane_pid_fn).toHaveBeenCalledWith("pool-1");
    expect(has_bun_descendant_fn).toHaveBeenCalledWith(4242);
  });

  it("returns false when no bun descendant is found", () => {
    const pane_pid_fn = vi.fn().mockReturnValue(4242);
    const has_bun_descendant_fn = vi.fn().mockReturnValue(false);

    expect(has_mcp_child("pool-1", pane_pid_fn, has_bun_descendant_fn)).toBe(false);
  });

  it("returns false when the pane PID can't be resolved (dead/unreadable session)", () => {
    const pane_pid_fn = vi.fn().mockReturnValue(null);
    const has_bun_descendant_fn = vi.fn();

    expect(has_mcp_child("pool-1", pane_pid_fn, has_bun_descendant_fn)).toBe(false);
    expect(has_bun_descendant_fn).not.toHaveBeenCalled();
  });
});

// ── is_discord_mcp_bun_process (comm + plugin-path disambiguation) ──

describe("is_discord_mcp_bun_process", () => {
  it("matches the real discord plugin launch command", () => {
    expect(
      is_discord_mcp_bun_process(
        "bun run --cwd /Users/farm/.claude/plugins/cache/claude-plugins-official/discord/0.0.4 --shell=bun --silent start",
      ),
    ).toBe(true);
  });

  it("matches a full-path bun executable, not just a bare argv0", () => {
    expect(
      is_discord_mcp_bun_process(
        "/opt/homebrew/bin/bun run --cwd /Users/farm/.claude/plugins/cache/claude-plugins-official/discord/0.0.4 start",
      ),
    ).toBe(true);
  });

  it("rejects a non-discord bun MCP server (the inverse hazard)", () => {
    expect(
      is_discord_mcp_bun_process(
        "bun run --cwd /Users/beacon/.claude/plugins/cache/claude-plugins-official/imessage/0.1.0 --shell=bun --silent start",
      ),
    ).toBe(false);
  });

  it("rejects a non-bun process even if its args mention discord", () => {
    expect(is_discord_mcp_bun_process("node /some/discord/script.js")).toBe(false);
  });

  it("rejects an empty command", () => {
    expect(is_discord_mcp_bun_process("")).toBe(false);
  });
});

// ── snapshot_processes (real `ps` call — smoke test only, OS-dependent) ──

describe("snapshot_processes", () => {
  it("returns a non-empty list of well-formed process nodes for the current machine", () => {
    const processes = snapshot_processes();
    expect(processes.length).toBeGreaterThan(0);
    for (const p of processes.slice(0, 20)) {
      expect(Number.isInteger(p.pid)).toBe(true);
      expect(Number.isInteger(p.ppid)).toBe(true);
      expect(typeof p.command).toBe("string");
    }
    // pid 1 (init/launchd) should always be present.
    expect(processes.some((p) => p.pid === 1)).toBe(true);
  });
});

// ── has_bun_descendant (full descendant-tree walk — the #347 fix) ──

describe("has_bun_descendant", () => {
  const DISCORD_BUN_CMD =
    "bun run --cwd /Users/farm/.claude/plugins/cache/claude-plugins-official/discord/0.0.4 --shell=bun --silent start";

  function node(pid: number, ppid: number, command: string): ProcessNode {
    return { pid, ppid, command };
  }

  it("regression: pane -> shell -> claude, no bun anywhere -> unhealthy", () => {
    // This is the exact shape that produced the #347 false positive: pane_pid
    // is the resumed session's original login shell, claude is its direct
    // child, and no MCP server ever spawned. The pre-#347 direct-children-only
    // check (`pgrep -P pane_pid` non-empty) would have reported this healthy
    // because `claude` itself counts as "a child."
    const pane_pid = 100;
    const processes = [node(200, pane_pid, "/bin/zsh"), node(300, 200, "claude --resume")];

    expect(has_bun_descendant(pane_pid, () => processes)).toBe(false);
  });

  it("pane -> shell -> claude -> bun (discord) -> healthy", () => {
    const pane_pid = 100;
    const processes = [
      node(200, pane_pid, "/bin/zsh"),
      node(300, 200, "claude --resume"),
      node(400, 300, DISCORD_BUN_CMD),
    ];

    expect(has_bun_descendant(pane_pid, () => processes)).toBe(true);
  });

  it("fresh spawn: pane PID is claude itself (exec'd shell), bun as direct child -> healthy", () => {
    const pane_pid = 300;
    const processes = [node(300, 1, "claude"), node(400, 300, DISCORD_BUN_CMD)];

    expect(has_bun_descendant(pane_pid, () => processes)).toBe(true);
  });

  it("fresh spawn with no MCP server at all -> unhealthy", () => {
    const pane_pid = 300;
    const processes = [node(300, 1, "claude")];

    expect(has_bun_descendant(pane_pid, () => processes)).toBe(false);
  });

  it("inverse hazard: a live sibling non-discord bun MCP server does not mask a dead discord one", () => {
    const pane_pid = 100;
    const processes = [
      node(200, pane_pid, "/bin/zsh"),
      node(300, 200, "claude --resume"),
      node(
        500,
        300,
        "bun run --cwd /Users/beacon/.claude/plugins/cache/claude-plugins-official/imessage/0.1.0 --shell=bun --silent start",
      ),
    ];

    expect(has_bun_descendant(pane_pid, () => processes)).toBe(false);
  });

  it("finds the discord bun descendant regardless of tree traversal order (siblings, multi-level)", () => {
    const pane_pid = 100;
    const processes = [
      node(999, pane_pid, "some-unrelated-sibling"),
      node(200, pane_pid, "/bin/zsh"),
      node(250, 200, "some-other-child"),
      node(300, 200, "claude --resume"),
      node(400, 300, DISCORD_BUN_CMD),
    ];

    expect(has_bun_descendant(pane_pid, () => processes)).toBe(true);
  });

  it("returns false when the process snapshot is empty (ps failed)", () => {
    expect(has_bun_descendant(100, () => [])).toBe(false);
  });

  it("does not infinite-loop on cyclical/duplicate ppid data", () => {
    const pane_pid = 100;
    // Pathological input: 200's ppid points back to itself.
    const processes = [node(200, pane_pid, "/bin/zsh"), node(200, 200, "/bin/zsh")];

    expect(() => has_bun_descendant(pane_pid, () => processes)).not.toThrow();
    expect(has_bun_descendant(pane_pid, () => processes)).toBe(false);
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
  // Guards the fixtures themselves. Every assertion below is only meaningful
  // because the real captures carry `❯ …` prompt echoes in the transcript
  // ABOVE the panel — that is exactly what #373 matched by mistake. A fixture
  // trimmed down to just the panel block would pass against the buggy
  // implementation and prove nothing, which is how this shipped in the first
  // place. If this fails, re-capture the fixtures; do not relax the test.
  it.each([
    ["server list", REAL_PANE_SERVER_LIST],
    ["discord selected", REAL_PANE_DISCORD_SELECTED],
    ["detail menu", REAL_PANE_DETAIL_MENU],
  ])("fixture guard: the %s capture has ❯ decoys above the panel", (_name, pane) => {
    const lines = pane.split("\n");
    const panel_start = lines.findIndex((l) => /^─{10,}/.test(l));
    const decoys = lines.slice(0, panel_start).filter((l) => l.includes("❯"));

    expect(panel_start).toBeGreaterThan(0);
    expect(decoys.length).toBeGreaterThanOrEqual(2);
    // ...and they must be the shape that fooled `.find()`: `❯` at column 0.
    expect(decoys.every((l) => l.startsWith("❯"))).toBe(true);
  });

  it("returns the panel cursor, not the transcript's own ❯ prompt echoes (#373)", () => {
    // The regression. `.find()` returned "❯ /compact" here — the first ❯ in
    // the pane, nine `❯ /mcp` echoes above the panel and completely unrelated
    // to the cursor. The Down-hunt could therefore never match, so every
    // automated reconnect aborted with server_not_found.
    expect(selection_line(REAL_PANE_DISCORD_SELECTED)).toBe(
      "  ❯ plugin:discord:discord · ✘ failed",
    );
  });

  it("returns the first panel row when the cursor has not moved yet", () => {
    expect(selection_line(REAL_PANE_SERVER_LIST)).toBe("  ❯ computer-use · ◯ disabled");
  });

  it("reads the detail menu, which carries no 'Manage MCP servers' header", () => {
    // The detail panel is headed "Plugin:discord:discord MCP Server". Scoping
    // the search by slicing at the server-list header would return null here
    // and break the final guard of the sequence, so the region is anchored on
    // the composer border instead.
    expect(REAL_PANE_DETAIL_MENU).not.toContain("Manage MCP servers");
    expect(selection_line(REAL_PANE_DETAIL_MENU)).toBe("  ❯ 1. Reconnect");
  });

  it("returns null for an idle pane with no panel open", () => {
    // Fails closed rather than handing back a transcript line that might
    // coincidentally match what a caller is looking for.
    expect(selection_line(real_pane_showing())).toBeNull();
  });

  it("returns null when the pane has no composer at all", () => {
    expect(selection_line("nothing here\njust text")).toBeNull();
  });

  it("ignores indented markdown table rules when locating the composer", () => {
    // Table borders are the only other `─` runs a pane shows; they are
    // indented and start with a corner glyph, so the anchored pattern skips
    // them and the composer border is still found.
    const pane = real_pane_showing("  ❯ plugin:discord:discord · ✘ failed").replace(
      "✻ Conversation compacted (ctrl+o for history)",
      "  ┌────────────┬─────────┐\n  ├────────────┼─────────┤\n  └────────────┴─────────┘",
    );
    expect(selection_line(pane)).toBe("  ❯ plugin:discord:discord · ✘ failed");
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
      last_fell_back_at: null,
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
      last_fell_back_at: null,
      given_up: true,
    });
    const result = process_mcp_health_tick(1, true, true, MCP_GRACE_PERIOD_MS, 2000, state);
    expect(result).toEqual({ action: "none" });
    expect(state.get(1)?.given_up).toBe(false);
  });

  it("stamps last_fell_back_at on a fell_back outcome", () => {
    const state = new Map<number, McpRecoveryState>();
    record_cycle_outcome(1, "fell_back", 5000, state);
    expect(state.get(1)?.last_fell_back_at).toBe(5000);
  });

  it("does not stamp last_fell_back_at on a reconnected outcome", () => {
    const state = new Map<number, McpRecoveryState>();
    record_cycle_outcome(1, "reconnected", 5000, state);
    expect(state.get(1)?.last_fell_back_at ?? null).toBeNull();
  });
});

// ── Post-Step-2 recovery signal (spec: #alerts on successful recovery after
//    a fallback — silent for routine Step 1 reconnects) ──

describe("process_mcp_health_tick post-fallback recovery signal", () => {
  it("reports notify_recovered on the first healthy tick after a fell_back cycle", () => {
    const state = new Map<number, McpRecoveryState>();
    process_mcp_health_tick(1, false, true, MCP_GRACE_PERIOD_MS, 0, state); // 1st fail
    process_mcp_health_tick(1, false, true, MCP_GRACE_PERIOD_MS, 1000, state); // fires recover
    record_cycle_outcome(1, "fell_back", 1000, state);

    const recovered = process_mcp_health_tick(1, true, true, MCP_GRACE_PERIOD_MS, 2000, state);
    expect(recovered).toEqual({ action: "notify_recovered" });
  });

  it("only reports the recovery once — later healthy ticks stay silent", () => {
    const state = new Map<number, McpRecoveryState>();
    record_cycle_outcome(1, "fell_back", 1000, state);

    expect(process_mcp_health_tick(1, true, true, MCP_GRACE_PERIOD_MS, 2000, state)).toEqual({
      action: "notify_recovered",
    });
    expect(process_mcp_health_tick(1, true, true, MCP_GRACE_PERIOD_MS, 3000, state)).toEqual({
      action: "none",
    });
  });

  it("stays silent on a healthy tick with no prior fallback (routine Step 1 reconnect)", () => {
    const state = new Map<number, McpRecoveryState>();
    process_mcp_health_tick(1, false, true, MCP_GRACE_PERIOD_MS, 0, state);
    process_mcp_health_tick(1, false, true, MCP_GRACE_PERIOD_MS, 1000, state);
    record_cycle_outcome(1, "reconnected", 1000, state);

    const result = process_mcp_health_tick(1, true, true, MCP_GRACE_PERIOD_MS, 2000, state);
    expect(result).toEqual({ action: "none" });
  });

  it("survives the grace period of the respawned session (the real Step 2 path)", () => {
    // Step 2 kills tmux; crash-recovery respawns with a fresh assigned_at, so
    // the next ticks land inside the grace window before the bot reads healthy.
    const state = new Map<number, McpRecoveryState>();
    record_cycle_outcome(1, "fell_back", 1000, state);

    process_mcp_health_tick(1, false, true, 0, 2000, state); // respawned, still warming
    process_mcp_health_tick(1, true, true, 5_000, 3000, state); // healthy but in grace

    const recovered = process_mcp_health_tick(1, true, true, MCP_GRACE_PERIOD_MS, 70_000, state);
    expect(recovered).toEqual({ action: "notify_recovered" });
  });

  it("clears the rest of the anti-thrash slate when reporting a recovery", () => {
    const state = new Map<number, McpRecoveryState>();
    state.set(1, {
      consecutive_fails: 4,
      last_action_ms: 500,
      cycle_fail_timestamps: [100, 200],
      last_fell_back_at: 200,
      given_up: true,
    });

    process_mcp_health_tick(1, true, true, MCP_GRACE_PERIOD_MS, 2000, state);

    expect(state.get(1)).toEqual({
      consecutive_fails: 0,
      last_action_ms: null,
      cycle_fail_timestamps: [],
      last_fell_back_at: null,
      given_up: false,
    });
  });
});

describe("prune_mcp_state", () => {
  it("removes state entries for bots no longer assigned", () => {
    const state = new Map<number, McpRecoveryState>();
    const blank: McpRecoveryState = {
      consecutive_fails: 1,
      last_action_ms: null,
      cycle_fail_timestamps: [],
      last_fell_back_at: null,
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

/**
 * The pane sequence a successful reconnect actually walks through, in real
 * captures: panel opens with the cursor on the first row, one Down lands on
 * the failed discord server, the pre-Enter guard re-reads the same pane, and
 * Enter opens the detail menu with Reconnect preselected.
 *
 * This is the sequence verified by hand against a live bot whose MCP server
 * had been killed — the driver drove it end to end and the bun child came
 * back (#373).
 */
function real_success_captures(): string[] {
  return [
    REAL_PANE_SERVER_LIST, // panel-open guard
    REAL_PANE_SERVER_LIST, // hunt: cursor still on computer-use → Down
    REAL_PANE_DISCORD_SELECTED, // hunt: landed on plugin:discord
    REAL_PANE_DISCORD_SELECTED, // pre-Enter re-confirm
    REAL_PANE_DETAIL_MENU, // detail menu, ❯ 1. Reconnect
  ];
}

function make_scripted_success_driver(): McpDriver {
  const captures = real_success_captures();
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
    const captures = real_success_captures();
    const capture = vi.fn(() => captures.shift() ?? null);
    const driver = make_driver({ capture, is_healthy: vi.fn().mockReturnValue(true) });

    const result = await attempt_mcp_reconnect("pool-1", driver);

    expect(result).toEqual({ ok: true });
    // Exactly one Down press to step off computer-use onto plugin:discord.
    // This count is the driver-level regression assertion for #373: reading
    // the transcript instead of the panel meant the hunt never matched, so it
    // burned all MCP_MAX_DOWN_PRESSES presses and then gave up.
    const downs = (driver.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[1] === "Down",
    );
    expect(downs).toHaveLength(1);
    expect(driver.send).toHaveBeenCalledWith("pool-1", "Enter");
    // Final step returns to the prompt.
    expect(driver.send).toHaveBeenLastCalledWith("pool-1", "Escape");
  });

  it("gives up with server_not_found when the panel never lists plugin:discord", async () => {
    // A real panel, but discord genuinely isn't in it. The hunt should exhaust
    // its press budget and abort — the correct behaviour for this pane, and
    // the behaviour #373 produced for every pane.
    const pane = real_pane_showing(
      "  Manage MCP servers",
      "  1 server",
      "",
      "  ❯ computer-use · ◯ disabled",
    );
    const driver = make_driver({ capture: vi.fn().mockReturnValue(pane) });

    const result = await attempt_mcp_reconnect("pool-1", driver);

    expect(result).toEqual({ ok: false, reason: "server_not_found" });
    const downs = (driver.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[1] === "Down",
    );
    expect(downs).toHaveLength(MCP_MAX_DOWN_PRESSES);
    expect(driver.send).toHaveBeenCalledWith("pool-1", "Escape");
  });

  it("aborts without pressing Enter when the selection line is wrong right before select", async () => {
    const moved = real_pane_showing(
      "  Manage MCP servers",
      "  2 servers",
      "",
      "  ❯ computer-use · ◯ disabled",
      "    plugin:discord:discord · ✘ failed",
    );
    const captures = [
      REAL_PANE_SERVER_LIST, // panel-open guard
      REAL_PANE_DISCORD_SELECTED, // hunt — found immediately
      moved, // re-confirm — a stray key moved the cursor
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
    const wrong_item = real_pane_showing(
      "  Plugin:discord:discord MCP Server",
      "",
      "  Status:           ✘ failed",
      "",
      "    1. Reconnect",
      "  ❯ 2. Disable",
    );
    const captures = [
      REAL_PANE_SERVER_LIST,
      REAL_PANE_DISCORD_SELECTED,
      REAL_PANE_DISCORD_SELECTED,
      wrong_item,
    ];
    const capture = vi.fn(() => captures.shift() ?? null);
    const send = vi.fn();
    const driver = make_driver({ capture, send });

    const result = await attempt_mcp_reconnect("pool-1", driver);

    expect(result).toEqual({ ok: false, reason: "detail_menu_not_shown" });
    // The failing capture was after the plugin:discord Enter — that Enter did fire...
    expect(send).toHaveBeenCalledWith("pool-1", "Enter");
    // ...but the final Reconnect-confirming Enter must never fire. Note the
    // pane *contains* the text "1. Reconnect" on an unselected row: the guard
    // has to read the cursor, not the panel body.
    expect(wrong_item).toContain("1. Reconnect");
    expect(send.mock.calls.filter((c) => c[1] === "Enter")).toHaveLength(1);
    expect(send).toHaveBeenCalledWith("pool-1", "Escape");
  });

  it("reports child_still_missing when the process signal doesn't recover after Reconnect", async () => {
    const captures = real_success_captures();
    const capture = vi.fn(() => captures.shift() ?? null);
    const driver = make_driver({ capture, is_healthy: vi.fn().mockReturnValue(false) });

    const result = await attempt_mcp_reconnect("pool-1", driver);

    expect(result).toEqual({ ok: false, reason: "child_still_missing" });
    // The TUI stays open after the Reconnect action, so it must be dismissed
    // even on failure — otherwise the next attempt's `/mcp` keystrokes land
    // inside the still-open panel and can fire a stray menu action.
    expect(driver.send).toHaveBeenCalledWith("pool-1", "Escape");
  });

  it("happy path: full sequence confirms reconnect and re-verifies the process signal", async () => {
    const captures = real_success_captures();
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
