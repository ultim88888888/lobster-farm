# Per-Entity Claude Max Subscriptions

## What This Does

By default, all entities share a single Claude Max subscription -- whichever OAuth credentials exist in `~/.claude`. This creates two problems:

1. **Billing** -- no way to attribute costs to individual entities/products
2. **Rate limits** -- one busy entity can starve another

This feature adds an optional `subscription.claude_config_dir` field to entity config. When set, the daemon injects `CLAUDE_CONFIG_DIR=<path>` into session environments at spawn time. Each config directory is fully isolated -- separate OAuth login, separate session state, separate rate limits.

## How CLAUDE_CONFIG_DIR Works

Claude Code supports `CLAUDE_CONFIG_DIR`, an environment variable that overrides where the CLI looks for all config, credentials, and state. When set, the CLI uses `$CLAUDE_CONFIG_DIR` instead of `~/.claude` for:

- OAuth credentials (the auth token for Claude Max)
- Session state (conversation history, JSONL files)
- Settings and configuration

Each directory is fully isolated. Two sessions with different `CLAUDE_CONFIG_DIR` values use completely separate accounts.

## Entity Config

Add a `subscription` block to the entity's `config.yaml`:

```yaml
entity:
  id: my-entity
  name: My Entity
  # ... other fields ...

  subscription:
    claude_config_dir: ~/.lobsterfarm/entities/my-entity/.claude-config
```

When this field is set, all sessions spawned for this entity (both queue-spawned and pool bot sessions) will have `CLAUDE_CONFIG_DIR` set to the specified path. When omitted, sessions use the default `~/.claude` -- no behavior change.

## One-Time Setup for a New Subscription

### 1. Create the config directory

```bash
mkdir -p ~/.lobsterfarm/entities/my-entity/.claude-config
```

### 2. Authenticate with Claude Max

```bash
CLAUDE_CONFIG_DIR=~/.lobsterfarm/entities/my-entity/.claude-config claude auth login
```

This opens a browser for OAuth and stores the credentials in the config directory.

### 3. Symlink shared config files

Global instructions (CLAUDE.md, rules, settings, agents) should be shared across all subscriptions. Symlink them from the default `~/.claude`:

```bash
cd ~/.lobsterfarm/entities/my-entity/.claude-config

# Shared global instructions
ln -s ~/.claude/CLAUDE.md CLAUDE.md
ln -s ~/.claude/rules rules
ln -s ~/.claude/settings.json settings.json
ln -s ~/.claude/agents agents
ln -s ~/.claude/skills skills
```

This way, auth is isolated (each entity uses its own Claude Max account) but global instructions and agent definitions are shared.

### 4. Add to entity config

Edit `~/.lobsterfarm/entities/my-entity/config.yaml`:

```yaml
entity:
  # ... existing fields ...
  subscription:
    claude_config_dir: ~/.lobsterfarm/entities/my-entity/.claude-config
```

### 5. Restart the daemon

```bash
lf stop && lf start
```

The daemon reads entity configs at startup. After restart, all new sessions for this entity will use the configured subscription.

## What's Shared vs. Isolated

| Component | Shared or Isolated | How |
|-----------|-------------------|-----|
| OAuth credentials | **Isolated** | Each config dir has its own auth token |
| Session state | **Isolated** | JSONL files live in each config dir |
| CLAUDE.md | **Shared** | Symlinked from ~/.claude |
| rules/ | **Shared** | Symlinked from ~/.claude |
| settings.json | **Shared** | Symlinked from ~/.claude |
| agents/ | **Shared** | Symlinked from ~/.claude |
| skills/ | **Shared** | Symlinked from ~/.claude |

## Architecture

The injection happens at two points in the daemon:

1. **Queue sessions** (`session.ts`) -- When `ClaudeSessionManager.spawn()` is called, it looks up the entity's config via the registry. If `subscription.claude_config_dir` is set, `CLAUDE_CONFIG_DIR` is added to the env dict passed to `child_process.spawn()`.

2. **Pool bot sessions** (`pool.ts`) -- When a pool bot is assigned, resumed, or crash-recovered, the daemon resolves `subscription.claude_config_dir` and adds it to `extra_env`. This gets injected both as a tmux command-string prefix (for the tmux session environment) and in the `spawn()` env object.

Both paths log which config directory is being used at spawn time.

### First-launch preparation (issue #327)

Before any pool-bot spawn under a per-entity `claude_config_dir`, the daemon
runs two idempotent fixes to make `--resume` and the interactive TUI work
cleanly. Both happen automatically — no manual setup is required beyond
`claude auth login`. The work runs at most once per `(entity, config_dir)`
pair per daemon process and is cached in memory thereafter.

1. **Session JSONL migration.** Claude Code stores session transcripts at
   `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<session-id>.jsonl`. Sessions
   that were originally written under the default `~/.claude` (before the
   entity switched to a per-entity sub) are invisible to the new config dir,
   so `--resume` would silently drop the bot into the onboarding wizard.

   On first launch, the daemon mirrors every project dir under
   `~/.claude/projects/` whose slug contains the entity_id into
   `<config_dir>/projects/`. Existing destination dirs are preserved
   (`cp -rn` semantics) so the migration is safe to re-run.

2. **Onboarding-completion patch.** A freshly-authed config dir has
   `oauthAccount` populated but `hasCompletedOnboarding`, `theme`, and
   `bypassPermissionsModeAccepted` are all unset. Headless `-p` mode skips
   onboarding, but pool bots launch interactively (TUI) and would stall on
   the first picker.

   On first launch, the daemon patches `<config_dir>/.claude.json` to set
   the three idle-bypass fields. Only missing/falsy fields are written —
   existing user preferences are preserved. The theme is sourced from the
   user's primary `~/.claude.json` with `dark-ansi` as fallback.
   `oauthAccount` is never touched.

3. **Config-dir-aware JSONL guard.** The existing "drop --resume when the
   transcript is missing" guard (issue #256) is now config-dir-aware. For
   entities with `subscription.claude_config_dir` set, the guard looks in
   `<config_dir>/projects/` instead of `~/.claude/projects/`. If the JSONL
   is genuinely missing even after the migration, the daemon drops `--resume`
   and spawns a fresh session — avoiding the wedge while sacrificing one
   session's continuity (recoverable; daemon-crash on recycle is not).

Both fixes fail open: any I/O error is logged and execution continues. The
worst case is one bot losing session context — the daemon never hard-crashes
on a recycle because of these helpers.

Legacy entities that were manually migrated before issue #327 landed
(canal-street, sonar) don't need any change. The new code is idempotent and
will no-op against the already-prepared dirs.

## Troubleshooting

### Verify which subscription a session is using

Check the daemon logs at spawn time. You'll see one of:

```
[session] Using CLAUDE_CONFIG_DIR=/path/to/.claude-config for my-entity
[session] Using default ~/.claude config for my-entity
```

Or for pool bots:

```
[pool] Assigning pool-3 with CLAUDE_CONFIG_DIR=/path/to/.claude-config (entity: my-entity)
```

### Auth expired or invalid

If a session fails because the auth token in the config directory is expired:

```bash
CLAUDE_CONFIG_DIR=~/.lobsterfarm/entities/my-entity/.claude-config claude auth login
```

### Config directory doesn't exist

The daemon does not validate that the config directory exists at startup. If the directory is missing, Claude CLI will fail at session startup. Create the directory and authenticate before adding it to entity config.

### Symlinks broken after moving directories

If you move the entity or the default `~/.claude` directory, symlinks will break. Re-create them pointing to the new locations.
