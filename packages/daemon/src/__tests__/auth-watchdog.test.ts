import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthWatchdog,
  type AuthWatchdogDeps,
  type CanaryRun,
  type ReloginHandle,
  classify_probe_output,
  keychain_service_for,
  matches_state,
  probe_credential,
  quarantine_poisoned_sessions,
} from "../auth-watchdog.js";
import type { EntityRegistry } from "../registry.js";

vi.mock("../sentry.js", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

// ── Fakes ──

/** Minimal registry with a single canal-street-like entity on a rengen config dir. */
function make_registry(config_dir = "/tmp/rengen"): EntityRegistry {
  return {
    get_active: () => [
      {
        entity: {
          id: "canal-street",
          name: "Canal Street",
          subscription: { claude_config_dir: config_dir },
        },
      },
    ],
  } as unknown as EntityRegistry;
}

function make_discord() {
  return {
    send_embed: vi.fn(async () => "msg-1"),
    create_thread_from_message: vi.fn(async () => "thread-1"),
    send_to_thread: vi.fn(async () => {}),
    edit_message_embed: vi.fn(async () => true),
    send: vi.fn(async () => {}),
    find_command_center_channel: vi.fn(async () => "cc-channel"),
  };
}

function make_pool() {
  return { recycle_stale_oauth_on_config_dir: vi.fn(() => 3) };
}

let tmp_dir: string;

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    paths: { lobsterfarm_dir: tmp_dir },
    discord: { server_id: "guild-1", user_id: "owner-123" },
    auth_watchdog: { enabled: true, alert_channel_id: "alert-chan" },
  });
}

/** The rengen credential path used across incident tests. */
const RENGEN = "/tmp/rengen";

/** Probe that fails only for the rengen credential; the default account is ok. */
function rengen_probe(signal: "logged_out" | "invalid_grant" | "network") {
  return vi.fn(async (config_dir: string | null) =>
    config_dir === RENGEN ? { ok: false, signal } : { ok: true, signal: "ok" as const },
  );
}

/** Base deps with all side effects stubbed hermetically (no tmux, no spawn, no fs races).
 * The default account (config_dir null) always probes ok so only the credential
 * under test drives an incident — mirroring reality where one shared cred fails. */
function base_deps(overrides: Partial<AuthWatchdogDeps> = {}): AuthWatchdogDeps {
  return {
    config: make_config(),
    registry: make_registry(),
    pool: make_pool() as unknown as AuthWatchdogDeps["pool"],
    discord: make_discord() as unknown as AuthWatchdogDeps["discord"],
    probe: vi.fn(async () => ({ ok: true, signal: "ok" as const })),
    token_expiry: vi.fn(async () => null),
    quarantine: vi.fn(async () => 0),
    gen_url: vi.fn(
      async (): Promise<ReloginHandle> => ({
        url: "https://claude.com/cai/oauth/authorize?state=STATE123",
        state: "STATE123",
        tmux_session: "auth-login-test",
      }),
    ),
    submit: vi.fn(async () => true),
    session_alive: vi.fn(() => true),
    kill_session: vi.fn(),
    ...overrides,
  };
}

beforeEach(async () => {
  tmp_dir = await mkdtemp(join(tmpdir(), "auth-watchdog-"));
  await mkdir(join(tmp_dir, "state"), { recursive: true });
});

afterEach(async () => {
  await rm(tmp_dir, { recursive: true, force: true });
});

// ── keychain_service_for ──

describe("keychain_service_for", () => {
  it("returns the base service name for the default account", () => {
    expect(keychain_service_for(null)).toBe("Claude Code-credentials");
  });

  it("derives the rengen hash from the config dir path (sha256 first 8)", () => {
    // Verified against the live keychain entry for the rengen credential.
    expect(keychain_service_for("/Users/farm/.lobsterfarm/shared/claude-config-rengen")).toBe(
      "Claude Code-credentials-4c64f669",
    );
  });

  it("ignores a trailing slash when hashing", () => {
    expect(keychain_service_for("/Users/farm/.lobsterfarm/shared/claude-config-rengen/")).toBe(
      "Claude Code-credentials-4c64f669",
    );
  });
});

// ── classify_probe_output ──

describe("classify_probe_output", () => {
  it("classifies logged-out output", () => {
    expect(classify_probe_output("Not logged in · Please run /login")).toBe("logged_out");
  });
  it("classifies invalid_grant", () => {
    expect(classify_probe_output("OAuth error: invalid_grant")).toBe("invalid_grant");
  });
  it("classifies network errors", () => {
    expect(classify_probe_output("read ECONNRESET")).toBe("network");
    expect(classify_probe_output("HTTP 503 Service Unavailable")).toBe("network");
  });
  it("classifies rate limiting", () => {
    expect(classify_probe_output("429 Too Many Requests")).toBe("rate_limit");
  });
  it("returns null when there is no failure marker", () => {
    expect(classify_probe_output("OK")).toBeNull();
  });
});

// ── probe_credential (mocked spawn) ──

describe("probe_credential", () => {
  const run = (r: Partial<CanaryRun>): CanaryRun => ({
    stdout: "",
    stderr: "",
    code: 0,
    timed_out: false,
    ...r,
  });

  it("returns ok on a clean OK reply", async () => {
    const res = await probe_credential(null, "/tmp", async () => run({ stdout: "OK", code: 0 }));
    expect(res).toEqual({ ok: true, signal: "ok" });
  });

  it("returns logged_out when the CLI is signed out", async () => {
    const res = await probe_credential(null, "/tmp", async () =>
      run({ stdout: "Not logged in · Please run /login", code: 1 }),
    );
    expect(res).toEqual({ ok: false, signal: "logged_out" });
  });

  it("returns invalid_grant on a refresh failure", async () => {
    const res = await probe_credential(null, "/tmp", async () =>
      run({ stderr: "invalid_grant", code: 1 }),
    );
    expect(res).toEqual({ ok: false, signal: "invalid_grant" });
  });

  it("treats a timeout as network (never an auth incident)", async () => {
    const res = await probe_credential(null, "/tmp", async () => run({ timed_out: true }));
    expect(res).toEqual({ ok: false, signal: "network" });
  });

  it("treats ECONNRESET as network", async () => {
    const res = await probe_credential(null, "/tmp", async () =>
      run({ stderr: "read ECONNRESET", code: 1 }),
    );
    expect(res).toEqual({ ok: false, signal: "network" });
  });
});

// ── quarantine_poisoned_sessions ──

describe("quarantine_poisoned_sessions", () => {
  it("moves only transcripts containing the login-error marker", async () => {
    const config_dir = join(tmp_dir, "cfg");
    const proj = join(config_dir, "projects", "slug-a");
    await mkdir(proj, { recursive: true });
    const poisoned = join(proj, "poisoned.jsonl");
    const clean = join(proj, "clean.jsonl");
    await writeFile(poisoned, '{"text":"Not logged in · Please run /login"}\n');
    await writeFile(clean, '{"text":"hello world"}\n');

    const count = await quarantine_poisoned_sessions(config_dir);

    expect(count).toBe(1);
    // Poisoned file is gone from projects/, clean one stays.
    await expect(readFile(poisoned, "utf-8")).rejects.toThrow();
    await expect(readFile(clean, "utf-8")).resolves.toContain("hello world");
  });

  it("returns 0 when there are no poisoned sessions", async () => {
    const config_dir = join(tmp_dir, "cfg2");
    const proj = join(config_dir, "projects", "slug-b");
    await mkdir(proj, { recursive: true });
    await writeFile(join(proj, "a.jsonl"), '{"text":"fine"}\n');
    expect(await quarantine_poisoned_sessions(config_dir)).toBe(0);
  });
});

// ── matches_state ──

describe("matches_state", () => {
  it("matches a bare code that contains the state", () => {
    expect(matches_state("abc123#STATE123", "STATE123")).toBe(true);
  });
  it("matches the code#state form exactly", () => {
    expect(matches_state("thecode#STATE123", "STATE123")).toBe(true);
  });
  it("rejects an unrelated message", () => {
    expect(matches_state("hello there", "STATE123")).toBe(false);
  });
  it("never matches an empty state", () => {
    expect(matches_state("anything", "")).toBe(false);
  });
});

// ── Watchdog tick: incident open + dedup ──

describe("AuthWatchdog.tick", () => {
  it("opens an incident (quarantine + URL + alert) on logged_out", async () => {
    const deps = base_deps({ probe: rengen_probe("logged_out") });
    const discord = deps.discord as unknown as ReturnType<typeof make_discord>;
    const wd = new AuthWatchdog(deps);

    await wd.tick();

    expect(deps.quarantine).toHaveBeenCalledWith("/tmp/rengen");
    expect(deps.gen_url).toHaveBeenCalledTimes(1);
    expect(discord.send_embed).toHaveBeenCalledTimes(1);

    // Incident is persisted keyed by config dir.
    const state = JSON.parse(
      await readFile(join(tmp_dir, "state", "auth-incidents.json"), "utf-8"),
    );
    expect(state["/tmp/rengen"].state).toBe("STATE123");
  });

  it("does NOT re-alert while an incident is already open (dedup)", async () => {
    const deps = base_deps({ probe: rengen_probe("logged_out") });
    const discord = deps.discord as unknown as ReturnType<typeof make_discord>;
    const wd = new AuthWatchdog(deps);

    await wd.tick();
    await wd.tick();

    expect(discord.send_embed).toHaveBeenCalledTimes(1);
    expect(deps.gen_url).toHaveBeenCalledTimes(1);
  });

  it("does NOT open an incident on a network-class failure", async () => {
    const deps = base_deps({ probe: rengen_probe("network") });
    const discord = deps.discord as unknown as ReturnType<typeof make_discord>;
    const wd = new AuthWatchdog(deps);

    await wd.tick();

    expect(deps.gen_url).not.toHaveBeenCalled();
    expect(discord.send_embed).not.toHaveBeenCalled();
  });

  it("fires the expiry warning exactly once while under the threshold", async () => {
    const deps = base_deps({
      probe: vi.fn(async () => ({ ok: true, signal: "ok" as const })),
      token_expiry: vi.fn(async (config_dir: string | null) => (config_dir === RENGEN ? 10 : null)),
    });
    const discord = deps.discord as unknown as ReturnType<typeof make_discord>;
    const wd = new AuthWatchdog(deps);

    await wd.tick();
    await wd.tick();

    // One amber warning, deduped on the second pass.
    expect(discord.send_embed).toHaveBeenCalledTimes(1);
    // Proactive warning must NOT quarantine — nothing is poisoned yet.
    expect(deps.quarantine).not.toHaveBeenCalled();
  });
});

// ── Code-submission handler ──

describe("AuthWatchdog.try_handle_code_submission", () => {
  async function open_outage(deps: AuthWatchdogDeps): Promise<AuthWatchdog> {
    const wd = new AuthWatchdog(deps);
    await wd.tick(); // probe returns logged_out → incident open
    return wd;
  }

  // Rengen probes logged_out on the first (tick) call, then ok on the re-probe
  // after the code is submitted. The default account is always ok.
  const logged_out_then_ok = () => {
    let rengen_calls = 0;
    return vi.fn(async (config_dir: string | null) => {
      if (config_dir !== RENGEN) return { ok: true, signal: "ok" as const };
      rengen_calls += 1;
      return rengen_calls === 1
        ? { ok: false, signal: "logged_out" as const }
        : { ok: true, signal: "ok" as const };
    });
  };

  it("completes login, recycles bots, and resolves on an owner code (matching state)", async () => {
    const deps = base_deps({ probe: logged_out_then_ok() });
    const discord = deps.discord as unknown as ReturnType<typeof make_discord>;
    const pool = deps.pool as unknown as ReturnType<typeof make_pool>;
    const wd = await open_outage(deps);

    const consumed = await wd.try_handle_code_submission(
      "alert-chan",
      "owner-123",
      "code#STATE123",
    );

    expect(consumed).toBe(true);
    expect(deps.submit).toHaveBeenCalledWith("auth-login-test", "code#STATE123");
    expect(pool.recycle_stale_oauth_on_config_dir).toHaveBeenCalledWith("/tmp/rengen");
    expect(discord.edit_message_embed).toHaveBeenCalledTimes(1); // resolved (green)

    // Incident cleared.
    const state = JSON.parse(
      await readFile(join(tmp_dir, "state", "auth-incidents.json"), "utf-8"),
    );
    expect(state["/tmp/rengen"]).toBeUndefined();
  });

  it("ignores a code from a non-owner (security boundary)", async () => {
    const deps = base_deps({ probe: logged_out_then_ok() });
    const pool = deps.pool as unknown as ReturnType<typeof make_pool>;
    const wd = await open_outage(deps);

    const consumed = await wd.try_handle_code_submission(
      "alert-chan",
      "intruder-999",
      "code#STATE123",
    );

    expect(consumed).toBe(false);
    expect(deps.submit).not.toHaveBeenCalled();
    expect(pool.recycle_stale_oauth_on_config_dir).not.toHaveBeenCalled();

    // Incident is still open — a non-owner cannot clear it.
    const state = JSON.parse(
      await readFile(join(tmp_dir, "state", "auth-incidents.json"), "utf-8"),
    );
    expect(state["/tmp/rengen"]).toBeDefined();
  });

  it("ignores an owner message that does not match any incident state", async () => {
    const deps = base_deps({ probe: logged_out_then_ok() });
    const wd = await open_outage(deps);

    const consumed = await wd.try_handle_code_submission(
      "alert-chan",
      "owner-123",
      "just chatting",
    );

    expect(consumed).toBe(false);
    expect(deps.submit).not.toHaveBeenCalled();
  });

  it("regenerates a fresh link when the submitted code fails", async () => {
    const deps = base_deps({
      probe: rengen_probe("logged_out"),
      submit: vi.fn(async () => false),
    });
    const discord = deps.discord as unknown as ReturnType<typeof make_discord>;
    const pool = deps.pool as unknown as ReturnType<typeof make_pool>;
    const wd = await open_outage(deps);

    const consumed = await wd.try_handle_code_submission("alert-chan", "owner-123", "bad#STATE123");

    expect(consumed).toBe(true);
    expect(pool.recycle_stale_oauth_on_config_dir).not.toHaveBeenCalled();
    // A follow-up message with a fresh link is sent; incident stays open.
    expect(discord.send).toHaveBeenCalled();
    const state = JSON.parse(
      await readFile(join(tmp_dir, "state", "auth-incidents.json"), "utf-8"),
    );
    expect(state["/tmp/rengen"]).toBeDefined();
  });
});
