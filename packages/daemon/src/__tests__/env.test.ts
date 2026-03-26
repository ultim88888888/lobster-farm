import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { check_required_binaries, propagate_tmux_env } from "../env.js";

describe("check_required_binaries", () => {
  let original_exit: typeof process.exit;
  let exit_code: number | undefined;

  beforeEach(() => {
    exit_code = undefined;
    original_exit = process.exit;

    // Mock process.exit to capture exit code without actually exiting
    process.exit = vi.fn((code?: number) => {
      exit_code = code ?? 0;
      throw new Error(`process.exit(${String(code)})`);
    }) as never;
  });

  afterEach(() => {
    process.exit = original_exit;
    vi.restoreAllMocks();
  });

  it("exits with code 1 when a required binary is missing", () => {
    // Checker that says "bun" is missing
    const checker = (name: string) => name !== "bun";

    expect(() => check_required_binaries(checker)).toThrow("process.exit(1)");
    expect(exit_code).toBe(1);
  });

  it("succeeds when all required binaries are found", () => {
    // All binaries found
    const checker = () => true;

    expect(() => check_required_binaries(checker)).not.toThrow();
    expect(exit_code).toBeUndefined();
  });

  it("warns but does not exit when only recommended binaries are missing", () => {
    const warn_spy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // `op` is recommended, not required — fail only op
    const checker = (name: string) => name !== "op";

    expect(() => check_required_binaries(checker)).not.toThrow();
    expect(exit_code).toBeUndefined();
    expect(warn_spy).toHaveBeenCalledWith(
      expect.stringContaining("op"),
    );

    warn_spy.mockRestore();
  });

  it("logs the current PATH on failure for debugging", () => {
    const error_spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const original_path = process.env["PATH"];
    process.env["PATH"] = "/test/path:/usr/bin";

    // Fail "claude"
    const checker = (name: string) => name !== "claude";

    try {
      check_required_binaries(checker);
    } catch {
      // Expected — process.exit throws
    }

    expect(error_spy).toHaveBeenCalledWith(
      expect.stringContaining("/test/path:/usr/bin"),
    );

    error_spy.mockRestore();
    process.env["PATH"] = original_path;
  });

  it("lists all missing required binaries in the error message", () => {
    const error_spy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Both bun and claude missing
    const checker = (name: string) => name !== "bun" && name !== "claude";

    try {
      check_required_binaries(checker);
    } catch {
      // Expected
    }

    expect(error_spy).toHaveBeenCalledWith(
      expect.stringContaining("claude, bun"),
    );

    error_spy.mockRestore();
  });
});

describe("propagate_tmux_env", () => {
  it("calls tmux setter for each present env var", () => {
    const calls: Array<[string, string]> = [];
    const setter = (key: string, value: string) => {
      calls.push([key, value]);
      return true;
    };

    const env = {
      PATH: "/usr/bin:/bin",
      HOME: "/Users/test",
      BUN_INSTALL: "/Users/test/.bun",
      OP_SERVICE_ACCOUNT_TOKEN: "ops_test123",
    };

    propagate_tmux_env(env, setter);

    expect(calls).toHaveLength(4);
    expect(calls).toContainEqual(["PATH", "/usr/bin:/bin"]);
    expect(calls).toContainEqual(["HOME", "/Users/test"]);
    expect(calls).toContainEqual(["BUN_INSTALL", "/Users/test/.bun"]);
    expect(calls).toContainEqual(["OP_SERVICE_ACCOUNT_TOKEN", "ops_test123"]);
  });

  it("skips env vars that are not set", () => {
    const calls: Array<[string, string]> = [];
    const setter = (key: string, value: string) => {
      calls.push([key, value]);
      return true;
    };

    // Only PATH and HOME are set
    const env = {
      PATH: "/usr/bin",
      HOME: "/Users/test",
    };

    propagate_tmux_env(env, setter);

    expect(calls).toHaveLength(2);
    expect(calls.map(c => c[0])).toEqual(["PATH", "HOME"]);
  });

  it("does not throw when tmux server is not running", () => {
    // All tmux calls fail
    const setter = () => false;

    const env = {
      PATH: "/usr/bin",
      HOME: "/Users/test",
    };

    // Should not throw
    expect(() => propagate_tmux_env(env, setter)).not.toThrow();
  });

  it("logs success message when at least one var propagated", () => {
    const log_spy = vi.spyOn(console, "log").mockImplementation(() => {});

    propagate_tmux_env({ PATH: "/usr/bin" }, () => true);

    expect(log_spy).toHaveBeenCalledWith("[env] Propagated environment to tmux server");

    log_spy.mockRestore();
  });

  it("logs fallback message when no vars could be propagated", () => {
    const log_spy = vi.spyOn(console, "log").mockImplementation(() => {});

    propagate_tmux_env({ PATH: "/usr/bin" }, () => false);

    expect(log_spy).toHaveBeenCalledWith("[env] tmux server not running, will inherit daemon env");

    log_spy.mockRestore();
  });
});
