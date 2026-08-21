/**
 * Tests for the parked-approval resolver (#372).
 *
 * The scenario these exist for: a v1 entity approves a PR while CI is running,
 * the `check_suite.completed` event that was supposed to finish the merge has
 * already fired and no-oped, and nothing else is watching. Before this module
 * the PR sat open forever (PR #371, three hours, merged by hand).
 *
 * The two invariants that must never bend:
 *   - a park whose CI goes green ends up merged
 *   - a park whose CI is pending or failing is never merged
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../sentry.js", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

import type { AlertPayload } from "../alert-router.js";
import {
  PARK_STALE_AFTER_MS,
  type ParkedApprovalDeps,
  type ParkedPRSnapshot,
  sweep_parked_approvals,
} from "../parked-approvals.js";
import type { PRReviewState, ProcessedPR } from "../persistence.js";
import type { AutoMergeResult, CICheckStatus } from "../review-utils.js";

// ── Harness ──

const APPROVED_SHA = "951b8d456d7df43dc57261ef3222fffd9bf0dc19";
const NOW = Date.parse("2026-08-21T19:45:00.000Z");

function parked_entry(overrides: Partial<ProcessedPR> = {}): ProcessedPR {
  return {
    entity_id: "lobster-farm",
    pr_number: 371,
    reviewed_at: "2026-08-21T19:39:19.886Z",
    outcome: "approved",
    v1_approved_sha: APPROVED_SHA,
    v1_parked_at: "2026-08-21T19:39:19.886Z",
    v1_repo_path: "/repos/lobster-farm",
    v1_installation_id: "4242",
    ...overrides,
  };
}

function snapshot(overrides: Partial<ParkedPRSnapshot> = {}): ParkedPRSnapshot {
  return {
    state: "OPEN",
    head_sha: APPROVED_SHA,
    branch: "feat/370-worktree-lock-reaper",
    title: "feat(daemon): reap orphaned worktree locks",
    ...overrides,
  };
}

interface Harness {
  deps: ParkedApprovalDeps;
  state: PRReviewState;
  alerts: AlertPayload[];
  merges: Array<{ pr_number: number; branch: string; repo_path: string; gh_token: string }>;
}

function harness(options: {
  entries?: PRReviewState;
  ci?: CICheckStatus;
  pr?: ParkedPRSnapshot;
  merge_result?: AutoMergeResult;
  now?: number;
}): Harness {
  const state: PRReviewState = structuredClone(
    options.entries ?? { "lobster-farm:371": parked_entry() },
  );
  const alerts: AlertPayload[] = [];
  const merges: Harness["merges"] = [];

  const deps: ParkedApprovalDeps = {
    load_pr_reviews: async () => structuredClone(state),
    save_pr_reviews: async (next) => {
      for (const key of Object.keys(state)) delete state[key];
      Object.assign(state, structuredClone(next));
    },
    resolve_token: async (installation_id) => `token-for-${installation_id ?? "default"}`,
    fetch_pr_snapshot: async () => options.pr ?? snapshot(),
    check_ci_status: async () => options.ci ?? { passed: true, pending: false, failures: [] },
    attempt_merge: async (pr_number, branch, repo_path, gh_token) => {
      merges.push({ pr_number, branch, repo_path, gh_token });
      return options.merge_result ?? { merged: true, method: "direct" };
    },
    post_alert: async (payload) => {
      alerts.push(payload);
      return { message_id: "m1" };
    },
    now: () => options.now ?? NOW,
  };

  return { deps, state, alerts, merges };
}

// ── The regression ──

describe("sweep_parked_approvals — the PR #371 scenario (#372)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("merges a v1 approval that was parked before check_suite could release it", async () => {
    const h = harness({ ci: { passed: true, pending: false, failures: [] } });

    const outcomes = await sweep_parked_approvals(h.deps);

    expect(outcomes).toEqual([{ kind: "merged", entity_id: "lobster-farm", pr_number: 371 }]);
    expect(h.merges).toEqual([
      {
        pr_number: 371,
        branch: "feat/370-worktree-lock-reaper",
        repo_path: "/repos/lobster-farm",
        gh_token: "token-for-4242",
      },
    ]);
    expect(h.alerts.map((a) => a.tier)).toEqual(["routine"]);
  });

  it("stamps the merge attempt before merging so check_suite cannot merge it too", async () => {
    const h = harness({});

    await sweep_parked_approvals(h.deps);

    expect(h.state["lobster-farm:371"]!.v1_merge_attempted_sha).toBe(APPROVED_SHA);
  });

  it("does not act twice on a park it has already merged", async () => {
    const h = harness({
      entries: {
        "lobster-farm:371": parked_entry({ v1_merge_attempted_sha: APPROVED_SHA }),
      },
    });

    const outcomes = await sweep_parked_approvals(h.deps);

    expect(outcomes).toEqual([]);
    expect(h.merges).toEqual([]);
  });

  it("survives a daemon restart — the park is read back from persisted state", async () => {
    // A "restart" is just a fresh sweep over the same on-disk state: nothing
    // about the park lives in a timer or in memory.
    const h = harness({ ci: { passed: false, pending: true, failures: [] } });
    await sweep_parked_approvals(h.deps);
    expect(h.state["lobster-farm:371"]!.v1_approved_sha).toBe(APPROVED_SHA);

    const restarted = harness({
      entries: h.state,
      ci: { passed: true, pending: false, failures: [] },
    });
    const outcomes = await sweep_parked_approvals(restarted.deps);

    expect(outcomes).toEqual([{ kind: "merged", entity_id: "lobster-farm", pr_number: 371 }]);
    expect(restarted.merges).toHaveLength(1);
  });
});

// ── Never merge past CI ──

describe("sweep_parked_approvals — never merges past CI", () => {
  it("does not merge while checks are pending", async () => {
    const h = harness({ ci: { passed: false, pending: true, failures: [] } });

    const outcomes = await sweep_parked_approvals(h.deps);

    expect(outcomes).toEqual([{ kind: "waiting", entity_id: "lobster-farm", pr_number: 371 }]);
    expect(h.merges).toEqual([]);
    expect(h.state["lobster-farm:371"]!.v1_approved_sha).toBe(APPROVED_SHA);
  });

  it("does not merge when checks failed — it alerts and drops the park", async () => {
    const h = harness({ ci: { passed: false, pending: false, failures: ["Lint", "Test"] } });

    const outcomes = await sweep_parked_approvals(h.deps);

    expect(outcomes).toEqual([
      { kind: "escalated", entity_id: "lobster-farm", pr_number: 371, reason: "ci_failed" },
    ]);
    expect(h.merges).toEqual([]);
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]!.tier).toBe("action_required");
    expect(h.alerts[0]!.body).toContain("Lint, Test");
    expect(h.state["lobster-farm:371"]!.v1_approved_sha).toBeUndefined();
  });

  it("does not merge a PR whose head moved after the approval", async () => {
    const h = harness({ pr: snapshot({ head_sha: "0000000000000000000000000000000000000000" }) });

    const outcomes = await sweep_parked_approvals(h.deps);

    expect(outcomes).toEqual([
      { kind: "cleared", entity_id: "lobster-farm", pr_number: 371, reason: "sha_moved" },
    ]);
    expect(h.merges).toEqual([]);
    expect(h.alerts).toEqual([]);
  });

  it("drops the park silently when the PR is already merged or closed", async () => {
    for (const state of ["MERGED", "CLOSED"]) {
      const h = harness({ pr: snapshot({ state }) });

      const outcomes = await sweep_parked_approvals(h.deps);

      expect(outcomes).toEqual([
        { kind: "cleared", entity_id: "lobster-farm", pr_number: 371, reason: "pr_gone" },
      ]);
      expect(h.merges).toEqual([]);
      expect(h.alerts).toEqual([]);
      expect(h.state["lobster-farm:371"]!.v1_approved_sha).toBeUndefined();
    }
  });
});

// ── Loud failure ──

describe("sweep_parked_approvals — escalates rather than expiring quietly", () => {
  const parked_at = "2026-08-21T19:39:19.886Z";
  const stale_now = Date.parse(parked_at) + PARK_STALE_AFTER_MS + 1;

  it("escalates a park that has waited past the staleness threshold", async () => {
    const h = harness({
      ci: { passed: false, pending: true, failures: [] },
      now: stale_now,
    });

    const outcomes = await sweep_parked_approvals(h.deps);

    expect(outcomes).toEqual([
      { kind: "escalated", entity_id: "lobster-farm", pr_number: 371, reason: "stale" },
    ]);
    expect(h.alerts[0]!.tier).toBe("action_required");
    // Still parked — escalating tells a human, it does not give up.
    expect(h.state["lobster-farm:371"]!.v1_approved_sha).toBe(APPROVED_SHA);
  });

  it("escalates once per parked commit, not once per tick", async () => {
    const h = harness({
      ci: { passed: false, pending: true, failures: [] },
      now: stale_now,
    });

    await sweep_parked_approvals(h.deps);
    await sweep_parked_approvals(h.deps);
    await sweep_parked_approvals(h.deps);

    expect(h.alerts).toHaveLength(1);
  });

  it("still merges a stale park once its CI finally reports green", async () => {
    const h = harness({ ci: { passed: false, pending: true, failures: [] }, now: stale_now });
    await sweep_parked_approvals(h.deps);

    const later = harness({
      entries: h.state,
      ci: { passed: true, pending: false, failures: [] },
      now: stale_now + 60_000,
    });
    const outcomes = await sweep_parked_approvals(later.deps);

    expect(outcomes).toEqual([{ kind: "merged", entity_id: "lobster-farm", pr_number: 371 }]);
  });

  it("escalates when the merge itself fails", async () => {
    const h = harness({ merge_result: { merged: false, failure: "CONFLICT", error: "conflicts" } });

    const outcomes = await sweep_parked_approvals(h.deps);

    expect(outcomes).toEqual([
      { kind: "escalated", entity_id: "lobster-farm", pr_number: 371, reason: "merge_failed" },
    ]);
    expect(h.alerts[0]!.tier).toBe("action_required");
    expect(h.alerts[0]!.body).toContain("CONFLICT");
  });

  it("escalates a park written before the repo path was recorded", async () => {
    const h = harness({
      entries: { "lobster-farm:371": parked_entry({ v1_repo_path: undefined }) },
    });

    const outcomes = await sweep_parked_approvals(h.deps);

    expect(outcomes).toEqual([
      { kind: "escalated", entity_id: "lobster-farm", pr_number: 371, reason: "unresolvable" },
    ]);
    expect(h.merges).toEqual([]);
    expect(h.alerts[0]!.tier).toBe("action_required");
    expect(h.state["lobster-farm:371"]!.v1_approved_sha).toBeUndefined();
  });

  it("stamps a missing park timestamp instead of escalating on the first sight", async () => {
    const h = harness({
      entries: { "lobster-farm:371": parked_entry({ v1_parked_at: undefined }) },
      ci: { passed: false, pending: true, failures: [] },
    });

    const outcomes = await sweep_parked_approvals(h.deps);

    expect(outcomes).toEqual([{ kind: "waiting", entity_id: "lobster-farm", pr_number: 371 }]);
    expect(h.alerts).toEqual([]);
    expect(h.state["lobster-farm:371"]!.v1_parked_at).toBe(new Date(NOW).toISOString());
  });
});

// ── Scoping and resilience ──

describe("sweep_parked_approvals — scoping and resilience", () => {
  it("ignores review records that are not parked approvals", async () => {
    const h = harness({
      entries: {
        "e:1": { entity_id: "e", pr_number: 1, reviewed_at: "x", outcome: "changes_requested" },
        // The CI fix loop also writes outcome: "approved" — without a pinned
        // SHA that is not a park and must never be merged.
        "e:2": { entity_id: "e", pr_number: 2, reviewed_at: "x", outcome: "approved" },
        "e:3": { entity_id: "e", pr_number: 3, reviewed_at: "x", outcome: "pending" },
      },
    });

    const outcomes = await sweep_parked_approvals(h.deps);

    expect(outcomes).toEqual([]);
    expect(h.merges).toEqual([]);
  });

  it("keeps resolving other parks when one throws", async () => {
    const h = harness({
      entries: {
        "e:1": parked_entry({ entity_id: "e", pr_number: 1, v1_repo_path: "/repos/boom" }),
        "e:2": parked_entry({ entity_id: "e", pr_number: 2, v1_repo_path: "/repos/ok" }),
      },
    });
    const original = h.deps.fetch_pr_snapshot;
    h.deps.fetch_pr_snapshot = async (pr_number, repo_path, token) => {
      if (pr_number === 1) throw new Error("gh exploded");
      return original(pr_number, repo_path, token);
    };

    const outcomes = await sweep_parked_approvals(h.deps);

    expect(outcomes).toHaveLength(2);
    expect(outcomes[1]).toEqual({ kind: "merged", entity_id: "e", pr_number: 2 });
    expect(h.merges.map((m) => m.pr_number)).toEqual([2]);
  });
});
