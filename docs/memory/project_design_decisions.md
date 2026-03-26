---
name: Architecture design decisions
description: Key design decisions - entity isolation, governance, agent architecture, Discord model, feature lifecycle, session tracking, skill taxonomy
type: project
---

## Entity Isolation

**Entity isolation is structural via directory scoping, NOT worktrees.** Each Claude Code session spawns in a specific entity's workspace directory. The agent literally cannot see another entity's files. This is a significant advantage over instructional isolation ("don't cross-reference entities" in prompts).

**Worktrees are for parallel branch work within a single entity,** not for entity isolation. An entity's builder might have multiple worktrees for concurrent feature branches, but the entity boundary is the directory scope.

## Governance Model

Four layers, hardest to softest:

1. **Hard enforcement (universal, deterministic, no LLM):** Claude Code hooks block writes to main branch and hardcoded secrets. System enforces budget/concurrency/session lifecycle. Filesystem enforces entity isolation.
2. **Escalation rules (universal, agent judgment, in global CLAUDE.md):** Irreversible decisions, scope changes, genuine uncertainty, external actions, security decisions. Everything not listed: autonomous.
3. **Phase gates (blueprint-specific, SOP-driven):** Plan->Build requires human spec approval. Build->Review requires tests passing. Review->Ship requires reviewer approval. DNA evolution always requires human approval. These gates are defined per blueprint, not universally.
4. **Budget governance (universal):** Per-entity budgets with soft warnings (80%) and hard stops (100%). Human can override.

## SOP Engine Direction

**SOPs should eventually be YAML state machines, not hardcoded TypeScript.** Lobster (OpenClaw's workflow engine) already does what our SOP engine needs. Whether we use Lobster directly or build our own equivalent is an open decision, but the target representation is declarative YAML with deterministic `run:` steps, LLM `pipeline:` steps, and `approval:` gates.

## Daemon Installation & Entity Independence

**The daemon and CLI should be installable independently of any entity.** When published, users install via `npm install -g @lobster-farm/cli` — no repo clone needed. The daemon binary lives in the global npm install, and `~/.lobsterfarm/` is pure runtime state. The lobster-farm repo only exists as an entity for platform developers (entity zero). This means no entity deletion — including lobster-farm itself — can kill the running daemon.

**For the primary developer instance, the repo living inside the entity is fine.** But the launchd plist and daemon startup must reference the globally installed binary, not a path inside an entity directory. The monorepo's existing package structure (`packages/cli`, `packages/daemon`, `packages/shared`) already supports this — it's a publishing concern, not a restructuring one.

**Why:** During development, deleting the lobster-farm entity to test scaffolding nuked the daemon's source/build artifacts. This chicken-and-egg problem only exists because the daemon runs from inside an entity. OpenClaw solves this by separating state (`~/.openclaw/`) from code (global install or dev repo), with profile isolation (`OPENCLAW_PROFILE`) for parallel instances.

**How to apply:** When preparing for distribution, publish the three packages to npm. The launchd plist should point to the globally installed daemon binary. For development, support a `--dev` flag or equivalent that runs from the local repo instead.

## Discord Agent Architecture

**One Discord bot per archetype, not per channel or per session.** Each archetype (Gary, Bob, Pearl, Ray, Pat) has its own Discord bot application with its own token. The daemon manages which channels each bot is active in via `allowed_channels` in `access.json`. Only one agent is active per work room at a time — the daemon cycles them on phase transitions.

**Agent bots:** Pat (#command-center), Gary (#general + active planning rooms), Bob (active build rooms), Pearl (active design rooms), Ray (active infra rooms). Reviewer is ephemeral/headless — no bot needed.

**Daemon bot is separate** — handles infrastructure only (scaffolding, webhooks, status). Does not handle conversations.

**Sessions are persistent, not headless.** Each agent runs as a persistent Claude Code session with the Discord channel plugin (`--channels plugin:discord`). No `-p` headless sessions for conversational work. Agents can ask questions, users can interject mid-work. The daemon manages session lifecycle (start, stop, cycle on phase transition).

**One agent can handle multiple channels** in a single session (messages are tagged with channel context). Shared context within an entity is a feature — cross-pollination between #general and work room conversations helps.

**Why:** Headless sessions introduce latency (startup per message) and prevent real-time collaboration. The user is a collaborator, not just an approver. Agents should surface discoveries and ask questions naturally, not pause/resume.

## Channel Ownership

**#general** — Gary (planner) owns this channel. Discovery, brainstorming, "what should we build." Features spin out of conversations here into work rooms. Gary is the entity-level project manager.

**#work-room-N** — one feature per room, one active agent at a time. Phase determines which agent. Room has a pinned status message updated by the daemon:
- `🟢 Available`
- `🔵 Secret Scanning Hook — Plan`
- `🟡 Secret Scanning Hook — Build`

**#alerts** — notification inbox. Errors, cross-room pings, entity-level notifications. Not for conversation — go to the work room for that.

**#work-log** — read-only activity feed.

## Feature Lifecycle (Revised)

**Planning happens in Discord, not headless.** The GitHub issue is the OUTPUT of planning, not the input. You riff with Gary in #general or a work room. Gary does socratic discovery, creates the issue when the spec is ready, posts it in the work room. You approve in Discord.

**Two modes of building:**
1. **Collaborative** — you and an agent riff together, step by step (like a pair programming session). No strict phase handoffs. The agent in the room stays for the duration.
2. **Autonomous** — clear spec, well-scoped feature. Gary plans, you approve, Bob builds independently, reviewer reviews. Clean handoffs between phases.

**Approvals happen in Discord, not GitHub.** The spec is posted in the work room. You approve right there. GitHub issues/PRs are record-keeping artifacts, not the user's interface.

**Agents are collaborators, not task executors.** During any phase, agents should surface discoveries that could affect decisions. Plans drift during implementation — new information should be communicated, not suppressed. This applies to ALL agents, not just builders.

**Planner gets coding-dna** for technical features (composable DNA). Planning-dna + coding-dna when the spec involves implementation decisions.

## PR Review-Merge (Independent SOP)

**Review is decoupled from the feature lifecycle.** Any PR on any entity repo triggers the review-merge SOP — whether from the feature lifecycle, a manual push, or external contributor.

**Triggered by cron** — daemon polls repos for open PRs. When found, spawns reviewer. Review → fix → re-review loop until clean. Merge with squash. Escalate conflicts if non-trivial rebase.

**Leverages Claude Code's built-in /review and /simplify** commands. Bob runs /simplify before pushing (less noise for reviewer). Reviewer uses /review for comprehensive analysis plus review-guideline for our standards.

## Work Room Management

**Daemon tracks room status** — which rooms are free, which are assigned to features. Stored in daemon state. Pinned status message in each room updated on assignment/release.

**Auto-assignment** — when a feature needs a room, daemon grabs the next free one. If all occupied, create overflow channel.

**Entity scaffold creates rooms with pinned "Available" status** during initial setup.

## Session Tracking

**Sessions tracked at entity level** — `entities/{id}/sessions/{feature-id}.json` with session history (session_id, archetype, started_at, ended_at, work_room). Enables "show me all sessions for feature X" and session restore.

**Why:** Lost session context is expensive. At the start of a session, 30+ minutes were spent recovering context from a previous session in a different project directory. Entity-scoped session tracking prevents this.

## Skill Taxonomy

Five types, each with a distinct loading behavior:

| Type | Loading | Purpose | Example |
|------|---------|---------|---------|
| **DNA** | Auto-load by task match | Creative/expertise lenses | coding-dna, design-dna, planning-dna |
| **Guidelines** | Auto-load by task match | Operational requirements | secrets-guideline, review-guideline, readme-guideline, discord-guideline |
| **SOPs** | Auto-load by task match | Step-by-step procedures with gates | entity-scaffold, feature-lifecycle, pr-review-merge |
| **Rules** | Always loaded | Universal constraints | secrets rules, git rules, escalation rules |
| **Commands** | Explicitly invoked with / | Specific actions | (future, as patterns emerge) |

**review-dna was renamed to review-guideline** — review standards are operational requirements, not a creative lens. DNA is for style/expertise that would change if the tech stack changed. Guidelines are operational requirements that apply regardless of stack.

**Rules live in `~/.claude/rules/`** (global) or `.claude/rules/` (per-repo). Always loaded, no auto-match needed. For constraints that should NEVER be skipped — secrets handling, git conventions, escalation policy. Currently these live in CLAUDE.md — should be extracted to rules for modularity.

## Other Decisions

**GitHub accounts are per-entity, not global.** Different GitHub orgs/accounts for different entities. GitHub config belongs in entity config, not tools.md.

**Shared services vault pattern.** Some services (Vercel, Sentry, domain registrar) operate at account level managing multiple entities. Master 1Password vault (`lobsterfarm`) for shared services, per-entity vaults (`entity-{id}`) for entity-specific secrets.

**user.md has no contact info.** Contact details don't belong in the user profile. Account identifiers go in tools.md (shared) or entity config (per-entity).

**Sudo and permissions are setup steps, not defaults.** The setup wizard configures or guides through these.

**Why:** These decisions establish the structural guarantees that make the system trustworthy. Structural isolation beats instructional. Declarative SOPs beat hardcoded workflows. Clear vault boundaries prevent secret leakage.

**How to apply:** Entity config schema needs an `accounts` section for GitHub org, repo URL, and entity-specific service accounts. SOP implementation should target YAML representation even if initially implemented in TypeScript.
