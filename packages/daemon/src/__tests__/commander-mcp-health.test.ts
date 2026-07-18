import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MCP_GIVEUP_THRESHOLD,
  MCP_GRACE_PERIOD_MS,
  MCP_RECOVERY_COOLDOWN_MS,
} from "../mcp-health.js";

// Mock sentry — commander-process.ts imports it directly.
vi.mock("../sentry.js", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

// Mock node:child_process's execFileSync — used by check_mcp_health()'s
// fallback kill_fn (`tmux kill-session`). ESM module namespaces aren't
// spy-able directly, so this needs vi.mock rather than vi.spyOn.
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, execFileSync: vi.fn() };
});

// Mock pool.js's is_tmux_session_idle — commander-process.ts reuses it for
// idle detection. Mocking the whole module would be wrong (pool.ts is huge
// and unrelated); only this one named export is used here.
vi.mock("../pool.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../pool.js")>();
  return {
    ...original,
    is_tmux_session_idle: vi.fn().mockReturnValue(true),
  };
});

// Partially mock mcp-health.js: keep the pure state-machine functions real,
// replace the tmux/pgrep-driving functions with controllable mocks.
vi.mock("../mcp-health.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../mcp-health.js")>();
  return {
    ...original,
    has_mcp_child: vi.fn().mockReturnValue(true),
    run_mcp_recovery_cycle: vi.fn().mockResolvedValue("reconnected"),
    wait_for_mcp_child: vi.fn().mockResolvedValue(true),
  };
});

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    paths: { lobsterfarm_dir: "/tmp" },
  });
}

/** Minimal typed view onto CommanderProcess internals under test. Avoids a
 * blanket `any` — each field/method used below is named explicitly. */
interface CommanderInternals {
  last_started_at: Date | null;
  mcp_state: Map<number, unknown>;
  check_mcp_health(): Promise<void>;
  verify_mcp_post_spawn(): Promise<boolean>;
  is_idle(): boolean;
}

describe("CommanderProcess MCP health (issue #345)", () => {
  let CommanderProcess: typeof import("../commander-process.js").CommanderProcess;
  let mock_has_mcp_child: ReturnType<typeof vi.fn>;
  let mock_run_cycle: ReturnType<typeof vi.fn>;
  let mock_wait: ReturnType<typeof vi.fn>;
  let mock_is_idle: ReturnType<typeof vi.fn>;
  let kill_spy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../commander-process.js");
    CommanderProcess = mod.CommanderProcess;

    const mcp_health = await import("../mcp-health.js");
    mock_has_mcp_child = mcp_health.has_mcp_child as unknown as ReturnType<typeof vi.fn>;
    mock_run_cycle = mcp_health.run_mcp_recovery_cycle as unknown as ReturnType<typeof vi.fn>;
    mock_wait = mcp_health.wait_for_mcp_child as unknown as ReturnType<typeof vi.fn>;
    mock_has_mcp_child.mockReturnValue(true);
    mock_run_cycle.mockReset().mockResolvedValue("reconnected");
    mock_wait.mockReset().mockResolvedValue(true);

    const pool = await import("../pool.js");
    mock_is_idle = pool.is_tmux_session_idle as unknown as ReturnType<typeof vi.fn>;
    mock_is_idle.mockReturnValue(true);

    const child_process = await import("node:child_process");
    kill_spy = child_process.execFileSync as unknown as ReturnType<typeof vi.fn>;
    (kill_spy as ReturnType<typeof vi.fn>).mockReset().mockReturnValue("");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function make_commander(): InstanceType<typeof CommanderProcess> & CommanderInternals {
    const commander = new CommanderProcess(make_config());
    return commander as unknown as InstanceType<typeof CommanderProcess> & CommanderInternals;
  }

  describe("check_mcp_health", () => {
    it("does nothing when the MCP child is present", async () => {
      const c = make_commander();
      c.last_started_at = new Date(Date.now() - MCP_GRACE_PERIOD_MS - 1000);
      mock_has_mcp_child.mockReturnValue(true);

      await c.check_mcp_health();
      await c.check_mcp_health();

      expect(mock_run_cycle).not.toHaveBeenCalled();
    });

    it("does not act within the grace period after a fresh start", async () => {
      const c = make_commander();
      c.last_started_at = new Date();
      mock_has_mcp_child.mockReturnValue(false);

      await c.check_mcp_health();

      expect(mock_run_cycle).not.toHaveBeenCalled();
    });

    it("runs a recovery cycle once consecutive fails cross the threshold", async () => {
      const c = make_commander();
      c.last_started_at = new Date(Date.now() - MCP_GRACE_PERIOD_MS - 1000);
      mock_has_mcp_child.mockReturnValue(false);

      await c.check_mcp_health(); // 1st fail
      await c.check_mcp_health(); // 2nd fail — fires

      expect(mock_run_cycle).toHaveBeenCalledTimes(1);
      expect(mock_run_cycle.mock.calls[0][0]).toBe("pat");
    });

    it("defers while mid-turn (not idle)", async () => {
      const c = make_commander();
      c.last_started_at = new Date(Date.now() - MCP_GRACE_PERIOD_MS - 1000);
      mock_has_mcp_child.mockReturnValue(false);
      mock_is_idle.mockReturnValue(false);

      await c.check_mcp_health();
      await c.check_mcp_health();
      await c.check_mcp_health();

      expect(mock_run_cycle).not.toHaveBeenCalled();
    });

    it("kills the tmux session via the fallback callback when Reconnect is exhausted", async () => {
      const c = make_commander();
      c.last_started_at = new Date(Date.now() - MCP_GRACE_PERIOD_MS - 1000);
      mock_has_mcp_child.mockReturnValue(false);
      mock_run_cycle.mockImplementation(async (_session: string, kill_fn: () => void) => {
        kill_fn();
        return "fell_back";
      });

      await c.check_mcp_health();
      await c.check_mcp_health();

      expect(kill_spy).toHaveBeenCalledWith(
        "tmux",
        ["kill-session", "-t", "pat"],
        expect.objectContaining({ stdio: "ignore" }),
      );
    });

    it("gives up after MCP_GIVEUP_THRESHOLD failed cycles and captures to sentry, without spamming further cycles", async () => {
      const c = make_commander();
      c.last_started_at = new Date(Date.now() - MCP_GRACE_PERIOD_MS - 1000);
      mock_has_mcp_child.mockReturnValue(false);
      mock_run_cycle.mockResolvedValue("fell_back");

      let now = Date.now();
      const real_now = Date.now;
      vi.spyOn(Date, "now").mockImplementation(() => now);

      await c.check_mcp_health(); // 1st fail
      for (let i = 0; i < MCP_GIVEUP_THRESHOLD; i++) {
        now += MCP_RECOVERY_COOLDOWN_MS + 1000;
        await c.check_mcp_health();
      }

      vi.spyOn(Date, "now").mockImplementation(real_now);

      expect(mock_run_cycle).toHaveBeenCalledTimes(MCP_GIVEUP_THRESHOLD);

      const sentry = await import("../sentry.js");
      expect(sentry.captureMessage).toHaveBeenCalledWith(
        "Commander MCP recovery gave up",
        "error",
        expect.anything(),
      );

      // Silent afterward — no further recovery cycles fire.
      now += MCP_RECOVERY_COOLDOWN_MS + 1000;
      await c.check_mcp_health();
      expect(mock_run_cycle).toHaveBeenCalledTimes(MCP_GIVEUP_THRESHOLD);
    });
  });

  describe("verify_mcp_post_spawn", () => {
    it("returns true immediately when the MCP child appears within the grace wait", async () => {
      mock_wait.mockResolvedValue(true);
      const c = make_commander();

      const result = await c.verify_mcp_post_spawn();

      expect(result).toBe(true);
      expect(mock_run_cycle).not.toHaveBeenCalled();
    });

    it("falls through to a scripted reconnect when the grace wait times out", async () => {
      mock_wait.mockResolvedValue(false);
      mock_run_cycle.mockResolvedValue("reconnected");
      const c = make_commander();

      const result = await c.verify_mcp_post_spawn();

      expect(result).toBe(true);
      expect(mock_run_cycle.mock.calls[0][0]).toBe("pat");
    });

    it("returns false without killing tmux when both the wait and reconnect fail", async () => {
      mock_wait.mockResolvedValue(false);
      mock_run_cycle.mockImplementation(async (_session: string, kill_fn: () => void) => {
        // Post-spawn recovery must pass a no-op kill_fn — killing a session
        // we just spawned would defeat the point of "post-spawn verify".
        kill_fn();
        return "fell_back";
      });
      const c = make_commander();

      const result = await c.verify_mcp_post_spawn();

      expect(result).toBe(false);
      expect(kill_spy).not.toHaveBeenCalledWith(
        "tmux",
        ["kill-session", "-t", "pat"],
        expect.anything(),
      );
    });
  });
});
