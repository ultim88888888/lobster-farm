import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { EntityRegistry } from "../registry.js";

function make_config(lobsterfarm_dir: string): LobsterFarmConfig {
  return {
    version: 1,
    paths: {
      projects_dir: "/tmp/projects",
      lobsterfarm_dir,
      claude_dir: "/tmp/.claude",
    },
    concurrency: {
      max_active_sessions: 3,
      max_queue_depth: 20,
    },
    defaults: {
      models: {
        planning: { model: "opus", think: "high" },
        design: { model: "opus", think: "standard" },
        building: { model: "opus", think: "high" },
        database: { model: "opus", think: "high" },
        review: { model: "sonnet", think: "standard" },
        operations: { model: "sonnet", think: "standard" },
        triage: { model: "sonnet", think: "standard" },
        classification: { model: "haiku", think: "none" },
      },
    },
    user: { name: "Test User" },
    machine: { name: "test-machine", hardware: "" },
    agents: {
      planner: { name: "Gary" },
      designer: { name: "Pearl" },
      builder: { name: "Bob" },
      operator: { name: "Ray" },
    },
  };
}

function valid_entity_yaml(id: string, name: string, status: "active" | "paused" | "archived" = "active"): string {
  return stringify({
    entity: {
      id,
      name,
      description: `Test entity ${name}`,
      status,
      repo: {
        url: `https://github.com/test/${id}`,
        path: `/tmp/projects/${id}`,
        structure: "monorepo",
      },
      memory: {
        path: `~/.lobsterfarm/entities/${id}/MEMORY.md`,
        auto_extract: true,
      },
      secrets: {
        vault: "1password",
        vault_name: `${id}-vault`,
      },
    },
  });
}

describe("EntityRegistry", () => {
  let tmp_dir: string;

  beforeEach(async () => {
    tmp_dir = await mkdtemp(join(tmpdir(), "lf-registry-test-"));
  });

  afterEach(async () => {
    await rm(tmp_dir, { recursive: true, force: true });
  });

  it("loads valid entity configs from disk", async () => {
    const entities_path = join(tmp_dir, "entities");
    await mkdir(join(entities_path, "alpha"), { recursive: true });
    await mkdir(join(entities_path, "beta"), { recursive: true });

    await writeFile(
      join(entities_path, "alpha", "config.yaml"),
      valid_entity_yaml("alpha", "Alpha Project"),
    );
    await writeFile(
      join(entities_path, "beta", "config.yaml"),
      valid_entity_yaml("beta", "Beta Project"),
    );

    const config = make_config(tmp_dir);
    const registry = new EntityRegistry(config);
    await registry.load_all();

    expect(registry.count()).toBe(2);
    expect(registry.get("alpha")).toBeDefined();
    expect(registry.get("alpha")?.entity.name).toBe("Alpha Project");
    expect(registry.get("beta")).toBeDefined();
    expect(registry.get("beta")?.entity.name).toBe("Beta Project");
  });

  it("get_all() returns all loaded entities", async () => {
    const entities_path = join(tmp_dir, "entities");
    await mkdir(join(entities_path, "one"), { recursive: true });
    await mkdir(join(entities_path, "two"), { recursive: true });

    await writeFile(
      join(entities_path, "one", "config.yaml"),
      valid_entity_yaml("one", "One"),
    );
    await writeFile(
      join(entities_path, "two", "config.yaml"),
      valid_entity_yaml("two", "Two"),
    );

    const config = make_config(tmp_dir);
    const registry = new EntityRegistry(config);
    await registry.load_all();

    const all = registry.get_all();
    expect(all).toHaveLength(2);
    const ids = all.map((e) => e.entity.id).sort();
    expect(ids).toEqual(["one", "two"]);
  });

  it("get_active() filters by status", async () => {
    const entities_path = join(tmp_dir, "entities");
    await mkdir(join(entities_path, "active-one"), { recursive: true });
    await mkdir(join(entities_path, "paused-one"), { recursive: true });

    await writeFile(
      join(entities_path, "active-one", "config.yaml"),
      valid_entity_yaml("active-one", "Active One", "active"),
    );
    await writeFile(
      join(entities_path, "paused-one", "config.yaml"),
      valid_entity_yaml("paused-one", "Paused One", "paused"),
    );

    const config = make_config(tmp_dir);
    const registry = new EntityRegistry(config);
    await registry.load_all();

    expect(registry.get_all()).toHaveLength(2);
    expect(registry.get_active()).toHaveLength(1);
    expect(registry.get_active()[0]?.entity.id).toBe("active-one");
  });

  it("get() returns undefined for unknown entity", async () => {
    const entities_path = join(tmp_dir, "entities");
    await mkdir(entities_path, { recursive: true });

    const config = make_config(tmp_dir);
    const registry = new EntityRegistry(config);
    await registry.load_all();

    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("skips invalid configs with a warning (does not crash)", async () => {
    const entities_path = join(tmp_dir, "entities");
    await mkdir(join(entities_path, "good"), { recursive: true });
    await mkdir(join(entities_path, "bad"), { recursive: true });

    await writeFile(
      join(entities_path, "good", "config.yaml"),
      valid_entity_yaml("good", "Good Project"),
    );
    await writeFile(
      join(entities_path, "bad", "config.yaml"),
      "this: is\nnot: valid\nentity: config",
    );

    const warn_spy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const config = make_config(tmp_dir);
    const registry = new EntityRegistry(config);
    await registry.load_all();

    expect(registry.count()).toBe(1);
    expect(registry.get("good")).toBeDefined();
    expect(registry.get("bad")).toBeUndefined();
    expect(warn_spy).toHaveBeenCalled();
    const warning_message = warn_spy.mock.calls[0]?.[0] as string;
    expect(warning_message).toContain("bad");

    warn_spy.mockRestore();
  });

  it("handles empty entities directory", async () => {
    const entities_path = join(tmp_dir, "entities");
    await mkdir(entities_path, { recursive: true });

    const config = make_config(tmp_dir);
    const registry = new EntityRegistry(config);
    await registry.load_all();

    expect(registry.count()).toBe(0);
    expect(registry.get_all()).toEqual([]);
    expect(registry.get_active()).toEqual([]);
  });

  it("handles missing entities directory", async () => {
    // tmp_dir has no "entities" subdirectory
    const config = make_config(tmp_dir);
    const registry = new EntityRegistry(config);
    await registry.load_all();

    expect(registry.count()).toBe(0);
  });
});
