import { describe, expect, it, vi } from "vitest";

// ── Mock child_process ──
// vi.hoisted() ensures the mock ref is available when vi.mock factory runs
// (vi.mock is hoisted above all imports by vitest).
//
// Node's real execFile has a [util.promisify.custom] symbol that makes
// promisify(execFile) return {stdout, stderr}. Our mock needs the same
// so that `const { stdout } = await exec_async(...)` works correctly.

const { execFile_mock } = vi.hoisted(() => {
  const mock = vi.fn();

  // Attach the custom promisify symbol so promisify(mock) returns {stdout, stderr}
  // The symbol is the well-known Symbol.for("nodejs.util.promisify.custom")
  const CUSTOM = Symbol.for("nodejs.util.promisify.custom");
  Object.defineProperty(mock, CUSTOM, {
    value: (...args: unknown[]) => {
      return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        mock(...args, (err: Error | null, stdout: string, stderr: string) => {
          if (err) reject(err);
          else resolve({ stdout, stderr });
        });
      });
    },
    configurable: true,
  });

  return { execFile_mock: mock };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: execFile_mock,
  };
});

import {
  build_review_fix_prompt,
  fetch_review_comments,
  check_merge_conflicts,
} from "../review-utils.js";

/**
 * Configure execFile mock to return specific stdout/error for sequential calls.
 * promisify(execFile) calls execFile(cmd, args, opts, callback) — the callback
 * is always the last argument.
 */
function mock_gh_responses(responses: Array<{ stdout?: string; error?: Error }>): void {
  let call_idx = 0;
  execFile_mock.mockImplementation((...args: unknown[]) => {
    const resp = responses[Math.min(call_idx, responses.length - 1)]!;
    call_idx++;

    // promisify adds callback as the last argument
    const callback = args[args.length - 1] as
      (err: Error | null, stdout: string, stderr: string) => void;

    if (typeof callback === "function") {
      if (resp.error) {
        callback(resp.error, "", "");
      } else {
        callback(null, resp.stdout ?? "", "");
      }
    }
    return { pid: 1 };
  });
}

// ── build_review_fix_prompt (pure function) ──

describe("build_review_fix_prompt", () => {
  it("includes review comments when provided", () => {
    const prompt = build_review_fix_prompt(42, "Add caching", "Fix the TTL logic in cache.ts");
    expect(prompt).toContain("PR #42");
    expect(prompt).toContain("Add caching");
    expect(prompt).toContain("## Reviewer Feedback");
    expect(prompt).toContain("Fix the TTL logic in cache.ts");
    expect(prompt).toContain("## Instructions");
    expect(prompt).toContain("Do NOT change anything the reviewer didn't flag");
  });

  it("omits reviewer feedback section when no comments", () => {
    const prompt = build_review_fix_prompt(42, "Add caching");
    expect(prompt).toContain("PR #42");
    expect(prompt).not.toContain("## Reviewer Feedback");
    expect(prompt).toContain("## Instructions");
  });

  it("omits reviewer feedback section when comments are undefined", () => {
    const prompt = build_review_fix_prompt(42, "Add caching", undefined);
    expect(prompt).not.toContain("## Reviewer Feedback");
  });

  it("includes all required instruction steps", () => {
    const prompt = build_review_fix_prompt(1, "Title", "feedback");
    expect(prompt).toContain("Read the reviewer's feedback carefully");
    expect(prompt).toContain("Fix each issue mentioned");
    expect(prompt).toContain("Run the test suite");
    expect(prompt).toContain("Commit and push");
    expect(prompt).toContain("Keep changes minimal and targeted");
  });
});

// ── fetch_review_comments ──

describe("fetch_review_comments", () => {
  it("returns the latest CHANGES_REQUESTED review body", async () => {
    mock_gh_responses([{ stdout: "Please fix the null check on line 42\n" }]);
    const result = await fetch_review_comments(10, "/tmp/repo");
    expect(result).toBe("Please fix the null check on line 42");
  });

  it("falls back to last review body when CHANGES_REQUESTED filter returns empty", async () => {
    mock_gh_responses([
      { stdout: "" },  // first call: CHANGES_REQUESTED filter returns empty
      { stdout: "General review body\n" },  // second call: last review fallback
    ]);
    const result = await fetch_review_comments(10, "/tmp/repo");
    expect(result).toBe("General review body");
  });

  it("returns fallback message when all gh calls fail", async () => {
    mock_gh_responses([
      { error: new Error("gh not found") },
      { error: new Error("gh not found") },
    ]);
    const result = await fetch_review_comments(10, "/tmp/repo");
    expect(result).toContain("Could not fetch review comments");
    expect(result).toContain("gh pr view 10");
  });

  it("returns empty-body fallback when both calls return empty", async () => {
    mock_gh_responses([
      { stdout: "" },
      { stdout: "" },
    ]);
    const result = await fetch_review_comments(10, "/tmp/repo");
    expect(result).toContain("No review body found");
  });
});

// ── check_merge_conflicts ──

describe("check_merge_conflicts", () => {
  it("returns true when PR is CONFLICTING", async () => {
    mock_gh_responses([{ stdout: "CONFLICTING\n" }]);
    const result = await check_merge_conflicts(10, "/tmp/repo");
    expect(result).toBe(true);
  });

  it("returns false when PR is MERGEABLE", async () => {
    mock_gh_responses([{ stdout: "MERGEABLE\n" }]);
    const result = await check_merge_conflicts(10, "/tmp/repo");
    expect(result).toBe(false);
  });

  it("returns false when PR is UNKNOWN", async () => {
    mock_gh_responses([{ stdout: "UNKNOWN\n" }]);
    const result = await check_merge_conflicts(10, "/tmp/repo");
    expect(result).toBe(false);
  });

  it("returns false on error (conservative -- don't block on uncertainty)", async () => {
    mock_gh_responses([{ error: new Error("network error") }]);
    const result = await check_merge_conflicts(10, "/tmp/repo");
    expect(result).toBe(false);
  });
});

