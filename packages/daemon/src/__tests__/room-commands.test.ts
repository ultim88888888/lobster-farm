import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sanitize_channel_name,
  write_room_archive,
  load_room_archives,
  type RoomArchive,
} from "../discord.js";

// ── sanitize_channel_name ──

describe("sanitize_channel_name", () => {
  it("lowercases input", () => {
    expect(sanitize_channel_name("Bitcoin-Dashboard")).toBe("bitcoin-dashboard");
  });

  it("replaces spaces with hyphens", () => {
    expect(sanitize_channel_name("auth flow")).toBe("auth-flow");
  });

  it("removes special characters", () => {
    expect(sanitize_channel_name("my_room!@#$%")).toBe("my-room");
  });

  it("collapses multiple hyphens", () => {
    expect(sanitize_channel_name("a---b---c")).toBe("a-b-c");
  });

  it("trims leading and trailing hyphens", () => {
    expect(sanitize_channel_name("--hello--")).toBe("hello");
  });

  it("truncates to 100 characters", () => {
    const long_name = "a".repeat(150);
    expect(sanitize_channel_name(long_name)).toHaveLength(100);
  });

  it("handles emoji by stripping them", () => {
    // Emoji are replaced by hyphens, then collapsed
    expect(sanitize_channel_name("plan-🚀-launch")).toBe("plan-launch");
  });

  it("preserves hyphens in valid names", () => {
    expect(sanitize_channel_name("bitcoin-dashboard")).toBe("bitcoin-dashboard");
  });

  it("handles empty string", () => {
    expect(sanitize_channel_name("")).toBe("");
  });

  it("handles purely special characters", () => {
    expect(sanitize_channel_name("!!!")).toBe("");
  });
});

// ── Archive I/O ──

describe("Room archive I/O", () => {
  let temp_dir: string;

  beforeEach(async () => {
    temp_dir = await mkdtemp(join(tmpdir(), "lf-room-test-"));
  });

  afterEach(async () => {
    await rm(temp_dir, { recursive: true, force: true });
  });

  function make_archive(overrides: Partial<RoomArchive> = {}): RoomArchive {
    return {
      name: "bitcoin-dashboard",
      channel_id: "ch-123",
      session_id: "sess-abc",
      entity_id: "alpha",
      archetype: "planner",
      created_at: "2026-03-28T02:00:00Z",
      closed_at: "2026-03-28T03:00:00Z",
      ...overrides,
    };
  }

  it("writes and reads an archive entry", async () => {
    const archive = make_archive();
    // Use temp_dir as the "entities" parent — entity_dir will be temp_dir/alpha
    // We need to set up the path structure entity_dir expects
    const paths = { lobsterfarm_dir: temp_dir };

    await write_room_archive("alpha", archive, paths);

    const archives = await load_room_archives("alpha", paths);
    expect(archives).toHaveLength(1);
    expect(archives[0]!.name).toBe("bitcoin-dashboard");
    expect(archives[0]!.session_id).toBe("sess-abc");
    expect(archives[0]!.entity_id).toBe("alpha");
  });

  it("writes atomically (no .tmp files left)", async () => {
    const archive = make_archive();
    const paths = { lobsterfarm_dir: temp_dir };

    await write_room_archive("alpha", archive, paths);

    const archives_dir = join(temp_dir, "entities", "alpha", "archives");
    const files = await readdir(archives_dir);
    const tmp_files = files.filter(f => f.endsWith(".tmp"));
    expect(tmp_files).toHaveLength(0);
  });

  it("returns empty array when no archives exist", async () => {
    const paths = { lobsterfarm_dir: temp_dir };
    const archives = await load_room_archives("nonexistent", paths);
    expect(archives).toHaveLength(0);
  });

  it("sorts archives by closed_at ascending", async () => {
    const paths = { lobsterfarm_dir: temp_dir };

    await write_room_archive("alpha", make_archive({
      name: "room-a",
      closed_at: "2026-03-28T05:00:00Z",
    }), paths);
    await write_room_archive("alpha", make_archive({
      name: "room-b",
      closed_at: "2026-03-28T01:00:00Z",
    }), paths);
    await write_room_archive("alpha", make_archive({
      name: "room-c",
      closed_at: "2026-03-28T03:00:00Z",
    }), paths);

    const archives = await load_room_archives("alpha", paths);
    expect(archives.map(a => a.name)).toEqual(["room-b", "room-c", "room-a"]);
  });

  it("handles null session_id", async () => {
    const archive = make_archive({ session_id: null });
    const paths = { lobsterfarm_dir: temp_dir };

    await write_room_archive("alpha", archive, paths);

    const archives = await load_room_archives("alpha", paths);
    expect(archives[0]!.session_id).toBeNull();
  });

  it("skips non-JSON files in archive directory", async () => {
    const paths = { lobsterfarm_dir: temp_dir };
    const { writeFile } = await import("node:fs/promises");

    // Write a valid archive
    await write_room_archive("alpha", make_archive(), paths);

    // Write a non-JSON file
    const archives_dir = join(temp_dir, "entities", "alpha", "archives");
    await writeFile(join(archives_dir, "notes.txt"), "not json", "utf-8");

    const archives = await load_room_archives("alpha", paths);
    expect(archives).toHaveLength(1);
  });

  it("skips invalid JSON files", async () => {
    const paths = { lobsterfarm_dir: temp_dir };
    const { writeFile } = await import("node:fs/promises");

    // Write a valid archive
    await write_room_archive("alpha", make_archive(), paths);

    // Write an invalid JSON file
    const archives_dir = join(temp_dir, "entities", "alpha", "archives");
    await writeFile(join(archives_dir, "bad.json"), "{broken", "utf-8");

    const archives = await load_room_archives("alpha", paths);
    expect(archives).toHaveLength(1);
  });

  it("stores multiple archives for the same room name", async () => {
    const paths = { lobsterfarm_dir: temp_dir };

    await write_room_archive("alpha", make_archive({
      name: "auth-flow",
      closed_at: "2026-03-28T01:00:00Z",
      session_id: "sess-1",
    }), paths);

    await write_room_archive("alpha", make_archive({
      name: "auth-flow",
      closed_at: "2026-03-28T04:00:00Z",
      session_id: "sess-2",
    }), paths);

    const archives = await load_room_archives("alpha", paths);
    const auth_archives = archives.filter(a => a.name === "auth-flow");
    expect(auth_archives).toHaveLength(2);
    // Sorted by closed_at
    expect(auth_archives[0]!.session_id).toBe("sess-1");
    expect(auth_archives[1]!.session_id).toBe("sess-2");
  });
});
