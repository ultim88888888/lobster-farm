import { describe, expect, it } from "vitest";
import { classify_merge_error } from "../actions.js";

// ── classify_merge_error ──

describe("classify_merge_error", () => {
  it('returns "conflict" for "merge conflict" in error message', () => {
    expect(classify_merge_error("Error: Pull request has merge conflict")).toBe("conflict");
  });

  it('returns "conflict" for "not mergeable"', () => {
    expect(classify_merge_error("Pull request is not mergeable")).toBe("conflict");
  });

  it('returns "conflict" for "CONFLICTING" (case-insensitive)', () => {
    expect(classify_merge_error("CONFLICTING files detected")).toBe("conflict");
  });

  it('returns "conflict" for "conflicts must be resolved"', () => {
    expect(classify_merge_error("Conflicts must be resolved before merging")).toBe("conflict");
  });

  it('returns "other" for authentication errors', () => {
    expect(classify_merge_error("Error: authentication required")).toBe("other");
  });

  it('returns "other" for network errors', () => {
    expect(classify_merge_error("Error: could not connect to server")).toBe("other");
  });

  it('returns "other" for generic error messages', () => {
    expect(classify_merge_error("Error: something went wrong")).toBe("other");
  });

  it('returns "other" for empty string', () => {
    expect(classify_merge_error("")).toBe("other");
  });

  it("is case-insensitive", () => {
    expect(classify_merge_error("MERGE CONFLICT detected")).toBe("conflict");
    expect(classify_merge_error("Not Mergeable")).toBe("conflict");
  });
});
