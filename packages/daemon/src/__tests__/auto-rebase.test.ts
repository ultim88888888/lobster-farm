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

import { describe, it, expect, vi, beforeEach } from "vitest";

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

function find_route_key(
  cmd: string,
  args: string[],
): string | null {
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
        if (args.some(a => a.includes("update-branch"))) {
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
      "mktemp": () => ({ stdout: "/tmp/test-rebase-dir" }),
      "git remote": () => ({ stdout: "https://github.com/test/repo.git" }),
      "git clone": () => ({ stdout: "" }),
      "git fetch": () => ({ stdout: "" }),
      "git rebase": (args) => {
        if (args.includes("--abort")) return { stdout: "" };
        rebase_attempted = true;
        return { stdout: "" };
      },
      "git push": () => ({ stdout: "" }),
      "rm": () => ({ stdout: "" }),
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
      "mktemp": () => ({ stdout: "/tmp/test-rebase-dir" }),
      "git remote": () => ({ stdout: "https://github.com/test/repo.git" }),
      "git clone": () => ({ stdout: "" }),
      "git fetch": () => ({ stdout: "" }),
      "git rebase": (args) => {
        if (args.includes("--abort")) {
          rebase_abort_called = true;
          return { stdout: "" };
        }
        return new Error("CONFLICT (content): Merge conflict in file.ts");
      },
      "rm": () => ({ stdout: "" }),
    });

    const result = await attempt_auto_merge(42, "feature/test", "/repo", "gh");

    expect(result.merged).toBe(false);
    expect(result.error).toContain("Rebase conflicts require manual resolution");
    expect(rebase_abort_called).toBe(true);
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
    expect(captured_env!["GH_TOKEN"]).toBe("ghs_test_token_123");
  });

  it("cleans up temp directory even when rebase fails", async () => {
    let rm_args: string[] | undefined;

    route_exec({
      "gh pr merge": () => new Error("not mergeable"),
      "gh repo view": () => ({ stdout: "test-org/test-repo" }),
      "gh api": () => new Error("Merge conflict"),
      "gh pr view": () => ({ stdout: "CONFLICTING" }),
      "git remote": () => ({ stdout: "https://github.com/test/repo.git" }),
      "mktemp": () => ({ stdout: "/tmp/auto-rebase-test-42" }),
      "git clone": () => ({ stdout: "" }),
      "git fetch": () => ({ stdout: "" }),
      "git rebase": (args) => {
        if (args.includes("--abort")) return { stdout: "" };
        return new Error("CONFLICT");
      },
      "rm": (args) => {
        rm_args = args;
        return { stdout: "" };
      },
    });

    await attempt_auto_merge(42, "feature/test", "/repo", "gh");

    expect(rm_args).toBeDefined();
    expect(rm_args).toContain("/tmp/auto-rebase-test-42");
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
      "mktemp": () => ({ stdout: "/tmp/test-dir" }),
      "git remote": () => ({ stdout: "https://github.com/test/repo.git" }),
      "git clone": () => ({ stdout: "" }),
      "git fetch": () => ({ stdout: "" }),
      "git rebase": (args) => {
        if (args.includes("--abort")) return { stdout: "" };
        rebase_attempted = true;
        return { stdout: "" };
      },
      "git push": () => ({ stdout: "" }),
      "rm": () => ({ stdout: "" }),
    });

    const result = await attempt_auto_merge(42, "feature/test", "/repo", "gh");

    expect(rebase_attempted).toBe(true);
    expect(result).toEqual({ merged: true, method: "local-rebase" });
  });
});
