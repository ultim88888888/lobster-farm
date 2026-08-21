/**
 * Unit coverage for the orphaned-lock reaper's decision logic (issue #370).
 *
 * Every branch here decides whether to clear a "do not touch" sign. The
 * asymmetry that shapes the whole table: releasing a lock we should have kept
 * exposes real work to the sweep, while keeping a lock we could have released
 * costs a directory until the next hour. So every uncertain answer is "keep".
 */

import { describe, expect, it, vi } from "vitest";
import {
  LOCK_REAP_GRACE_MS,
  type LivenessProbes,
  UNATTRIBUTABLE_LOCK_REAP_GRACE_MS,
  lock_reap_decision,
  owner_liveness,
} from "../worktree-lock-reaper.js";
import { agent_lock_reason } from "../worktree-lock.js";

const HOUR = 60 * 60 * 1000;

/** A lock of ours naming an owner, as written since #370. */
const owned = agent_lock_reason("issue-570", { kind: "pid", id: "4242" });
/** A lock of ours from before #370 — ours, but naming nobody resolvable. */
const legacy = agent_lock_reason("issue-570");

describe("grace period constants", () => {
  it("gives an unattributable lock a longer rope than an orphaned one", () => {
    expect(LOCK_REAP_GRACE_MS).toBe(2 * HOUR);
    expect(UNATTRIBUTABLE_LOCK_REAP_GRACE_MS).toBe(24 * HOUR);
  });
});

describe("lock_reap_decision — foreign locks", () => {
  // The #358 guarantee. A reason we do not recognise is a human or another
  // tool saying "do not touch", and no amount of age is an answer to that.
  const foreign = [
    "added with --lock",
    "Ray - issue #151 follow-up, in progress",
    "agent-556 active",
    "active agent session #577",
    "active build", // the bare marker names no owner, so it is not ours
  ];

  for (const locked_reason of foreign) {
    it(`never releases ${JSON.stringify(locked_reason)}, at any age`, () => {
      for (const age_ms of [0, HOUR, 48 * HOUR, 365 * 24 * HOUR]) {
        const decision = lock_reap_decision({
          locked_reason,
          owner: null,
          liveness: "gone",
          age_ms,
        });
        expect(decision.action).toBe("keep");
      }
    });
  }
});

describe("lock_reap_decision — our locks with a resolvable owner", () => {
  it("keeps a lock whose owner is alive, however old the directory is", () => {
    const decision = lock_reap_decision({
      locked_reason: owned,
      owner: { kind: "pid", id: "4242" },
      liveness: "alive",
      age_ms: 365 * 24 * HOUR,
    });
    expect(decision.action).toBe("keep");
  });

  it("keeps a lock when the liveness probe could not answer", () => {
    // tmux missing, a timeout, a signal — none of those are evidence the
    // owner died, and guessing wrong here is the expensive direction.
    const decision = lock_reap_decision({
      locked_reason: owned,
      owner: { kind: "tmux", id: "pool-3" },
      liveness: "unknown",
      age_ms: 48 * HOUR,
    });
    expect(decision.action).toBe("keep");
  });

  it("keeps a lock whose owner is gone but whose directory is still warm", () => {
    const decision = lock_reap_decision({
      locked_reason: owned,
      owner: { kind: "pid", id: "4242" },
      liveness: "gone",
      age_ms: LOCK_REAP_GRACE_MS - 60_000,
    });
    expect(decision.action).toBe("keep");
  });

  it("releases a lock whose owner is gone once the directory is past grace", () => {
    const decision = lock_reap_decision({
      locked_reason: owned,
      owner: { kind: "pid", id: "4242" },
      liveness: "gone",
      age_ms: LOCK_REAP_GRACE_MS + 60_000,
    });
    expect(decision.action).toBe("release");
    if (decision.action !== "release") return;
    // Routine housekeeping — the loud channel is reserved for the locks whose
    // ownership nobody can reconstruct.
    expect(decision.loud).toBe(false);
  });
});

describe("lock_reap_decision — our locks predating the owner token", () => {
  it("treats an unresolvable owner as gone and releases past grace", () => {
    // These are the 80 stale locks measured on the live instance: ours by
    // format, but naming an owner nothing can look up.
    const decision = lock_reap_decision({
      locked_reason: legacy,
      owner: null,
      liveness: "unknown",
      age_ms: LOCK_REAP_GRACE_MS + 60_000,
    });
    expect(decision.action).toBe("release");
  });

  it("still honours the grace period for them", () => {
    const decision = lock_reap_decision({
      locked_reason: legacy,
      owner: null,
      liveness: "unknown",
      age_ms: LOCK_REAP_GRACE_MS - 60_000,
    });
    expect(decision.action).toBe("keep");
  });
});

describe("lock_reap_decision — unattributable locks", () => {
  // 29 of the 35 locks measured in canalstreet-admin recorded no reason at
  // all. Ownership is unknowable, so the only lever left is age.
  for (const locked_reason of [null, "", "   "]) {
    it(`keeps a no-reason lock (${JSON.stringify(locked_reason)}) inside the long grace`, () => {
      const decision = lock_reap_decision({
        locked_reason,
        owner: null,
        liveness: "unknown",
        age_ms: UNATTRIBUTABLE_LOCK_REAP_GRACE_MS - HOUR,
      });
      expect(decision.action).toBe("keep");
    });

    it(`releases a no-reason lock (${JSON.stringify(locked_reason)}) past the long grace, loudly`, () => {
      const decision = lock_reap_decision({
        locked_reason,
        owner: null,
        liveness: "unknown",
        age_ms: UNATTRIBUTABLE_LOCK_REAP_GRACE_MS + HOUR,
      });
      expect(decision.action).toBe("release");
      if (decision.action !== "release") return;
      expect(decision.loud).toBe(true);
    });
  }

  it("does not release a no-reason lock at the shorter grace", () => {
    // The long grace is the whole point: an unowned lock gets more rope than
    // one whose owner we watched die.
    const decision = lock_reap_decision({
      locked_reason: null,
      owner: null,
      liveness: "unknown",
      age_ms: LOCK_REAP_GRACE_MS + HOUR,
    });
    expect(decision.action).toBe("keep");
  });
});

describe("lock_reap_decision — unknown age", () => {
  it("keeps every lock whose directory age could not be read", () => {
    for (const locked_reason of [null, legacy, owned]) {
      const decision = lock_reap_decision({
        locked_reason,
        owner: null,
        liveness: "gone",
        age_ms: null,
      });
      expect(decision.action).toBe("keep");
    }
  });
});

describe("owner_liveness", () => {
  it("reports unknown when there is no owner to resolve", () => {
    expect(owner_liveness(null)).toBe("unknown");
  });

  it("reports this very process as alive", () => {
    expect(owner_liveness({ kind: "pid", id: String(process.pid) })).toBe("alive");
  });

  it("reports a pid that has exited as gone", async () => {
    const { spawn } = await import("node:child_process");
    const child = spawn("sleep", ["30"]);
    const pid = child.pid;
    expect(pid).toBeTypeOf("number");
    await new Promise<void>((resolve) => {
      child.once("exit", () => {
        resolve();
      });
      child.kill("SIGKILL");
    });

    expect(owner_liveness({ kind: "pid", id: String(pid) })).toBe("gone");
  });

  it("routes a tmux owner to the tmux probe, by its bare session name", () => {
    // The exact-match `=` prefix is the probe's own business (tmux resolves a
    // bare target by prefix, so a dead `pool-1` would otherwise match a live
    // `pool-10`); what is asserted here is that the name arrives unmangled.
    const tmux_session_alive = vi.fn(() => true);
    const process_alive = vi.fn(() => null);
    const probes: LivenessProbes = { tmux_session_alive, process_alive };

    expect(owner_liveness({ kind: "tmux", id: "pool-1" }, probes)).toBe("alive");
    expect(tmux_session_alive).toHaveBeenCalledWith("pool-1");
    expect(process_alive).not.toHaveBeenCalled();
  });

  it("routes a pid owner to the process probe, as a number", () => {
    const tmux_session_alive = vi.fn(() => null);
    const process_alive = vi.fn(() => true);
    const probes: LivenessProbes = { tmux_session_alive, process_alive };

    expect(owner_liveness({ kind: "pid", id: "4242" }, probes)).toBe("alive");
    expect(process_alive).toHaveBeenCalledWith(4242);
    expect(tmux_session_alive).not.toHaveBeenCalled();
  });

  it("maps a probe that cannot answer to unknown, not to gone", () => {
    const probes: LivenessProbes = {
      tmux_session_alive: () => null,
      process_alive: () => null,
    };
    expect(owner_liveness({ kind: "tmux", id: "pool-3" }, probes)).toBe("unknown");
    expect(owner_liveness({ kind: "pid", id: "4242" }, probes)).toBe("unknown");
  });

  it("maps a negative probe answer to gone", () => {
    const probes: LivenessProbes = {
      tmux_session_alive: () => false,
      process_alive: () => false,
    };
    expect(owner_liveness({ kind: "tmux", id: "pool-3" }, probes)).toBe("gone");
    expect(owner_liveness({ kind: "pid", id: "4242" }, probes)).toBe("gone");
  });
});
