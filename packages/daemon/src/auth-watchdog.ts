/**
 * Auth-recovery watchdog (#343).
 *
 * The shared `rengen` Claude credential (one OAuth cred backing ~7 canal-street +
 * sonar pool bots) expires periodically, silently taking down every bot on that
 * account. This watchdog collapses the previously-manual recovery into an
 * automated loop:
 *
 *   detect (canary probe + re-login deadline) → quarantine poisoned sessions →
 *   alert the owner with a re-login URL (or the exact command to run) →
 *   accept the pasted code via Discord → complete the login → recycle the
 *   affected bots → resolve.
 *
 * Detection patterns are ported from `~/.lobsterfarm/bin/auth-probe.sh`.
 *
 * Safety invariants:
 *   - The canary probe runs in a FRESH bounded process and NEVER kills or masks
 *     a running pool bot (read-only w.r.t. the pool).
 *   - Network-class failures (ECONNRESET / timeouts / 5xx) are NOT auth incidents
 *     and never trigger a re-login.
 *   - The OAuth code and token values are NEVER logged.
 *   - The code-submission handler only accepts the code from the configured
 *     Discord owner (`config.discord.user_id`) — a hard security boundary.
 *
 * Alarm invariants (#363 — three defects that made this thing cry wolf):
 *   - Only the *re-login deadline* (`refreshTokenExpiresAt`) opens a proactive
 *     incident. `expiresAt` is the access token; the CLI refreshes it silently
 *     every few hours and no human can act on it.
 *   - One open incident per credential, held until the credential recovers.
 *     Every path through `open_incident` persists, so a failure downstream can
 *     never re-alert on the next tick.
 *   - An incident always carries an actionable instruction: the authorize URL
 *     when we captured one, otherwise the exact `CLAUDE_CONFIG_DIR=… claude`
 *     command. Never a bare "will retry".
 */

import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import {
  claude_dir,
  entity_config_path,
  entity_dir,
  expand_home,
  lobsterfarm_dir,
} from "@lobster-farm/shared";
import { EmbedBuilder } from "discord.js";
import { ALERT_COLOR_AMBER, ALERT_COLOR_GREEN, ALERT_COLOR_RED } from "./alert-router.js";
import { resolve_binary } from "./env.js";
import type { EntityRegistry } from "./registry.js";
import * as sentry from "./sentry.js";

const execFileAsync = promisify(execFile);

// ── Constants ──

/** The default account's keychain service name (CLAUDE_CONFIG_DIR unset → ~/.claude). */
const DEFAULT_KEYCHAIN_SERVICE = "Claude Code-credentials";

/** Stable substring of the Claude CLI's "Not logged in · Please run /login"
 * message. A session transcript containing this is poisoned — resuming it would
 * spread the logged-out state channel-to-channel. */
const POISON_MARKER = "Please run /login";

/** Bounded timeout for the canary probe (fresh process). ~50s mirrors auth-probe.sh. */
const CANARY_TIMEOUT_MS = 50_000;

/** Sentinel key for the default account (no CLAUDE_CONFIG_DIR override). */
const DEFAULT_KEY = "default";

/**
 * Width of the detached tmux pane the `/login` flow is driven in.
 *
 * We fix it here (rather than letting tmux pick) because `extract_authorize_url`
 * uses it to tell a hard-wrapped URL row from a row that simply ended: an
 * authorize URL is ~450 chars, so it renders across three rows of this width.
 */
export const TMUX_PANE_WIDTH = 220;

// ── Types ──

/**
 * Result of a canary probe. `ok` is true only when the credential authenticated
 * successfully. `signal` classifies the failure for incident routing — only
 * `logged_out` / `invalid_grant` are auth incidents; the rest are transient.
 */
export type ProbeSignal =
  | "ok"
  | "logged_out"
  | "invalid_grant"
  | "network"
  | "rate_limit"
  | "other";

export interface ProbeResult {
  ok: boolean;
  signal: ProbeSignal;
}

/** A distinct Claude credential (config dir) the watchdog monitors, plus the
 * entities/bots that ride on it (used for recycle scope + alert wording). */
export interface MonitoredConfigDir {
  /** Dedup key — the config dir path, or "default" for the base account. */
  key: string;
  /** Absolute CLAUDE_CONFIG_DIR path, or null for the default account. */
  config_dir: string | null;
  /** Entity ids using this credential. */
  entity_ids: string[];
  /** Human-readable entity names, for alert copy. */
  entity_names: string[];
  /** A cwd that is already trusted under this credential — used for the canary. */
  probe_cwd: string;
}

/** A held re-login flow: the URL to visit, the OAuth `state` param (used to match
 * the pasted code back to this incident), and the tmux session driving `/login`. */
export interface ReloginHandle {
  url: string;
  state: string;
  tmux_session: string;
}

/** Persisted incident — one open re-login per config dir (dedup). */
export interface AuthIncident {
  key: string;
  config_dir: string | null;
  entity_ids: string[];
  entity_names: string[];
  /** OAuth state param — matches an inbound pasted code to this incident.
   * Empty when no URL was captured (the alert carries a manual command instead,
   * and `matches_state` never matches an empty state). */
  state: string;
  /** tmux session driving the /login flow, awaiting the code. Null when the
   * incident is manual-command only. */
  tmux_session: string | null;
  /** Authorize URL, or null when it could not be captured. */
  url: string | null;
  /** Alert channel the incident embed was posted to. */
  channel_id: string;
  /** Top-level embed message id (for editing to resolved). */
  message_id: string | null;
  /** Incident thread id (for updates). */
  thread_id: string | null;
  /** "outage" = already logged out; "expiring" = proactive pre-expiry warning. */
  kind: "outage" | "expiring";
  created_at: string;
}

export type AuthIncidentsState = Record<string, AuthIncident>;

// ── Narrow collaborator interfaces (keeps the watchdog testable) ──

/** The single pool capability the watchdog needs: recycle stale-OAuth bots on a
 * credential so they respawn fresh. Implemented by BotPool. */
export interface RecyclePool {
  recycle_stale_oauth_on_config_dir(config_dir: string | null): number;
}

/** The Discord surface the watchdog needs. Implemented by DiscordBot. */
export interface WatchdogDiscord {
  send_embed(channel_id: string, embed: EmbedBuilder): Promise<string | null>;
  create_thread_from_message(
    channel_id: string,
    message_id: string,
    name: string,
  ): Promise<string | null>;
  send_to_thread(thread_id: string, content: string): Promise<void>;
  edit_message_embed(channel_id: string, message_id: string, embed: EmbedBuilder): Promise<boolean>;
  send(channel_id: string, content: string): Promise<void>;
  find_command_center_channel(): Promise<string | null>;
}

// ── Keychain service resolution ──

/**
 * Resolve the macOS keychain service name for a config dir's OAuth credential.
 *
 * Default account (config_dir null / ~/.claude) → "Claude Code-credentials".
 * Per-config-dir → "Claude Code-credentials-<hash>", where <hash> is the first
 * 8 hex chars of SHA-256 over the absolute config dir path. Verified: the
 * rengen dir `/Users/farm/.lobsterfarm/shared/claude-config-rengen` hashes to
 * `4c64f669`, matching the live keychain entry.
 */
export function keychain_service_for(config_dir: string | null): string {
  if (!config_dir) return DEFAULT_KEYCHAIN_SERVICE;
  const normalized = config_dir.replace(/\/+$/, "");
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 8);
  return `${DEFAULT_KEYCHAIN_SERVICE}-${hash}`;
}

// ── Probe classification (ported from auth-probe.sh classify()) ──

/**
 * Classify canary output into a signal. Returns null when no failure marker is
 * present (caller then checks for a success reply). Order matters: auth markers
 * win over transient ones so a "Please run /login" is never mistaken for network.
 */
export function classify_probe_output(text: string): Exclude<ProbeSignal, "ok"> | null {
  // Auth failures — the only signals that open an incident.
  if (/Please run \/login|Not logged in|logged_?out/i.test(text)) return "logged_out";
  if (/invalid_grant/i.test(text)) return "invalid_grant";
  // Rate limiting — transient, not an auth incident.
  if (/\b429\b|rate.?limit|overloaded/i.test(text)) return "rate_limit";
  // Network / server-class — transient, MUST NOT trigger re-login.
  if (
    /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|\b5[0-9][0-9]\b/i.test(
      text,
    )
  ) {
    return "network";
  }
  return null;
}

/** Raw canary invocation result. Injectable so tests never spawn a real process. */
export interface CanaryRun {
  stdout: string;
  stderr: string;
  code: number | null;
  timed_out: boolean;
}

export type CanaryRunner = (config_dir: string | null, cwd: string) => Promise<CanaryRun>;

/** Default canary: a fresh, bounded `claude -p` process. Never touches the pool. */
const default_canary_runner: CanaryRunner = async (config_dir, cwd) => {
  const claude_bin = resolve_binary("claude");
  const env = { ...process.env };
  if (config_dir) {
    env.CLAUDE_CONFIG_DIR = config_dir;
  } else {
    delete env.CLAUDE_CONFIG_DIR;
  }
  try {
    const { stdout, stderr } = await execFileAsync(claude_bin, ["-p", "Reply with exactly: OK"], {
      cwd,
      env,
      timeout: CANARY_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return { stdout, stderr, code: 0, timed_out: false };
  } catch (err) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      code?: number;
      killed?: boolean;
      signal?: string;
    };
    // execFile marks a timeout kill via `killed` + SIGTERM.
    const timed_out = !!e.killed && (e.signal === "SIGTERM" || e.signal === undefined);
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      code: typeof e.code === "number" ? e.code : null,
      timed_out,
    };
  }
};

/**
 * Probe a credential with a fresh canary process. Returns `ok` only on a clean
 * "OK" reply; otherwise classifies the failure. A timeout is network-class
 * (never an auth incident).
 */
export async function probe_credential(
  config_dir: string | null,
  cwd: string,
  runner: CanaryRunner = default_canary_runner,
): Promise<ProbeResult> {
  const run = await runner(config_dir, cwd);
  if (run.timed_out) return { ok: false, signal: "network" };

  const combined = `${run.stdout}\n${run.stderr}`;
  const sig = classify_probe_output(combined);
  if (sig) return { ok: false, signal: sig };

  if (run.code === 0 && /\bOK\b/.test(run.stdout)) return { ok: true, signal: "ok" };
  return { ok: false, signal: "other" };
}

// ── Keychain expiry (best-effort; null when unresolved) ──

export type KeychainReader = (service: string) => Promise<string | null>;

/** Default keychain reader — reads the raw credential JSON. The value is parsed
 * in-process for `expiresAt` only and NEVER logged. */
const default_keychain_reader: KeychainReader = async (service) => {
  try {
    const { stdout } = await execFileAsync(
      "security",
      ["find-generic-password", "-s", service, "-w"],
      { timeout: 5_000, maxBuffer: 256 * 1024 },
    );
    return stdout;
  } catch {
    return null;
  }
};

/**
 * Minutes until this credential genuinely needs a human at a keyboard, or null
 * when that is unresolvable (keychain miss, unparseable, older credential
 * format). Best-effort — the canary probe is the definitive auth signal; this
 * only drives the proactive warning.
 *
 * Reads `refreshTokenExpiresAt`, NOT `expiresAt`. That distinction is the whole
 * point (#363): a stored credential carries two clocks.
 *
 *   expiresAt             — the access token. Hours. The CLI silently swaps in
 *                           a new one via the refresh token. Nobody can act on
 *                           it, and alarming on it produced a permanent siren
 *                           over two healthy accounts.
 *   refreshTokenExpiresAt — the session. Weeks. When this lapses, refreshing is
 *                           no longer possible and only `/login` fixes it.
 *
 * A credential exposing only `expiresAt` yields null: there is nothing here a
 * human could act on, so it must not open an incident. Only `expiresAt`-style
 * numbers are read; no token material is returned, logged, or persisted.
 */
export async function read_relogin_deadline_minutes(
  config_dir: string | null,
  reader: KeychainReader = default_keychain_reader,
  now: () => number = Date.now,
): Promise<number | null> {
  const raw = await reader(keychain_service_for(config_dir));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      claudeAiOauth?: { refreshTokenExpiresAt?: number };
      refreshTokenExpiresAt?: number;
    };
    const oauth = parsed.claudeAiOauth ?? parsed;
    const deadline = oauth.refreshTokenExpiresAt;
    if (typeof deadline !== "number") return null;
    return Math.round((deadline - now()) / 60_000);
  } catch {
    // Never surface token bytes in a log line.
    return null;
  }
}

// ── Poisoned-session quarantine ──

/** The projects/ root for a config dir (default account → ~/.claude/projects). */
function projects_root(config_dir: string | null): string {
  const base = config_dir ?? claude_dir();
  return join(base, "projects");
}

async function walk_jsonl(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk_jsonl(full)));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Move every session transcript under `<config_dir>/projects/` that contains the
 * logged-out marker into a timestamped quarantine dir, preserving relative paths
 * so nothing is clobbered. Clean transcripts are left untouched. Returns the
 * count quarantined.
 *
 * This is exactly the manual step Pat performed by hand — it stops the breakage
 * from spreading channel-to-channel when a poisoned session is resumed.
 */
export async function quarantine_poisoned_sessions(config_dir: string | null): Promise<number> {
  const root = projects_root(config_dir);
  const files = await walk_jsonl(root);
  if (files.length === 0) return 0;

  const base = config_dir ?? claude_dir();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const quarantine_base = join(base, "projects-quarantine", stamp);

  let count = 0;
  for (const file of files) {
    let content: string;
    try {
      content = await readFile(file, "utf-8");
    } catch {
      continue;
    }
    if (!content.includes(POISON_MARKER)) continue;

    const rel = relative(root, file);
    const dest = join(quarantine_base, rel);
    try {
      await mkdir(dirname(dest), { recursive: true });
      await rename(file, dest);
      count++;
      console.warn(`[auth-watchdog] Quarantined poisoned session: ${rel}`);
    } catch (err) {
      console.error(`[auth-watchdog] Failed to quarantine ${rel}: ${String(err)}`);
    }
  }
  return count;
}

// ── Config-dir enumeration ──

/** Whether an entity still exists on disk. The daemon's in-memory registry is
 * only refreshed on `POST /reload`, so it can name entities deleted days ago —
 * which is how incident alerts ended up citing entities that were gone (#363). */
export type EntityExists = (entity_id: string) => boolean;

/**
 * Distinct credentials to monitor: every entity's `subscription.claude_config_dir`
 * plus the default account. Entities are grouped per credential so the incident
 * flow knows which bots to recycle and how to word the alert.
 *
 * Entities whose config file no longer exists are skipped, so alert copy names
 * only entities that are live right now — never a name cached in the registry
 * (or in an already-open incident) from before a deletion.
 */
export function enumerate_monitored_config_dirs(
  registry: EntityRegistry,
  config: LobsterFarmConfig,
  entity_exists: EntityExists = (id) => existsSync(entity_config_path(config.paths, id)),
): MonitoredConfigDir[] {
  const by_key = new Map<string, MonitoredConfigDir>();

  // Default account — always monitored. cwd = homedir (trusted for the operator).
  by_key.set(DEFAULT_KEY, {
    key: DEFAULT_KEY,
    config_dir: null,
    entity_ids: [],
    entity_names: [],
    probe_cwd: homedir(),
  });

  for (const entity of registry.get_active()) {
    if (!entity_exists(entity.entity.id)) continue;
    const raw = entity.entity.subscription?.claude_config_dir;
    const config_dir = raw ? expand_home(raw) : null;
    const key = config_dir ?? DEFAULT_KEY;

    const existing = by_key.get(key);
    if (existing) {
      existing.entity_ids.push(entity.entity.id);
      existing.entity_names.push(entity.entity.name);
      // Prefer an entity dir as the probe cwd — already trusted under this cred.
      if (config_dir && existing.probe_cwd === homedir()) {
        existing.probe_cwd = entity_dir(config.paths, entity.entity.id);
      }
    } else {
      by_key.set(key, {
        key,
        config_dir,
        entity_ids: [entity.entity.id],
        entity_names: [entity.entity.name],
        probe_cwd: entity_dir(config.paths, entity.entity.id),
      });
    }
  }

  return [...by_key.values()];
}

// ── Interactive re-login driver (tmux) ──

function tmux(args: string[]): void {
  execFileSync("tmux", args, { stdio: "ignore", timeout: 5_000 });
}

function tmux_capture(session: string): string {
  try {
    // -J joins rows tmux itself wrapped. It does NOT join rows the TUI rendered
    // as separate rows, which is why `extract_authorize_url` still has to stitch.
    return execFileSync("tmux", ["capture-pane", "-t", session, "-p", "-J"], {
      encoding: "utf-8",
      timeout: 5_000,
    });
  } catch {
    return "";
  }
}

function tmux_alive(session: string): boolean {
  try {
    execFileSync("tmux", ["has-session", "-t", session], { stdio: "ignore", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

async function wait_for<T>(
  fn: () => T | null,
  timeout_ms: number,
  poll_ms = 500,
): Promise<T | null> {
  const start = Date.now();
  while (Date.now() - start < timeout_ms) {
    const v = fn();
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, poll_ms));
  }
  return fn();
}

/** Start of the authorize URL as the Claude CLI prints it. */
const AUTHORIZE_URL_START = /https:\/\/claude\.com\/[^\s"'`]*oauth\/authorize\?/;

/** Characters legal in a URL. A pane row made only of these, immediately after a
 * row that filled the pane, is a continuation of that row's URL. */
const URL_ROW_CHARS = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;

/**
 * Pull the OAuth authorize URL out of a captured `/login` pane, rejoining the
 * rows tmux split it across.
 *
 * This is the fix for the defect that made the watchdog useless (#363): the
 * authorize URL is ~450 characters, so Claude Code renders it as three
 * consecutive `TMUX_PANE_WIDTH`-column rows. The previous single-line regex
 * matched only the first row — which ends mid-`scope` parameter, long before
 * `state=` — so the handle was discarded and every one of 745 attempts logged
 * "Could not capture the OAuth authorize URL".
 *
 * A row is treated as continuing only when it exactly fills the pane (so the
 * text really was cut off) and the next row is URL-legal throughout (so we
 * never swallow the "Paste code here" prompt that follows). The result must
 * parse and carry a `state` param, or we report failure rather than hand the
 * owner a truncated link.
 */
export function extract_authorize_url(pane: string, pane_width = TMUX_PANE_WIDTH): string | null {
  const rows = pane.split("\n").map((row) => row.replace(/\s+$/, ""));

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] ?? "";
    const start = AUTHORIZE_URL_START.exec(row);
    if (!start) continue;

    let url = row.slice(start.index);
    // Walk forward while the row we just consumed filled the pane exactly —
    // that is the only case where the text really was cut off mid-URL.
    for (let j = i; (rows[j] ?? "").length === pane_width; j++) {
      const next = rows[j + 1];
      if (next === undefined || !URL_ROW_CHARS.test(next)) break;
      url += next;
    }

    try {
      if (new URL(url).searchParams.get("state")) return url;
    } catch {
      // Not a usable URL — keep scanning the rest of the pane.
    }
  }
  return null;
}

/**
 * The exact command a human runs to re-authenticate this credential. Non-default
 * accounts need the `CLAUDE_CONFIG_DIR` prefix or the login lands on the wrong
 * keychain entry and the alarm never clears.
 */
export function relogin_command(config_dir: string | null): string {
  return config_dir ? `CLAUDE_CONFIG_DIR=${config_dir} claude` : "claude";
}

/** Manual re-auth instructions, used whenever no authorize URL was captured. */
function manual_instruction(config_dir: string | null): string {
  return [
    "**Re-auth manually** — run this on the farm host, then `/login` inside the session:",
    "```",
    relogin_command(config_dir),
    "```",
  ].join("\n");
}

/**
 * Drive a dedicated tmux `claude` session through the trust prompt → `/login` →
 * subscription method, and capture the OAuth authorize URL. The session is kept
 * ALIVE awaiting the pasted code (submit_code drives the rest).
 *
 * Best-effort and inherently interactive — not unit-tested. Returns null if the
 * URL can't be captured within the timeout.
 */
export async function generate_relogin_url(
  config_dir: string | null,
  cwd: string,
): Promise<ReloginHandle | null> {
  const claude_bin = resolve_binary("claude");
  const session = `auth-login-${keychain_service_for(config_dir).slice(-8)}-${randomUUID().slice(0, 4)}`;

  // Fresh session — never reuse a stale one.
  try {
    tmux(["kill-session", "-t", session]);
  } catch {
    /* not running */
  }

  const cmd = config_dir
    ? `CLAUDE_CONFIG_DIR=${config_dir} exec ${claude_bin}`
    : `exec ${claude_bin}`;

  try {
    tmux([
      "new-session",
      "-d",
      "-s",
      session,
      "-x",
      String(TMUX_PANE_WIDTH),
      "-y",
      "50",
      "-c",
      cwd,
      cmd,
    ]);
  } catch (err) {
    console.error(`[auth-watchdog] Failed to start login session: ${String(err)}`);
    return null;
  }

  // Accept a trust prompt if one appears (default option is "yes" → Enter).
  await wait_for(() => {
    const pane = tmux_capture(session);
    if (/trust the files|Do you trust/i.test(pane)) {
      tmux(["send-keys", "-t", session, "Enter"]);
      return true;
    }
    if (/❯|bypass permissions|Welcome to Claude/i.test(pane)) return true;
    return null;
  }, 15_000);

  // Open the login flow.
  tmux(["send-keys", "-t", session, "-l", "/login"]);
  tmux(["send-keys", "-t", session, "Enter"]);

  // Select method 1 (Claude subscription) when the menu appears, then read URL.
  const handle = await wait_for<ReloginHandle>(() => {
    const pane = tmux_capture(session);
    const url = extract_authorize_url(pane);
    if (url) {
      // extract_authorize_url only returns a URL that parses and carries `state`.
      const state = new URL(url).searchParams.get("state") as string;
      return { url, state, tmux_session: session };
    }
    // Still on the method menu (never re-send once a URL has been printed).
    if (!AUTHORIZE_URL_START.test(pane) && /subscription|Claude account|Log in with/i.test(pane)) {
      tmux(["send-keys", "-t", session, "-l", "1"]);
      tmux(["send-keys", "-t", session, "Enter"]);
    }
    return null;
  }, 30_000);

  if (!handle) {
    console.warn("[auth-watchdog] Could not capture the OAuth authorize URL from the login pane");
    try {
      tmux(["kill-session", "-t", session]);
    } catch {
      /* ignore */
    }
    return null;
  }

  return handle;
}

/**
 * Paste the OAuth code into a held login session and confirm success. Verifies
 * the pane shows a success marker ("Login successful" / "Claude Max"). The code
 * is NEVER logged.
 */
export async function submit_code(tmux_session: string, code: string): Promise<boolean> {
  if (!tmux_alive(tmux_session)) return false;

  tmux(["send-keys", "-t", tmux_session, "-l", code]);
  tmux(["send-keys", "-t", tmux_session, "Enter"]);

  const ok = await wait_for<boolean>(() => {
    const pane = tmux_capture(tmux_session);
    if (/Login successful|Logged in|Claude Max|subscription active/i.test(pane)) return true;
    if (/invalid|error|failed|expired/i.test(pane)) return false;
    return null;
  }, 20_000);

  return ok === true;
}

// ── Incident persistence (atomic write, keyed per config dir) ──

const AUTH_INCIDENTS_FILE = "auth-incidents.json";

function incidents_path(config: LobsterFarmConfig): string {
  return join(lobsterfarm_dir(config.paths), "state", AUTH_INCIDENTS_FILE);
}

export async function load_auth_incidents(config: LobsterFarmConfig): Promise<AuthIncidentsState> {
  try {
    const content = await readFile(incidents_path(config), "utf-8");
    const data: unknown = JSON.parse(content);
    if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
    return data as AuthIncidentsState;
  } catch {
    return {};
  }
}

export async function save_auth_incidents(
  state: AuthIncidentsState,
  config: LobsterFarmConfig,
): Promise<void> {
  const path = incidents_path(config);
  const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf-8");
  await rename(tmp, path);
}

// ── Watchdog ──

export interface AuthWatchdogDeps {
  config: LobsterFarmConfig;
  registry: EntityRegistry;
  pool: RecyclePool;
  discord: WatchdogDiscord | null;
  /** Overridable side effects (default to the real implementations). */
  probe?: (config_dir: string | null, cwd: string) => Promise<ProbeResult>;
  /** Minutes until a human must re-login (refresh-token expiry), or null. */
  relogin_deadline?: (config_dir: string | null) => Promise<number | null>;
  quarantine?: (config_dir: string | null) => Promise<number>;
  gen_url?: (config_dir: string | null, cwd: string) => Promise<ReloginHandle | null>;
  submit?: (tmux_session: string, code: string) => Promise<boolean>;
  /** Liveness check for a held login session (default: real tmux has-session). */
  session_alive?: (tmux_session: string) => boolean;
  /** Best-effort teardown of a held login session (default: real tmux kill-session). */
  kill_session?: (tmux_session: string) => void;
  /** Whether an entity still exists on disk (default: real fs check). */
  entity_exists?: EntityExists;
  now?: () => number;
}

/**
 * What a credential currently needs.
 *
 *   healthy   — authenticating, and no human-actionable deadline in sight.
 *   transient — the probe failed for a network/rate reason. Says nothing about
 *               auth: never opens an incident, never resolves one.
 *   expiring  — authenticating, but the re-login deadline is inside the warning
 *               window. A refresh cannot extend it.
 *   outage    — logged out or the grant was rejected. Bots on it are down.
 */
export type CredentialAssessment =
  | { state: "healthy" }
  | { state: "transient" }
  | { state: "expiring"; minutes: number }
  | { state: "outage" };

/** Human label for a credential in log lines (never the credential itself). */
function credential_label(config_dir: string | null): string {
  return config_dir ?? "default account";
}

/** Alert copy for the entities riding on a credential. */
function entities_label(entity_names: string[]): string {
  return entity_names.length > 0 ? entity_names.join(", ") : "shared/default bots";
}

/** Compact, human-readable duration for alert copy. */
function format_minutes(minutes: number): string {
  if (minutes <= 0) return "less than a minute";
  if (minutes < 60) return `${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${String(hours)}h ${String(minutes % 60)}m`;
  return `${String(Math.floor(hours / 24))}d ${String(hours % 24)}h`;
}

export class AuthWatchdog {
  private readonly config: LobsterFarmConfig;
  private readonly registry: EntityRegistry;
  private readonly pool: RecyclePool;
  private readonly discord: WatchdogDiscord | null;

  private readonly probe: NonNullable<AuthWatchdogDeps["probe"]>;
  private readonly relogin_deadline: NonNullable<AuthWatchdogDeps["relogin_deadline"]>;
  private readonly quarantine: NonNullable<AuthWatchdogDeps["quarantine"]>;
  private readonly gen_url: NonNullable<AuthWatchdogDeps["gen_url"]>;
  private readonly submit: NonNullable<AuthWatchdogDeps["submit"]>;
  private readonly session_alive: NonNullable<AuthWatchdogDeps["session_alive"]>;
  private readonly kill_session: NonNullable<AuthWatchdogDeps["kill_session"]>;
  private readonly entity_exists: EntityExists;
  private readonly now: () => number;

  private timer: ReturnType<typeof setInterval> | null = null;
  /** Guards against overlapping ticks (a probe can take ~50s). */
  private ticking = false;

  constructor(deps: AuthWatchdogDeps) {
    this.config = deps.config;
    this.registry = deps.registry;
    this.pool = deps.pool;
    this.discord = deps.discord;
    this.probe = deps.probe ?? probe_credential;
    this.relogin_deadline = deps.relogin_deadline ?? ((dir) => read_relogin_deadline_minutes(dir));
    this.quarantine = deps.quarantine ?? quarantine_poisoned_sessions;
    this.gen_url = deps.gen_url ?? generate_relogin_url;
    this.submit = deps.submit ?? submit_code;
    this.session_alive = deps.session_alive ?? tmux_alive;
    this.entity_exists =
      deps.entity_exists ?? ((id) => existsSync(entity_config_path(deps.config.paths, id)));
    this.now = deps.now ?? Date.now;
    this.kill_session =
      deps.kill_session ??
      ((s) => {
        try {
          tmux(["kill-session", "-t", s]);
        } catch {
          /* not running */
        }
      });
  }

  /** Start the periodic watchdog loop (no-op when disabled in config). */
  start(): void {
    const cfg = this.config.auth_watchdog;
    if (!cfg.enabled) {
      console.log("[auth-watchdog] Disabled via config");
      return;
    }
    const interval_ms = cfg.interval_minutes * 60_000;
    console.log(
      `[auth-watchdog] Started (every ${String(cfg.interval_minutes)}m, ` +
        `warn < ${format_minutes(cfg.expiry_warn_minutes)} to re-login deadline)`,
    );
    // Kick one tick shortly after boot, then on the interval.
    this.timer = setInterval(() => void this.tick(), interval_ms);
    setTimeout(() => void this.tick(), 5_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One watchdog pass. Public for testability. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const monitored = enumerate_monitored_config_dirs(
        this.registry,
        this.config,
        this.entity_exists,
      );
      for (const m of monitored) {
        try {
          await this.evaluate(m);
        } catch (err) {
          // One bad credential must not stop the others from being checked.
          console.error(
            `[auth-watchdog] Evaluation failed for ${credential_label(m.config_dir)}: ${String(err)}`,
          );
          sentry.captureException(err, {
            tags: { module: "auth-watchdog", action: "evaluate" },
          });
        }
      }
    } catch (err) {
      console.error(`[auth-watchdog] tick failed: ${String(err)}`);
      sentry.captureException(err, { tags: { module: "auth-watchdog", action: "tick" } });
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Decide what this credential needs right now.
   *
   * The probe is the authority on whether auth works. The re-login deadline is
   * only consulted when it does — a network blip must never be read as expiry,
   * and an access token about to roll over must never be read as anything.
   */
  private async assess(m: MonitoredConfigDir): Promise<CredentialAssessment> {
    const probe = await this.probe(m.config_dir, m.probe_cwd);
    if (!probe.ok) {
      return probe.signal === "logged_out" || probe.signal === "invalid_grant"
        ? { state: "outage" }
        : { state: "transient" };
    }
    const minutes = await this.relogin_deadline(m.config_dir);
    if (minutes !== null && minutes < this.config.auth_watchdog.expiry_warn_minutes) {
      return { state: "expiring", minutes };
    }
    return { state: "healthy" };
  }

  /**
   * Reconcile one credential against its open incident, if any. Exactly one of:
   * open, resolve, update in place, or do nothing. Never re-alert.
   */
  private async evaluate(m: MonitoredConfigDir): Promise<void> {
    const assessment = await this.assess(m);
    const incidents = await load_auth_incidents(this.config);
    const open = incidents[m.key];

    if (!open) {
      if (assessment.state === "outage" || assessment.state === "expiring") {
        await this.open_incident(m, assessment);
      }
      return;
    }

    if (assessment.state === "healthy") {
      await this.auto_resolve(open, m);
      return;
    }
    // Transient: the credential's auth state is unknown this pass. Hold the
    // incident exactly as it is — neither escalate nor falsely resolve.
    if (assessment.state === "transient") return;

    await this.update_open_incident(open, m, assessment);
  }

  /** The credential recovered — close the incident and bring its bots back. */
  private async auto_resolve(incident: AuthIncident, m: MonitoredConfigDir): Promise<void> {
    console.log(
      `[auth-watchdog] ${credential_label(m.config_dir)} is authenticating again — resolving incident`,
    );
    const recycled = this.pool.recycle_stale_oauth_on_config_dir(m.config_dir);
    const suffix = recycled > 0 ? ` (recycled ${String(recycled)} bot(s))` : "";
    await this.resolve_incident(
      incident,
      `✅ Claude auth healthy again — **${entities_label(m.entity_names)}** back online${suffix}.`,
    );
    if (incident.tmux_session) this.kill_session(incident.tmux_session);
  }

  /**
   * The credential is still unhealthy. Keep the single open incident, but keep
   * it *truthful*: re-word it from the live registry, escalate a warning that
   * became an outage, and swap a dead one-time link for the manual command.
   */
  private async update_open_incident(
    incident: AuthIncident,
    m: MonitoredConfigDir,
    assessment: { state: "outage" } | { state: "expiring"; minutes: number },
  ): Promise<void> {
    const updated: AuthIncident = {
      ...incident,
      entity_ids: m.entity_ids,
      entity_names: m.entity_names,
    };
    const notes: string[] = [];
    let changed = incident.entity_names.join(" ") !== m.entity_names.join(" ");

    if (assessment.state !== incident.kind) {
      updated.kind = assessment.state;
      changed = true;
      if (assessment.state === "outage") {
        const quarantined = await this.quarantine(m.config_dir);
        notes.push(
          `🚨 Escalated — the credential is now logged out and every bot on it is down. Quarantined **${String(quarantined)}** poisoned session(s).`,
        );
      } else {
        notes.push(
          "The credential is authenticating again, but a re-login is still due before the deadline below.",
        );
      }
    }

    // A captured authorize URL is bound to its login process (PKCE). Once that
    // tmux session dies the link is dead, so replace it in place rather than
    // dropping the incident and re-alerting on the next tick.
    if (updated.tmux_session && !this.session_alive(updated.tmux_session)) {
      console.warn(
        `[auth-watchdog] Login session for ${incident.key} is gone — falling back to the manual command`,
      );
      updated.tmux_session = null;
      updated.url = null;
      updated.state = "";
      changed = true;
      notes.push(
        `The one-time re-auth link has expired along with its login session.\n\n${manual_instruction(m.config_dir)}`,
      );
    }

    if (changed) {
      const incidents = await load_auth_incidents(this.config);
      incidents[incident.key] = updated;
      await save_auth_incidents(incidents, this.config);
    }
    for (const note of notes) await this.post_incident_update(updated, note);
  }

  /** Post a follow-up into an incident's thread (or its channel as a fallback). */
  private async post_incident_update(incident: AuthIncident, content: string): Promise<void> {
    if (!this.discord) return;
    if (incident.thread_id) {
      await this.discord.send_to_thread(incident.thread_id, content);
      return;
    }
    await this.discord.send(incident.channel_id, content);
  }

  private async resolve_alert_channel(): Promise<string | null> {
    const configured = this.config.auth_watchdog.alert_channel_id;
    if (configured) return configured;
    if (this.discord) return this.discord.find_command_center_channel();
    return null;
  }

  /**
   * Open the one re-login incident for a credential: quarantine poisoned
   * sessions (outage only), capture an authorize URL, alert the owner, persist.
   *
   * Persisting is unconditional once the alert is posted — including when no URL
   * could be captured. The old code returned early on that path without writing
   * state, so every 5-minute tick re-opened the same incident and re-alerted;
   * that is the loop #363 is about. The alert stays actionable either way: a URL
   * the owner can click, or the exact command they can run.
   */
  private async open_incident(
    m: MonitoredConfigDir,
    assessment: { state: "outage" } | { state: "expiring"; minutes: number },
  ): Promise<void> {
    const kind = assessment.state;
    const label = credential_label(m.config_dir);
    console.warn(
      `[auth-watchdog] Opening ${kind} incident for ${label} ` +
        `(entities: ${m.entity_names.join(", ") || "none"})`,
    );

    // Resolve the destination before doing anything with side effects — an
    // unreachable Discord shouldn't leave an orphaned login session behind.
    const channel_id = await this.resolve_alert_channel();
    if (!channel_id) {
      console.error("[auth-watchdog] No alert channel resolved — cannot post incident");
      return;
    }

    const quarantined = kind === "outage" ? await this.quarantine(m.config_dir) : 0;
    const handle = await this.gen_url(m.config_dir, m.probe_cwd);
    if (!handle) {
      console.warn(
        `[auth-watchdog] No authorize URL for ${label} — alerting with the manual re-login command`,
      );
    }

    const owner = this.config.discord?.user_id;
    const mention = owner ? `<@${owner}> ` : "";
    const entities_line = entities_label(m.entity_names);

    const title =
      kind === "outage"
        ? `\u{1f6a8} Claude auth down — ${label}`
        : `⚠️ Claude re-login due — ${label}`;

    const action = handle
      ? `**Re-auth now:** ${handle.url}\n\nThen **reply in this channel with the code** you get after authorizing.`
      : manual_instruction(m.config_dir);

    const lead =
      kind === "outage"
        ? `${mention}The shared Claude credential for **${entities_line}** is logged out — every bot on it is down.\n\nQuarantined **${String(quarantined)}** poisoned session(s).`
        : `${mention}The shared Claude credential for **${entities_line}** needs a human re-login within **${format_minutes(assessment.minutes)}** — a token refresh cannot extend it.`;

    const embed = new EmbedBuilder()
      .setColor(kind === "outage" ? ALERT_COLOR_RED : ALERT_COLOR_AMBER)
      .setTitle(title)
      .setDescription(`${lead}\n\n${action}`)
      .setTimestamp();

    let message_id: string | null = null;
    let thread_id: string | null = null;
    if (this.discord) {
      message_id = await this.discord.send_embed(channel_id, embed);
      if (message_id) {
        thread_id = await this.discord.create_thread_from_message(
          channel_id,
          message_id,
          title.slice(0, 100),
        );
      }
    }

    const incident: AuthIncident = {
      key: m.key,
      config_dir: m.config_dir,
      entity_ids: m.entity_ids,
      entity_names: m.entity_names,
      state: handle?.state ?? "",
      tmux_session: handle?.tmux_session ?? null,
      url: handle?.url ?? null,
      channel_id,
      message_id,
      thread_id,
      kind,
      created_at: new Date(this.now()).toISOString(),
    };

    const incidents = await load_auth_incidents(this.config);
    incidents[m.key] = incident;
    await save_auth_incidents(incidents, this.config);
  }

  /**
   * Inbound Discord message handler for the alert channel. Consumes a pasted
   * OAuth code — completing the login, recycling affected bots, and resolving
   * the incident. Returns true iff the message was consumed.
   *
   * Security boundary: only the configured owner (`config.discord.user_id`) may
   * submit a code. A message from anyone else is ignored (returns false).
   */
  async try_handle_code_submission(
    channel_id: string,
    author_id: string,
    content: string,
  ): Promise<boolean> {
    const owner = this.config.discord?.user_id;
    // Hard security boundary: no owner configured, or a non-owner author → ignore.
    if (!owner || author_id !== owner) return false;

    const incidents = await load_auth_incidents(this.config);
    const open = Object.values(incidents);
    if (open.length === 0) return false;

    const trimmed = content.trim();
    // A manual-command incident carries an empty state, and `matches_state`
    // never matches one — so a chat message can't be mistaken for its code.
    const incident = open.find(
      (i) =>
        i.channel_id === channel_id && i.tmux_session !== null && matches_state(trimmed, i.state),
    );
    if (!incident?.tmux_session) return false;

    console.log(`[auth-watchdog] Received a code submission for ${incident.key}`);

    const ok = await this.submit(incident.tmux_session, trimmed);
    if (!ok) {
      await this.reply(incident.channel_id, "That code didn't take. Generating a fresh link…");
      await this.regenerate(incident);
      return true;
    }

    // Confirm the credential is actually healthy again before declaring victory.
    const m = this.monitored_for(incident.key);
    const reprobe = await this.probe(incident.config_dir, m?.probe_cwd ?? homedir());
    if (!reprobe.ok) {
      await this.reply(
        incident.channel_id,
        "Login accepted but the credential still isn't authenticating. Generating a fresh link…",
      );
      await this.regenerate(incident);
      return true;
    }

    const recycled = this.pool.recycle_stale_oauth_on_config_dir(incident.config_dir);
    // Name entities from the live registry, never from the incident's snapshot.
    const entities_line = entities_label(m?.entity_names ?? []);

    await this.resolve_incident(
      incident,
      `✅ Re-authenticated — **${entities_line}** back online${recycled > 0 ? ` (recycled ${String(recycled)} bot(s)).` : "."}`,
    );

    // Tidy up the held login session.
    this.kill_session(incident.tmux_session);
    return true;
  }

  /** The live monitoring entry for a credential key, if it is still monitored. */
  private monitored_for(key: string): MonitoredConfigDir | undefined {
    return enumerate_monitored_config_dirs(this.registry, this.config, this.entity_exists).find(
      (x) => x.key === key,
    );
  }

  /**
   * Replace a spent authorize URL on an incident that stays open. When a fresh
   * URL can't be captured the incident is downgraded to the manual command —
   * never deleted, which would re-alert on the next tick.
   */
  private async regenerate(incident: AuthIncident): Promise<void> {
    const m = this.monitored_for(incident.key);
    const cwd = m?.probe_cwd ?? homedir();
    if (incident.tmux_session) this.kill_session(incident.tmux_session);

    const handle = await this.gen_url(incident.config_dir, cwd);
    const updated: AuthIncident = {
      ...incident,
      state: handle?.state ?? "",
      tmux_session: handle?.tmux_session ?? null,
      url: handle?.url ?? null,
    };

    const incidents = await load_auth_incidents(this.config);
    incidents[incident.key] = updated;
    await save_auth_incidents(incidents, this.config);

    await this.reply(
      incident.channel_id,
      handle
        ? `New re-auth link: ${handle.url}`
        : `Couldn't produce a new link.\n\n${manual_instruction(incident.config_dir)}`,
    );
  }

  /** Mark the incident resolved (green), post the update, and clear state. */
  private async resolve_incident(incident: AuthIncident, resolution: string): Promise<void> {
    if (this.discord && incident.message_id) {
      const resolved = new EmbedBuilder()
        .setColor(ALERT_COLOR_GREEN)
        .setTitle(`✅ Resolved: ${incident.key}`)
        .setDescription(resolution)
        .setTimestamp();
      await this.discord.edit_message_embed(incident.channel_id, incident.message_id, resolved);
    }
    if (this.discord && incident.thread_id) {
      await this.discord.send_to_thread(incident.thread_id, resolution);
    } else if (this.discord) {
      await this.discord.send(incident.channel_id, resolution);
    }

    const incidents = await load_auth_incidents(this.config);
    delete incidents[incident.key];
    await save_auth_incidents(incidents, this.config);
  }

  private async reply(channel_id: string, content: string): Promise<void> {
    if (this.discord) await this.discord.send(channel_id, content);
  }
}

/**
 * Match a pasted code to an incident's OAuth state. The Claude flow returns a
 * `<code>#<state>` string, so we accept either the exact `code#state` form or
 * any message that simply contains the state token.
 */
export function matches_state(content: string, state: string): boolean {
  if (!state) return false;
  if (content.includes(state)) return true;
  return new RegExp(`^[A-Za-z0-9_-]+#${escape_regex(state)}$`).test(content);
}

function escape_regex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
