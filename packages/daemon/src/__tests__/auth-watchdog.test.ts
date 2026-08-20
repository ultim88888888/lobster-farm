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
  TMUX_PANE_WIDTH,
  classify_probe_output,
  enumerate_monitored_config_dirs,
  extract_authorize_url,
  keychain_service_for,
  matches_state,
  probe_credential,
  quarantine_poisoned_sessions,
  read_relogin_deadline_minutes,
  relogin_command,
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
    auth_watchdog: { enabled: true, alert_channel_id: "alert-chan", expiry_warn_minutes: 1440 },
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
    relogin_deadline: vi.fn(async () => null),
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
    entity_exists: vi.fn(() => true),
    ...overrides,
  };
}

async function read_incidents(): Promise<Record<string, Record<string, unknown>>> {
  return JSON.parse(
    await readFile(join(tmp_dir, "state", "auth-incidents.json"), "utf-8"),
  ) as Record<string, Record<string, unknown>>;
}

/** The description text of the Nth embed passed to `send_embed`. */
function embed_body(discord: ReturnType<typeof make_discord>, n = 0): string {
  const call = discord.send_embed.mock.calls[n] as unknown as [
    string,
    { data: { description?: string } },
  ];
  return call[1].data.description ?? "";
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

// ── AC3a: the authorize URL is recovered from a wrapped tmux pane ──

/** Shape of a real Claude Code v2.1.237 `/login` pane. The authorize URL is
 * ~450 chars, so tmux renders it across three `TMUX_PANE_WIDTH`-column rows —
 * the defect behind #363, where the old single-line regex captured only row one
 * and so never saw `state=`. */
function login_pane(url: string, width = TMUX_PANE_WIDTH): string {
  const rows: string[] = [];
  for (let i = 0; i < url.length; i += width) rows.push(url.slice(i, i + width));
  return [
    " Browser didn't open? Use the url below to sign in (c to copy)",
    ...rows,
    " Paste code here if prompted >",
    "",
  ].join("\n");
}

/** A realistic authorize URL: 450+ chars, so it wraps across three rows. */
const REAL_URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e" +
  "&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback" +
  "&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code" +
  "+user%3Amcp_servers+user%3Afile_upload" +
  "&code_challenge=bgZUY-LyEjijlzkFu2qGaXCNBmdWm-3RpYEePgv_ckk&code_challenge_method=S256" +
  "&state=MGbncdWBV4hu3_rK2IJ1aTrTuhYVWW-PTy2xrgWTxPQ";

describe("extract_authorize_url", () => {
  it("rejoins a URL that tmux wrapped across three pane rows", () => {
    const pane = login_pane(REAL_URL);
    // Guard the fixture itself: this URL really does wrap.
    expect(pane.split("\n").filter((l) => l.length === TMUX_PANE_WIDTH).length).toBeGreaterThan(1);

    expect(extract_authorize_url(pane)).toBe(REAL_URL);
  });

  it("recovers the state param that the pre-fix single-line match truncated", () => {
    const url = extract_authorize_url(login_pane(REAL_URL));
    expect(url).not.toBeNull();
    expect(new URL(url as string).searchParams.get("state")).toBe(
      "MGbncdWBV4hu3_rK2IJ1aTrTuhYVWW-PTy2xrgWTxPQ",
    );
  });

  it("reads an unwrapped URL that fits on one row", () => {
    const short = "https://claude.com/cai/oauth/authorize?code=true&state=SHORTSTATE";
    expect(extract_authorize_url(` prefix\n${short}\n more text\n`)).toBe(short);
  });

  it("never swallows the following pane line when the URL does not wrap", () => {
    const short = "https://claude.com/cai/oauth/authorize?code=true&state=SHORTSTATE";
    expect(extract_authorize_url(`${short}\n Paste code here if prompted >\n`)).toBe(short);
  });

  it("returns null when the pane has no authorize URL", () => {
    expect(extract_authorize_url(" Welcome to Claude Code\n ❯ 1. Claude account\n")).toBeNull();
  });

  it("returns null when the captured URL carries no state param", () => {
    expect(
      extract_authorize_url("https://claude.com/cai/oauth/authorize?code=true\nnext\n"),
    ).toBeNull();
  });
});

// ── AC3b: the manual fallback command ──

describe("relogin_command", () => {
  it("is a bare `claude` for the default account", () => {
    expect(relogin_command(null)).toBe("claude");
  });

  it("prefixes CLAUDE_CONFIG_DIR for a non-default account", () => {
    expect(relogin_command("/Users/farm/.lobsterfarm/shared/claude-config-rengen")).toBe(
      "CLAUDE_CONFIG_DIR=/Users/farm/.lobsterfarm/shared/claude-config-rengen claude",
    );
  });
});

// ── AC1: alarm on the credential that needs a human, not the access token ──

describe("read_relogin_deadline_minutes", () => {
  const NOW = 1_700_000_000_000;
  const now = () => NOW;
  const minutes = (n: number) => NOW + n * 60_000;

  it("measures the refresh token, not the access token", async () => {
    const reader = async () =>
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "unused",
          refreshToken: "unused",
          expiresAt: minutes(5), // access token about to roll over — refreshes silently
          refreshTokenExpiresAt: minutes(20_000),
        },
      });
    expect(await read_relogin_deadline_minutes(null, reader, now)).toBe(20_000);
  });

  it("returns null when only an access-token expiry is present (nothing a human can act on)", async () => {
    const reader = async () =>
      JSON.stringify({ claudeAiOauth: { accessToken: "unused", expiresAt: minutes(5) } });
    expect(await read_relogin_deadline_minutes(null, reader, now)).toBeNull();
  });

  it("returns null on a keychain miss", async () => {
    expect(await read_relogin_deadline_minutes(null, async () => null, now)).toBeNull();
  });

  it("returns null on unparseable credential material without echoing it", async () => {
    const secretish = "sk-ant-oat01-NOT-A-REAL-TOKEN";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(await read_relogin_deadline_minutes(null, async () => secretish, now)).toBeNull();

    for (const s of [spy, warn, log]) {
      for (const call of s.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(secretish);
      }
    }
    spy.mockRestore();
    warn.mockRestore();
    log.mockRestore();
  });
});

// ── AC5: entity names come from the live registry ──

describe("enumerate_monitored_config_dirs", () => {
  function registry_with(
    ...entities: { id: string; name: string; dir?: string }[]
  ): EntityRegistry {
    return {
      get_active: () =>
        entities.map((e) => ({
          entity: {
            id: e.id,
            name: e.name,
            subscription: e.dir ? { claude_config_dir: e.dir } : undefined,
          },
        })),
    } as unknown as EntityRegistry;
  }

  it("drops entities that no longer exist on disk", () => {
    const registry = registry_with(
      { id: "canal-street", name: "Canal Street", dir: RENGEN },
      { id: "paragon-mm", name: "Paragon MM", dir: RENGEN },
    );
    const dirs = enumerate_monitored_config_dirs(
      registry,
      LobsterFarmConfigSchema.parse({ user: { name: "T" }, paths: { lobsterfarm_dir: tmp_dir } }),
      (id) => id !== "paragon-mm",
    );
    const rengen = dirs.find((d) => d.key === RENGEN);
    expect(rengen?.entity_names).toEqual(["Canal Street"]);
    expect(rengen?.entity_ids).toEqual(["canal-street"]);
  });

  it("still monitors the default account when every entity is gone", () => {
    const registry = registry_with({ id: "ea", name: "EA", dir: RENGEN });
    const dirs = enumerate_monitored_config_dirs(
      registry,
      LobsterFarmConfigSchema.parse({ user: { name: "T" }, paths: { lobsterfarm_dir: tmp_dir } }),
      () => false,
    );
    expect(dirs.map((d) => d.key)).toEqual(["default"]);
  });
});

// ── AC1: a healthy credential opens no incident ──

describe("AuthWatchdog.tick — healthy credentials stay silent", () => {
  it("opens NO incident when the access token is about to refresh but the login is good", async () => {
    // The #363 regression: `expiresAt` is minutes away, but that token refreshes
    // silently. `relogin_deadline` reports the refresh token — days out.
    const deps = base_deps({
      probe: vi.fn(async () => ({ ok: true, signal: "ok" as const })),
      relogin_deadline: vi.fn(async () => 20_000),
    });
    const discord = deps.discord as unknown as ReturnType<typeof make_discord>;
    const wd = new AuthWatchdog(deps);

    await wd.tick();
    await wd.tick();

    expect(discord.send_embed).not.toHaveBeenCalled();
    expect(deps.gen_url).not.toHaveBeenCalled();
  });

  it("opens NO incident when the re-login deadline is unknown", async () => {
    const deps = base_deps({ relogin_deadline: vi.fn(async () => null) });
    const discord = deps.discord as unknown as ReturnType<typeof make_discord>;
    await new AuthWatchdog(deps).tick();
    expect(discord.send_embed).not.toHaveBeenCalled();
  });

  it("does NOT open an incident on a network-class failure", async () => {
    const deps = base_deps({ probe: rengen_probe("network") });
    const discord = deps.discord as unknown as ReturnType<typeof make_discord>;

    await new AuthWatchdog(deps).tick();

    expect(deps.gen_url).not.toHaveBeenCalled();
    expect(discord.send_embed).not.toHaveBeenCalled();
  });
});

// ── AC2 + AC3: exactly one actionable incident ──

describe("AuthWatchdog.tick — one actionable incident per credential", () => {
  it("opens an incident (quarantine + URL + alert) on logged_out", async () => {
    const deps = base_deps({ probe: rengen_probe("logged_out") });
    const discord = deps.discord as unknown as ReturnType<typeof make_discord>;

    await new AuthWatchdog(deps).tick();

    expect(deps.quarantine).toHaveBeenCalledWith(RENGEN);
    expect(deps.gen_url).toHaveBeenCalledTimes(1);
    expect(discord.send_embed).toHaveBeenCalledTimes(1);
    expect(embed_body(discord)).toContain("https://claude.com/cai/oauth/authorize?state=STATE123");

    const state = await read_incidents();
    expect(state[RENGEN].state).toBe("STATE123");
  });

  it("opens exactly one incident across repeated ticks (dedup)", async () => {
    const deps = base_deps({ probe: rengen_probe("logged_out") });
    const discord = deps.discord as unknown as ReturnType<typeof make_discord>;
    const wd = new AuthWatchdog(deps);

    await wd.tick();
    await wd.tick();
    await wd.tick();

    expect(discord.send_embed).toHaveBeenCalledTimes(1);
    expect(deps.gen_url).toHaveBeenCalledTimes(1);
  });

  it("opens exactly one incident even when the URL can never be captured", async () => {
    // The #363 loop: gen_url failing used to abort before persisting, so every
    // 5-minute tick re-opened and re-alerted forever.
    const deps = base_deps({
      probe: rengen_probe("logged_out"),
      gen_url: vi.fn(async () => null),
    });
    const discord = deps.discord as unknown as ReturnType<typeof make_discord>;
    const wd = new AuthWatchdog(deps);

    await wd.tick();
    await wd.tick();
    await wd.tick();

    expect(discord.send_embed).toHaveBeenCalledTimes(1);
    expect(await read_incidents()).toHaveProperty(RENGEN);
  });

  it("falls back to the exact CLAUDE_CONFIG_DIR command when no URL is captured", async () => {
    const deps = base_deps({
      probe: rengen_probe("logged_out"),
      gen_url: vi.fn(async () => null),
    });
    const discord = deps.discord as unknown as ReturnType<typeof make_discord>;

    await new AuthWatchdog(deps).tick();

    const body = embed_body(discord);
    expect(body).toContain(`CLAUDE_CONFIG_DIR=${RENGEN} claude`);
    expect(body).toContain("/login");
    // No dishonest promise of a retry that never produced anything.
    expect(body).not.toContain("will retry");

    const incident = (await read_incidents())[RENGEN];
    expect(incident.url).toBeNull();
    expect(incident.tmux_session).toBeNull();
  });

  it("fires the expiry warning exactly once while under the threshold", async () => {
    const deps = base_deps({
      probe: vi.fn(async () => ({ ok: true, signal: "ok" as const })),
      relogin_deadline: vi.fn(async (config_dir: string | null) =>
        config_dir === RENGEN ? 60 : null,
      ),
    });
    const discord = deps.discord as unknown as ReturnType<typeof make_discord>;
    const wd = new AuthWatchdog(deps);

    await wd.tick();
    await wd.tick();

    expect(discord.send_embed).toHaveBeenCalledTimes(1);
    // Proactive warning must NOT quarantine — nothing is poisoned yet.
    expect(deps.quarantine).not.toHaveBeenCalled();
  });

  it("names only entities that still exist on disk", async () => {
    const registry = {
      get_active: () => [
        {
          entity: {
            id: "canal-street",
            name: "Canal Street",
            subscription: { claude_config_dir: RENGEN },
          },
        },
        {
          entity: {
            id: "paragon-mm",
            name: "Paragon MM",
            subscription: { claude_config_dir: RENGEN },
          },
        },
      ],
    } as unknown as EntityRegistry;
    const deps = base_deps({
      registry,
      probe: rengen_probe("logged_out"),
      entity_exists: vi.fn((id: string) => id !== "paragon-mm"),
    });
    const discord = deps.discord as unknown as ReturnType<typeof make_discord>;

    await new AuthWatchdog(deps).tick();

    const body = embed_body(discord);
    expect(body).toContain("Canal Street");
    expect(body).not.toContain("Paragon MM");
  });

  it("escalates an open expiring incident to an outage without opening a second one", async () => {
    let ticks = 0;
    const deps = base_deps({
      probe: vi.fn(async (config_dir: string | null) => {
        if (config_dir !== RENGEN) return { ok: true, signal: "ok" as const };
        ticks += 1;
        return ticks === 1
          ? { ok: true, signal: "ok" as const }
          : { ok: false, signal: "logged_out" as const };
      }),
      relogin_deadline: vi.fn(async (config_dir: string | null) =>
        config_dir === RENGEN ? 60 : null,
      ),
    });
    const discord = deps.discord as unknown as ReturnType<typeof make_discord>;
    const wd = new AuthWatchdog(deps);

    await wd.tick(); // expiring
    await wd.tick(); // now logged out

    expect(discord.send_embed).toHaveBeenCalledTimes(1);
    expect((await read_incidents())[RENGEN].kind).toBe("outage");
  });
});

// ── AC4: incidents auto-resolve when the credential recovers ──

describe("AuthWatchdog.tick — auto-resolve", () => {
  /** Rengen fails for the first `n` probe calls, then reports healthy. */
  function recovers_after(n: number, signal: "logged_out" | "invalid_grant" = "logged_out") {
    let calls = 0;
    return vi.fn(async (config_dir: string | null) => {
      if (config_dir !== RENGEN) return { ok: true, signal: "ok" as const };
      calls += 1;
      return calls <= n ? { ok: false, signal } : { ok: true, signal: "ok" as const };
    });
  }

  it("resolves an outage incident once the credential authenticates again", async () => {
    const deps = base_deps({ probe: recovers_after(1) });
    const discord = deps.discord as unknown as ReturnType<typeof make_discord>;
    const pool = deps.pool as unknown as ReturnType<typeof make_pool>;
    const wd = new AuthWatchdog(deps);

    await wd.tick(); // opens
    await wd.tick(); // credential healthy → resolve

    expect(discord.edit_message_embed).toHaveBeenCalledTimes(1);
    expect(pool.recycle_stale_oauth_on_config_dir).toHaveBeenCalledWith(RENGEN);
    expect((await read_incidents())[RENGEN]).toBeUndefined();
  });

  it("resolves an expiring incident once the re-login deadline moves back out", async () => {
    let calls = 0;
    const deps = base_deps({
      relogin_deadline: vi.fn(async (config_dir: string | null) => {
        if (config_dir !== RENGEN) return null;
        calls += 1;
        return calls === 1 ? 60 : 20_000;
      }),
    });
    const discord = deps.discord as unknown as ReturnType<typeof make_discord>;
    const wd = new AuthWatchdog(deps);

    await wd.tick();
    await wd.tick();

    expect(discord.send_embed).toHaveBeenCalledTimes(1);
    expect(discord.edit_message_embed).toHaveBeenCalledTimes(1);
    expect((await read_incidents())[RENGEN]).toBeUndefined();
  });

  it("opens a fresh incident if the credential fails again after resolving", async () => {
    const deps = base_deps({ probe: recovers_after(1) });
    const discord = deps.discord as unknown as ReturnType<typeof make_discord>;
    const wd = new AuthWatchdog(deps);

    await wd.tick(); // open
    await wd.tick(); // resolve
    (deps.probe as ReturnType<typeof vi.fn>).mockImplementation(
      async (config_dir: string | null) =>
        config_dir === RENGEN
          ? { ok: false, signal: "logged_out" as const }
          : { ok: true, signal: "ok" as const },
    );
    await wd.tick(); // open again

    expect(discord.send_embed).toHaveBeenCalledTimes(2);
  });

  it("does NOT resolve on a transient network failure", async () => {
    let calls = 0;
    const deps = base_deps({
      probe: vi.fn(async (config_dir: string | null) => {
        if (config_dir !== RENGEN) return { ok: true, signal: "ok" as const };
        calls += 1;
        return calls === 1
          ? { ok: false, signal: "logged_out" as const }
          : { ok: false, signal: "network" as const };
      }),
    });
    const discord = deps.discord as unknown as ReturnType<typeof make_discord>;
    const wd = new AuthWatchdog(deps);

    await wd.tick();
    await wd.tick();

    expect(discord.edit_message_embed).not.toHaveBeenCalled();
    expect(await read_incidents()).toHaveProperty(RENGEN);
  });

  it("downgrades to the manual command when the held login session dies, without re-alerting", async () => {
    const deps = base_deps({
      probe: rengen_probe("logged_out"),
      session_alive: vi.fn(() => false),
    });
    const discord = deps.discord as unknown as ReturnType<typeof make_discord>;
    const wd = new AuthWatchdog(deps);

    await wd.tick(); // opens with a URL
    await wd.tick(); // tmux gone → the URL is dead

    expect(discord.send_embed).toHaveBeenCalledTimes(1);
    const incident = (await read_incidents())[RENGEN];
    expect(incident.url).toBeNull();
    expect(incident.tmux_session).toBeNull();
    // The owner is told what to run instead.
    const follow_ups = [...discord.send_to_thread.mock.calls, ...discord.send.mock.calls].map((c) =>
      String(c[1]),
    );
    expect(follow_ups.some((t) => t.includes(`CLAUDE_CONFIG_DIR=${RENGEN} claude`))).toBe(true);
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
    expect(pool.recycle_stale_oauth_on_config_dir).toHaveBeenCalledWith(RENGEN);
    expect(discord.edit_message_embed).toHaveBeenCalledTimes(1); // resolved (green)

    expect((await read_incidents())[RENGEN]).toBeUndefined();
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
    expect((await read_incidents())[RENGEN]).toBeDefined();
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
    expect((await read_incidents())[RENGEN]).toBeDefined();
  });

  it("never consumes a message for a manual-command incident (no state to match)", async () => {
    const deps = base_deps({
      probe: rengen_probe("logged_out"),
      gen_url: vi.fn(async () => null),
    });
    const wd = await open_outage(deps);

    const consumed = await wd.try_handle_code_submission(
      "alert-chan",
      "owner-123",
      "code#STATE123",
    );

    expect(consumed).toBe(false);
    expect(deps.submit).not.toHaveBeenCalled();
  });
});
