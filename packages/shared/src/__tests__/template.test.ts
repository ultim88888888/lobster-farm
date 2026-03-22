import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolve_template,
  load_and_resolve,
  write_resolved,
  find_unresolved,
} from "../template.js";

describe("resolve_template", () => {
  it("replaces simple placeholders", () => {
    const result = resolve_template("Hello {{USER_NAME}}!", {
      USER_NAME: "Jax",
    });
    expect(result).toBe("Hello Jax!");
  });

  it("replaces multiple occurrences of the same placeholder", () => {
    const result = resolve_template(
      "{{BUILDER_NAME}} builds. {{BUILDER_NAME}} tests.",
      { BUILDER_NAME: "Bob" },
    );
    expect(result).toBe("Bob builds. Bob tests.");
  });

  it("replaces different placeholders", () => {
    const result = resolve_template(
      "{{PLANNER_NAME}} plans, {{BUILDER_NAME}} builds.",
      { PLANNER_NAME: "Gary", BUILDER_NAME: "Bob" },
    );
    expect(result).toBe("Gary plans, Bob builds.");
  });

  it("leaves unresolved placeholders intact", () => {
    const result = resolve_template("Hello {{USER_NAME}} and {{UNKNOWN}}", {
      USER_NAME: "Jax",
    });
    expect(result).toBe("Hello Jax and {{UNKNOWN}}");
  });

  it("handles empty string values", () => {
    const result = resolve_template("Email: {{USER_EMAIL}}", {
      USER_EMAIL: "",
    });
    expect(result).toBe("Email: ");
  });

  it("handles block regions with content", () => {
    const result = resolve_template(
      "Before\n{{#SHARED_SERVICES}}services here{{/SHARED_SERVICES}}\nAfter",
      { SHARED_SERVICES: "- Vercel: my-org\n- Sentry: my-org" },
    );
    expect(result).toBe("Before\n- Vercel: my-org\n- Sentry: my-org\nAfter");
  });

  it("removes block regions when variable is empty", () => {
    const result = resolve_template(
      "Before\n{{#SHARED_SERVICES}}default content{{/SHARED_SERVICES}}\nAfter",
      { SHARED_SERVICES: "" },
    );
    expect(result).toBe("Before\n\nAfter");
  });

  it("removes block regions when variable is missing", () => {
    const result = resolve_template(
      "Before\n{{#SHARED_SERVICES}}default content{{/SHARED_SERVICES}}\nAfter",
      {},
    );
    expect(result).toBe("Before\n\nAfter");
  });
});

describe("find_unresolved", () => {
  it("finds remaining placeholders", () => {
    const result = find_unresolved("{{USER_NAME}} and {{MACHINE_NAME}}");
    expect(result).toContain("USER_NAME");
    expect(result).toContain("MACHINE_NAME");
    expect(result).toHaveLength(2);
  });

  it("returns empty array when all resolved", () => {
    expect(find_unresolved("No placeholders here")).toEqual([]);
  });

  it("deduplicates", () => {
    const result = find_unresolved("{{X}} and {{X}} again");
    expect(result).toEqual(["X"]);
  });
});

describe("file operations", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = join(tmpdir(), `lf-test-${Date.now()}`);
    await mkdir(tmp, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("load_and_resolve reads and resolves a file", async () => {
    const templatePath = join(tmp, "template.md");
    await writeFile(templatePath, "# Hello {{USER_NAME}}", "utf-8");

    const result = await load_and_resolve(templatePath, { USER_NAME: "Jax" });
    expect(result).toBe("# Hello Jax");
  });

  it("write_resolved creates output with resolved content", async () => {
    const templatePath = join(tmp, "template.md");
    const outputPath = join(tmp, "output", "result.md");
    await writeFile(templatePath, "Agent: {{PLANNER_NAME}}", "utf-8");

    await write_resolved(templatePath, outputPath, { PLANNER_NAME: "Gary" });

    const content = await readFile(outputPath, "utf-8");
    expect(content).toBe("Agent: Gary");
  });

  it("write_resolved creates parent directories", async () => {
    const templatePath = join(tmp, "template.md");
    const outputPath = join(tmp, "deep", "nested", "dir", "result.md");
    await writeFile(templatePath, "test", "utf-8");

    await write_resolved(templatePath, outputPath, {});

    const content = await readFile(outputPath, "utf-8");
    expect(content).toBe("test");
  });
});
