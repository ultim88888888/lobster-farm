/**
 * Tests for attempt_auto_merge() — the auto-rebase merge recovery function.
 *
 * Mocks all external commands (gh, git, mktemp) to test the decision logic
 * without touching real repos or the GitHub API.
 *
 * Uses a dynamic import pattern: the mock factory installs a stub execFile
 * with the custom promisify symbol. Per-test routing is configured via a
 * module-level variable that the promisified function reads at call time.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Command routing ──

type ExecRoute = (
  args: string[],
  opts: Record<string, unknown>,
) => { stdout: string; stderr?: string } | Error;

/**
 * Module-level route map, updated per-test via route_exec().
 * The mock reads this at call time (not at hoist time).
 */
const routes: Record<string, ExecRoute> = {};

function find_route_key(cmd: string, args: string[]): string | null {
  const tokens = [cmd, ...args.slice(0, 3)];
  for (let len = tokens.length; len > 0; len--) {
    const candidate = tokens.slice(0, len).join(" ");
    if (routes[candidate] !== undefined) return candidate;
  }
  return null;
}

/**
 * Set up routing for execFile calls in the current test.
 * Each key is matched against "cmd args[0] args[1] ..." (progressively shorter).
 * Handlers return { stdout } on success or an Error on failure.
 */
function route_exec(new_routes: Record<string, ExecRoute>): void {
  // Clear previous routes
  for (const key of Object.keys(routes)) delete routes[key];
  Object.assign(routes, new_routes);
}

// ── Mock node:child_process ──
//
// vi.mock is hoisted, so the factory cannot reference variables declared after it.
// Instead, we rely on the routes object (declared above the factory) and the
// util.promisify.custom symbol to make promisify(execFile) return our async handler.

vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");

  // The async handler that routes calls through the `routes` map
  const promisified = async (
    cmd: string,
    args: string[],
    opts: Record<string, unknown> = {},
  ): Promise<{ stdout: string; stderr: string }> => {
    const key = find_route_key(cmd, args);
    if (!key) {
      throw new Error(`Unmocked command: ${cmd} ${args.join(" ")}`);
    }
    const result = routes[key]!(args, opts);
    if (result instanceof Error) throw result;
    return { stdout: result.stdout, stderr: result.stderr ?? "" };
  };

  // Build a callback-style stub with the custom promisify symbol
  const stub = (..._args: unknown[]) => {
    // Shouldn't be called directly (review-utils uses promisify), but handle it
    throw new Error("execFile mock: use promisify, not direct calls");
  };
  (stub as unknown as Record<symbol, unknown>)[promisify.custom] = promisified;

  return { execFile: stub };
});

import { attempt_auto_merge } from "../review-utils.js";

// ── Tests ──

describe("attempt_auto_merge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    // Clear routes — each test must set its own
    for (const key of Object.keys(routes)) delete routes[key];
  });

  it("returns merged: true with method 'direct' when first merge succeeds", async () => {
    route_exec({
      "gh pr merge": () => ({ stdout: "" }),
    });

    const result = await attempt_auto_merge(42, "feature/test", "/repo", "gh");
    expect(result).toEqual({ merged: true, method: "direct" });
  });

  it("tries update-branch API when direct merge fails", async () => {
    let update_branch_called = false;
    let merge_count = 0;

    route_exec({
      "gh pr merge": () => {
        merge_count++;
        if (merge_count === 1) return new Error("Pull request is not mergeable");
        return { stdout: "" };
      },
      "gh repo view": () => ({ stdout: "test-org/test-repo" }),
      "gh api": (args) => {
        if (args.some((a) => a.includes("update-branch"))) {
          update_branch_called = true;
          return { stdout: "" };
        }
        return new Error("unknown api call");
      },
      "gh pr view": () => ({ stdout: "MERGEABLE" }),
    });

    const result = await attempt_auto_merge(42, "feature/test", "/repo", "gh");

    expect(update_branch_called).toBe(true);
    expect(result).toEqual({ merged: true, method: "update-branch" });
  });

  it("attempts local rebase when update-branch API fails", async () => {
    let rebase_attempted = false;
    let merge_count = 0;

    route_exec({
      "gh pr merge": () => {
        merge_count++;
        // First attempt (direct) fails; second attempt (after rebase) succeeds
        if (merge_count === 1) return new Error("Pull request is not mergeable");
        return { stdout: "" };
      },
      "gh repo view": () => ({ stdout: "test-org/test-repo" }),
      "gh api": () => new Error("Merge conflict"),
      "gh pr view": () => ({ stdout: "MERGEABLE" }),
      mktemp: () => ({ stdout: "/tmp/test-rebase-dir" }),
      "git remote": () => ({ stdout: "https://github.com/test/repo.git" }),
      "git clone": () => ({ stdout: "" }),
      "git fetch": () => ({ stdout: "" }),
      // No merge commits in origin/main..HEAD — the #367 guard lets the rebase run.
      "git rev-list": () => ({ stdout: "" }),
      "git rebase": (args) => {
        if (args.includes("--abort")) return { stdout: "" };
        rebase_attempted = true;
        return { stdout: "" };
      },
      "git push": () => ({ stdout: "" }),
      rm: () => ({ stdout: "" }),
    });

    const result = await attempt_auto_merge(42, "feature/test", "/repo", "gh");

    expect(rebase_attempted).toBe(true);
    expect(result).toEqual({ merged: true, method: "local-rebase" });
  });

  it("returns error when rebase has conflicts and aborts cleanly", async () => {
    let rebase_abort_called = false;

    route_exec({
      "gh pr merge": () => new Error("Pull request is not mergeable"),
      "gh repo view": () => ({ stdout: "test-org/test-repo" }),
      "gh api": () => new Error("Merge conflict"),
      "gh pr view": () => ({ stdout: "CONFLICTING" }),
      mktemp: () => ({ stdout: "/tmp/test-rebase-dir" }),
      "git remote": () => ({ stdout: "https://github.com/test/repo.git" }),
      "git clone": () => ({ stdout: "" }),
      "git fetch": () => ({ stdout: "" }),
      // No merge commits in origin/main..HEAD — the #367 guard lets the rebase run.
      "git rev-list": () => ({ stdout: "" }),
      "git rebase": (args) => {
        if (args.includes("--abort")) {
          rebase_abort_called = true;
          return { stdout: "" };
        }
        return new Error("CONFLICT (content): Merge conflict in file.ts");
      },
      rm: () => ({ stdout: "" }),
    });

    const result = await attempt_auto_merge(42, "feature/test", "/repo", "gh");

    expect(result.merged).toBe(false);
    expect(result.error).toContain("Rebase conflicts require manual resolution");
    expect(rebase_abort_called).toBe(true);
  });

  it("never rebases, pushes, or merges a branch carrying merge commits (#367)", async () => {
    // The v2 merge-gate is not the only caller of try_local_rebase — this
    // legacy path reaches it too, and must fail closed the same way. Real-git
    // coverage of the guard itself lives in rebase-merge-commits.integration.test.ts.
    let rebase_called = false;
    let push_called = false;
    let merge_after_rebase = false;
    let merge_count = 0;

    route_exec({
      "gh pr merge": () => {
        merge_count++;
        if (merge_count > 1) merge_after_rebase = true;
        return new Error("Pull request is not mergeable");
      },
      "gh repo view": () => ({ stdout: "test-org/test-repo" }),
      "gh api": () => new Error("Merge conflict"),
      "gh pr view": () => ({
        stdout: JSON.stringify({ mergeable: "UNKNOWN", mergeStateStatus: "BEHIND" }),
      }),
      mktemp: () => ({ stdout: "/tmp/test-rebase-dir" }),
      "git remote": () => ({ stdout: "https://github.com/test/repo.git" }),
      "git clone": () => ({ stdout: "" }),
      "git fetch": () => ({ stdout: "" }),
      "git rev-list": () => ({ stdout: "abc1234def5678\n9876543210fedc\n" }),
      "git rebase": () => {
        rebase_called = true;
        return { stdout: "" };
      },
      "git push": () => {
        push_called = true;
        return { stdout: "" };
      },
      rm: () => ({ stdout: "" }),
    });

    const result = await attempt_auto_merge(42, "feature/test", "/repo", "gh");

    expect(rebase_called).toBe(false);
    expect(push_called).toBe(false);
    expect(merge_after_rebase).toBe(false);
    expect(result.merged).toBe(false);
    expect(result.error).toContain("abc1234def5678");
  });

  it("does not attempt update-branch or rebase when direct merge succeeds", async () => {
    let update_branch_called = false;
    let rebase_called = false;

    route_exec({
      "gh pr merge": () => ({ stdout: "" }),
      "gh api": () => {
        update_branch_called = true;
        return { stdout: "" };
      },
      "git rebase": () => {
        rebase_called = true;
        return { stdout: "" };
      },
    });

    const result = await attempt_auto_merge(42, "feature/test", "/repo", "gh");

    expect(result).toEqual({ merged: true, method: "direct" });
    expect(update_branch_called).toBe(false);
    expect(rebase_called).toBe(false);
  });

  it("returns error when repo nwo cannot be determined", async () => {
    route_exec({
      "gh pr merge": () => new Error("Pull request is not mergeable"),
      "gh repo view": () => new Error("not a git repository"),
    });

    const result = await attempt_auto_merge(42, "feature/test", "/repo", "gh");

    expect(result.merged).toBe(false);
    expect(result.error).toContain("Could not determine repo owner/name");
  });

  it("passes gh_token through via env", async () => {
    let captured_env: Record<string, unknown> | undefined;

    route_exec({
      "gh pr merge": (_args, opts) => {
        captured_env = opts.env as Record<string, unknown>;
        return { stdout: "" };
      },
    });

    await attempt_auto_merge(42, "feature/test", "/repo", "gh", "ghs_test_token_123");

    expect(captured_env).toBeDefined();
    expect(captured_env!.GH_TOKEN).toBe("ghs_test_token_123");
  });

  it("cleans up temp directory even when rebase fails", async () => {
    let rm_args: string[] | undefined;

    route_exec({
      "gh pr merge": () => new Error("not mergeable"),
      "gh repo view": () => ({ stdout: "test-org/test-repo" }),
      "gh api": () => new Error("Merge conflict"),
      "gh pr view": () => ({ stdout: "CONFLICTING" }),
      "git remote": () => ({ stdout: "https://github.com/test/repo.git" }),
      mktemp: () => ({ stdout: "/tmp/auto-rebase-test-42" }),
      "git clone": () => ({ stdout: "" }),
      "git fetch": () => ({ stdout: "" }),
      // No merge commits in origin/main..HEAD — the #367 guard lets the rebase run.
      "git rev-list": () => ({ stdout: "" }),
      "git rebase": (args) => {
        if (args.includes("--abort")) return { stdout: "" };
        return new Error("CONFLICT");
      },
      rm: (args) => {
        rm_args = args;
        return { stdout: "" };
      },
    });

    await attempt_auto_merge(42, "feature/test", "/repo", "gh");

    expect(rm_args).toBeDefined();
    expect(rm_args).toContain("/tmp/auto-rebase-test-42");
  });

  // ── Merge-state classification (#254, #262) ──

  it("short-circuits on CONFLICTING without touching update-branch or rebase", async () => {
    let update_branch_called = false;
    let rebase_called = false;
    let merge_called = false;

    route_exec({
      // Initial fetch_merge_state returns CONFLICTING — we should NOT merge.
      "gh pr view": () => ({
        stdout: JSON.stringify({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }),
      }),
      "gh pr merge": () => {
        merge_called = true;
        return new Error("should not be called on CONFLICTING");
      },
      "gh api": () => {
        update_branch_called = true;
        return { stdout: "" };
      },
      "git rebase": () => {
        rebase_called = true;
        return { stdout: "" };
      },
    });

    const result = await attempt_auto_merge(42, "feature/test", "/repo", "gh");

    expect(result.merged).toBe(false);
    expect(result.failure).toBe("CONFLICT");
    expect(result.error).toMatch(/conflicts.*manual/i);
    expect(merge_called).toBe(false);
    expect(update_branch_called).toBe(false);
    expect(rebase_called).toBe(false);
  });

  it("classifies REQUIRED_CHECKS_PENDING and retries with backoff until success", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    try {
      let merge_count = 0;
      let pr_view_count = 0;

      route_exec({
        "gh pr view": () => {
          pr_view_count++;
          // First call (initial state): BLOCKED + MERGEABLE
          // Subsequent calls (retry): first still BLOCKED, then CLEAN
          if (pr_view_count <= 2) {
            return {
              stdout: JSON.stringify({
                mergeable: "MERGEABLE",
                mergeStateStatus: "BLOCKED",
              }),
            };
          }
          return {
            stdout: JSON.stringify({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
          };
        },
        "gh pr merge": () => {
          merge_count++;
          // First merge: direct attempt fails with generic BLOCKED
          // Second merge: first retry still fails
          // Third merge: success
          if (merge_count < 3) return new Error("Pull request is not mergeable");
          return { stdout: "" };
        },
      });

      const promise = attempt_auto_merge(42, "feature/test", "/repo", "gh");
      // Advance fake timers through the first two backoff intervals (10s + 20s)
      await vi.advanceTimersByTimeAsync(40_000);

      const result = await promise;

      expect(result.merged).toBe(true);
      expect(result.method).toBe("policy-retry");
      expect(merge_count).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies POLICY_LAG from error text and retries with backoff", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    try {
      let merge_count = 0;

      route_exec({
        "gh pr view": () => ({
          stdout: JSON.stringify({ mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" }),
        }),
        "gh pr merge": () => {
          merge_count++;
          // Direct and first retry: policy-lag error
          // Second retry: succeeds (GitHub eval caught up)
          if (merge_count < 3) {
            return new Error(
              "X Pull request #42 is not mergeable: the base branch policy prohibits the merge.",
            );
          }
          return { stdout: "" };
        },
      });

      const promise = attempt_auto_merge(42, "feature/test", "/repo", "gh");
      await vi.advanceTimersByTimeAsync(40_000);

      const result = await promise;

      expect(result.merged).toBe(true);
      expect(result.method).toBe("policy-retry");
    } finally {
      vi.useRealTimers();
    }
  });

  it("exhausts backoff budget and returns POLICY_LAG failure without falling into rebase", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    try {
      let update_branch_called = false;
      let rebase_called = false;

      route_exec({
        "gh pr view": () => ({
          stdout: JSON.stringify({ mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" }),
        }),
        "gh pr merge": () =>
          new Error(
            "X Pull request #42 is not mergeable: the base branch policy prohibits the merge.",
          ),
        "gh repo view": () => ({ stdout: "test/repo" }),
        "gh api": () => {
          update_branch_called = true;
          return { stdout: "" };
        },
        "git rebase": () => {
          rebase_called = true;
          return { stdout: "" };
        },
      });

      const promise = attempt_auto_merge(42, "feature/test", "/repo", "gh");
      // Advance through the full backoff budget (sum = 610s + buffer)
      await vi.advanceTimersByTimeAsync(650_000);

      const result = await promise;

      expect(result.merged).toBe(false);
      expect(result.failure).toBe("POLICY_LAG");
      expect(result.error).toMatch(/evaluat|converg/i);
      // Must NOT have escalated to update-branch or rebase — those can't help.
      expect(update_branch_called).toBe(false);
      expect(rebase_called).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies non-conflict rebase failures accurately (no false 'rebase conflicts')", async () => {
    // Regression test for #254: a transient rebase error (timeout, network)
    // was being reported as "Rebase conflicts require manual resolution".
    // The non-conflict path should surface the actual error.
    route_exec({
      "gh pr view": () => ({
        stdout: JSON.stringify({ mergeable: "UNKNOWN", mergeStateStatus: "BEHIND" }),
      }),
      "gh pr merge": () => new Error("Pull request is not mergeable"),
      "gh repo view": () => ({ stdout: "test/repo" }),
      "gh api": () => new Error("some api failure"),
      mktemp: () => ({ stdout: "/tmp/test-dir" }),
      "git remote": () => ({ stdout: "https://github.com/test/repo.git" }),
      "git clone": () => ({ stdout: "" }),
      "git fetch": () => ({ stdout: "" }),
      // No merge commits in origin/main..HEAD — the #367 guard lets the rebase run.
      "git rev-list": () => ({ stdout: "" }),
      "git rebase": (args) => {
        if (args.includes("--abort")) return { stdout: "" };
        // Simulate a non-conflict git error (e.g. network, timeout).
        return new Error("fatal: unable to access remote: timeout");
      },
      rm: () => ({ stdout: "" }),
    });

    const result = await attempt_auto_merge(42, "feature/test", "/repo", "gh");

    expect(result.merged).toBe(false);
    // Must NOT claim rebase conflicts — it was a network/timeout error.
    expect(result.error).not.toMatch(/Rebase conflicts require manual resolution/);
    expect(result.error).toMatch(/timeout|Rebase failed/i);
  });

  it("falls through to update-branch/rebase when PR transitions to BEHIND during policy-lag backoff", async () => {
    // Regression test: when retry_merge_with_backoff detects a BEHIND transition
    // mid-loop, it must NOT return early — the outer flow needs to reach Step 3
    // (update-branch + local rebase fallback) to actually fix the BEHIND state.
    vi.useFakeTimers({ shouldAdvanceTime: true });

    try {
      let merge_count = 0;
      let pr_view_count = 0;
      let update_branch_called = false;

      route_exec({
        "gh pr view": () => {
          pr_view_count++;
          if (pr_view_count <= 2) {
            // Initial state + post-direct: BLOCKED + MERGEABLE → enters backoff
            return {
              stdout: JSON.stringify({
                mergeable: "MERGEABLE",
                mergeStateStatus: "BLOCKED",
              }),
            };
          }
          if (pr_view_count === 3) {
            // First backoff poll: PR transitioned to BEHIND
            return {
              stdout: JSON.stringify({
                mergeable: "MERGEABLE",
                mergeStateStatus: "BEHIND",
              }),
            };
          }
          // After update-branch: MERGEABLE
          return { stdout: "MERGEABLE" };
        },
        "gh pr merge": () => {
          merge_count++;
          // First attempt (direct): fails with policy-lag
          if (merge_count === 1) {
            return new Error(
              "X Pull request is not mergeable: the base branch policy prohibits the merge.",
            );
          }
          // After update-branch: succeeds
          return { stdout: "" };
        },
        "gh repo view": () => ({ stdout: "test-org/test-repo" }),
        "gh api": (args) => {
          if (args.some((a) => a.includes("update-branch"))) {
            update_branch_called = true;
            return { stdout: "" };
          }
          return new Error("unknown api call");
        },
      });

      const promise = attempt_auto_merge(42, "feature/test", "/repo", "gh");
      // Advance through the first backoff interval (10s)
      await vi.advanceTimersByTimeAsync(15_000);

      const result = await promise;

      // Should have fallen through to update-branch (Step 3), not returned early
      expect(update_branch_called).toBe(true);
      expect(result.merged).toBe(true);
      expect(result.method).toBe("update-branch");
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls through to local rebase when update-branch succeeds but merge still fails", async () => {
    let merge_count = 0;
    let rebase_attempted = false;

    route_exec({
      "gh pr merge": () => {
        merge_count++;
        if (merge_count <= 2) return new Error("not mergeable");
        return { stdout: "" };
      },
      "gh repo view": () => ({ stdout: "test-org/test-repo" }),
      "gh api": () => ({ stdout: "" }), // update-branch succeeds
      "gh pr view": () => ({ stdout: "MERGEABLE" }),
      mktemp: () => ({ stdout: "/tmp/test-dir" }),
      "git remote": () => ({ stdout: "https://github.com/test/repo.git" }),
      "git clone": () => ({ stdout: "" }),
      "git fetch": () => ({ stdout: "" }),
      // No merge commits in origin/main..HEAD — the #367 guard lets the rebase run.
      "git rev-list": () => ({ stdout: "" }),
      "git rebase": (args) => {
        if (args.includes("--abort")) return { stdout: "" };
        rebase_attempted = true;
        return { stdout: "" };
      },
      "git push": () => ({ stdout: "" }),
      rm: () => ({ stdout: "" }),
    });

    const result = await attempt_auto_merge(42, "feature/test", "/repo", "gh");

    expect(rebase_attempted).toBe(true);
    expect(result).toEqual({ merged: true, method: "local-rebase" });
  });
});
