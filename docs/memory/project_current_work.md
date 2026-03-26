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
- Design decisions captured: dynamic bot pool, channel-level scoping via access.json, LRU session management, separate contexts per channel
- Confirmed: access.json `groups` field accepts channel IDs (not server IDs) for per-channel bot scoping
- Confirmed: one bot + multi-channel = shared context (not suitable for isolation). Separate sessions needed per channel.
- Tested Gary bot in #general and work-room-1 with native Discord plugin — functional

## Next Steps

1. **Create Discord bot pool** — 10 generic bots (LF Agent 1-10). User creates in Developer Portal, stores tokens in 1Password. Daemon assigns dynamically.
2. **Implement bot pool manager** — daemon component that tracks pool state (free/assigned/parked), assigns bots to channels, handles LRU eviction, parks/resumes sessions.
3. **Work room management** — daemon tracks room status, pins status messages, auto-assigns features to rooms, releases on completion.
4. **Rework feature lifecycle** — Discord-first flow: planning in channels, approvals via Discord, no headless sessions. Features.ts updated to use pool manager instead of headless session spawning.
5. **PR review-merge cron** — daemon polls entity repos for open PRs, triggers review-merge SOP.
6. **Session tracking** — entity-level session history (`entities/{id}/sessions/`) for feature restore.

## What's Built and Working
- CLI: lf init, entity create/list, start/stop/status, update
- Daemon: HTTP API, session manager, task queue, feature lifecycle, Discord bot (daemon + Pat), router, persistence, scaffold/reload endpoints
- Commander (Pat): persistent Discord session in #command-center, full tool access
- Gary (test): persistent Discord session via pool bot, channel-scoped, confirmed working
- Discord: daemon bot (infrastructure) + Pat (command-center) + 1 test pool bot (Gary). Entity channels scaffolded.
- Skills: 4 DNA + 4 guidelines + 3 SOPs
- Rules: 4 global rules (secrets, git, collaboration, escalation)
- Blueprint: software blueprint
- Entities: lobster-farm (entity zero), bayview (first real entity)
- 116 tests passing
