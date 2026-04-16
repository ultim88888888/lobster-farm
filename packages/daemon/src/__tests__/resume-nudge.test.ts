import { tmpdir } from "node:os";
import { join } from "node:path";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistedPoolBot } from "../persistence.js";
import type { PoolBot } from "../pool.js";
import { BotPoolTestBase } from "./helpers/test-bot-pool-base.js";

// ── Mocks ──

// Mock node:fs/promises — writeFile is the key assertion target
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue("{}"),
    readdir: vi.fn().mockResolvedValue([]),
    mkdir: vi.fn().mockResolvedValue(undefined),
  };
});

// Mock node:child_process — controls tmux readiness simulation
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: vi.fn().mockImplementation(() => {
      throw new Error("not mocked");
    }),
    spawn: vi.fn(),
  };
});

import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";

// ── Test helpers ──

// Use a static temp path per test run — mkdtemp is not mocked but we use a
// unique-enough path since fs writes are already mocked in this file.
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

/**
 * Test-friendly BotPool subclass. Stubs tmux/filesystem side effects
 * and exposes internals for resume_parked_bots testing.
 */
class TestBotPool extends BotPoolTestBase {
  inject_bots(bots: PoolBot[]): void {
    (this as unknown as { bots: PoolBot[] }).bots = bots;
  }

  get_bots(): PoolBot[] {
    return (this as unknown as { bots: PoolBot[] }).bots;
  }

  inject_resume_candidates(candidates: PersistedPoolBot[]): void {
    (this as unknown as { resume_candidates: PersistedPoolBot[] }).resume_candidates = candidates;
  }

  protected override is_bot_idle(): boolean {
    return true;
  }
}

// ── Tests ──

describe("resume nudge (issue #156)", () => {
  let config: LobsterFarmConfig;
  let pool: TestBotPool;

  beforeEach(() => {
    vi.clearAllMocks();
    // Use fake timers so we can skip the readiness polling delays
    vi.useFakeTimers({ shouldAdvanceTime: true });

    // Use a unique temp path to isolate config from production ~/.lobsterfarm.
    // mkdtemp is not available here (fs mocked), but mkdir is also mocked so
    // the directory doesn't need to actually exist — we just need a non-production path.
    temp_dir = join(tmpdir(), `resume-nudge-test-${Date.now()}`);
    config = make_config();
    pool = new TestBotPool(config);

    // Stub out side effects that resume_parked_bots calls before the nudge
    vi.spyOn(pool as unknown as Record<string, unknown>, "kill_tmux" as never).mockImplementation(
      () => {},
    );
    vi.spyOn(
      pool as unknown as Record<string, unknown>,
      "write_access_json" as never,
    ).mockResolvedValue(undefined);
    vi.spyOn(
      pool as unknown as Record<string, unknown>,
      "set_bot_nickname" as never,
    ).mockResolvedValue(undefined);
    vi.spyOn(
      pool as unknown as Record<string, unknown>,
      "set_bot_avatar" as never,
    ).mockResolvedValue(undefined);
    vi.spyOn(pool as unknown as Record<string, unknown>, "start_tmux" as never).mockResolvedValue(
      undefined,
    );
    vi.spyOn(pool as unknown as Record<string, unknown>, "is_tmux_alive" as never).mockReturnValue(
      false,
    );
    vi.spyOn(pool as unknown as Record<string, unknown>, "persist" as never).mockResolvedValue(
      undefined,
    );

    // Default: tmux capture-pane returns a ready prompt (bot is ready)
    (execFileSync as Mock).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "capture-pane") {
        return "Listening for channel messages\n❯ ";
      }
      if (cmd === "tmux" && args[0] === "has-session") {
        throw new Error("no session");
      }
      return "";
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes nudge file after successful resume", async () => {
    const bot = make_bot({
      id: 3,
      state: "parked",
      channel_id: "ch-1",
      entity_id: "e1",
      archetype: "planner",
      session_id: "sess-abc123",
    });
    pool.inject_bots([bot]);
    pool.inject_resume_candidates([
      {
        id: 3,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "e1",
        archetype: "planner",
        channel_type: null,
        session_id: "sess-abc123",
        last_active: new Date().toISOString(),
      },
    ]);

    await pool.resume_parked_bots();
    // Let the fire-and-forget nudge promise settle
    await vi.advanceTimersByTimeAsync(25_000);

    expect(writeFile).toHaveBeenCalledWith(
      "/tmp/lf-pending-pool-3.txt",
      expect.stringContaining("daemon restarted"),
      "utf-8",
    );

    // The actual delivery mechanism: tmux send-keys injects the prompt
    expect(execFileSync).toHaveBeenCalledWith(
      "tmux",
      ["send-keys", "-t", "pool-3", expect.stringContaining("/tmp/lf-pending-pool-3.txt"), "Enter"],
      expect.objectContaining({ stdio: "ignore", timeout: 5000 }),
    );
  });

  it("nudge content includes instruction to continue work", async () => {
    const bot = make_bot({
      id: 0,
      state: "parked",
      channel_id: "ch-1",
      entity_id: "e1",
      archetype: "builder",
      session_id: "sess-xyz",
    });
    pool.inject_bots([bot]);
    pool.inject_resume_candidates([
      {
        id: 0,
        state: "assigned",
        channel_id: "ch-1",
        entity_id: "e1",
        archetype: "builder",
        channel_type: null,
        session_id: "sess-xyz",
        last_active: new Date().toISOString(),
      },
    ]);

    await pool.resume_parked_bots();
    await vi.advanceTimersByTimeAsync(25_000);

    const write_calls = (writeFile as Mock).mock.calls;
    const nudge_call = write_calls.find((c: unknown[]) =>
      (c[0] as string).includes("lf-pending-pool-0"),
    );
    expect(nudge_call).toBeDefined();

    const content = nudge_call![1] as string;
    expect(content).toContain("continue any in-progress work");

    // send-keys must also be called to deliver the nudge
    expect(execFileSync).toHaveBeenCalledWith(
      "tmux",
      [
        "send-keys",
        "-t",
        "pool-0",
        expect.stringContaining("Read /tmp/lf-pending-pool-0.txt"),
        "Enter",
      ],
      expect.objectContaining({ stdio: "ignore", timeout: 5000 }),
    );
  });

  it("nudge file path matches bot ID", async () => {
    const bot = make_bot({
      id: 7,
      state: "assigned",
      channel_id: "ch-7",
      entity_id: "e1",
      archetype: "designer",
      session_id: "sess-777",
    });
    pool.inject_bots([bot]);
    pool.inject_resume_candidates([
      {
        id: 7,
        state: "assigned",
        channel_id: "ch-7",
        entity_id: "e1",
        archetype: "designer",
        channel_type: null,
        session_id: "sess-777",
        last_active: new Date().toISOString(),
      },
    ]);

    await pool.resume_parked_bots();
    await vi.advanceTimersByTimeAsync(25_000);

    expect(writeFile).toHaveBeenCalledWith(
      "/tmp/lf-pending-pool-7.txt",
      expect.any(String),
      "utf-8",
    );

    // send-keys targets the correct tmux session
    expect(execFileSync).toHaveBeenCalledWith(
      "tmux",
      ["send-keys", "-t", "pool-7", expect.stringContaining("/tmp/lf-pending-pool-7.txt"), "Enter"],
      expect.objectContaining({ stdio: "ignore", timeout: 5000 }),
    );
  });

  it("does not write nudge file if start_tmux fails", async () => {
    const bot = make_bot({
      id: 2,
      state: "parked",
      channel_id: "ch-2",
      entity_id: "e1",
      archetype: "planner",
      session_id: "sess-fail",
    });
    pool.inject_bots([bot]);
    pool.inject_resume_candidates([
      {
        id: 2,
        state: "assigned",
        channel_id: "ch-2",
        entity_id: "e1",
        archetype: "planner",
        channel_type: null,
        session_id: "sess-fail",
        last_active: new Date().toISOString(),
      },
    ]);

    // Make start_tmux throw
    vi.spyOn(pool as unknown as Record<string, unknown>, "start_tmux" as never).mockRejectedValue(
      new Error("tmux failed"),
    );

    await pool.resume_parked_bots();
    await vi.advanceTimersByTimeAsync(25_000);

    // writeFile should NOT have been called with the pending nudge path
    const write_calls = (writeFile as Mock).mock.calls;
    const nudge_call = write_calls.find((c: unknown[]) =>
      (c[0] as string).includes("lf-pending-pool-2"),
    );
    expect(nudge_call).toBeUndefined();

    // send-keys should NOT have been called for this bot
    const send_calls = (execFileSync as Mock).mock.calls.filter(
      (c: unknown[]) =>
        c[0] === "tmux" &&
        (c[1] as string[])[0] === "send-keys" &&
        (c[1] as string[])[2] === "pool-2",
    );
    expect(send_calls).toHaveLength(0);
  });

  it("does not nudge if bot is not ready within timeout", async () => {
    const bot = make_bot({
      id: 4,
      state: "parked",
      channel_id: "ch-4",
      entity_id: "e1",
      archetype: "planner",
      session_id: "sess-slow",
    });
    pool.inject_bots([bot]);
    pool.inject_resume_candidates([
      {
        id: 4,
        state: "assigned",
        channel_id: "ch-4",
        entity_id: "e1",
        archetype: "planner",
        channel_type: null,
        session_id: "sess-slow",
        last_active: new Date().toISOString(),
      },
    ]);

    // tmux capture-pane never returns the ready indicator.
    // has-session throws — simulates dead session, causing early bail after first attempt.
    (execFileSync as Mock).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "capture-pane") {
        return "Loading conversation history...";
      }
      if (cmd === "tmux" && args[0] === "has-session") {
        throw new Error("no session");
      }
      return "";
    });

    await pool.resume_parked_bots();
    // wait_for_bot_ready_with_retries uses 30s timeout per attempt (3 attempts max).
    // With has-session throwing, it bails after the first 30s attempt.
    await vi.advanceTimersByTimeAsync(35_000);

    const write_calls = (writeFile as Mock).mock.calls;
    const nudge_call = write_calls.find((c: unknown[]) =>
      (c[0] as string).includes("lf-pending-pool-4"),
    );
    expect(nudge_call).toBeUndefined();

    // send-keys should NOT have been called for this bot
    const send_calls = (execFileSync as Mock).mock.calls.filter(
      (c: unknown[]) =>
        c[0] === "tmux" &&
        (c[1] as string[])[0] === "send-keys" &&
        (c[1] as string[])[2] === "pool-4",
    );
    expect(send_calls).toHaveLength(0);
  });
});
