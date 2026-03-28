import { describe, it, expect } from "vitest";
import { format_duration } from "../discord.js";

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
