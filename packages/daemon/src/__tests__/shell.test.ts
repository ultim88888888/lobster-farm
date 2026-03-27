import { describe, it, expect } from "vitest";
import { sq } from "../shell.js";

describe("sq (shell quote)", () => {
  it("wraps a simple string in single quotes", () => {
    expect(sq("hello")).toBe("'hello'");
  });

  it("handles paths with spaces", () => {
    expect(sq("/Users/farm/my project/dir")).toBe("'/Users/farm/my project/dir'");
  });

  it("escapes embedded single quotes", () => {
    expect(sq("it's")).toBe("'it'\\''s'");
  });

  it("handles empty string", () => {
    expect(sq("")).toBe("''");
  });

  it("handles shell metacharacters safely", () => {
    // All of these are inert inside single quotes
    expect(sq('$(rm -rf /)')).toBe("'$(rm -rf /)'");
    expect(sq('`whoami`')).toBe("'`whoami`'");
    expect(sq('foo; bar')).toBe("'foo; bar'");
    expect(sq('a && b')).toBe("'a && b'");
    expect(sq('$HOME')).toBe("'$HOME'");
  });

  it("handles multiple single quotes", () => {
    expect(sq("a'b'c")).toBe("'a'\\''b'\\''c'");
  });
});
