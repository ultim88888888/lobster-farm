import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { load_yaml, parse_yaml, write_yaml } from "../yaml.js";

const TestSchema = z.object({
  name: z.string(),
  count: z.number().default(0),
  tags: z.array(z.string()).default([]),
});

describe("parse_yaml", () => {
  it("parses valid YAML with schema validation", () => {
    const result = parse_yaml("name: test\ncount: 5\ntags:\n  - a\n  - b", TestSchema);
    expect(result).toEqual({ name: "test", count: 5, tags: ["a", "b"] });
  });

  it("applies defaults for missing optional fields", () => {
    const result = parse_yaml("name: test", TestSchema);
    expect(result.count).toBe(0);
    expect(result.tags).toEqual([]);
  });

  it("throws on missing required fields", () => {
    expect(() => parse_yaml("count: 5", TestSchema)).toThrow("YAML validation failed");
  });

  it("throws on wrong types", () => {
    expect(() => parse_yaml("name: 123", TestSchema)).toThrow("YAML validation failed");
  });
});

describe("file operations", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = join(tmpdir(), `lf-yaml-test-${Date.now()}`);
    await mkdir(tmp, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("write_yaml and load_yaml round-trip", async () => {
    const filePath = join(tmp, "test.yaml");
    const data = { name: "alpha", count: 42, tags: ["trading", "crypto"] };

    await write_yaml(filePath, data);
    const loaded = await load_yaml(filePath, TestSchema);

    expect(loaded).toEqual(data);
  });

  it("write_yaml creates parent directories", async () => {
    const filePath = join(tmp, "deep", "nested", "test.yaml");
    await write_yaml(filePath, { name: "test" });

    const content = await readFile(filePath, "utf-8");
    expect(content).toContain("name: test");
  });

  it("load_yaml throws on non-existent file", async () => {
    await expect(
      load_yaml(join(tmp, "nope.yaml"), TestSchema),
    ).rejects.toThrow();
  });
});
