/**
 * MCP connection verification and auto-reconnect recovery for pool bots and
 * the Commander (Pat).
 *
 * 2026-07-18 outage: after a machine reboot, sessions came up "alive but
 * deaf" — tmux alive, Claude at the prompt, but the Discord plugin's MCP
 * server process was never spawned (or died) inside the session, and
 * nothing retried. Pane text is NOT a trustworthy proxy for a live MCP
 * connection — `wait_for_bot_ready` already requires "Listening for channel
 * messages" in the pane, and deaf sessions passed that check anyway.
 *
 * Detection is process-level: a healthy session has a `bun` process (the
 * plugin MCP server) somewhere in the pane PID's descendant tree.
 *
 * 2026-07-22 false-positive (#347): the original detector only checked
 * whether the pane PID had ANY direct child (`pgrep -P`), not specifically a
 * `bun` descendant. That's correct when the pane PID is `claude` itself
 * (fresh spawn, the login shell execs into `claude` in place), but when a bot
 * is respawned inside an EXISTING tmux pane (the resume path after a daemon
 * restart), the pane PID is the original login shell, `claude` is its child,
 * and `bun` — if it spawned at all — is a grandchild. A deaf `claude` with no
 * MCP server still has a child ("claude" itself), so it read healthy. Fix:
 * `has_bun_descendant` walks the full descendant tree from one `ps` snapshot
 * and requires finding a `bun` process specifically (further disambiguated
 * to the discord plugin's `bun`, see `is_discord_mcp_bun_process`).
 *
 * Recovery is ordered:
 *   1. Scripted in-session `/mcp` Reconnect (primary) — driven via tmux
 *      send-keys with a pane-state guard before every keystroke. Preserves
 *      full conversation context, measured 19/19 during the incident.
 *   2. Kill + resume (fallback) — after 2 failed Reconnect attempts, kill
 *      the tmux session and let the existing crash-recovery path
 *      (`restart_crashed_session`) respawn it with `--resume`. Recycling
 *      alone (no MCP verification) was measured at ~25% success in bad
 *      windows — Reconnect is tried first because it's far more reliable
 *      and doesn't touch the crash-loop counter.
 *
 * Anti-thrash: at most one recovery action (a Reconnect attempt or the
 * fallback) per bot per 10 minutes. After 3 failed full recovery cycles
 * (Reconnect x2 + fallback, still unhealthy) within 30 minutes, give up —
 * stop attempting and let the caller alert. The bot is never released.
 *
 * 2026-08-21 (#373): the scripted Reconnect above had in fact never worked
 * in production — `selection_line` was reading the session's own transcript
 * instead of the panel, so every attempt aborted and fell back to kill +
 * resume. See that function's comment; it is the reason a long run of
 * "deaf channel" reports all traced back to one helper.
 *
 * References: issue #345, #347, #373. Template for pane-driving with guards:
 * `rate-limit-recovery.ts` (#270) and `econnreset-recovery.ts` (#337, sibling
 * — a different failure mode, deliberately not merged with this detector).
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { COMPOSER_BORDER } from "./tui-pane.js";

// ── Thresholds ──

/** Don't flag a session younger than this — the MCP server takes a few
 * seconds to appear after spawn. */
export const MCP_GRACE_PERIOD_MS = 60_000;

/** Require the process-level check to fail this many consecutive ticks
 * before acting — avoids racing a slow spawn. */
export const MCP_MIN_CONSECUTIVE_FAILS = 2;

/** At most one recovery action (Reconnect attempt or fallback) per bot in
 * this window. */
export const MCP_RECOVERY_COOLDOWN_MS = 10 * 60 * 1000;

/** Number of scripted Reconnect attempts tried before falling back to
 * kill + resume. Spec: "If Reconnect fails twice, kill the tmux session." */
export const MCP_MAX_RECONNECT_ATTEMPTS = 2;

/** Give up (stop attempting, escalate) after this many failed full recovery
 * cycles within MCP_GIVEUP_WINDOW_MS. */
export const MCP_GIVEUP_THRESHOLD = 3;
export const MCP_GIVEUP_WINDOW_MS = 30 * 60 * 1000;

/** Wait between each guarded keystroke of the reconnect driver, giving the
 * TUI time to render before the next pane capture.
 *
 * Measured (#373) against a live idle session by polling `capture-pane` every
 * 50ms: the `/mcp` panel paints 60-81ms after Enter, a Down moves the cursor
 * in 4-6ms, and the detail menu paints in 59-68ms — four consecutive runs.
 * 1.5s is ~20x headroom, so this was never the bottleneck it looked like when
 * the driver appeared to hang; that was `selection_line` failing to match.
 * Left as-is: it already absorbs a 20x slowdown, and raising it would only
 * make each *failed* cycle slower (up to MCP_MAX_DOWN_PRESSES waits). */
export const MCP_RECONNECT_STEP_WAIT_MS = 1_500;

/** After sending the final Reconnect keystroke, wait this long before
 * re-verifying the process-level signal (spec: "wait ~6s"). */
export const MCP_RECONNECT_VERIFY_WAIT_MS = 6_000;

/** Safety cap on Down-presses while hunting for the plugin:discord row —
 * the server count varies per session; this just bounds a runaway loop. */
export const MCP_MAX_DOWN_PRESSES = 20;

// ── Process-level detection ──

/** Get the pane PID of a tmux session's active pane. Returns null if the
 * session doesn't exist or the pane PID can't be parsed. */
export function get_pane_pid(tmux_session: string): number | null {
  try {
    const out = execFileSync("tmux", ["list-panes", "-t", tmux_session, "-F", "#{pane_pid}"], {
      encoding: "utf-8",
      timeout: 2000,
    })
      .trim()
      .split("\n")[0];
    const pid = Number.parseInt(out ?? "", 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export interface ProcessNode {
  pid: number;
  ppid: number;
  /** Full command line (argv0 + args), not just the truncated `comm` name —
   * needed to disambiguate the discord plugin's `bun` process from any other
   * bun-based MCP server a session might also be running (see
   * `is_discord_mcp_bun_process`). */
  command: string;
}

/**
 * Snapshot every process on the system as {pid, ppid, command} via a single
 * `ps` call (spec: "one `ps` snapshot per check, no per-process spawning in
 * a loop" — `has_bun_descendant` below builds a full parent→children map
 * from one of these and walks it in memory, rather than shelling out per
 * process). Returns `[]` on any error — fails closed, same posture as
 * `get_pane_pid` / `capture_pane`: no process data means "can't confirm a
 * live MCP connection."
 */
export function snapshot_processes(): ProcessNode[] {
  try {
    const out = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
      encoding: "utf-8",
      timeout: 2000,
    });
    const nodes: ProcessNode[] = [];
    for (const line of out.split("\n")) {
      // pid/ppid are whitespace-padded fixed columns; command is the
      // remainder of the line and may itself contain arbitrary whitespace,
      // so it's captured greedily rather than split on whitespace.
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!match) continue;
      nodes.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? "" });
    }
    return nodes;
  } catch {
    return [];
  }
}

/**
 * True when `command` is the discord plugin's bun MCP server, launched per
 * the plugin's `.mcp.json` as `bun run --cwd <plugin_root> --shell=bun
 * --silent start`. Two checks:
 *   1. The executable's basename is `bun` — matches whether argv0 is a bare
 *      `bun` (the common case; ps resolves it via PATH lookup at spawn time)
 *      or a full path.
 *   2. The command line references a `discord` plugin path — cheap
 *      disambiguation against other bun-based MCP servers a session might
 *      also be running (e.g. an imessage plugin) so a live sibling can't
 *      mask a dead discord server (the "inverse hazard" noted in #347).
 *      This is a substring match on the plugin install path, not a strict
 *      argument parse; acceptable here because every known install layout
 *      (`.claude/plugins/cache/.../discord/...`,
 *      `shared/claude-config-rengen/plugins/.../discord/...`) contains
 *      "discord" in the path, confirmed against live process snapshots.
 */
export function is_discord_mcp_bun_process(command: string): boolean {
  const exe = command.trim().split(/\s+/)[0] ?? "";
  const basename = exe.split("/").pop() ?? "";
  if (basename !== "bun") return false;
  return /discord/i.test(command);
}

/**
 * Walk the FULL descendant tree of `pane_pid` and return true iff a discord
 * plugin `bun` process (see `is_discord_mcp_bun_process`) is found anywhere
 * in it — not just among direct children. This is the fix for #347: when a
 * bot is respawned inside an existing tmux pane (the resume path), the pane
 * PID is the original login shell, `claude` is its direct child, and `bun`
 * is a grandchild — a direct-children-only check (the pre-#347 bug) sees
 * `claude` and reports healthy even when `claude` is deaf with no MCP server
 * spawned at all.
 */
export function has_bun_descendant(
  pane_pid: number,
  processes_fn: () => ProcessNode[] = snapshot_processes,
): boolean {
  const processes = processes_fn();
  const children_of = new Map<number, ProcessNode[]>();
  for (const p of processes) {
    const siblings = children_of.get(p.ppid);
    if (siblings) siblings.push(p);
    else children_of.set(p.ppid, [p]);
  }

  const stack = [...(children_of.get(pane_pid) ?? [])];
  const visited = new Set<number>();
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || visited.has(node.pid)) continue; // guard against cyclical/duplicate ppid data
    visited.add(node.pid);
    if (is_discord_mcp_bun_process(node.command)) return true;
    for (const child of children_of.get(node.pid) ?? []) stack.push(child);
  }
  return false;
}

/**
 * Primary detection signal (spec: process-level, reliable, scriptable).
 * A healthy session has a discord-plugin `bun` process (the MCP server)
 * anywhere in the pane PID's descendant tree — see `has_bun_descendant`.
 * Returns false if the pane can't be read or no such descendant is found —
 * both mean "can't confirm a live MCP connection."
 */
export function has_mcp_child(
  tmux_session: string,
  pane_pid_fn: (session: string) => number | null = get_pane_pid,
  has_bun_descendant_fn: (pid: number) => boolean = has_bun_descendant,
): boolean {
  const pane_pid = pane_pid_fn(tmux_session);
  if (pane_pid === null) return false;
  return has_bun_descendant_fn(pane_pid);
}

// ── Corroborating signal (log-dir, diagnosis only — never gates recovery) ──

/** Encode an absolute path into the claude-cli-nodejs cache slug format
 * (replaces every `/` and `.` with `-`). Mirrors `encode_project_slug` in
 * pool.ts — duplicated here rather than imported to avoid a pool.ts <->
 * mcp-health.ts import cycle; both are one-line pure functions. */
export function encode_cache_slug(abs_path: string): string {
  return abs_path.replace(/[/.]/g, "-");
}

/** Absolute path to this session's Discord plugin MCP log directory. */
export function mcp_log_dir(working_dir: string): string {
  return join(
    homedir(),
    "Library",
    "Caches",
    "claude-cli-nodejs",
    encode_cache_slug(working_dir),
    "mcp-logs-plugin-discord-discord",
  );
}

export type McpFailureMode = "never-spawned" | "died" | "unknown";

/**
 * Classify a detected MCP failure using the log-dir corroborating signal,
 * for logging/diagnosis only — this NEVER gates detection or recovery
 * (spec: "Do NOT rely on pane text" applies equally to log presence, which
 * can be stale or missing for reasons unrelated to the current failure).
 */
export function classify_mcp_failure(
  working_dir: string,
  exists_fn: (path: string) => boolean = existsSync,
): McpFailureMode {
  const dir = mcp_log_dir(working_dir);
  if (!exists_fn(dir)) return "never-spawned";
  return "died";
}

// ── Tmux pane interaction (reconnect driver primitives) ──

/** Capture the full content of a tmux pane. Returns null if unreadable. */
export function capture_pane(tmux_session: string): string | null {
  try {
    return execFileSync("tmux", ["capture-pane", "-t", tmux_session, "-p"], {
      encoding: "utf-8",
      timeout: 2000,
    });
  } catch {
    return null;
  }
}

/** Send one or more keys/literal strings to a tmux session via send-keys.
 * Best-effort — a dead/unreadable session throws from tmux itself; swallow
 * it the same way `capture_pane` fails closed to null, so a stray failed
 * keystroke can't crash the driver mid-sequence (the next pane capture will
 * naturally see the unexpected state and abort). */
export function send_keys(tmux_session: string, ...keys: string[]): void {
  try {
    execFileSync("tmux", ["send-keys", "-t", tmux_session, ...keys], {
      stdio: "ignore",
      timeout: 2000,
    });
  } catch {
    /* best-effort — see doc comment above */
  }
}

/**
 * Find the line bearing the `❯` selection cursor in the overlay panel that
 * Claude Code draws *below* the composer — the `/mcp` server list, or a
 * single server's detail menu.
 *
 * #373: this used to be `.find((line) => line.includes("❯"))` across the
 * whole pane. But `capture_pane` returns everything visible, and the
 * transcript above the composer echoes every command the session has run as
 * `❯ /mcp` at column 0. On any bot that had already attempted a reconnect,
 * the FIRST `❯` was one of those stale echoes, never the cursor. The
 * Down-hunt in `attempt_mcp_reconnect` then burned all
 * MCP_MAX_DOWN_PRESSES iterations without ever matching "plugin:discord",
 * aborted with `server_not_found`, and pressed Escape — surfacing in the
 * transcript as "MCP dialog dismissed". The failure was self-reinforcing:
 * each attempt echoed one more `❯ /mcp` decoy above the panel. Every
 * automated recovery since had been failing this way; manual recovery always
 * worked first try because a human reads the actual cursor.
 *
 * So the search is scoped to the panel rather than the pane. The panel is
 * always drawn after the composer's bottom border, which makes the cursor the
 * first `❯` following the LAST border rule. Scoping by region rather than by
 * `findLast` is deliberate: it is a statement about where the cursor lives,
 * not an assumption that nothing below it can ever contain a `❯`. It also
 * fails closed — a pane with no panel open yields null instead of whatever
 * `❯` line happened to be last, so the callers' guards abort rather than
 * matching a transcript line by coincidence.
 *
 * Deliberately NOT scoped by slicing at the "Manage MCP servers" header: the
 * server detail menu is headed "Plugin:discord:discord MCP Server" and
 * contains no such string, so a header slice would return null for the
 * `1. Reconnect` guard and break the last step of the sequence.
 *
 * Returns null when no panel is open (or the pane is unreadable enough to
 * have lost its composer) — same fail-closed posture as `capture_pane`.
 */
export function selection_line(pane_output: string): string | null {
  const lines = pane_output.split("\n");
  let composer_bottom = lines.length - 1;
  while (composer_bottom >= 0 && !COMPOSER_BORDER.test(lines[composer_bottom] ?? "")) {
    composer_bottom--;
  }
  if (composer_bottom < 0) return null;
  return lines.slice(composer_bottom + 1).find((line) => line.includes("❯")) ?? null;
}

// ── Reconnect driver (Step 1) ──

export interface McpDriver {
  capture: (session: string) => string | null;
  send: (session: string, ...keys: string[]) => void;
  sleep: (ms: number) => Promise<void>;
  is_healthy: (session: string) => boolean;
}

export const default_mcp_driver: McpDriver = {
  capture: capture_pane,
  send: send_keys,
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  is_healthy: (session: string) => has_mcp_child(session),
};

export type ReconnectFailureReason =
  | "panel_not_open"
  | "server_not_found"
  | "wrong_selection"
  | "detail_menu_not_shown"
  | "child_still_missing"
  | "pane_unreadable";

export type ReconnectResult = { ok: true } | { ok: false; reason: ReconnectFailureReason };

/**
 * Drive Claude Code's `/mcp` TUI to reconnect the Discord plugin server.
 * Guards at every step (spec): stray keys go into the prompt if we don't
 * verify pane state before each Enter — this fired an accidental `/compact`
 * during manual recovery in the incident. Aborts with Escape on any
 * unexpected pane state instead of pressing on blind.
 *
 * Sequence (measured 19/19 during the incident):
 *   1. Send `/mcp` + Enter.
 *   2. Confirm "Manage MCP servers" panel visible, else abort.
 *   3. Press Down until the `❯` selection line contains "plugin:discord" —
 *      never count keystrokes, the server list varies per session (e.g. a
 *      "computer-use" built-in may appear first).
 *   4. Re-confirm the selection line before Enter (guards against a stray
 *      keystroke moving the cursor between capture and send).
 *   5. Confirm the detail menu shows "❯ 1. Reconnect" selected, else abort.
 *      Verified against a real failed server (#373): its menu is
 *      "❯ 1. Reconnect / 2. Disable", Reconnect preselected. A *connected*
 *      server shows "1. View tools / 2. Reconnect / 3. Disable" instead, but
 *      recovery only ever runs against a failed one.
 *   6. Enter, wait ~6s, then re-verify the process-level signal.
 */
export async function attempt_mcp_reconnect(
  tmux_session: string,
  driver: McpDriver = default_mcp_driver,
): Promise<ReconnectResult> {
  driver.send(tmux_session, "/mcp", "Enter");
  await driver.sleep(MCP_RECONNECT_STEP_WAIT_MS);

  let pane = driver.capture(tmux_session);
  if (pane === null) return { ok: false, reason: "pane_unreadable" };
  if (!pane.includes("Manage MCP servers")) {
    driver.send(tmux_session, "Escape");
    return { ok: false, reason: "panel_not_open" };
  }

  let found = false;
  for (let i = 0; i < MCP_MAX_DOWN_PRESSES; i++) {
    pane = driver.capture(tmux_session);
    if (pane === null) return { ok: false, reason: "pane_unreadable" };
    if (selection_line(pane)?.includes("plugin:discord")) {
      found = true;
      break;
    }
    driver.send(tmux_session, "Down");
    await driver.sleep(MCP_RECONNECT_STEP_WAIT_MS);
  }
  if (!found) {
    driver.send(tmux_session, "Escape");
    return { ok: false, reason: "server_not_found" };
  }

  // Re-confirm immediately before Enter — guards against a stray keystroke
  // moving the selection between the last capture and now.
  pane = driver.capture(tmux_session);
  if (pane === null) return { ok: false, reason: "pane_unreadable" };
  if (!selection_line(pane)?.includes("plugin:discord")) {
    driver.send(tmux_session, "Escape");
    return { ok: false, reason: "wrong_selection" };
  }
  driver.send(tmux_session, "Enter");
  await driver.sleep(MCP_RECONNECT_STEP_WAIT_MS);

  pane = driver.capture(tmux_session);
  if (pane === null) return { ok: false, reason: "pane_unreadable" };
  if (!selection_line(pane)?.includes("1. Reconnect")) {
    driver.send(tmux_session, "Escape");
    return { ok: false, reason: "detail_menu_not_shown" };
  }
  driver.send(tmux_session, "Enter");

  await driver.sleep(MCP_RECONNECT_VERIFY_WAIT_MS);
  // The panel stays open after the Reconnect action, so dismiss it back to the
  // prompt regardless of outcome. On failure the caller retries immediately,
  // and a leftover panel would swallow the next attempt's `/mcp` keystrokes —
  // firing whatever menu item happened to be selected instead.
  driver.send(tmux_session, "Escape");
  if (!driver.is_healthy(tmux_session)) {
    return { ok: false, reason: "child_still_missing" };
  }
  return { ok: true };
}

// ── Recovery cycle orchestration (Step 1 x N, then Step 2 fallback) ──

export type RecoveryCycleOutcome = "reconnected" | "fell_back";

/**
 * Run one full recovery cycle for a bot: up to MCP_MAX_RECONNECT_ATTEMPTS
 * scripted `/mcp` Reconnect attempts (Step 1), falling back to `kill_fn()`
 * (Step 2 — kills the tmux session; the caller's existing crash-recovery
 * path picks up the respawn with `--resume` on its next tick) if all of
 * them fail.
 *
 * Runs end-to-end inside a single health-tick invocation (each Reconnect
 * attempt takes only a few seconds) so the caller's per-bot cooldown
 * throttles whole cycles, not individual keystroke-level attempts — this is
 * what makes "≤1 action/10min" and "≤3 failed cycles/30min" compatible
 * (3 cycles x 10min cooldown = 30min, not 3 cycles x 2 attempts x 10min).
 */
export async function run_mcp_recovery_cycle(
  tmux_session: string,
  kill_fn: () => void,
  driver: McpDriver = default_mcp_driver,
): Promise<RecoveryCycleOutcome> {
  for (let attempt = 0; attempt < MCP_MAX_RECONNECT_ATTEMPTS; attempt++) {
    const result = await attempt_mcp_reconnect(tmux_session, driver);
    if (result.ok) return "reconnected";
  }
  kill_fn();
  return "fell_back";
}

// ── Continuous-monitoring state machine (grace + consecutive-fail gate,
//    per-bot cooldown, give-up) ──

export interface McpRecoveryState {
  /** Consecutive health-tick failures since the last healthy reading. */
  consecutive_fails: number;
  /** epoch ms of the last recovery cycle — drives the 10-minute per-bot
   * cooldown between cycles. */
  last_action_ms: number | null;
  /** epoch ms timestamps of failed cycles (recorded via
   * `record_cycle_outcome` when a cycle ends in "fell_back") — drives the
   * give-up count. */
  cycle_fail_timestamps: number[];
  /** epoch ms of the most recent Step 2 (kill+resume) fallback, or null if
   * the last cycle didn't fall back. Set by `record_cycle_outcome`, consumed
   * and cleared by the first healthy tick afterwards — that transition is
   * the "recovered after a fallback" signal the spec wants on #alerts.
   * Routine Step 1 reconnects never set it, so they stay silent. */
  last_fell_back_at: number | null;
  /** Once true, stop acting entirely until the bot is observed healthy
   * again (external recovery or manual intervention resets state). */
  given_up: boolean;
}

function initial_state(): McpRecoveryState {
  return {
    consecutive_fails: 0,
    last_action_ms: null,
    cycle_fail_timestamps: [],
    last_fell_back_at: null,
    given_up: false,
  };
}

export type McpHealthAction =
  | { action: "none" }
  | { action: "recover" }
  /** The bot is healthy again after a Step 2 kill+resume fallback — the
   * caller should post the one-shot recovery notice (spec: #alerts on
   * successful recovery after a fallback). Distinct from "recover", which
   * asks the caller to *start* a recovery cycle. */
  | { action: "notify_recovered" };

/**
 * Decide what (if anything) to do for one bot on one health tick.
 *
 * Mutates `state` in place — the caller owns the map and persists it across
 * ticks. Pure w.r.t. its inputs otherwise (no I/O), so it's a plain unit to
 * test against synthetic tick sequences.
 *
 * When this returns `{action: "recover"}`, the caller should run
 * `run_mcp_recovery_cycle` and report the outcome back via
 * `record_cycle_outcome` — this function only decides *whether* to act.
 *
 * When it returns `{action: "notify_recovered"}`, the bot came back healthy
 * after a Step 2 fallback and the caller should post the one-shot recovery
 * notice; no recovery cycle is needed.
 *
 * @param bot_id - identifies the bot's entry in `state`
 * @param is_healthy - result of has_mcp_child() this tick
 * @param is_idle - whether the bot is idle at the prompt right now. Gates
 *   "recover" — Step 1 drives the TUI, so it must not run mid-turn (spec:
 *   "reuse the existing idle-detection used for injection draining... if
 *   mid-turn, defer to the next health tick"). Deferring does NOT consume
 *   the cooldown budget.
 * @param age_ms - how long the current session has been assigned/spawned
 * @param now_ms - current epoch ms (injectable for testing)
 * @param state - mutable map: bot_id → McpRecoveryState (owned by caller)
 */
export function process_mcp_health_tick(
  bot_id: number,
  is_healthy: boolean,
  is_idle: boolean,
  age_ms: number,
  now_ms: number,
  state: Map<number, McpRecoveryState>,
): McpHealthAction {
  const s = state.get(bot_id) ?? initial_state();

  if (age_ms < MCP_GRACE_PERIOD_MS) {
    state.set(bot_id, { ...s, consecutive_fails: 0 });
    return { action: "none" };
  }

  if (is_healthy) {
    // Healthy — clear everything, including give-up. A bot that recovers
    // (on its own or via our recovery) gets a fresh slate. Clearing also
    // consumes `last_fell_back_at`, so the recovery notice fires exactly
    // once rather than on every healthy tick that follows.
    const recovered_after_fallback = s.last_fell_back_at !== null;
    state.set(bot_id, initial_state());
    return recovered_after_fallback ? { action: "notify_recovered" } : { action: "none" };
  }

  const fails = s.consecutive_fails + 1;

  if (fails < MCP_MIN_CONSECUTIVE_FAILS) {
    state.set(bot_id, { ...s, consecutive_fails: fails });
    return { action: "none" };
  }

  if (s.given_up) {
    state.set(bot_id, { ...s, consecutive_fails: fails });
    return { action: "none" };
  }

  if (s.last_action_ms !== null && now_ms - s.last_action_ms < MCP_RECOVERY_COOLDOWN_MS) {
    state.set(bot_id, { ...s, consecutive_fails: fails });
    return { action: "none" };
  }

  if (!is_idle) {
    // Mid-turn — defer to the next tick without spending cooldown budget.
    state.set(bot_id, { ...s, consecutive_fails: fails });
    return { action: "none" };
  }

  state.set(bot_id, { ...s, consecutive_fails: fails, last_action_ms: now_ms });
  return { action: "recover" };
}

/**
 * Report the outcome of a recovery cycle back into `state`. Call this after
 * `run_mcp_recovery_cycle` resolves, following a `{action: "recover"}` tick.
 *
 * A "reconnected" outcome needs no bookkeeping here — the next health tick
 * will observe `is_healthy: true` and clear the state naturally, silently
 * (spec: routine Step 1 reconnects don't page anyone).
 *
 * A "fell_back" outcome additionally stamps `last_fell_back_at`, so the first
 * healthy tick afterwards returns `{action: "notify_recovered"}` and the
 * caller can post the "recovered after kill+resume" notice.
 *
 * A "fell_back" outcome records a failed-cycle timestamp and, once
 * MCP_GIVEUP_THRESHOLD failed cycles land within MCP_GIVEUP_WINDOW_MS, sets
 * `given_up` so future ticks stay silent instead of spamming recovery
 * attempts (and #alerts) for a bot that isn't responding to any of them.
 *
 * Returns escalation info when this outcome crosses the give-up threshold,
 * or null otherwise.
 */
export function record_cycle_outcome(
  bot_id: number,
  outcome: RecoveryCycleOutcome,
  now_ms: number,
  state: Map<number, McpRecoveryState>,
): { cycle_fail_count: number } | null {
  if (outcome === "reconnected") return null;

  const s = state.get(bot_id) ?? initial_state();
  const window_start = now_ms - MCP_GIVEUP_WINDOW_MS;
  const recent_cycle_fails = [...s.cycle_fail_timestamps.filter((t) => t > window_start), now_ms];
  const given_up = recent_cycle_fails.length >= MCP_GIVEUP_THRESHOLD;

  state.set(bot_id, {
    ...s,
    cycle_fail_timestamps: recent_cycle_fails,
    last_fell_back_at: now_ms,
    given_up,
  });

  return given_up ? { cycle_fail_count: recent_cycle_fails.length } : null;
}

/** Remove state entries for bots no longer assigned (released, parked) so
 * the map doesn't grow unbounded. Call periodically from the health loop. */
export function prune_mcp_state(
  state: Map<number, McpRecoveryState>,
  assigned_bot_ids: Set<number>,
): void {
  for (const id of state.keys()) {
    if (!assigned_bot_ids.has(id)) {
      state.delete(id);
    }
  }
}

// ── Post-spawn verification (grace-period poll, no state machine) ──

/**
 * Poll for the MCP child to appear after a fresh spawn. Distinct from the
 * continuous-monitoring tick machinery above — this is a one-shot wait used
 * right after `start_tmux` + `wait_for_bot_ready`, mirroring the shape of
 * `wait_for_bot_ready` itself (poll loop with a bounded timeout).
 */
export async function wait_for_mcp_child(
  tmux_session: string,
  opts?: { timeout_ms?: number; poll_ms?: number },
  has_child_fn: (session: string) => boolean = has_mcp_child,
): Promise<boolean> {
  const timeout = opts?.timeout_ms ?? 15_000;
  const poll = opts?.poll_ms ?? 1_000;
  const start = Date.now();

  if (has_child_fn(tmux_session)) return true;

  while (Date.now() - start < timeout) {
    await new Promise((resolve) => setTimeout(resolve, poll));
    if (has_child_fn(tmux_session)) return true;
  }
  return false;
}
