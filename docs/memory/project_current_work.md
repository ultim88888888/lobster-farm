---
name: Current work and next steps
description: Active work items and immediate next steps as of 2026-03-25
type: project
---

## Completed

**Pat on Discord via Claude Code Channels — DONE (2026-03-22)**
Persistent Claude Code session connected to Discord #command-center via native channel plugin. Tested and working. Daemon manages lifecycle (spawn in tmux, health check, restart on crash).

**Architecture docs written (2026-03-24)**
Comprehensive architecture documentation at `docs/architecture/`.

**Entity scaffolding SOP + Discord guide skill — DONE (2026-03-25)**
- Entity scaffold SOP as a Claude Code skill (`entity-scaffold/SKILL.md`)
- Discord guide skill for server management (`discord-guide/SKILL.md`)
- Software blueprint at `~/.lobsterfarm/blueprints/software/blueprint.yaml`
- Entity config schema updated: blueprint reference + sop/guideline overrides
- Guidelines established as distinct skill type (separate from DNA)

**Setup wizard fully automated (2026-03-25)**
`lf init` now handles: bun, tmux, gh CLI, Discord plugin install, two bot tokens, Pat's access.json.

## NEXT SESSION: Repo location cutover

**The repo must move from `~/.lobsterfarm/src/` to `~/entities/lobster-farm/lobster-farm/`.**

LobsterFarm is entity zero. Its repo should live where any entity's repo lives — under the entity directory, not inside the instance root. Currently the repo is at `~/.lobsterfarm/src/` which conflates instance runtime with platform source.

Steps:
1. Stop daemon and Pat (`kill` daemon pid, `tmux kill-session -t pat`)
2. Move the repo: `mv ~/.lobsterfarm/src ~/entities/lobster-farm/lobster-farm`
3. Update entity config repo path: `~/.lobsterfarm/entities/lobster-farm/config.yaml` → `path: ~/entities/lobster-farm/lobster-farm`
4. Update symlink: already points to the right place if we move correctly
5. Update any hardcoded references to `~/.lobsterfarm/src/` in daemon code, CLI, or config
6. Start a new Claude Code session in the new repo location
7. Restart daemon and verify Pat comes back up
8. Verify auto memory symlink still works (currently `~/.claude/projects/-Users-farm--lobsterfarm-src/memory` → may need re-symlinking since the project path hash changes)

**Risk:** Everything referencing `~/.lobsterfarm/src/` breaks — daemon process, Pat's cwd, Claude Code project scoping, auto memory path hash. Must be done cleanly with everything stopped.

## What's Built and Working
- CLI: lf init (fully automated), entity create/list, start/stop/status, update
- Daemon: HTTP API, session manager, task queue, feature lifecycle, Discord bot, router, persistence
- Commander (Pat): persistent Discord session via Claude Code channels, full tool access
- Discord: two-bot architecture, entity channels, webhooks, channel scaffolding
- Skills: 5 DNA + discord-guide + entity-scaffold
- Blueprint: software blueprint defined
- 62 tests passing

## After Cutover
1. Test entity scaffold SOP with Pat — scaffold a real external entity
2. Feature lifecycle end-to-end — run a feature through plan, build, review, ship
3. Create first guideline skills (secrets-guideline, sentry-guideline)

## Future (not started)
- YAML-based SOP engine (currently hardcoded TypeScript)
- Daemon reload endpoint (hot-reload entity registry without restart)
- Entity-level orchestrator (open question)
- Embedding-powered semantic search for memory
- Web dashboard
- Interactive sessions for entity agents

**How to apply:** Next session starts with the repo cutover. Stop everything, move the repo, fix references, restart. Then continue with entity scaffolding and feature lifecycle.
