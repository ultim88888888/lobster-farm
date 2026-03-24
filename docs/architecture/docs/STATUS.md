# Project Status

What exists, what's designed, what's planned, and what's still open.

---

## Designed & Documented (Ready to Implement)

These have been designed in detail through extensive architectural discussion. Specifications exist.

- **Archetype definitions** — 5 archetypes (planner, designer, builder, reviewer, operator) with souls, identities, and frontmatter. Files produced and ready to install.
- **DNA profiles** — 5 DNA skill files. coding-dna (~710 lines, ported from battle-tested CODE-DNA.md) and design-dna (~778 lines, ported from battle-tested DESIGN-DNA.md) are production-quality. planning-dna, review-dna, and database-dna are new and solid but less battle-tested.
- **Global CLAUDE.md** — Shared soul foundation, session startup, role map, universal rules, escalation triggers. Written and ready to install.
- **USER.md** — About Jax. Preferences, communication style, frustrations. Written and ready.
- **TOOLS.md** — Machine infrastructure. Minimal, grows organically. Written and ready.
- **Two-layer architecture** — Command layer / entity layer model fully designed with clear boundaries.
- **Terminology** — All key terms defined with litmus tests for resolving ambiguity.
- **File boundary map** — What content goes in which file. Litmus tests for every file type. 11 file types mapped with "no homeless content" rule.
- **Interaction model** — Direct agent access + background orchestration + drop-in ability.
- **Autonomous build loop** — Plan → build → review → test → loop → present → approve → merge.
- **Governance model** — 4 layers: hooks (hard enforcement), escalation rules (agent judgment), phase gates (SOP-driven), budgets (system-managed).
- **Entity model** — Config structure, memory layout, daily logs, context hierarchy.

## Built in Claude Code (Needs Review)

Code has been built in Claude Code sessions, but WITHOUT DNA, souls, or the full LobsterFarm context loaded. This code needs to be reviewed against the architecture designed in this document set to check for alignment or drift.

- Status of what was built needs to be assessed by reviewing the actual codebase.

## Not Yet Built

- **Orchestrator / daemon** — The background coordinator. Design exists but implementation approach is still open (custom Node.js service vs leveraging existing tools vs hybrid).
- **SOPs as code** — Feature lifecycle, PR review, entity scaffolding, Sentry triage, README maintenance, DNA evolution. Designed as YAML state machines but not implemented. Could use Lobster, custom engine, or other approach.
- **Blueprints** — Entity scaffolding templates. Concept defined but no concrete blueprints written yet.
- **Communication channels** — Discord/Telegram integration. Whether via Claude Code Channels, OpenClaw gateway, custom bot, or other approach is still open.
- **Dashboard / UI** — Cross-entity visibility. No implementation chosen. Could be custom web app, Paperclip, or agent-generated reports.
- **Entity zero** — LobsterFarm managing itself as its first entity.

## Open Decisions

These are architectural decisions that are intentionally deferred. Each has been discussed but not committed to.

**Orchestration platform:** Custom daemon vs OpenClaw + Lobster vs Paperclip vs hybrid vs something else. Each has tradeoffs documented in the architecture discussion. The decision should be driven by real friction after testing, not by speculation.

**Messaging platform:** Claude Code Channels (4 days old, research preview) vs OpenClaw gateway (battle-tested, 25+ channels) vs custom bot vs combination. Needs testing.

**Project management:** GitHub Issues (free, CLI-native) vs Linear (MCP server, Symphony pattern, 25K+ companies) vs custom dashboard vs combination.

**Routing between conversation and code:** When planning requires codebase context, how does the system transition from conversational mode to Claude Code's plan mode? When the plan is done, how does it transition to build? This is the "glue" problem — the most novel thing to solve.

**OpenClaw's role:** Options range from "primary orchestration layer" to "not used at all" to "used for non-coding tasks only." The existing OpenClaw instance works but feels fragile. Maintaining DNA/soul files in both OpenClaw and Claude Code workspaces is possible but creates drift risk.

---

*Update this document as decisions are made and work is completed.*
