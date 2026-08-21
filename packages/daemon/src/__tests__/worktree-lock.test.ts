/**
 * Unit coverage for the agent lock vocabulary (issue #359).
 *
 * This predicate decides whether a cleanup path may clear a lock, so its edge
 * cases are worth pinning down: too loose and cleanup walks over a human's
 * "do not touch"; too strict and every agent worktree leaks forever.
 */

import { describe, expect, it } from "vitest";
import { agent_lock_reason, is_agent_lock, parse_lock_owner } from "../worktree-lock.js";

describe("agent_lock_reason", () => {
  it("matches the reason format already used in the daemon logs", () => {
    expect(agent_lock_reason("issue-570")).toBe("issue-570 active build");
  });

  it("produces reasons its own predicate recognises", () => {
    expect(is_agent_lock(agent_lock_reason("issue-1"))).toBe(true);
    expect(is_agent_lock(agent_lock_reason("feature/no-issue"))).toBe(true);
  });

  it("embeds a machine-readable owner token when given an owner", () => {
    expect(agent_lock_reason("issue-570", { kind: "tmux", id: "pool-3" })).toBe(
      "issue-570 [lf-owner:tmux:pool-3] active build",
    );
    expect(agent_lock_reason("issue-570", { kind: "pid", id: "4242" })).toBe(
      "issue-570 [lf-owner:pid:4242] active build",
    );
  });

  it("keeps the agent marker last, so the #358 predicate still recognises it", () => {
    // The token is inserted *before* the suffix on purpose: `is_agent_lock`
    // matches on the trailing phrase, and locks placed before #370 must keep
    // reading as ours or the reaper would treat them as foreign forever.
    const reason = agent_lock_reason("issue-570", { kind: "pid", id: "4242" });
    expect(is_agent_lock(reason)).toBe(true);
  });

  it("strips bracket characters that would break the token back out", () => {
    const reason = agent_lock_reason("issue-1", { kind: "tmux", id: "we[ir]d" });
    expect(parse_lock_owner(reason)).toEqual({ kind: "tmux", id: "weird" });
  });
});

describe("parse_lock_owner", () => {
  it("round-trips every owner kind it can write", () => {
    expect(parse_lock_owner(agent_lock_reason("issue-9", { kind: "tmux", id: "pool-7" }))).toEqual({
      kind: "tmux",
      id: "pool-7",
    });
    expect(parse_lock_owner(agent_lock_reason("issue-9", { kind: "pid", id: "123" }))).toEqual({
      kind: "pid",
      id: "123",
    });
  });

  it("returns null for a lock placed before the token existed", () => {
    // The 80 stale locks measured on the live instance look exactly like this.
    expect(parse_lock_owner("issue-570 active build")).toBeNull();
  });

  it("returns null for reasons with no token at all", () => {
    expect(parse_lock_owner(null)).toBeNull();
    expect(parse_lock_owner(undefined)).toBeNull();
    expect(parse_lock_owner("")).toBeNull();
    expect(parse_lock_owner("Ray - issue #151 follow-up, in progress")).toBeNull();
  });

  it("rejects tokens it cannot act on", () => {
    // An unknown kind is not resolvable, and neither is a pid that is not a
    // positive integer — both must read as "no owner", never as a live one.
    expect(parse_lock_owner("x [lf-owner:ouija:spirit] active build")).toBeNull();
    expect(parse_lock_owner("x [lf-owner:pid:not-a-number] active build")).toBeNull();
    expect(parse_lock_owner("x [lf-owner:pid:0] active build")).toBeNull();
    expect(parse_lock_owner("x [lf-owner:pid:-1] active build")).toBeNull();
    expect(parse_lock_owner("x [lf-owner:tmux:] active build")).toBeNull();
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
