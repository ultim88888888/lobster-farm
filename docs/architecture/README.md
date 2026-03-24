# LobsterFarm

An autonomous software consultancy platform. One developer, multiple businesses, specialized AI agents, deterministic workflows.

---

## What This Is

LobsterFarm manages multiple software projects (entities) with specialized AI agents that plan, design, build, review, and operate. The system is designed so that improving a shared component (an archetype, a DNA profile, an SOP) instantly improves every entity that uses it.

The core thesis: Claude is capable of excellent work across every phase of software development. What it lacks out of the box is **structure** — the institutional knowledge, workflows, quality standards, and isolation boundaries that make a real consultancy reliable. LobsterFarm provides that structure.

## How It Works (Interaction Model)

**You talk directly to agents.** There is no mandatory middleman. If you want to fix a bug, you talk to the builder. If you want to riff on brand colors, you talk to the designer. If you want to plan a feature, you talk to the planner.

**Autonomous work happens in the background.** When you kick off a feature build and walk away, the system handles build → review → test → loop without you. You get pinged for approvals and questions. You can drop into any running process at any time to steer.

**The orchestrator is a background coordinator, not a front door.** It manages handoffs between agents, runs deterministic workflows, tracks progress across entities, and handles the plumbing. Most of the time, you don't interact with it directly — you interact with the agents it manages.

**Approval gates are lightweight.** Across 10 entities, approving a step takes 30 seconds. The system does the work; you make the decisions.

## Terminology

See [docs/TERMINOLOGY.md](docs/TERMINOLOGY.md) for the complete reference. Quick summary:

| Term | Definition |
|------|-----------|
| **Entity** | An isolated business/project. Has its own codebase(s), documents, workflows, and agents. |
| **Archetype** | An agent template — NOT an agent itself. Defines soul + default DNA. Lives in the command layer. |
| **Soul** | A component of an archetype. Personality, preferences, how it thinks. |
| **DNA** | A composable expertise lens. Design preferences, coding standards, review criteria. Called upon by archetypes. |
| **Agent** | An entity-level instance created from an archetype. Has its own memory. This is what actually does work. |
| **Memory** | What separates an agent from its archetype. Entity-specific accumulated knowledge. |
| **SOP** | Standard Operating Procedure. Can be a deterministic workflow OR a best-practices document. Guidelines entities follow. |
| **Blueprint** | The structure an entity follows. Defines which SOPs apply, channel layouts, scaffolding patterns. |

## Two-Layer Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    COMMAND LAYER (shared)                        │
│                                                                 │
│  Everything shared across entities. All public information.     │
│                                                                 │
│  ┌────────────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌───────────┐      │
│  │ Archetypes │ │Souls │ │ DNAs │ │ SOPs │ │Blueprints │      │
│  └────────────┘ └──────┘ └──────┘ └──────┘ └───────────┘      │
│                                                                 │
│  Improve a DNA → every entity benefits                         │
│  Add an SOP → every entity follows it                          │
│  Refine an archetype → every agent inherits it                 │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                    ENTITY LAYER (scoped)                         │
│                                                                 │
│  Entity-specific information. Where agents live.                │
│                                                                 │
│  ┌─────────────────────────┐  ┌─────────────────────────┐      │
│  │ Entity: Alpha           │  │ Entity: Beta            │      │
│  │                         │  │                         │      │
│  │ ┌─────────┐ ┌────────┐ │  │ ┌─────────┐ ┌────────┐ │      │
│  │ │ Agents  │ │ Memory │ │  │ │ Agents  │ │ Memory │ │      │
│  │ │(from    │ │(entity │ │  │ │(from    │ │(entity │ │      │
│  │ │archetypes)│specific)│ │  │ │archetypes)│specific)│ │      │
│  │ └─────────┘ └────────┘ │  │ └─────────┘ └────────┘ │      │
│  │ ┌──────────────────┐   │  │ ┌──────────────────┐   │      │
│  │ │ Codebase(s)      │   │  │ │ Codebase(s)      │   │      │
│  │ │ Documents        │   │  │ │ Documents        │   │      │
│  │ │ Entity config    │   │  │ │ Entity config    │   │      │
│  │ └──────────────────┘   │  │ └──────────────────┘   │      │
│  └─────────────────────────┘  └─────────────────────────┘      │
│                                                                 │
│  Agents are scoped. Memory is scoped. No cross-contamination.  │
└─────────────────────────────────────────────────────────────────┘
```

## Archetypes

| Archetype | Name | Primary DNA | Role |
|-----------|------|-------------|------|
| Planner | Gary | planning-dna | Specs, architecture, project scoping, socratic discovery |
| Designer | Pearl | design-dna | Brand kits, design systems, component libraries, visual exploration |
| Builder | Bob | coding-dna | Feature implementation, backend, frontend, testing |
| Reviewer | (unnamed) | review-dna | Code review — always ephemeral, always fresh eyes |
| Operator | Ray | operator-dna | Infrastructure, CI/CD, deployment, monitoring |

DNA is composable. The builder can load `coding-dna + design-dna` for frontend work, or `coding-dna + database-dna` for schema work.

## Design Principles

1. **You are the front door.** Direct access to any agent, any time. The orchestrator coordinates in the background.
2. **Determinism for process, intelligence for work.** Workflows and routing are code. Creative and analytical work is LLM.
3. **Autonomy with circuit breakers.** Agents work independently by default. Escalation thresholds determine when to ask you.
4. **Same brain, different lenses.** Specialization comes from DNA layered onto archetypes. All agents share a soul foundation.
5. **Entity isolation is structural.** Agents can't see other entities' data because they're scoped to their entity's workspace.
6. **Modular and replaceable.** Components can be swapped independently. New archetypes, SOPs, DNA, tools, and entities added without modifying core.
7. **The system builds itself.** LobsterFarm is entity zero. Its agents build and improve the platform.
8. **Not everything is deterministic.** SOPs add structure to repeatable tasks. Creative work, planning, and exploration remain conversational and adaptive.
9. **Use the best tool for the job.** Claude Code for coding. Other interfaces for planning, design exploration, research. The system should route intelligently, not force everything through one channel.

## Key Commitments

**Committed:**
- Claude Code as the coding execution engine (Max subscription)
- DNA/archetype system with composable lenses
- Entity isolation (structural, not instructional)
- Two-layer architecture (command layer / entity layer)
- Modular design — components can be swapped without rebuilding

**Not committed:**
- Specific orchestration platform (custom daemon vs OpenClaw vs hybrid vs other)
- Specific messaging platform (Discord, Telegram, or other)
- Specific project management tool (GitHub Issues, Linear, custom, or other)
- How routing between conversational and code interfaces works (still being designed)

## Autonomous Build Loop (Target Workflow)

When you trigger a feature build, the target behavior is:

1. You describe what you want (conversationally, with the planner)
2. Planner creates a spec (socratic discovery → implementation-ready spec)
3. You approve the spec
4. Builder works autonomously: implement → test → review → fix → loop
5. During the loop, if questions arise that need your input, you're asked
6. Builder learns as it goes — the implementation may evolve from the original plan as new information emerges, but stays aligned with the goal
7. When the feature is complete and tests pass, you're presented with the result
8. You review, riff if needed, and approve the PR
9. Merge, deploy, done

The loop should be mostly autonomous with socratic dialogue as needed. You're happy to answer questions throughout, but the build loop shouldn't stop every 5 minutes for permission.

## Current State

See [docs/STATUS.md](docs/STATUS.md) for what's built vs what's planned.

## File Structure

See [docs/FILE-STRUCTURE.md](docs/FILE-STRUCTURE.md) for the planned directory layout.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full system architecture.

## Agent Files

See [docs/AGENT-FILES.md](docs/AGENT-FILES.md) for the complete inventory of archetype, soul, and DNA files.

---

*LobsterFarm — where agents build products, and products build agents.*
