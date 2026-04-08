import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for resolve_daemon_path() priority logic.
 *
 * We mock `statSync` (used by the internal `file_exists` helper) to control
 * which paths "exist" on disk, then assert that the function returns the
 * highest-priority match.
 *
 * The mock is defined once at module level (vi.mock is hoisted). Per-test
 * behavior is controlled via `existing_paths` — a Set of paths that should
 * appear to exist on disk.
 */

const home = homedir();
const install_path = join(home, ".lobsterfarm", "src", "packages", "daemon", "dist", "index.js");
const legacy_path = join(
  home,
  ".lobsterfarm",
  "entities",
  "lobster-farm",
  "repos",
  "lobster-farm",
  "packages",
  "daemon",
  "dist",
  "index.js",
);

// Controlled per-test: which paths should "exist"
const existing_paths = new Set<string>();

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    statSync: (p: string) => {
      if (existing_paths.has(p as string)) {
        return { isFile: () => true };
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  };
});

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  existing_paths.clear();
  vi.restoreAllMocks();
});

describe("resolve_daemon_path", () => {
  it("prefers install path over legacy path when both exist", async () => {
    existing_paths.add(install_path);
    existing_paths.add(legacy_path);

    const { resolve_daemon_path } = await import("../commands/start.js");
    const result = resolve_daemon_path();
    expect(result).toBe(install_path);
  });

  it("falls back to legacy path when install and walk-up paths do not exist", async () => {
    existing_paths.add(legacy_path);

    const { resolve_daemon_path } = await import("../commands/start.js");
    const result = resolve_daemon_path();
    expect(result).toBe(legacy_path);
  });

  it("returns install path as default when nothing exists on disk", async () => {
    // All paths missing — function returns install_path so the error
    // message points the user to where the daemon should be installed.
    const { resolve_daemon_path } = await import("../commands/start.js");
    const result = resolve_daemon_path();
    expect(result).toBe(install_path);
  });
});
