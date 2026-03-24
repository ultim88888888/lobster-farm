---
name: Research findings and tool landscape
description: Claude Code strengths/limitations, OpenClaw, Lobster, Paperclip, Linear, Symphony, CrewAI - evaluated March 2026
type: project
---

## Claude Code

**Strengths:** Best-in-class coding agent, native agent profiles (`~/.claude/agents/`), native skills system with auto-loading by task match (where DNA lives), hooks for deterministic enforcement, CLAUDE.md hierarchy, subagents, Channels (Discord + Telegram, shipped March 19 2026), Max subscription flat rate.

**Limitations:** Channels is research preview (reliability unproven). Agent Teams (experimental) cannot use custom agent profiles — open feature request #24316, also broken when launched from custom agent sessions (bug #23506). No native orchestration. No deterministic workflow system. No mid-session YOLO mode toggle.

**Implication:** Agent Teams can't leverage our archetype system until Anthropic ships profile support for teammates. Our orchestrator handles multi-agent coordination externally for now.

## OpenClaw

**Strengths:** 25+ messaging channel adapters, multi-agent routing with isolated workspaces, per-agent tool allow/deny, Lobster workflow engine, massive ecosystem (5,400+ skills), MCP support, battle-tested.

**Limitations for us:** Entity isolation is instructional not structural (agents told "don't cross-reference" in prompts vs our filesystem scoping). Multi-agent coordination is basic. Maintaining DNA/soul in both OpenClaw AND Claude Code creates drift risk. Uses API keys (per-token cost). Jax's existing setup "feels fragile."

## Lobster (OpenClaw Workflow Engine)

YAML-defined deterministic pipelines with `run:` steps (shell), `pipeline:` steps (LLM), `approval:` gates (human confirmation with resume tokens), loop support. Essentially what our SOP engine was designed to be. Whether we use it or build our own is open.

## Paperclip

Multi-company isolation (maps to entity model), org charts, budgets, governance, full audit trail, runtime-agnostic, company templates (maps to blueprints). But ticket-based not conversational, no DNA/archetype system, no socratic build loop, hierarchical org model. **Potential role: dashboard/visibility layer,** not primary orchestration.

## Linear + Symphony Pattern

Linear's state-based workflow model maps well to our phase model. Symphony (OpenClaw's PR triage tool) demonstrates the general pattern: project board states trigger agent dispatch, hooks handle setup, gates require human approval, templates define prompts per state. This pattern IS our feature lifecycle.

**Why:** Understanding the landscape prevents building things that already exist and reveals which gaps are genuinely novel. The most novel thing to solve is the "glue" between conversational and code interfaces.

**How to apply:** Before building orchestration infrastructure, check if an existing tool covers the need. Lobster for SOP engine, Paperclip for dashboard, Linear for project management are all candidates worth testing before building custom.
