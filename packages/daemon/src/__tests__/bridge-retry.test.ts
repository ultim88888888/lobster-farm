import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ──

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
import { wait_for_bot_ready, wait_for_bot_ready_with_retries } from "../pool.js";

// ── Tests ──

describe("wait_for_bot_ready", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns true when bot shows ready indicators", async () => {
    (execFileSync as Mock).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "capture-pane") {
        return "Listening for channel messages\n❯ ";
      }
      return "";
    });

    const result_promise = wait_for_bot_ready("pool-0", { timeout_ms: 5000, poll_ms: 100 });
    await vi.advanceTimersByTimeAsync(500);
    const result = await result_promise;
    expect(result).toBe(true);
  });

  it("returns true when bot shows bypass permissions indicator", async () => {
    (execFileSync as Mock).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "capture-pane") {
        return "Listening for channel messages\nbypass permissions";
      }
      return "";
    });

    const result_promise = wait_for_bot_ready("pool-0", { timeout_ms: 5000, poll_ms: 100 });
    await vi.advanceTimersByTimeAsync(500);
    const result = await result_promise;
    expect(result).toBe(true);
  });

  it("returns false when bot never becomes ready", async () => {
    (execFileSync as Mock).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "capture-pane") {
        return "Loading conversation history...";
      }
      return "";
    });

    const result_promise = wait_for_bot_ready("pool-0", { timeout_ms: 2000, poll_ms: 100 });
    await vi.advanceTimersByTimeAsync(3000);
    const result = await result_promise;
    expect(result).toBe(false);
  });

  it("returns false when tmux capture-pane keeps throwing", async () => {
    (execFileSync as Mock).mockImplementation(() => {
      throw new Error("tmux not found");
    });

    const result_promise = wait_for_bot_ready("pool-0", { timeout_ms: 2000, poll_ms: 100 });
    await vi.advanceTimersByTimeAsync(3000);
    const result = await result_promise;
    expect(result).toBe(false);
  });

  it("uses 500ms poll and 30s timeout by default", async () => {
    let poll_count = 0;
    (execFileSync as Mock).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "capture-pane") {
        poll_count++;
        // Become ready after ~5 polls
        if (poll_count >= 5) {
          return "Listening for channel messages\n❯ ";
        }
        return "Loading...";
      }
      return "";
    });

    const result_promise = wait_for_bot_ready("pool-0");
    await vi.advanceTimersByTimeAsync(5000);
    const result = await result_promise;
    expect(result).toBe(true);
    // With 500ms polling, ~5 polls means the bot was checked at 500, 1000, 1500, 2000, 2500ms
    expect(poll_count).toBeGreaterThanOrEqual(5);
  });

  it("requires both Listening and prompt indicators", async () => {
    // Only prompt, no "Listening for channel messages"
    (execFileSync as Mock).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "capture-pane") {
        return "❯ ";
      }
      return "";
    });

    const result_promise = wait_for_bot_ready("pool-0", { timeout_ms: 1000, poll_ms: 100 });
    await vi.advanceTimersByTimeAsync(1500);
    const result = await result_promise;
    expect(result).toBe(false);
  });
});

describe("wait_for_bot_ready_with_retries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("succeeds on first attempt when bot is ready", async () => {
    (execFileSync as Mock).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "capture-pane") {
        return "Listening for channel messages\n❯ ";
      }
      return "";
    });

    const result_promise = wait_for_bot_ready_with_retries("pool-0", {
      timeout_ms: 2000,
      poll_ms: 100,
    });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await result_promise;
    expect(result).toBe(true);
  });

  it("retries and succeeds on second attempt", async () => {
    let attempt = 0;
    (execFileSync as Mock).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "capture-pane") {
        // First attempt (~2s timeout): never ready. Second attempt: ready.
        if (attempt >= 1) {
          return "Listening for channel messages\n❯ ";
        }
        return "Loading...";
      }
      if (cmd === "tmux" && args[0] === "has-session") {
        // Session is alive — allow retry
        return "";
      }
      return "";
    });

    const result_promise = wait_for_bot_ready_with_retries("pool-0", {
      timeout_ms: 2000,
      poll_ms: 100,
      max_attempts: 3,
    });

    // Advance past first attempt timeout
    await vi.advanceTimersByTimeAsync(2500);
    // After first timeout, the code checks has-session and logs retry
    attempt = 1;
    // Advance through second attempt
    await vi.advanceTimersByTimeAsync(1000);

    const result = await result_promise;
    expect(result).toBe(true);
  });

  it("bails early when tmux session dies between retries", async () => {
    (execFileSync as Mock).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "capture-pane") {
        return "Loading...";
      }
      if (cmd === "tmux" && args[0] === "has-session") {
        // Session died
        throw new Error("no session");
      }
      return "";
    });

    const result_promise = wait_for_bot_ready_with_retries("pool-0", {
      timeout_ms: 2000,
      poll_ms: 100,
      max_attempts: 3,
    });
    // Advance past first attempt + bail check
    await vi.advanceTimersByTimeAsync(3000);
    const result = await result_promise;
    expect(result).toBe(false);
  });

  it("returns false after all attempts exhausted", async () => {
    (execFileSync as Mock).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "capture-pane") {
        return "Loading...";
      }
      if (cmd === "tmux" && args[0] === "has-session") {
        return ""; // Session alive — allow all retries
      }
      return "";
    });

    const result_promise = wait_for_bot_ready_with_retries("pool-0", {
      timeout_ms: 1000,
      poll_ms: 100,
      max_attempts: 3,
    });
    // Need enough time for 3 attempts of 1s each
    await vi.advanceTimersByTimeAsync(5000);
    const result = await result_promise;
    expect(result).toBe(false);
  });

  it("defaults to 3 max_attempts", async () => {
    let has_session_calls = 0;
    (execFileSync as Mock).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "capture-pane") {
        return "Loading...";
      }
      if (cmd === "tmux" && args[0] === "has-session") {
        has_session_calls++;
        return "";
      }
      return "";
    });

    const result_promise = wait_for_bot_ready_with_retries("pool-0", {
      timeout_ms: 500,
      poll_ms: 100,
    });
    await vi.advanceTimersByTimeAsync(5000);
    const result = await result_promise;
    expect(result).toBe(false);
    // has-session is called between retries (after attempt 1, after attempt 2)
    // Not called after last attempt
    expect(has_session_calls).toBe(2);
  });
});
