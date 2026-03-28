import { describe, it, expect } from "vitest";
import {
  parse_context_usage,
  parse_subscription_usage,
  parse_token_count,
} from "../tmux-query.js";

describe("parse_token_count", () => {
  it("parses k suffix", () => {
    expect(parse_token_count("19k")).toBe(19000);
    expect(parse_token_count("45.5k")).toBe(45500);
  });

  it("parses m suffix", () => {
    expect(parse_token_count("1m")).toBe(1000000);
    expect(parse_token_count("1.5m")).toBe(1500000);
  });

  it("parses plain numbers", () => {
    expect(parse_token_count("145234")).toBe(145234);
    expect(parse_token_count("1,048,576")).toBe(1048576);
  });

  it("handles whitespace", () => {
    expect(parse_token_count("  19k  ")).toBe(19000);
  });

  it("is case-insensitive", () => {
    expect(parse_token_count("19K")).toBe(19000);
    expect(parse_token_count("1M")).toBe(1000000);
  });

  it("returns null for invalid input", () => {
    expect(parse_token_count("abc")).toBeNull();
    expect(parse_token_count("")).toBeNull();
  });
});

describe("parse_context_usage", () => {
  it("parses compact format (19k / 1m)", () => {
    const output = `
System prompt
Tools
Messages

Tokens: 19k / 1m (2%)
    `;
    const result = parse_context_usage(output);
    expect(result).not.toBeNull();
    expect(result!.summary).toBe("19k / 1m (2%)");
    expect(result!.used_tokens).toBe(19000);
    expect(result!.total_tokens).toBe(1000000);
    expect(result!.percent).toBe(2);
  });

  it("parses full number format", () => {
    const output = "Tokens: 145,234 / 1,048,576 (14%)";
    const result = parse_context_usage(output);
    expect(result).not.toBeNull();
    expect(result!.summary).toBe("145,234 / 1,048,576 (14%)");
    expect(result!.used_tokens).toBe(145234);
    expect(result!.total_tokens).toBe(1048576);
    expect(result!.percent).toBe(14);
  });

  it("parses decimal percentage", () => {
    const output = "Tokens: 45k / 1m (4.5%)";
    const result = parse_context_usage(output);
    expect(result).not.toBeNull();
    expect(result!.percent).toBe(4.5);
    expect(result!.summary).toBe("45k / 1m (4.5%)");
  });

  it("returns null for output without token line", () => {
    expect(parse_context_usage("No tokens here")).toBeNull();
    expect(parse_context_usage("")).toBeNull();
  });

  it("handles output with surrounding noise", () => {
    const output = `
some other output
❯ /context

Context for this conversation:

  System prompt   ████████░░░░░░░░  12k
  Tools           ██████░░░░░░░░░░   8k
  Messages        ██░░░░░░░░░░░░░░   3k
  Free space      ░░░░░░░░░░░░░░░░ 977k

Tokens: 23k / 1m (2.3%)

❯
    `;
    const result = parse_context_usage(output);
    expect(result).not.toBeNull();
    expect(result!.summary).toBe("23k / 1m (2.3%)");
    expect(result!.used_tokens).toBe(23000);
    expect(result!.percent).toBe(2.3);
  });
});

describe("parse_subscription_usage", () => {
  it("parses 'Weekly usage: XX%' format", () => {
    const output = "Weekly usage: 62%";
    const result = parse_subscription_usage(output);
    expect(result).not.toBeNull();
    expect(result!.summary).toBe("62% weekly");
    expect(result!.weekly_percent).toBe(62);
  });

  it("parses 'Usage: XX% of weekly limit' format", () => {
    const output = "Usage: 43.5% of weekly limit";
    const result = parse_subscription_usage(output);
    expect(result).not.toBeNull();
    expect(result!.summary).toBe("43.5% weekly");
    expect(result!.weekly_percent).toBe(43.5);
  });

  it("parses percentage with 'of your' context", () => {
    const output = "You have used 78% of your Opus limit this week";
    const result = parse_subscription_usage(output);
    expect(result).not.toBeNull();
    expect(result!.summary).toBe("78% weekly");
    expect(result!.weekly_percent).toBe(78);
  });

  it("returns null for output without usage info", () => {
    expect(parse_subscription_usage("No usage here")).toBeNull();
    expect(parse_subscription_usage("")).toBeNull();
  });

  it("handles output with surrounding noise", () => {
    const output = `
❯ /usage

Claude Code usage this session:
  Tokens in: 45,000
  Tokens out: 12,000

Weekly usage: 35%

❯
    `;
    const result = parse_subscription_usage(output);
    expect(result).not.toBeNull();
    expect(result!.summary).toBe("35% weekly");
    expect(result!.weekly_percent).toBe(35);
  });
});
