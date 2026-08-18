/**
 * Unit coverage for the agent lock vocabulary (issue #359).
 *
 * This predicate decides whether a cleanup path may clear a lock, so its edge
 * cases are worth pinning down: too loose and cleanup walks over a human's
 * "do not touch"; too strict and every agent worktree leaks forever.
 */

import { describe, expect, it } from "vitest";
import { agent_lock_reason, is_agent_lock } from "../worktree-lock.js";

describe("agent_lock_reason", () => {
  it("matches the reason format already used in the daemon logs", () => {
    expect(agent_lock_reason("issue-570")).toBe("issue-570 active build");
  });

  it("produces reasons its own predicate recognises", () => {
    expect(is_agent_lock(agent_lock_reason("issue-1"))).toBe(true);
    expect(is_agent_lock(agent_lock_reason("feature/no-issue"))).toBe(true);
  });
});

describe("is_agent_lock", () => {
  it("rejects locks placed by anyone else", () => {
    expect(is_agent_lock("builder still running")).toBe(false);
    expect(is_agent_lock("agent session running")).toBe(false);
    expect(is_agent_lock("debugging a flaky test")).toBe(false);
  });

  it("rejects a lock with no reason at all", () => {
    expect(is_agent_lock(null)).toBe(false);
    expect(is_agent_lock(undefined)).toBe(false);
    expect(is_agent_lock("")).toBe(false);
  });

  it("rejects the bare marker, which identifies no owner", () => {
    // Requiring an owner is what keeps the reason useful in `git worktree
    // list` — and stops a generic constant from being clearable.
    expect(is_agent_lock("active build")).toBe(false);
    expect(is_agent_lock(" active build")).toBe(false);
  });

  it("ignores surrounding whitespace, which git may fold in", () => {
    expect(is_agent_lock("  issue-42 active build  ")).toBe(true);
  });
});
