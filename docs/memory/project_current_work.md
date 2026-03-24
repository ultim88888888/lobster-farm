---
name: Current work and next steps
description: Active work items and immediate next steps as of 2026-03-24
type: project
---

## Completed

**Pat on Discord via Claude Code Channels — DONE (2026-03-22)**
Persistent Claude Code session connected to Discord #command-center via native channel plugin. Tested and working.

Architecture:
- Pat's bot: separate Discord application, connected via `claude --channels plugin:discord@claude-plugins-official`
- Daemon bot: unchanged, handles entity channel routing, `!lf` commands, webhooks
- Daemon role for Pat: lifecycle only (spawn, health check, restart on crash)
- Pat queries daemon API (`http://localhost:7749`) for system state on demand
- Access control: `~/.lobsterfarm/channels/pat/access.json`
- Pseudo-TTY via tmux since `--channels` needs interactive mode

**Architecture docs written (2026-03-24)**
Comprehensive architecture documentation produced in browser session: README, TERMINOLOGY, STATUS, FILE-STRUCTURE, ARCHITECTURE, AGENT-FILES, RESEARCH. Now at `docs/architecture/`.

## What's Built and Working
- CLI: lf init, entity create/list, start/stop/status, update
- Daemon: HTTP API, session manager, task queue, feature lifecycle, Discord bot, router, persistence
- Commander (Pat): persistent Discord session via Claude Code channels, full tool access, real conversation
- Discord: two-bot architecture (daemon bot + Pat bot), entity channels, webhooks, channel scaffolding
- 62 tests passing
- Discord plugin installed: `discord@claude-plugins-official`

## Immediate Next Steps
1. Entity scaffolding SOP — define the process for standing up a new entity
2. First real entity — scaffold it through Pat in #command-center
3. Feature lifecycle end-to-end — run a feature through plan, build, review, ship

## Future (not started)
- Blueprint system (entity config inheritance)
- YAML-based SOP engine (currently hardcoded TypeScript)
- Embedding-powered semantic search for memory
- Pre-compaction memory flush
- Web dashboard
- Interactive sessions for other agents (not just Commander)

**How to apply:** Next session should focus on entity scaffolding SOP, then first real entity, then feature lifecycle end-to-end.
