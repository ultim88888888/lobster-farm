import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock sentry
vi.mock("../sentry.js", () => ({
  captureException: vi.fn(),
}));

// We'll override the CLAUDE_PROJECTS_DIR by mocking the homedir
const test_home = join(tmpdir(), "session-context-test-");
let tmp_dir: string;

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => tmp_dir,
  };
});

const { read_session_context, find_session_file } = await import("../session-context.js");

describe("session-context", () => {
  beforeEach(async () => {
    tmp_dir = await mkdtemp(test_home);
    // Create the .claude/projects directory structure
    await mkdir(join(tmp_dir, ".claude", "projects", "test-project"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp_dir, { recursive: true, force: true });
  });

  describe("find_session_file", () => {
    it("finds a session file in a project directory", async () => {
      const session_id = "abc12345-1234-5678-9012-123456789012";
      const file_path = join(tmp_dir, ".claude", "projects", "test-project", `${session_id}.jsonl`);
      await writeFile(file_path, "{}");

      const result = await find_session_file(session_id);
      expect(result).toBe(file_path);
    });

    it("returns null when session file does not exist", async () => {
      const result = await find_session_file("nonexistent-session-id");
      expect(result).toBeNull();
    });

    it("searches across multiple project directories", async () => {
      const session_id = "multi-proj-1234-5678-9012-123456789012";
      await mkdir(join(tmp_dir, ".claude", "projects", "other-project"), { recursive: true });
      const file_path = join(tmp_dir, ".claude", "projects", "other-project", `${session_id}.jsonl`);
      await writeFile(file_path, "{}");

      const result = await find_session_file(session_id);
      expect(result).toBe(file_path);
    });
  });

  describe("read_session_context", () => {
    it("parses assistant messages and returns context usage", async () => {
      const session_id = "ctx-test-1234-5678-9012-123456789012";
      const file_path = join(tmp_dir, ".claude", "projects", "test-project", `${session_id}.jsonl`);

      const lines = [
        JSON.stringify({
          type: "assistant",
          message: {
            model: "claude-opus-4-6",
            usage: {
              input_tokens: 1000,
              cache_creation_input_tokens: 500,
              cache_read_input_tokens: 200,
              output_tokens: 300,
            },
          },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            model: "claude-opus-4-6",
            usage: {
              input_tokens: 5000,
              cache_creation_input_tokens: 1000,
              cache_read_input_tokens: 4000,
              output_tokens: 600,
            },
          },
        }),
      ];
      await writeFile(file_path, lines.join("\n"));

      const result = await read_session_context(session_id);
      expect(result).not.toBeNull();
      // Last turn: input_tokens=5000 + cache_creation=1000 + cache_read=4000 = 10000
      expect(result!.used_tokens).toBe(10_000);
      expect(result!.total_tokens).toBe(200_000);
      expect(result!.percent).toBe(5);
      expect(result!.summary).toBe("10k / 200k (5%)");
    });

    it("returns null when session file is not found", async () => {
      const result = await read_session_context("nonexistent-session");
      expect(result).toBeNull();
    });

    it("returns null when session has no assistant messages", async () => {
      const session_id = "empty-sess-1234-5678-9012-123456789012";
      const file_path = join(tmp_dir, ".claude", "projects", "test-project", `${session_id}.jsonl`);
      await writeFile(file_path, JSON.stringify({ type: "human", message: { text: "hello" } }));

      const result = await read_session_context(session_id);
      expect(result).toBeNull();
    });

    it("skips malformed JSONL lines gracefully", async () => {
      const session_id = "malformed-1234-5678-9012-123456789012";
      const file_path = join(tmp_dir, ".claude", "projects", "test-project", `${session_id}.jsonl`);

      const lines = [
        "not valid json",
        JSON.stringify({
          type: "assistant",
          message: {
            usage: {
              input_tokens: 3000,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 2000,
              output_tokens: 100,
            },
          },
        }),
        "{also not valid",
      ];
      await writeFile(file_path, lines.join("\n"));

      const result = await read_session_context(session_id);
      expect(result).not.toBeNull();
      expect(result!.used_tokens).toBe(5000);
    });

    it("uses the last assistant turn for context fill", async () => {
      const session_id = "last-turn-1234-5678-9012-123456789012";
      const file_path = join(tmp_dir, ".claude", "projects", "test-project", `${session_id}.jsonl`);

      // First turn: small context
      // Second turn: larger context (cumulative)
      const lines = [
        JSON.stringify({
          type: "assistant",
          message: { usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 50 } },
        }),
        JSON.stringify({
          type: "assistant",
          message: { usage: { input_tokens: 50000, cache_creation_input_tokens: 0, cache_read_input_tokens: 100000, output_tokens: 200 } },
        }),
      ];
      await writeFile(file_path, lines.join("\n"));

      const result = await read_session_context(session_id);
      expect(result).not.toBeNull();
      // Last turn: 50000 + 0 + 100000 = 150000
      expect(result!.used_tokens).toBe(150_000);
      expect(result!.percent).toBe(75);
      expect(result!.summary).toBe("150k / 200k (75%)");
    });

    it("formats sub-thousand token counts correctly", async () => {
      const session_id = "small-tok-1234-5678-9012-123456789012";
      const file_path = join(tmp_dir, ".claude", "projects", "test-project", `${session_id}.jsonl`);

      const lines = [
        JSON.stringify({
          type: "assistant",
          message: { usage: { input_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 50 } },
        }),
      ];
      await writeFile(file_path, lines.join("\n"));

      const result = await read_session_context(session_id);
      expect(result).not.toBeNull();
      expect(result!.summary).toBe("500 / 200k (0.3%)");
    });
  });
});
