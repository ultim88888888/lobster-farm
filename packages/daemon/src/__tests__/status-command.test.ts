import { describe, it, expect } from "vitest";
import { format_duration, format_cache_staleness } from "../discord.js";

describe("format_duration", () => {
  it("formats hours and minutes", () => {
    const start = new Date(Date.now() - 2 * 60 * 60_000 - 14 * 60_000);
    expect(format_duration(start)).toBe("2h 14m");
  });

  it("formats minutes only when under an hour", () => {
    const start = new Date(Date.now() - 45 * 60_000);
    expect(format_duration(start)).toBe("45m");
  });

  it("formats zero minutes for very recent start", () => {
    const start = new Date(Date.now() - 10_000); // 10 seconds ago
    expect(format_duration(start)).toBe("0m");
  });

  it("formats exactly one hour", () => {
    const start = new Date(Date.now() - 60 * 60_000);
    expect(format_duration(start)).toBe("1h 0m");
  });

  it("handles future dates gracefully", () => {
    const start = new Date(Date.now() + 60_000);
    expect(format_duration(start)).toBe("0m");
  });

  it("formats large durations", () => {
    const start = new Date(Date.now() - 25 * 60 * 60_000 - 30 * 60_000);
    expect(format_duration(start)).toBe("25h 30m");
  });
});

describe("format_cache_staleness", () => {
  it("returns empty string for null", () => {
    expect(format_cache_staleness(null)).toBe("");
  });

  it("returns empty string for fresh cache (under 60s)", () => {
    const recent = new Date(Date.now() - 30_000); // 30s ago
    expect(format_cache_staleness(recent)).toBe("");
  });

  it("returns empty string at exactly 0s", () => {
    expect(format_cache_staleness(new Date())).toBe("");
  });

  it("returns seconds label for 60-119s staleness", () => {
    const stale = new Date(Date.now() - 90_000); // 90s ago
    expect(format_cache_staleness(stale)).toBe(" *(90s ago)*");
  });

  it("returns minutes label for 2+ minutes staleness", () => {
    const stale = new Date(Date.now() - 180_000); // 3m ago
    expect(format_cache_staleness(stale)).toBe(" *(3m ago)*");
  });

  it("returns minutes label for large staleness", () => {
    const stale = new Date(Date.now() - 600_000); // 10m ago
    expect(format_cache_staleness(stale)).toBe(" *(10m ago)*");
  });

  it("returns empty string for future dates", () => {
    const future = new Date(Date.now() + 60_000);
    expect(format_cache_staleness(future)).toBe("");
  });

  it("shows seconds at the 60s boundary", () => {
    const boundary = new Date(Date.now() - 60_000); // exactly 60s
    expect(format_cache_staleness(boundary)).toBe(" *(60s ago)*");
  });
});
