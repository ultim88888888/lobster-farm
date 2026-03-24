---
name: System architecture
description: Three concerns (execution/orchestration/interaction), archetype system, memory architecture, MCP, tool routing
type: project
---

## Three Concerns

**Execution:** Actually doing work (writing code, creating designs, reviewing PRs). Claude Code for coding, potentially other tools for other work types.

**Orchestration:** Managing WHAT gets done, by WHOM, in WHAT order. Handoffs, SOPs, progress tracking across entities. Background coordinator.

**Interaction:** How Jax communicates with agents. Terminal, Discord, Telegram. Jax is the front door; orchestrator is background infrastructure.

## Archetype System

Three components define an agent:
- **Soul (WHO):** Personality, values, approach. Lives in archetype definition. Shared across entities.
- **DNA (HOW):** Domain expertise lens. Composable. Lives as skills. Shared across entities. Auto-loaded by task match.
- **Memory (WHAT IT KNOWS):** Entity-specific accumulated knowledge. Lives in entity layer. Unique per agent instance.

DNA is composable: builder loads `coding-dna + design-dna` for frontend, `coding-dna + database-dna` for schema work. Soul stays constant.

## Memory Architecture

**Single MEMORY.md per entity. No vector store at launch.**

- `MEMORY.md`: long-term curated knowledge (<200 lines). Read every session.
- `daily/` logs: session summaries. Staging area for MEMORY.md promotion.
- `context/` docs: architecture, decision logs, deeper reference material.

Lifecycle: daily logs accumulate, periodic review, promote important items to MEMORY.md, archive old logs. If MEMORY.md outgrows 200 lines: split into index + topic files in context/.

No global memory for archetypes. Universal learnings improve DNA via evolution pipeline. Pat is the sole exception (command-layer memory).

## MCP as Shared Protocol

Both Claude Code and OpenClaw use MCP natively. MCP servers configured once work with either platform. Tool integrations are portable regardless of orchestration approach. 1,000+ community MCP servers available.

## Tool Routing (Open Design Problem)

Different work types benefit from different tools. Feature implementation and code review need Claude Code. Planning without codebase context can be conversational. Design exploration starts conversational, becomes coded prototype.

WHO decides which tool handles which task? Options: human decides (simple, bottleneck), orchestrator decides (autonomous, needs routing logic), single platform with mode switching (simplest, depends on Claude Code sufficiency). Answer will likely be a hybrid that evolves.

## File Structure

Command layer: `~/.lobsterfarm/` (config, user.md, tools.md, sops/, blueprints/, entities/)
Claude Code config: `~/.claude/` (CLAUDE.md, agents/, skills/)
Entity codebases: `~/projects/{entity}/{repo}/`

The "no homeless content" rule: every piece of information belongs in exactly ONE location.

**Why:** Separating execution, orchestration, and interaction allows each to evolve independently. The archetype system gives specialization without duplication.

**How to apply:** When building new features, identify which concern they belong to. Execution changes go through Claude Code config. Orchestration changes go through daemon. Interaction changes go through channel/UI layer.
