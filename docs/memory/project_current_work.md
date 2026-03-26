---
name: Current work and next steps
description: Active work items and immediate next steps as of 2026-03-25
type: project
---

## Completed (2026-03-25)

- Pat on Discord, architecture docs, setup wizard
- Repo location cutover (entities inside instance)
- Entity scaffolding tested e2e (lobster-farm + bayview)
- Daemon endpoints: POST /scaffold/entity, POST /reload
- Schema: repos array, channels with category_id, dropped budget/agent_mode/models/active_sops
- Guidelines: secrets, readme, discord, review (renamed from review-dna)
- SOPs: entity-scaffold, feature-lifecycle, pr-review-merge
- Rules extracted to ~/.claude/rules/ (secrets, git, collaboration, escalation)
- Feature lifecycle tested — discovered and fixed: planner auto-spawn on feature creation, stdin prompt piping, --verbose flag requirement
- Design decisions captured: agent-per-archetype bot model, work room management, channel ownership, session tracking, skill taxonomy

## Next Steps

1. **Create Discord bots** — one per archetype (Gary, Bob, Pearl, Ray). User creates in Developer Portal, stores tokens in 1Password. Daemon manages lifecycle.
2. **Implement interactive agent sessions** — daemon spawns agents in tmux with Discord channel plugin, manages allowed_channels per work room, cycles agents on phase transitions.
3. **Work room management** — daemon tracks room status, pins status messages, auto-assigns features to rooms, releases on completion.
4. **PR review-merge cron** — daemon polls entity repos for open PRs, triggers review-merge SOP.
5. **Session tracking** — entity-level session history for feature restore.
6. **Rework feature lifecycle code** — update features.ts to match the new flow (Discord-first approvals, work room assignment, no headless planning).

## What's Built and Working
- CLI: lf init, entity create/list, start/stop/status, update
- Daemon: HTTP API, session manager (headless — needs interactive upgrade), task queue, feature lifecycle, Discord bot, router, persistence, scaffold/reload endpoints
- Commander (Pat): persistent Discord session, full tool access
- Discord: two-bot architecture + planned archetype bots, entity channels, webhooks, channel scaffolding
- Skills: 4 DNA + 4 guidelines + 3 SOPs
- Rules: 4 global rules (secrets, git, collaboration, escalation)
- Blueprint: software blueprint
- Entities: lobster-farm (entity zero), bayview (first real entity)
- 116 tests passing
