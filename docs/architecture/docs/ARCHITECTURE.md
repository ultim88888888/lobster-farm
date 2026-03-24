# Architecture

System design for LobsterFarm. How the pieces fit together.

---

## System Overview

LobsterFarm has three distinct concerns:

**Execution:** Actually doing work — writing code, creating designs, reviewing PRs. This is Claude Code (for coding) and potentially other tools for other work types.

**Orchestration:** Managing WHAT gets done, by WHOM, in WHAT order. Handling handoffs between phases, running SOPs, tracking progress across entities. This is the orchestrator.

**Interaction:** How Jax communicates with agents. Direct conversation via terminal, Discord, Telegram, or other channels. Jax is the front door — the orchestrator is background infrastructure.

```
┌──────────────────────────────────────────────────┐
│                 INTERACTION                       │
│                                                  │
│   Terminal (direct Claude Code sessions)         │
│   Discord / Telegram (messaging)                 │
│   Dashboard / UI (visibility, future)            │
│                                                  │
│   You talk directly to agents.                   │
│   You can drop into any running process.         │
└─────────────────────┬────────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────────┐
│              ORCHESTRATION                        │
│              (background coordinator)            │
│                                                  │
│   Routes work to the right agent                 │
│   Manages autonomous build loops                 │
│   Runs deterministic SOPs                        │
│   Tracks cross-entity status                     │
│   Enforces budgets and governance                │
│   Handles agent handoffs                         │
│                                                  │
│   Implementation: TBD (see Open Decisions)       │
└─────────────────────┬────────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────────┐
│               EXECUTION                           │
│                                                  │
│   Claude Code — coding, file ops, git, testing   │
│   Other tools — as needed per task type           │
│                                                  │
│   Agents load: archetype + DNA + entity memory   │
│   Work in entity-scoped worktrees                │
└──────────────────────────────────────────────────┘
```

## Archetype System

Three components define an agent:

**Soul** (WHO) — Personality, values, approach. Lives in the archetype definition. Shared across all entities.

**DNA** (HOW) — Domain expertise lens. Standards, patterns, anti-patterns. Composable — multiple DNAs can be loaded per session. Lives as skills. Shared across all entities.

**Memory** (WHAT IT KNOWS) — Entity-specific accumulated knowledge. Lives in the entity layer. Unique per agent instance.

```
Archetype (command layer)     Agent (entity layer)
┌──────────────────────┐      ┌──────────────────────┐
│ Soul: Pearl           │      │ Soul: Pearl           │
│ DNA: design-dna       │  →   │ DNA: design-dna       │
│                       │      │ Memory: Entity Alpha  │
│ (template)            │      │ (instance)            │
└──────────────────────┘      └──────────────────────┘
```

## Governance

Four layers, from hardest to softest:

**Layer 1 — Hard enforcement (deterministic, no LLM):**
- Claude Code hooks block: writes to main branch, hardcoded secrets
- System enforces: budget limits, concurrency limits, session lifecycle
- Filesystem enforces: entity isolation (sessions in entity worktrees)

**Layer 2 — Escalation rules (agent judgment, in global CLAUDE.md):**
- Irreversible decisions (migrations, API contract changes)
- Scope changes from what was spec'd
- Genuine uncertainty between valid approaches
- External actions (production, emails, public posts, spending money)
- Security decisions (auth, permissions, encryption)
- Everything not listed: autonomous, use judgment, move fast

**Layer 3 — Phase gates (SOP-driven):**
- Plan → Build: requires human approval of spec
- Build → Review: requires tests passing
- Review → Ship: requires reviewer approval
- DNA evolution: always requires human approval

**Layer 4 — Budget governance:**
- Per-entity budgets with soft warnings (80%) and hard stops (100%)
- Human can override at any time

## Tool Routing (Open Design Problem)

Not all work is coding. Different work types benefit from different tools:

| Work Type | Best Tool | Why |
|-----------|-----------|-----|
| Feature implementation | Claude Code | Codebase awareness, file ops, git, testing |
| Code review | Claude Code | Needs to read the actual code |
| Planning with codebase context | Claude Code (plan mode) | Reads existing code to inform the plan |
| Planning without codebase context | Conversational (any chat) | Pure reasoning and dialogue |
| Design exploration | Conversational → Claude Code | Starts as creative conversation, becomes coded prototype |
| Research | Either | Depends on whether codebase is relevant |
| Project management | Orchestrator | Status, routing, cross-entity coordination |

The routing question: WHO decides which tool handles which task? Options:

1. **Human decides** — You pick the right tool for the moment. Simple but you're the bottleneck.
2. **Orchestrator decides** — Deterministic routing rules. More autonomous but requires building the routing logic.
3. **Single platform, mode switching** — Everything in Claude Code with different agent profiles and modes. Simplest architecture but depends on Claude Code being sufficient for non-coding work.

This is the most important open design problem. The answer will likely be a hybrid that evolves over time.

## MCP as Shared Protocol

Both Claude Code and OpenClaw use MCP (Model Context Protocol) for tool integration. This means:

- MCP servers configured once work with either platform
- GitHub, Linear, Slack, 1Password, and hundreds of other integrations available via MCP
- If the orchestration platform changes, MCP integrations remain portable
- Custom MCP servers can be built for LobsterFarm-specific needs

## Entity Isolation

Entity isolation is **structural, not instructional.** Each Claude Code session is spawned in a specific entity's worktree. The agent literally cannot see another entity's files because it's not running in that directory.

This is a significant advantage over systems that rely on telling agents "don't cross-reference entities" in their prompts. Structural isolation can't be accidentally ignored.

## Memory Architecture

**Single MEMORY.md per entity. No vector store at launch.**

- MEMORY.md: long-term curated knowledge (<200 lines). Read every session.
- daily/ logs: session summaries. Staging area for MEMORY.md promotion.
- context/ docs: architecture, decision logs, deeper reference material.

Memory lifecycle: daily logs accumulate → periodic review → promote important items to MEMORY.md → archive old logs.

If MEMORY.md outgrows 200 lines: split into MEMORY.md (index) + topic files in context/.

No global memory for archetypes. Universal learnings improve DNA via the evolution pipeline.

---

## Open Decisions

See [STATUS.md](STATUS.md) for the full list of open decisions with context on each.
