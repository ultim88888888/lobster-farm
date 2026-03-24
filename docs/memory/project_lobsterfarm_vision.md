---
name: LobsterFarm vision and interaction model
description: Two-layer architecture (command/entity), direct agent access, design principles, key commitments
type: project
---

LobsterFarm is an orchestration platform that turns a machine into an autonomous software consultancy, built entirely on Claude Code CLI as sole execution runtime.

## Two-Layer Architecture

**Command layer (shared):** Archetypes, souls, DNA, SOPs, blueprints. Improving anything here improves every entity. All public information.

**Entity layer (scoped):** Agents, memory, codebases, entity config. Fully isolated per entity. No cross-contamination.

Key insight: "Improve a DNA, every entity benefits. Add an SOP, every entity follows it. Refine an archetype, every agent inherits it."

## Interaction Model

**"You are the front door."** Direct access to any agent, any time. Talk to the builder about bugs, the designer about brand colors, the planner about features. No mandatory middleman.

**Autonomous work in the background.** Kick off a feature build and walk away. The system handles build, review, test, loop. You get pinged for approvals and questions. Drop into any running process at any time.

**The orchestrator is background infrastructure, not the front door.** It manages handoffs, runs workflows, tracks progress across entities, handles plumbing. You interact with agents, not the orchestrator.

**Approval gates are lightweight.** Across 10 entities, approving a step takes 30 seconds. The system does the work; you make the decisions.

## Design Principles

1. You are the front door — direct agent access, orchestrator coordinates in background
2. Determinism for process, intelligence for work — workflows are code, creative work is LLM
3. Autonomy with circuit breakers — agents work independently, escalation thresholds determine when to ask
4. Same brain, different lenses — specialization via DNA layered onto archetypes
5. Entity isolation is structural — agents scoped to entity workspace, cannot see other entities
6. Modular and replaceable — components swap independently, new archetypes/SOPs/DNA/entities added without modifying core
7. The system builds itself — LobsterFarm is entity zero
8. Not everything is deterministic — SOPs for repeatable tasks, conversational for creative/planning/exploration
9. Use the best tool for the job — Claude Code for coding, other interfaces for planning/design/research, route intelligently

## Key Commitments

**Committed:** Claude Code as coding execution engine (Max subscription), DNA/archetype system with composable lenses, entity isolation (structural not instructional), two-layer architecture, modular design.

**Not committed:** Specific orchestration platform, specific messaging platform, specific project management tool, how routing between conversational and code interfaces works.

**Why:** Structure is what makes Claude reliable. LobsterFarm provides institutional knowledge, workflows, quality standards, and isolation boundaries.

**How to apply:** All implementation decisions should consider multi-tenancy/portability. Hardcoded paths, personal info, and user preferences flow through config, not baked into platform code.
