import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { PRWatchStore, watch_key } from "../pr-watches.js";
import { load_pr_watches } from "../persistence.js";

let temp_dir: string;

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    paths: { lobsterfarm_dir: temp_dir },
  });
}

describe("PRWatchStore", () => {
  let config: LobsterFarmConfig;
  let store: PRWatchStore;

  beforeEach(async () => {
    temp_dir = await mkdtemp(join(tmpdir(), "pr-watch-test-"));
    config = make_config();
    store = new PRWatchStore(config);
  });

  afterEach(async () => {
    await rm(temp_dir, { recursive: true, force: true });
  });

  it("adds and retrieves a watch", async () => {
    await store.add("owner/repo", 42, "chan-123");

    const watch = store.get("owner/repo", 42);
    expect(watch).toBeDefined();
    expect(watch!.repo).toBe("owner/repo");
    expect(watch!.pr_number).toBe(42);
    expect(watch!.channel_id).toBe("chan-123");
    expect(watch!.created_at).toBeTruthy();
  });

  it("returns undefined for non-existent watch", () => {
    const watch = store.get("owner/repo", 999);
    expect(watch).toBeUndefined();
  });

  it("removes a watch", async () => {
    await store.add("owner/repo", 42, "chan-123");
    await store.remove("owner/repo", 42);

    expect(store.get("owner/repo", 42)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it("supports multiple watches from the same channel", async () => {
    await store.add("owner/repo", 1, "chan-123");
    await store.add("owner/repo", 2, "chan-123");

    expect(store.size).toBe(2);
    expect(store.get("owner/repo", 1)?.channel_id).toBe("chan-123");
    expect(store.get("owner/repo", 2)?.channel_id).toBe("chan-123");
  });

  it("supports watches from different channels", async () => {
    await store.add("owner/repo", 1, "chan-A");
    await store.add("owner/repo", 2, "chan-B");

    expect(store.get("owner/repo", 1)?.channel_id).toBe("chan-A");
    expect(store.get("owner/repo", 2)?.channel_id).toBe("chan-B");
  });

  it("removes all watches for a channel", async () => {
    await store.add("owner/repo", 1, "chan-123");
    await store.add("owner/repo", 2, "chan-123");
    await store.add("owner/repo", 3, "chan-456");

    await store.remove_for_channel("chan-123");

    expect(store.size).toBe(1);
    expect(store.get("owner/repo", 1)).toBeUndefined();
    expect(store.get("owner/repo", 2)).toBeUndefined();
    expect(store.get("owner/repo", 3)).toBeDefined();
  });

  it("persists watches to disk", async () => {
    await store.add("owner/repo", 42, "chan-123");

    // Load from disk in a new store instance
    const fresh_store = new PRWatchStore(config);
    await fresh_store.initialize();

    const watch = fresh_store.get("owner/repo", 42);
    expect(watch).toBeDefined();
    expect(watch!.channel_id).toBe("chan-123");
  });

  it("survives empty state file", async () => {
    const fresh_store = new PRWatchStore(config);
    await fresh_store.initialize();

    expect(fresh_store.size).toBe(0);
  });

  it("get_all returns all watches", async () => {
    await store.add("owner/repo", 1, "chan-A");
    await store.add("owner/repo", 2, "chan-B");

    const all = store.get_all();
    expect(all).toHaveLength(2);
  });
});

describe("PRWatchStore TTL cleanup", () => {
  let config: LobsterFarmConfig;
  let store: PRWatchStore;

  beforeEach(async () => {
    temp_dir = await mkdtemp(join(tmpdir(), "pr-watch-ttl-"));
    config = make_config();
    store = new PRWatchStore(config);
  });

  afterEach(async () => {
    await rm(temp_dir, { recursive: true, force: true });
  });

  it("expires watches older than TTL", async () => {
    // Add a watch, then manually backdate its created_at via persistence
    await store.add("owner/repo", 1, "chan-123");

    // Reload with manipulated state — set created_at 25 hours ago
    const state = await load_pr_watches(config);
    const key = watch_key("owner/repo", 1);
    state[key]!.created_at = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

    // Save the backdated state and reinitialize
    const { save_pr_watches } = await import("../persistence.js");
    await save_pr_watches(state, config);

    const fresh_store = new PRWatchStore(config);
    await fresh_store.initialize();

    const expired = await fresh_store.cleanup_expired();
    expect(expired).toBe(1);
    expect(fresh_store.size).toBe(0);
  });

  it("keeps watches within TTL", async () => {
    await store.add("owner/repo", 1, "chan-123");

    const expired = await store.cleanup_expired();
    expect(expired).toBe(0);
    expect(store.size).toBe(1);
  });

  it("supports custom TTL", async () => {
    await store.add("owner/repo", 1, "chan-123");

    // Use a TTL of -1ms — everything with any age expires
    const expired = await store.cleanup_expired(-1);
    expect(expired).toBe(1);
  });
});

describe("watch_key", () => {
  it("formats key correctly", () => {
    expect(watch_key("owner/repo", 42)).toBe("owner/repo#42");
  });
});
