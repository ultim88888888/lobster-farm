import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import {
  append_session_log,
  read_session_log,
} from "../persistence.js";
import type { SessionLogEntry } from "../persistence.js";

function make_config(tmp: string): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    paths: {
      lobsterfarm_dir: tmp,
    },
  });
}

function make_entry(overrides: Partial<SessionLogEntry> = {}): SessionLogEntry {
  return {
    session_id: "test-session-001",
    entity_id: "alpha",
    feature_id: "alpha-42",
    archetype: "builder",
    phase: "build",
    source: "queue",
    started_at: "2026-03-26T10:00:00.000Z",
    ended_at: null,
    exit_code: null,
    duration_ms: null,
    bot_id: null,
    resume: false,
    ...overrides,
  };
}

describe("Session Log", () => {
  let tmp: string;
  let config: LobsterFarmConfig;

  beforeEach(async () => {
    tmp = join(tmpdir(), `lf-session-log-test-${Date.now()}`);
    await mkdir(tmp, { recursive: true });
    config = make_config(tmp);
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  // ── append_session_log ──

  describe("append_session_log", () => {
    it("creates file and parent directories on first write", async () => {
      const entry = make_entry();
      await append_session_log("alpha", entry, config);

      const log_path = join(tmp, "entities", "alpha", "session-log.jsonl");
      const content = await readFile(log_path, "utf-8");
      const lines = content.trim().split("\n");

      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]!) as SessionLogEntry;
      expect(parsed.session_id).toBe("test-session-001");
      expect(parsed.entity_id).toBe("alpha");
      expect(parsed.source).toBe("queue");
    });

    it("appends multiple entries without overwriting", async () => {
      const start_entry = make_entry();
      const end_entry = make_entry({
        ended_at: "2026-03-26T10:05:00.000Z",
        exit_code: 0,
        duration_ms: 300_000,
      });

      await append_session_log("alpha", start_entry, config);
      await append_session_log("alpha", end_entry, config);

      const log_path = join(tmp, "entities", "alpha", "session-log.jsonl");
      const content = await readFile(log_path, "utf-8");
      const lines = content.trim().split("\n");

      expect(lines).toHaveLength(2);

      const first = JSON.parse(lines[0]!) as SessionLogEntry;
      expect(first.ended_at).toBeNull();

      const second = JSON.parse(lines[1]!) as SessionLogEntry;
      expect(second.ended_at).toBe("2026-03-26T10:05:00.000Z");
      expect(second.exit_code).toBe(0);
      expect(second.duration_ms).toBe(300_000);
    });

    it("writes queue-sourced session with correct metadata", async () => {
      const entry = make_entry({
        source: "queue",
        archetype: "reviewer",
        phase: "review",
        bot_id: null,
      });

      await append_session_log("alpha", entry, config);

      const entries = await read_session_log("alpha", config);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.source).toBe("queue");
      expect(entries[0]!.archetype).toBe("reviewer");
      expect(entries[0]!.phase).toBe("review");
      expect(entries[0]!.bot_id).toBeNull();
    });

    it("writes pool-sourced session with bot_id", async () => {
      const entry = make_entry({
        source: "pool",
        bot_id: 3,
        archetype: "builder",
      });

      await append_session_log("alpha", entry, config);

      const entries = await read_session_log("alpha", config);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.source).toBe("pool");
      expect(entries[0]!.bot_id).toBe(3);
    });

    it("marks resumed sessions with resume: true", async () => {
      const entry = make_entry({ resume: true });

      await append_session_log("alpha", entry, config);

      const entries = await read_session_log("alpha", config);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.resume).toBe(true);
    });

    it("writes completion entry with exit_code and duration", async () => {
      const entry = make_entry({
        ended_at: "2026-03-26T10:10:00.000Z",
        exit_code: 0,
        duration_ms: 600_000,
      });

      await append_session_log("alpha", entry, config);

      const entries = await read_session_log("alpha", config);
      expect(entries[0]!.exit_code).toBe(0);
      expect(entries[0]!.duration_ms).toBe(600_000);
    });

    it("writes failure entry with non-zero exit_code", async () => {
      const entry = make_entry({
        ended_at: "2026-03-26T10:02:00.000Z",
        exit_code: 1,
        duration_ms: 120_000,
      });

      await append_session_log("alpha", entry, config);

      const entries = await read_session_log("alpha", config);
      expect(entries[0]!.exit_code).toBe(1);
    });
  });

  // ── read_session_log ──

  describe("read_session_log", () => {
    it("returns empty array when log file does not exist", async () => {
      const entries = await read_session_log("nonexistent", config);
      expect(entries).toEqual([]);
    });

    it("skips malformed lines gracefully", async () => {
      // Write a valid entry, a malformed line, then another valid entry
      const entity_dir = join(tmp, "entities", "alpha");
      await mkdir(entity_dir, { recursive: true });

      const log_path = join(entity_dir, "session-log.jsonl");
      const { writeFile } = await import("node:fs/promises");

      const valid1 = JSON.stringify(make_entry({ session_id: "s1" }));
      const malformed = "this is not json{{{";
      const valid2 = JSON.stringify(make_entry({ session_id: "s2" }));

      await writeFile(log_path, [valid1, malformed, valid2].join("\n") + "\n", "utf-8");

      const entries = await read_session_log("alpha", config);
      expect(entries).toHaveLength(2);
      expect(entries[0]!.session_id).toBe("s1");
      expect(entries[1]!.session_id).toBe("s2");
    });

    it("filters by since date", async () => {
      const old_entry = make_entry({
        session_id: "old",
        started_at: "2026-03-25T10:00:00.000Z",
        ended_at: "2026-03-25T10:05:00.000Z",
      });
      const new_entry = make_entry({
        session_id: "new",
        started_at: "2026-03-26T12:00:00.000Z",
        ended_at: "2026-03-26T12:05:00.000Z",
      });

      await append_session_log("alpha", old_entry, config);
      await append_session_log("alpha", new_entry, config);

      const entries = await read_session_log("alpha", config, {
        since: new Date("2026-03-26T00:00:00.000Z"),
      });

      expect(entries).toHaveLength(1);
      expect(entries[0]!.session_id).toBe("new");
    });

    it("uses started_at for in-progress sessions when filtering by since", async () => {
      const running = make_entry({
        session_id: "running",
        started_at: "2026-03-26T14:00:00.000Z",
        ended_at: null,
      });

      await append_session_log("alpha", running, config);

      const entries = await read_session_log("alpha", config, {
        since: new Date("2026-03-26T00:00:00.000Z"),
      });

      expect(entries).toHaveLength(1);
      expect(entries[0]!.session_id).toBe("running");
    });

    it("respects limit parameter (returns last N entries)", async () => {
      for (let i = 0; i < 5; i++) {
        await append_session_log("alpha", make_entry({
          session_id: `session-${String(i)}`,
        }), config);
      }

      const entries = await read_session_log("alpha", config, { limit: 2 });
      expect(entries).toHaveLength(2);
      // Returns the last 2 entries
      expect(entries[0]!.session_id).toBe("session-3");
      expect(entries[1]!.session_id).toBe("session-4");
    });

    it("returns all entries when limit exceeds count", async () => {
      await append_session_log("alpha", make_entry({ session_id: "only" }), config);

      const entries = await read_session_log("alpha", config, { limit: 100 });
      expect(entries).toHaveLength(1);
    });

    it("handles empty log file", async () => {
      const entity_dir = join(tmp, "entities", "alpha");
      await mkdir(entity_dir, { recursive: true });

      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(entity_dir, "session-log.jsonl"), "", "utf-8");

      const entries = await read_session_log("alpha", config);
      expect(entries).toEqual([]);
    });
  });

  // ── Integration: start + complete lifecycle ──

  describe("session lifecycle pattern", () => {
    it("records start then completion for a queue session", async () => {
      // Simulate what index.ts does: log start, then log completion
      const session_id = "lifecycle-001";
      const start_time = Date.now();

      // Start entry
      await append_session_log("alpha", make_entry({
        session_id,
        started_at: new Date(start_time).toISOString(),
        ended_at: null,
        exit_code: null,
        duration_ms: null,
      }), config);

      // Completion entry (simulating ~5s later)
      const end_time = start_time + 5000;
      await append_session_log("alpha", make_entry({
        session_id,
        started_at: new Date(start_time).toISOString(),
        ended_at: new Date(end_time).toISOString(),
        exit_code: 0,
        duration_ms: 5000,
      }), config);

      const entries = await read_session_log("alpha", config);
      expect(entries).toHaveLength(2);

      // First entry: in-progress
      expect(entries[0]!.ended_at).toBeNull();
      expect(entries[0]!.exit_code).toBeNull();

      // Second entry: completed
      expect(entries[1]!.ended_at).not.toBeNull();
      expect(entries[1]!.exit_code).toBe(0);
      expect(entries[1]!.duration_ms).toBe(5000);
    });

    it("records pool session with bot_id through full lifecycle", async () => {
      const session_id = "pool-3-assign";

      // Assignment entry
      await append_session_log("alpha", make_entry({
        session_id,
        source: "pool",
        bot_id: 3,
        ended_at: null,
      }), config);

      // Session ended entry
      await append_session_log("alpha", make_entry({
        session_id: "pool-3-ended",
        source: "pool",
        bot_id: 3,
        ended_at: "2026-03-26T11:00:00.000Z",
        exit_code: 0,
        duration_ms: 3_600_000,
      }), config);

      const entries = await read_session_log("alpha", config);
      expect(entries).toHaveLength(2);
      expect(entries.every(e => e.source === "pool")).toBe(true);
      expect(entries.every(e => e.bot_id === 3)).toBe(true);
    });
  });
});
