# Shared Source

Types, schemas, constants, and utilities shared between the daemon and CLI packages. This is the single source of truth for data shapes and path resolution across the monorepo.

## Files

- `index.ts` -- Re-exports everything from schemas, paths, template, yaml, and constants.
- `constants.ts` -- Archetype defaults (name, model, think level, DNA), phase transition map, default SOPs, channel type descriptions, daemon port (`7749`), and launchd label.
- `paths.ts` -- All path resolution functions. Global paths (`~/.lobsterfarm/`, `~/.claude/`), LobsterFarm subdirectories (entities, logs, sops, queue, scripts, templates), Claude subdirectories (agents, skills, settings), and per-entity paths (config, memory, daily, context, files, repos, worktrees). Accepts optional `PathConfig` overrides for testing.
- `template.ts` -- Mustache-style template engine. Resolves `{{KEY}}` placeholders and `{{#BLOCK}}...{{/BLOCK}}` regions. Used by `lf init` to generate config files from templates.
- `yaml.ts` -- YAML utilities. Load, parse, and write YAML files with Zod schema validation.

### schemas/

Zod schemas that define the shape of all configuration and runtime data.

- `index.ts` -- Re-exports all schema modules.
- `enums.ts` -- Enumeration types: `ArchetypeRole`, `ChannelType`, `EntityStatus`, `AgentMode`, `ModelName`, `ThinkLevel`, `RepoStructure`, `Priority`.
- `config.ts` -- `LobsterFarmConfigSchema`. Global config shape: version, paths, concurrency limits, default model tiers per task type, Discord settings, user info, machine info, and agent names.
- `entity.ts` -- `EntityConfigSchema`. Per-entity config shape: identity, status, blueprint, repos, accounts (GitHub/Vercel/Sentry), Discord channels, memory settings, SOP/guideline overrides, and secrets vault.
- `queue.ts` -- `QueuedTaskSchema`. Task queue entry: entity, feature, archetype, DNA, model, prompt, priority, status, and completion metadata.
- `template.ts` -- `TemplateVariablesSchema`. All `{{PLACEHOLDER}}` keys used in config templates: user info, GitHub credentials, machine details, agent names (title case and lowercase), and block content.
