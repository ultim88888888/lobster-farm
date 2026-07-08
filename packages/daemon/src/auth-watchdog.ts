/**
 * Auth-recovery watchdog (#343).
 *
 * The shared `rengen` Claude credential (one OAuth cred backing ~7 canal-street +
 * sonar pool bots) expires periodically, silently taking down every bot on that
 * account. This watchdog collapses the previously-manual recovery into an
 * automated loop:
 *
 *   detect (canary probe + keychain expiry) → quarantine poisoned sessions →
 *   alert the owner with a re-login URL → accept the pasted code via Discord →
 *   complete the login → recycle the affected bots → resolve.
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
 */

import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { claude_dir, entity_dir, expand_home, lobsterfarm_dir } from "@lobster-farm/shared";
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
  /** OAuth state param — matches an inbound pasted code to this incident. */
  state: string;
  /** tmux session driving the /login flow, awaiting the code. */
  tmux_session: string;
  url: string;
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
 * Minutes until the credential's OAuth token expires, or null if unresolvable
 * (keychain miss, unparseable, hash mismatch). Best-effort — the canary probe is
 * the definitive auth signal; expiry only drives the proactive warning.
 */
export async function read_token_expiry_minutes(
  config_dir: string | null,
  reader: KeychainReader = default_keychain_reader,
  now: () => number = Date.now,
): Promise<number | null> {
  const raw = await reader(keychain_service_for(config_dir));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      claudeAiOauth?: { expiresAt?: number };
      expiresAt?: number;
    };
    const oauth = parsed.claudeAiOauth ?? parsed;
    const expires_at = oauth.expiresAt;
    if (typeof expires_at !== "number") return null;
    return Math.round((expires_at - now()) / 60_000);
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

/**
 * Distinct credentials to monitor: every entity's `subscription.claude_config_dir`
 * plus the default account. Entities are grouped per credential so the incident
 * flow knows which bots to recycle and how to word the alert.
 */
export function enumerate_monitored_config_dirs(
  registry: EntityRegistry,
  config: LobsterFarmConfig,
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
    return execFileSync("tmux", ["capture-pane", "-t", session, "-p"], {
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

const AUTHORIZE_URL_RE = /(https:\/\/claude\.com\/[^\s"'`]*oauth\/authorize\?[^\s"'`]+)/;

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
    tmux(["new-session", "-d", "-s", session, "-x", "220", "-y", "50", "-c", cwd, cmd]);
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
    if (/subscription|Claude account|Log in with/i.test(pane) && !AUTHORIZE_URL_RE.test(pane)) {
      tmux(["send-keys", "-t", session, "-l", "1"]);
      tmux(["send-keys", "-t", session, "Enter"]);
      return null;
    }
    const m = pane.match(AUTHORIZE_URL_RE);
    if (m?.[1]) {
      const url = m[1];
      let state = "";
      try {
        state = new URL(url).searchParams.get("state") ?? "";
      } catch {
        /* leave empty */
      }
      if (state) return { url, state, tmux_session: session };
    }
    return null;
  }, 30_000);

  if (!handle) {
    console.error("[auth-watchdog] Could not capture the OAuth authorize URL");
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
  token_expiry?: (config_dir: string | null) => Promise<number | null>;
  quarantine?: (config_dir: string | null) => Promise<number>;
  gen_url?: (config_dir: string | null, cwd: string) => Promise<ReloginHandle | null>;
  submit?: (tmux_session: string, code: string) => Promise<boolean>;
  /** Liveness check for a held login session (default: real tmux has-session). */
  session_alive?: (tmux_session: string) => boolean;
  /** Best-effort teardown of a held login session (default: real tmux kill-session). */
  kill_session?: (tmux_session: string) => void;
  now?: () => number;
}

export class AuthWatchdog {
  private readonly config: LobsterFarmConfig;
  private readonly registry: EntityRegistry;
  private readonly pool: RecyclePool;
  private readonly discord: WatchdogDiscord | null;

  private readonly probe: NonNullable<AuthWatchdogDeps["probe"]>;
  private readonly token_expiry: NonNullable<AuthWatchdogDeps["token_expiry"]>;
  private readonly quarantine: NonNullable<AuthWatchdogDeps["quarantine"]>;
  private readonly gen_url: NonNullable<AuthWatchdogDeps["gen_url"]>;
  private readonly submit: NonNullable<AuthWatchdogDeps["submit"]>;
  private readonly session_alive: NonNullable<AuthWatchdogDeps["session_alive"]>;
  private readonly kill_session: NonNullable<AuthWatchdogDeps["kill_session"]>;

  private timer: ReturnType<typeof setInterval> | null = null;
  /** Guards against overlapping ticks (a probe can take ~50s). */
  private ticking = false;

  constructor(deps: AuthWatchdogDeps) {
    this.config = deps.config;
    this.registry = deps.registry;
    this.pool = deps.pool;
    this.discord = deps.discord;
    this.probe = deps.probe ?? probe_credential;
    this.token_expiry = deps.token_expiry ?? ((dir) => read_token_expiry_minutes(dir));
    this.quarantine = deps.quarantine ?? quarantine_poisoned_sessions;
    this.gen_url = deps.gen_url ?? generate_relogin_url;
    this.submit = deps.submit ?? submit_code;
    this.session_alive = deps.session_alive ?? tmux_alive;
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
        `warn < ${String(cfg.expiry_warn_minutes)}m to expiry)`,
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
      const monitored = enumerate_monitored_config_dirs(this.registry, this.config);
      const incidents = await load_auth_incidents(this.config);

      for (const m of monitored) {
        const open = incidents[m.key];
        if (open) {
          // Dedup: an incident is already open for this credential. Recover from
          // a daemon restart that lost the login tmux by regenerating the URL.
          await this.recover_incident_if_stale(open, m);
          continue;
        }

        const probe = await this.probe(m.config_dir, m.probe_cwd);

        if (!probe.ok && (probe.signal === "logged_out" || probe.signal === "invalid_grant")) {
          await this.open_incident(m, "outage");
          continue;
        }

        // Only consider proactive expiry when auth currently works — never
        // re-login on a transient network/rate failure.
        if (probe.ok) {
          const minutes = await this.token_expiry(m.config_dir);
          if (minutes !== null && minutes < this.config.auth_watchdog.expiry_warn_minutes) {
            await this.open_incident(m, "expiring", minutes);
          }
        }
      }
    } catch (err) {
      console.error(`[auth-watchdog] tick failed: ${String(err)}`);
      sentry.captureException(err, { tags: { module: "auth-watchdog", action: "tick" } });
    } finally {
      this.ticking = false;
    }
  }

  /** If an open incident's login session has vanished (daemon restart), drop it
   * so the next tick re-opens cleanly with a fresh URL. */
  private async recover_incident_if_stale(
    incident: AuthIncident,
    _m: MonitoredConfigDir,
  ): Promise<void> {
    if (this.session_alive(incident.tmux_session)) return;
    console.warn(
      `[auth-watchdog] Login session for ${incident.key} is gone — clearing incident to regenerate`,
    );
    const incidents = await load_auth_incidents(this.config);
    delete incidents[incident.key];
    await save_auth_incidents(incidents, this.config);
  }

  private async resolve_alert_channel(): Promise<string | null> {
    const configured = this.config.auth_watchdog.alert_channel_id;
    if (configured) return configured;
    if (this.discord) return this.discord.find_command_center_channel();
    return null;
  }

  /** Open (or upgrade to) a re-login incident for a credential: quarantine
   * poisoned sessions (outage only), generate the URL, alert the owner, persist. */
  private async open_incident(
    m: MonitoredConfigDir,
    kind: "outage" | "expiring",
    minutes_to_expiry?: number,
  ): Promise<void> {
    const label = m.config_dir ?? "default account";
    console.warn(
      `[auth-watchdog] Opening ${kind} incident for ${label} ` +
        `(entities: ${m.entity_names.join(", ") || "none"})`,
    );

    let quarantined = 0;
    if (kind === "outage") {
      quarantined = await this.quarantine(m.config_dir);
    }

    const handle = await this.gen_url(m.config_dir, m.probe_cwd);
    if (!handle) {
      console.error(`[auth-watchdog] Could not generate a re-login URL for ${label} — will retry`);
      return;
    }

    const channel_id = await this.resolve_alert_channel();
    if (!channel_id) {
      console.error("[auth-watchdog] No alert channel resolved — cannot post incident");
      // Tear down the held login session; next tick regenerates.
      this.kill_session(handle.tmux_session);
      return;
    }

    const owner = this.config.discord?.user_id;
    const mention = owner ? `<@${owner}> ` : "";
    const entities_line =
      m.entity_names.length > 0 ? m.entity_names.join(", ") : "shared/default bots";

    const title =
      kind === "outage"
        ? `\u{1f6a8} Claude auth down — ${label}`
        : `⚠️ Claude auth expiring — ${label}`;

    const body =
      kind === "outage"
        ? `${mention}The shared Claude credential for **${entities_line}** is logged out — every bot on it is down.\n\nQuarantined **${String(quarantined)}** poisoned session(s).\n\n**Re-auth now:** ${handle.url}\n\nThen **reply in this channel with the code** you get after authorizing.`
        : `${mention}The shared Claude credential for **${entities_line}** expires in ~${String(minutes_to_expiry ?? "?")} min. Re-auth now to avoid an outage.\n\n**Re-auth:** ${handle.url}\n\nThen **reply in this channel with the code** you get after authorizing.`;

    const embed = new EmbedBuilder()
      .setColor(kind === "outage" ? ALERT_COLOR_RED : ALERT_COLOR_AMBER)
      .setTitle(title)
      .setDescription(body)
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
      state: handle.state,
      tmux_session: handle.tmux_session,
      url: handle.url,
      channel_id,
      message_id,
      thread_id,
      kind,
      created_at: new Date().toISOString(),
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
    const incident = open.find(
      (i) => i.channel_id === channel_id && matches_state(trimmed, i.state),
    );
    if (!incident) return false;

    console.log(`[auth-watchdog] Received a code submission for ${incident.key}`);

    const ok = await this.submit(incident.tmux_session, trimmed);
    if (!ok) {
      await this.reply(incident.channel_id, "That code didn't take. Generating a fresh link…");
      await this.regenerate(incident);
      return true;
    }

    // Confirm the credential is actually healthy again before declaring victory.
    const m = enumerate_monitored_config_dirs(this.registry, this.config).find(
      (x) => x.key === incident.key,
    );
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
    const entities_line =
      incident.entity_names.length > 0 ? incident.entity_names.join(", ") : "shared/default bots";

    await this.resolve_incident(
      incident,
      `✅ Re-authenticated — **${entities_line}** back online${recycled > 0 ? ` (recycled ${String(recycled)} bot(s)).` : "."}`,
    );

    // Tidy up the held login session.
    this.kill_session(incident.tmux_session);
    return true;
  }

  private async regenerate(incident: AuthIncident): Promise<void> {
    const m = enumerate_monitored_config_dirs(this.registry, this.config).find(
      (x) => x.key === incident.key,
    );
    const cwd = m?.probe_cwd ?? homedir();
    this.kill_session(incident.tmux_session);
    const handle = await this.gen_url(incident.config_dir, cwd);
    const incidents = await load_auth_incidents(this.config);
    if (!handle) {
      // Drop the incident so the next tick re-opens cleanly.
      delete incidents[incident.key];
      await save_auth_incidents(incidents, this.config);
      return;
    }
    const updated: AuthIncident = {
      ...incident,
      state: handle.state,
      tmux_session: handle.tmux_session,
      url: handle.url,
    };
    incidents[incident.key] = updated;
    await save_auth_incidents(incidents, this.config);
    await this.reply(incident.channel_id, `New re-auth link: ${handle.url}`);
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
