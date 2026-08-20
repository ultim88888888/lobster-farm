/**
 * Tests for the v2 merge-gate (#257).
 *
 * The merge-gate is a pure function over its dependency seam — every external
 * call (gh pr view, gh pr checks, gh pr merge, git rebase) is provided through
 * the MergeGateDeps interface. Tests stub those rather than mocking
 * node:child_process, which keeps the surface tiny and the assertions sharp.
 */

import { describe, expect, it, vi } from "vitest";
import { type MergeGateDeps, type MergeGateInput, run_merge_gate } from "../merge-gate.js";
import type { CICheckStatus, LocalRebaseResult, PRMergeability } from "../review-utils.js";

// ── Helpers ──

const APPROVED_SHA = "deadbeef0000000000000000000000000000beef";

function make_input(overrides: Partial<MergeGateInput> = {}): MergeGateInput {
  return {
    pr_number: 42,
    branch: "feature/test",
    approved_sha: APPROVED_SHA,
    repo_path: "/tmp/test-repo",
    gh_token: "ghs_test_token",
    ...overrides,
  };
}

interface DepFixtures {
  mergeability?: PRMergeability;
  mergeability_error?: Error;
  ci?: CICheckStatus;
  rebase?: LocalRebaseResult;
  merge_error?: Error;
}

function make_deps(fixtures: DepFixtures = {}): MergeGateDeps {
  const mergeability: PRMergeability = fixtures.mergeability ?? {
    mergeable: "MERGEABLE",
    merge_state_status: "CLEAN",
    head_sha: APPROVED_SHA,
  };
  const ci: CICheckStatus = fixtures.ci ?? { passed: true, pending: false, failures: [] };
  const rebase: LocalRebaseResult = fixtures.rebase ?? { success: true };

  return {
    fetch_pr_mergeability: vi.fn(async () => {
      if (fixtures.mergeability_error) throw fixtures.mergeability_error;
      return mergeability;
    }),
    check_ci_status: vi.fn(async () => ci),
    try_local_rebase: vi.fn(async () => rebase),
    gh_pr_merge: vi.fn(async () => {
      if (fixtures.merge_error) throw fixtures.merge_error;
    }),
    sleep: vi.fn(async () => {}),
  };
}

// ── Tests ──

describe("run_merge_gate", () => {
  it("happy path: clean state, CI green, SHA unchanged → merges", async () => {
    const deps = make_deps();
    const result = await run_merge_gate(make_input(), deps);

    expect(result).toEqual({ kind: "merged", method: "direct" });
    expect(deps.gh_pr_merge).toHaveBeenCalledTimes(1);
    expect(deps.gh_pr_merge).toHaveBeenCalledWith(42, "/tmp/test-repo", "ghs_test_token");
  });

  it("HAS_HOOKS counts as mergeable (post-merge hook is OK)", async () => {
    const deps = make_deps({
      mergeability: {
        mergeable: "MERGEABLE",
        merge_state_status: "HAS_HOOKS",
        head_sha: APPROVED_SHA,
      },
    });
    const result = await run_merge_gate(make_input(), deps);

    expect(result.kind).toBe("merged");
    expect(deps.gh_pr_merge).toHaveBeenCalled();
  });

  it("UNSTABLE state merges (non-required check failure is acceptable)", async () => {
    const deps = make_deps({
      mergeability: {
        mergeable: "MERGEABLE",
        merge_state_status: "UNSTABLE",
        head_sha: APPROVED_SHA,
      },
    });
    const result = await run_merge_gate(make_input(), deps);

    expect(result.kind).toBe("merged");
    expect(deps.gh_pr_merge).toHaveBeenCalled();
  });

  it("CI regressed since review (was green, now failing) → ci_regressed, no merge", async () => {
    const deps = make_deps({
      ci: { passed: false, pending: false, failures: ["typecheck", "lint"] },
    });
    const result = await run_merge_gate(make_input(), deps);

    expect(result).toEqual({ kind: "ci_regressed", failures: ["typecheck", "lint"] });
    expect(deps.gh_pr_merge).not.toHaveBeenCalled();
  });

  it("CI pending after approval (new check started) → ci_pending, wait", async () => {
    const deps = make_deps({
      ci: { passed: false, pending: true, failures: [] },
    });
    const result = await run_merge_gate(make_input(), deps);

    expect(result).toEqual({ kind: "ci_pending" });
    expect(deps.gh_pr_merge).not.toHaveBeenCalled();
  });

  it("head SHA changed since approval → sha_changed, abort merge", async () => {
    const deps = make_deps({
      mergeability: {
        mergeable: "MERGEABLE",
        merge_state_status: "CLEAN",
        head_sha: "f00dba110000000000000000000000000000f00d",
      },
    });
    const result = await run_merge_gate(make_input(), deps);

    expect(result).toEqual({
      kind: "sha_changed",
      observed_sha: "f00dba110000000000000000000000000000f00d",
    });
    // Critically: no CI re-fetch and no merge after SHA drift
    expect(deps.check_ci_status).not.toHaveBeenCalled();
    expect(deps.gh_pr_merge).not.toHaveBeenCalled();
  });

  it("BLOCKED state (branch protection) → branch_protected, alert", async () => {
    const deps = make_deps({
      mergeability: {
        mergeable: "MERGEABLE",
        merge_state_status: "BLOCKED",
        head_sha: APPROVED_SHA,
      },
    });
    const result = await run_merge_gate(make_input(), deps);

    expect(result.kind).toBe("branch_protected");
    if (result.kind === "branch_protected") {
      expect(result.merge_state_status).toBe("BLOCKED");
    }
    expect(deps.gh_pr_merge).not.toHaveBeenCalled();
  });

  it("DIRTY state (real conflicts) → rebase_conflict, do not attempt merge", async () => {
    const deps = make_deps({
      mergeability: {
        mergeable: "CONFLICTING",
        merge_state_status: "DIRTY",
        head_sha: APPROVED_SHA,
      },
    });
    const result = await run_merge_gate(make_input(), deps);

    expect(result.kind).toBe("rebase_conflict");
    expect(deps.try_local_rebase).not.toHaveBeenCalled();
    expect(deps.gh_pr_merge).not.toHaveBeenCalled();
  });

  it("UNKNOWN mergeable state → retries once, still UNKNOWN → mergeable_unknown", async () => {
    const deps = make_deps({
      mergeability: {
        mergeable: "UNKNOWN",
        merge_state_status: "UNKNOWN",
        head_sha: APPROVED_SHA,
      },
    });
    const result = await run_merge_gate(make_input(), deps);

    expect(result).toEqual({ kind: "mergeable_unknown" });
    // fetch_pr_mergeability called twice: initial + retry
    expect(deps.fetch_pr_mergeability).toHaveBeenCalledTimes(2);
    expect(deps.gh_pr_merge).not.toHaveBeenCalled();
  });

  it("UNKNOWN mergeable state → retries once, resolves to CLEAN → merges", async () => {
    const unknown_mergeability: PRMergeability = {
      mergeable: "UNKNOWN",
      merge_state_status: "UNKNOWN",
      head_sha: APPROVED_SHA,
    };
    const clean_mergeability: PRMergeability = {
      mergeable: "MERGEABLE",
      merge_state_status: "CLEAN",
      head_sha: APPROVED_SHA,
    };
    const deps = make_deps();
    vi.mocked(deps.fetch_pr_mergeability)
      .mockResolvedValueOnce(unknown_mergeability)
      .mockResolvedValueOnce(clean_mergeability);

    const result = await run_merge_gate(make_input(), deps);

    expect(result).toEqual({ kind: "merged", method: "direct" });
    expect(deps.fetch_pr_mergeability).toHaveBeenCalledTimes(2);
    expect(deps.gh_pr_merge).toHaveBeenCalledTimes(1);
  });

  it("UNKNOWN mergeable state → retry throws → mergeable_unknown (no crash)", async () => {
    const unknown_mergeability: PRMergeability = {
      mergeable: "UNKNOWN",
      merge_state_status: "UNKNOWN",
      head_sha: APPROVED_SHA,
    };
    const deps = make_deps();
    vi.mocked(deps.fetch_pr_mergeability)
      .mockResolvedValueOnce(unknown_mergeability)
      .mockRejectedValueOnce(new Error("rate limit"));

    const result = await run_merge_gate(make_input(), deps);

    expect(result).toEqual({ kind: "mergeable_unknown" });
    expect(deps.fetch_pr_mergeability).toHaveBeenCalledTimes(2);
  });

  it("BEHIND state with successful rebase → rebased_awaiting_ci (next check_suite drives merge)", async () => {
    // BEHIND triggers rebase. After force-push the SHA changes, so we abort
    // and wait for the new check_suite — we never blindly merge a freshly-
    // rebased SHA without re-running CI.
    const deps = make_deps({
      mergeability: {
        mergeable: "MERGEABLE",
        merge_state_status: "BEHIND",
        head_sha: APPROVED_SHA,
      },
      rebase: { success: true },
    });
    const result = await run_merge_gate(make_input(), deps);

    expect(result.kind).toBe("rebased_awaiting_ci");
    expect(deps.try_local_rebase).toHaveBeenCalledTimes(1);
    expect(deps.gh_pr_merge).not.toHaveBeenCalled();
  });

  it("BEHIND with rebase conflict → rebase_conflict (issue #254 path)", async () => {
    const deps = make_deps({
      mergeability: {
        mergeable: "MERGEABLE",
        merge_state_status: "BEHIND",
        head_sha: APPROVED_SHA,
      },
      rebase: {
        success: false,
        kind: "conflict",
        error: "Rebase conflicts require manual resolution",
      },
    });
    const result = await run_merge_gate(make_input(), deps);

    expect(result.kind).toBe("rebase_conflict");
    expect(deps.gh_pr_merge).not.toHaveBeenCalled();
  });

  it("BEHIND with merge commits on the branch → rebase_conflict alert, never a merge (#367)", async () => {
    // The rebase was refused before it started, so there is nothing to retry
    // and nothing to wait for. This must reach a human on the same alert path
    // as a real conflict — a silent stall would leave the PR sitting approved
    // and unmerged with nobody told why.
    const deps = make_deps({
      mergeability: {
        mergeable: "MERGEABLE",
        merge_state_status: "BEHIND",
        head_sha: APPROVED_SHA,
      },
      rebase: {
        success: false,
        kind: "unsafe_merge_commits",
        merge_shas: ["abc1234def5678", "9876543210fedc"],
        error:
          "Branch contains 2 merge commit(s) (abc1234def5678, 9876543210fedc). " +
          "A plain rebase would drop them and can silently revert work already on main, " +
          "so no rebase was attempted. Manual resolution required.",
      },
    });
    const result = await run_merge_gate(make_input(), deps);

    expect(result.kind).toBe("rebase_conflict");
    expect(deps.gh_pr_merge).not.toHaveBeenCalled();
    // The alert body is this error string, so the SHAs a human needs in order
    // to resolve the branch have to survive into it.
    if (result.kind !== "rebase_conflict") throw new Error("unreachable");
    expect(result.error).toContain("abc1234def5678");
    expect(result.error).toContain("9876543210fedc");
    expect(result.error).toMatch(/merge commit/i);
  });

  it("BEHIND with transient rebase failure → merge_failed (not falsely reported as conflict)", async () => {
    // Issue #254 — non-conflict rebase failures must NOT be reported as conflicts.
    const deps = make_deps({
      mergeability: {
        mergeable: "MERGEABLE",
        merge_state_status: "BEHIND",
        head_sha: APPROVED_SHA,
      },
      rebase: {
        success: false,
        kind: "clone_failed",
        error: "Clone failed: network unreachable",
      },
    });
    const result = await run_merge_gate(make_input(), deps);

    expect(result.kind).toBe("merge_failed");
    if (result.kind === "merge_failed") {
      expect(result.error).toContain("clone_failed");
      expect(result.error).toContain("network unreachable");
    }
  });

  it("gh pr merge returns non-zero → merge_failed with underlying error", async () => {
    const deps = make_deps({
      merge_error: new Error("422 Unprocessable Entity: required status check missing"),
    });
    const result = await run_merge_gate(make_input(), deps);

    expect(result.kind).toBe("merge_failed");
    if (result.kind === "merge_failed") {
      expect(result.error).toContain("422 Unprocessable Entity");
    }
  });

  it("fetch_pr_mergeability throws → merge_failed (does not crash the gate)", async () => {
    const deps = make_deps({
      mergeability_error: new Error("rate limit exceeded"),
    });
    const result = await run_merge_gate(make_input(), deps);

    expect(result.kind).toBe("merge_failed");
    if (result.kind === "merge_failed") {
      expect(result.error).toContain("rate limit exceeded");
    }
    expect(deps.check_ci_status).not.toHaveBeenCalled();
  });
});
