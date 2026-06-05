/**
 * Per-entity CLAUDE_CONFIG_DIR migration helpers (issue #327).
 *
 * Per-entity Claude Max subscriptions (set via `subscription.claude_config_dir`
 * in entity config) inject `CLAUDE_CONFIG_DIR=<path>` into pool-bot spawn
 * environments so each entity uses an isolated OAuth account. That works fine
 * for fresh sessions but breaks `--resume` and interactive TUI launch in two
 * ways:
 *
 *  1. Claude Code looks up session JSONL transcripts under
 *     `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<session-id>.jsonl`. Sessions
 *     written under the *default* `~/.claude` before the entity switched to a
 *     per-entity sub are invisible to the new config dir — `--resume` then
 *     silently drops the bot into the onboarding wizard instead of failing
 *     loud. We solve this by mirroring the entity's project dirs into the
 *     per-entity `projects/` on first launch.
 *
 *  2. A freshly-authed config dir has `oauthAccount` populated (because
 *     `claude auth login` ran) but `hasCompletedOnboarding`, `theme`, and
 *     `bypassPermissionsModeAccepted` are all unset. Headless `-p` skips the
 *     onboarding wizard, but the pool-bot launch path is interactive (TUI),
 *     so it stalls on the first picker. We pre-populate the three idle-bypass
 *     fields once per config dir.
 *
 * Both operations are idempotent (cheap and safe to re-run on every relevant
 * spawn) and fail-open (a copy failure logs a warning rather than crashing
 * the daemon — the worst case is one bot losing session continuity, which is
 * recoverable; the daemon hard-crashing on a recycle is not).
 *
 * `oauthAccount` is never touched — that's auth state and the user owns it.
 */

import type { Dirent } from "node:fs";
import { access, cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Default theme used when the user's `~/.claude.json` doesn't expose one. */
const DEFAULT_THEME = "dark-ansi";

/** Per-process cache of config dirs we've already prepared. Both fixes are
 * idempotent on disk, but skipping the work on subsequent spawns saves a few
 * stat/readFile calls per recycle. */
const prepared: Set<string> = new Set();

/** Reset the prepared-set. Test-only. */
export function _reset_prepared_cache_for_tests(): void {
  prepared.clear();
}

/** Read the user's `theme` setting from `~/.claude.json`, falling back to the
 * default. Used to mirror the user's TUI preference into a per-entity config
 * dir so bots don't get a jarring color scheme. */
async function read_user_theme(): Promise<string> {
  const user_config_path = join(homedir(), ".claude.json");
  try {
    const raw = await readFile(user_config_path, "utf-8");
    const parsed = JSON.parse(raw) as { theme?: unknown };
    if (typeof parsed.theme === "string" && parsed.theme.length > 0) {
      return parsed.theme;
    }
  } catch {
    // Missing or unreadable — fall through to default.
  }
  return DEFAULT_THEME;
}

/** Mirror an entity's project transcript directories from `~/.claude/projects/`
 * into `<config_dir>/projects/`. Only directories whose slug *contains* the
 * entity_id are copied — this scopes the migration so we never accidentally
 * leak unrelated session history across subscriptions.
 *
 * Idempotent: skips entries that already exist in the destination (cp -rn
 * semantics via `force: false`).
 *
 * Fail-open: any I/O error is logged and swallowed — the caller proceeds
 * without `--resume` rather than the daemon crashing on a recycle.
 *
 * Returns the names of project dirs that were newly migrated this call.
 */
export async function migrate_entity_project_dirs(
  entity_id: string,
  config_dir: string,
): Promise<string[]> {
  const src_root = join(homedir(), ".claude", "projects");
  const dst_root = join(config_dir, "projects");
  const migrated: string[] = [];

  let entries: Dirent[];
  try {
    entries = await readdir(src_root, { withFileTypes: true });
  } catch {
    // ~/.claude/projects missing — nothing to migrate, not an error.
    return migrated;
  }

  try {
    await mkdir(dst_root, { recursive: true });
  } catch (err) {
    console.warn(
      `[claude-config] Could not create ${dst_root} for entity ${entity_id}: ${String(err)} — skipping migration`,
    );
    return migrated;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Match project slugs that contain the entity_id. Claude Code encodes a
    // path like `/Users/farm/.lobsterfarm/entities/<id>/...` as
    // `-Users-farm--lobsterfarm-entities-<id>-...` (every `/` and `.`
    // becomes `-`), so a plain substring check on entity_id is sufficient.
    if (!entry.name.includes(entity_id)) continue;

    const src = join(src_root, entry.name);
    const dst = join(dst_root, entry.name);

    // Skip if destination already exists (idempotency).
    try {
      await access(dst);
      continue;
    } catch {
      // Doesn't exist yet — copy.
    }

    try {
      await cp(src, dst, { recursive: true, force: false, errorOnExist: false });
      migrated.push(entry.name);
    } catch (err) {
      console.warn(
        `[claude-config] Failed to migrate ${entry.name} for entity ${entity_id}: ${String(err)} — continuing`,
      );
    }
  }

  if (migrated.length > 0) {
    console.log(
      `[claude-config] Migrated ${String(migrated.length)} project dir(s) for entity ${entity_id} into ${config_dir}: ${migrated.join(", ")}`,
    );
  }

  return migrated;
}

/** Pre-populate onboarding-completion markers in `<config_dir>/.claude.json`
 * so interactive (TUI) launches don't stall on the wizard.
 *
 * Writes only fields that are missing/falsy — never overwrites a user's
 * existing preference. Never touches `oauthAccount`. Theme is sourced from
 * `~/.claude.json` (the user's primary config) with `dark-ansi` as fallback.
 *
 * Fail-open: any error is logged and swallowed.
 *
 * Returns true iff the file was written this call (false = already populated
 * or write failed).
 */
export async function ensure_onboarding_fields(config_dir: string): Promise<boolean> {
  const path = join(config_dir, ".claude.json");

  let current: Record<string, unknown> = {};
  try {
    const raw = await readFile(path, "utf-8");
    current = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Missing or unparseable. We don't create a fresh `.claude.json` from
    // scratch — that would race with `claude auth login` and risk wiping
    // `oauthAccount`. Bail out; the next spawn will retry.
    console.warn(
      `[claude-config] ${path} missing or unreadable — skipping onboarding patch (run \`claude auth login\` against this dir first)`,
    );
    return false;
  }

  const target_theme = await read_user_theme();

  const needs_onboarding = current.hasCompletedOnboarding !== true;
  const needs_theme = typeof current.theme !== "string" || current.theme.length === 0;
  const needs_bypass = current.bypassPermissionsModeAccepted !== true;

  if (!needs_onboarding && !needs_theme && !needs_bypass) {
    return false;
  }

  const patched = {
    ...current,
    ...(needs_onboarding ? { hasCompletedOnboarding: true } : {}),
    ...(needs_theme ? { theme: target_theme } : {}),
    ...(needs_bypass ? { bypassPermissionsModeAccepted: true } : {}),
  };

  try {
    await writeFile(path, `${JSON.stringify(patched, null, 2)}\n`, "utf-8");
    console.log(
      `[claude-config] Patched onboarding fields in ${path}` +
        ` (onboarding=${String(needs_onboarding)}, theme=${String(needs_theme)}, bypass=${String(needs_bypass)})`,
    );
    return true;
  } catch (err) {
    console.warn(
      `[claude-config] Failed to patch onboarding fields in ${path}: ${String(err)} — continuing`,
    );
    return false;
  }
}

/** Run both fixes for a per-entity config dir. Idempotent and cached per
 * daemon process — the on-disk work runs at most once per (entity, config_dir)
 * pair per daemon lifetime. Subsequent calls are a no-op cache hit.
 *
 * Safe to call on every pool-bot spawn that resolves a per-entity config dir.
 */
export async function ensure_per_entity_config_dir_ready(
  entity_id: string,
  config_dir: string,
): Promise<void> {
  const key = `${entity_id}::${config_dir}`;
  if (prepared.has(key)) return;
  prepared.add(key);

  await migrate_entity_project_dirs(entity_id, config_dir);
  await ensure_onboarding_fields(config_dir);
}

/** Config-dir-aware version of `session_jsonl_exists_anywhere`. When
 * `config_dir` is provided, looks under `<config_dir>/projects/`; otherwise
 * falls back to `~/.claude/projects/`. */
export async function session_jsonl_exists_anywhere_in(
  config_dir: string | null,
  session_id: string,
): Promise<boolean> {
  const projects_root = config_dir
    ? join(config_dir, "projects")
    : join(homedir(), ".claude", "projects");
  const filename = `${session_id}.jsonl`;
  try {
    const entries = await readdir(projects_root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        await access(join(projects_root, entry.name, filename));
        return true;
      } catch {
        // not in this project dir
      }
    }
  } catch {
    // projects/ missing or unreadable — treat as "not found"
  }
  return false;
}
