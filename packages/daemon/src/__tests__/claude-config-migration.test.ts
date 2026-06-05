/**
 * Tests for per-entity CLAUDE_CONFIG_DIR migration helpers (issue #327).
 *
 * Covers:
 *  - Project-dir migration: copies, scoping, idempotency, fail-open
 *  - Onboarding-field patch: writes when missing, preserves existing values,
 *    fail-open when .claude.json is absent
 *  - Combined ensure helper: idempotent across calls, cached per process
 *  - Config-dir-aware JSONL existence check
 *
 * All tests use throwaway tempdirs as both "fake HOME" and "fake config dir"
 * so we never touch the real `~/.claude` or any live per-entity sub dir.
 */

import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted holder so vi.mock (also hoisted) can share the same reference with
// beforeEach below. The module under test imports `homedir` directly; we
// redirect it to a per-test tempdir so we never touch the real ~/.claude.
const home_holder = vi.hoisted(() => ({ value: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => home_holder.value,
  };
});

import {
  _reset_prepared_cache_for_tests,
  ensure_onboarding_fields,
  ensure_per_entity_config_dir_ready,
  migrate_entity_project_dirs,
  session_jsonl_exists_anywhere_in,
} from "../claude-config-migration.js";

let config_dir: string;

beforeEach(async () => {
  home_holder.value = await mkdtemp(join(tmpdir(), "claude-config-home-"));
  config_dir = await mkdtemp(join(tmpdir(), "claude-config-dir-"));
  _reset_prepared_cache_for_tests();

  // Safety: the mock must be active. If homedir() doesn't return our tempdir,
  // refuse to run so we never accidentally read/write the real ~/.claude.
  if (homedir() !== home_holder.value) {
    throw new Error(
      `homedir mock not active (got ${homedir()}, expected ${home_holder.value}) — refusing to run tests`,
    );
  }
});

afterEach(async () => {
  await rm(home_holder.value, { recursive: true, force: true });
  await rm(config_dir, { recursive: true, force: true });
});

/** Seed a fake `~/.claude/projects/` with the given project slugs. */
async function seed_project_dirs(
  slugs: Array<{ name: string; session_id: string }>,
): Promise<void> {
  const projects_dir = join(home_holder.value, ".claude", "projects");
  await mkdir(projects_dir, { recursive: true });
  for (const { name, session_id } of slugs) {
    const dir = join(projects_dir, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${session_id}.jsonl`), '{"type":"user"}\n', "utf-8");
  }
}

/** Seed the user's primary `~/.claude.json` with a theme. */
async function seed_user_config(theme: string | undefined): Promise<void> {
  const path = join(home_holder.value, ".claude.json");
  const data = theme !== undefined ? { theme } : {};
  await writeFile(path, JSON.stringify(data), "utf-8");
}

// ── migrate_entity_project_dirs ──

describe("migrate_entity_project_dirs", () => {
  it("copies project dirs whose slug contains the entity_id", async () => {
    await seed_project_dirs([
      {
        name: "-Users-farm--lobsterfarm-entities-canal-street-repos-app",
        session_id: "aaaa-1111",
      },
      {
        name: "-Users-farm--lobsterfarm-entities-canal-street-repos-app-worktrees-feat",
        session_id: "bbbb-2222",
      },
      // unrelated entity — must NOT be copied
      {
        name: "-Users-farm--lobsterfarm-entities-other-entity-repos-app",
        session_id: "cccc-3333",
      },
    ]);

    const migrated = await migrate_entity_project_dirs("canal-street", config_dir);

    expect(migrated).toHaveLength(2);
    expect(migrated.sort()).toEqual([
      "-Users-farm--lobsterfarm-entities-canal-street-repos-app",
      "-Users-farm--lobsterfarm-entities-canal-street-repos-app-worktrees-feat",
    ]);

    // JSONLs are present in the destination
    await expect(
      access(
        join(
          config_dir,
          "projects",
          "-Users-farm--lobsterfarm-entities-canal-street-repos-app",
          "aaaa-1111.jsonl",
        ),
      ),
    ).resolves.toBeUndefined();

    // Unrelated entity's projects were NOT copied
    await expect(
      access(
        join(config_dir, "projects", "-Users-farm--lobsterfarm-entities-other-entity-repos-app"),
      ),
    ).rejects.toThrow();
  });

  it("is idempotent — second call copies nothing new", async () => {
    await seed_project_dirs([
      {
        name: "-Users-farm--lobsterfarm-entities-canal-street-repos-app",
        session_id: "aaaa-1111",
      },
    ]);

    const first = await migrate_entity_project_dirs("canal-street", config_dir);
    const second = await migrate_entity_project_dirs("canal-street", config_dir);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it("returns empty list when ~/.claude/projects/ is missing (fail-open)", async () => {
    // No seeding — no projects dir at all.
    const migrated = await migrate_entity_project_dirs("canal-street", config_dir);
    expect(migrated).toEqual([]);
  });

  it("creates <config_dir>/projects/ if absent", async () => {
    await seed_project_dirs([
      {
        name: "-Users-farm--lobsterfarm-entities-canal-street-repos-app",
        session_id: "aaaa-1111",
      },
    ]);

    await migrate_entity_project_dirs("canal-street", config_dir);

    await expect(access(join(config_dir, "projects"))).resolves.toBeUndefined();
  });

  it("does not overwrite existing destination dir (preserves whatever's there)", async () => {
    await seed_project_dirs([
      {
        name: "-Users-farm--lobsterfarm-entities-canal-street-repos-app",
        session_id: "aaaa-1111",
      },
    ]);

    // Pre-create destination with different content
    const dst = join(
      config_dir,
      "projects",
      "-Users-farm--lobsterfarm-entities-canal-street-repos-app",
    );
    await mkdir(dst, { recursive: true });
    await writeFile(join(dst, "preexisting.jsonl"), "preserved", "utf-8");

    const migrated = await migrate_entity_project_dirs("canal-street", config_dir);

    expect(migrated).toEqual([]);
    // Preexisting file is still there, source JSONL is NOT copied in.
    const preserved = await readFile(join(dst, "preexisting.jsonl"), "utf-8");
    expect(preserved).toBe("preserved");
    await expect(access(join(dst, "aaaa-1111.jsonl"))).rejects.toThrow();
  });
});

// ── ensure_onboarding_fields ──

describe("ensure_onboarding_fields", () => {
  it("patches missing fields when .claude.json exists with only oauthAccount", async () => {
    await seed_user_config("light-daltonized");

    // Simulate the post-`claude auth login` state
    const claude_json = join(config_dir, ".claude.json");
    await writeFile(
      claude_json,
      JSON.stringify({
        oauthAccount: { emailAddress: "test@example.com" },
        hasCompletedOnboarding: null,
      }),
      "utf-8",
    );

    const wrote = await ensure_onboarding_fields(config_dir);
    expect(wrote).toBe(true);

    const patched = JSON.parse(await readFile(claude_json, "utf-8")) as Record<string, unknown>;
    expect(patched.hasCompletedOnboarding).toBe(true);
    expect(patched.theme).toBe("light-daltonized");
    expect(patched.bypassPermissionsModeAccepted).toBe(true);
    // oauthAccount must be preserved untouched
    expect(patched.oauthAccount).toEqual({ emailAddress: "test@example.com" });
  });

  it("falls back to dark-ansi when user's ~/.claude.json has no theme", async () => {
    await seed_user_config(undefined);

    const claude_json = join(config_dir, ".claude.json");
    await writeFile(claude_json, JSON.stringify({ oauthAccount: {} }), "utf-8");

    await ensure_onboarding_fields(config_dir);

    const patched = JSON.parse(await readFile(claude_json, "utf-8")) as Record<string, unknown>;
    expect(patched.theme).toBe("dark-ansi");
  });

  it("preserves existing truthy values (idempotent)", async () => {
    await seed_user_config("dark-ansi");

    const claude_json = join(config_dir, ".claude.json");
    await writeFile(
      claude_json,
      JSON.stringify({
        oauthAccount: {},
        hasCompletedOnboarding: true,
        theme: "user-custom-theme",
        bypassPermissionsModeAccepted: true,
      }),
      "utf-8",
    );

    const wrote = await ensure_onboarding_fields(config_dir);
    expect(wrote).toBe(false);

    const after = JSON.parse(await readFile(claude_json, "utf-8")) as Record<string, unknown>;
    expect(after.theme).toBe("user-custom-theme");
  });

  it("returns false (fail-open) when .claude.json is missing", async () => {
    // No file at all — we must not crash, must not create a fresh file
    // (would race with `claude auth login` and risk wiping oauthAccount).
    const wrote = await ensure_onboarding_fields(config_dir);
    expect(wrote).toBe(false);
    await expect(access(join(config_dir, ".claude.json"))).rejects.toThrow();
  });

  it("only patches the missing field when others are already set", async () => {
    await seed_user_config("dark-ansi");

    const claude_json = join(config_dir, ".claude.json");
    await writeFile(
      claude_json,
      JSON.stringify({
        oauthAccount: {},
        hasCompletedOnboarding: true,
        theme: "existing-theme",
        // bypassPermissionsModeAccepted intentionally missing
      }),
      "utf-8",
    );

    await ensure_onboarding_fields(config_dir);

    const patched = JSON.parse(await readFile(claude_json, "utf-8")) as Record<string, unknown>;
    expect(patched.theme).toBe("existing-theme"); // preserved
    expect(patched.bypassPermissionsModeAccepted).toBe(true); // added
  });
});

// ── ensure_per_entity_config_dir_ready ──

describe("ensure_per_entity_config_dir_ready", () => {
  it("runs migration + onboarding patch on first call, no-ops on second", async () => {
    await seed_user_config("dark-ansi");
    await seed_project_dirs([
      {
        name: "-Users-farm--lobsterfarm-entities-canal-street",
        session_id: "aaaa-1111",
      },
    ]);
    const claude_json = join(config_dir, ".claude.json");
    await writeFile(claude_json, JSON.stringify({ oauthAccount: {} }), "utf-8");

    await ensure_per_entity_config_dir_ready("canal-street", config_dir);

    // Migration ran
    await expect(
      access(
        join(
          config_dir,
          "projects",
          "-Users-farm--lobsterfarm-entities-canal-street",
          "aaaa-1111.jsonl",
        ),
      ),
    ).resolves.toBeUndefined();

    // Onboarding patched
    const after = JSON.parse(await readFile(claude_json, "utf-8")) as Record<string, unknown>;
    expect(after.hasCompletedOnboarding).toBe(true);

    // Second call is a cache hit — verify by mutating the source and confirming
    // it does NOT get re-copied.
    await writeFile(
      join(
        home_holder.value,
        ".claude",
        "projects",
        "-Users-farm--lobsterfarm-entities-canal-street",
        "bbbb-2222.jsonl",
      ),
      '{"x":1}\n',
      "utf-8",
    );
    await ensure_per_entity_config_dir_ready("canal-street", config_dir);
    await expect(
      access(
        join(
          config_dir,
          "projects",
          "-Users-farm--lobsterfarm-entities-canal-street",
          "bbbb-2222.jsonl",
        ),
      ),
    ).rejects.toThrow();
  });
});

// ── session_jsonl_exists_anywhere_in ──

describe("session_jsonl_exists_anywhere_in", () => {
  it("finds JSONL under the per-entity config dir's projects/ when config_dir is set", async () => {
    const projects = join(config_dir, "projects", "-some-path");
    await mkdir(projects, { recursive: true });
    await writeFile(join(projects, "abc-123.jsonl"), "{}", "utf-8");

    expect(await session_jsonl_exists_anywhere_in(config_dir, "abc-123")).toBe(true);
    expect(await session_jsonl_exists_anywhere_in(config_dir, "missing")).toBe(false);
  });

  it("falls back to ~/.claude/projects/ when config_dir is null", async () => {
    const projects = join(home_holder.value, ".claude", "projects", "-some-path");
    await mkdir(projects, { recursive: true });
    await writeFile(join(projects, "abc-123.jsonl"), "{}", "utf-8");

    expect(await session_jsonl_exists_anywhere_in(null, "abc-123")).toBe(true);
  });

  it("does NOT find a JSONL in ~/.claude/projects/ when looking in a per-entity dir", async () => {
    // This is the bug — make sure the new helper is strict about its scope.
    const projects = join(home_holder.value, ".claude", "projects", "-some-path");
    await mkdir(projects, { recursive: true });
    await writeFile(join(projects, "abc-123.jsonl"), "{}", "utf-8");

    // config_dir is set but empty — the JSONL exists in HOME only
    expect(await session_jsonl_exists_anywhere_in(config_dir, "abc-123")).toBe(false);
  });

  it("returns false (no crash) when projects/ does not exist", async () => {
    expect(await session_jsonl_exists_anywhere_in(config_dir, "anything")).toBe(false);
  });
});
