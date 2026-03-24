# Research Findings

What we learned about the tool landscape during the architecture design phase. This context helps future sessions understand why certain decisions were made or deferred.

---

## Claude Code

**What it is:** Anthropic's CLI tool for agentic coding. Uses Max subscription (flat rate, not per-token).

**Strengths for us:**
- Best-in-class coding agent. Purpose-built for code.
- Native agent profiles (`~/.claude/agents/`) with soul, model, tool restrictions.
- Native skills system (`~/.claude/skills/`) with auto-loading by task match. This is where our DNA lives.
- Hooks (PreToolUse, PostToolUse, Stop) for deterministic enforcement.
- CLAUDE.md hierarchy (global → project → per-directory, auto-merged).
- Subagents with custom profiles, tool restrictions, and isolated context windows.
- Channels (Telegram + Discord, shipped March 19, 2026) for mobile interaction.
- `/review` and `/simplify` built-in skills for security review and code cleanup.
- Max subscription = flat rate. No per-token costs for core work.

**Limitations:**
- Channels is 4 days old (research preview). Reliability unproven.
- Agent Teams (experimental) cannot use custom agent profiles — open feature request #24316.
- Agent Teams don't work properly when launched from custom agent sessions — bug #23506.
- No native orchestration. It's an execution engine, not a coordinator.
- No native deterministic workflow system (no equivalent to Lobster).
- No mid-session YOLO mode toggle — must restart with `--dangerously-skip-permissions` flag.

## OpenClaw

**What it is:** Open-source personal AI agent platform. 150K+ GitHub stars. Nvidia NemoClaw partnership (March 16, 2026).

**Strengths:**
- 25+ messaging channel adapters (Discord, Telegram, WhatsApp, Slack, etc.).
- Multi-agent routing with isolated workspaces per agent.
- Per-agent tool allow/deny lists, model selection.
- Session management, memory system, heartbeat/cron scheduling.
- Lobster workflow engine (optional plugin) for deterministic pipelines.
- Massive ecosystem (5,400+ skills, ClawHub registry).
- MCP support (same protocol as Claude Code).
- Battle-tested. Thousands of deployments.

**Limitations for us:**
- Entity isolation is instructional, not structural (agents told "don't cross-reference").
- Multi-agent coordination is basic (sessions_send ping-pong, sessions_spawn fire-and-forget).
- Agent Teams feature doesn't exist yet (open RFC, inspired by Claude Code).
- Not optimized for coding specifically — it's a generalist platform.
- Maintaining DNA/soul files in both OpenClaw workspaces AND Claude Code's `~/.claude/` creates drift risk.
- Uses API keys (per-token cost) not flat-rate subscription.
- Jax's existing setup "feels fragile" — knowledge distributed across many files and implicit agent behaviors.

## Lobster (OpenClaw's Workflow Engine)

**What it is:** Optional OpenClaw plugin. Deterministic workflow engine. YAML-defined pipelines with approval gates and resume tokens.

**Key capabilities:**
- `run:` steps execute shell commands deterministically.
- `pipeline:` steps invoke LLM for judgment calls within deterministic flow.
- `approval:` gates pause workflow, wait for human confirmation, return resume token.
- Loop support (recently contributed via community PR) for review-fix cycles.
- Can invoke OpenClaw agents as steps (`openclaw.invoke --tool agent-send`).
- Steps pipe data between each other via `stdin: $step.stdout`.

**Relevance:** Lobster is essentially what our SOP engine was designed to be. It already exists and works. Whether we use it (via OpenClaw) or build our own equivalent is an open decision.

## Paperclip

**What it is:** Open-source orchestration for "zero-human companies." 31K GitHub stars. Node.js server + React UI.

**Strengths:**
- Multi-company isolation in one deployment (maps to our entity model).
- Org charts, budgets, goal hierarchy, governance.
- Per-agent monthly budgets with auto-pause.
- Full audit trail — every conversation, decision, tool call logged.
- Runtime-agnostic — works with Claude Code, OpenClaw, Codex, scripts, HTTP agents.
- Company templates (export/import full org configs — maps to our blueprints).
- Dashboard with cost tracking.

**Limitations for us:**
- Ticket-based, not conversational. No chat interface with agents.
- No DNA/archetype system. Has roles but nothing like composable expertise lenses.
- No socratic build loop. Assign ticket → agent works → done. No mid-build dialogue.
- No deterministic SOP execution (not like Lobster).
- Hierarchical org model (CEO → CTO → engineers) vs our flat archetype model.

**Potential role:** Dashboard/visibility layer alongside other tools, rather than primary orchestration.

## Linear

**What it is:** Issue tracking and project management. Founded 2019 by Finnish engineers (ex-Airbnb, Coinbase, Uber). 25K+ companies.

**Relevance:** Symphony (OpenClaw's PR triage tool) is built on Linear. Linear's state-based workflow model maps well to our phase model (plan → build → review → ship). Has official MCP server for Claude Code integration. Could serve as the project management backbone.

## Symphony (OpenClaw)

**What it is:** NOT a general-purpose framework. It's the OpenClaw team's internal PR triage pipeline connecting Linear to Codex agents.

**The pattern IS general-purpose:** Project board states → agent dispatch → human gates between stages. This pattern (defined in WORKFLOW.md) is exactly our feature lifecycle: states trigger agent dispatch, hooks handle setup, gates require human approval, templates define prompts per state.

## Claude Code Agent Teams

**What it is:** Experimental feature (Feb 2026). Multiple Claude Code sessions coordinate via shared task list and direct messaging.

**Key finding:** Teammates are generic — they CANNOT use custom agent profiles from `~/.claude/agents/`. Open feature request #24316 asks for exactly this. Also broken when launched from custom agent sessions (bug #23506).

**Implication:** Agent Teams is interesting but can't currently leverage our archetype system. Our orchestrator needs to handle multi-agent coordination externally until Anthropic ships profile support for teammates.

## CrewAI

**What it is:** Open-source multi-agent orchestration framework. 44K+ GitHub stars.

**Relevance:** Role-based agent system with tasks, tools, and memory. More code-centric (Python API) than what we want. Useful reference for multi-agent patterns but not a direct fit for our conversation-first, Claude-Code-native approach.

## MCP (Model Context Protocol)

**What it is:** Open standard for AI-tool integration. Originally Anthropic, now under Linux Foundation (AAIF). Co-founded by Anthropic, Block, OpenAI.

**Key insight:** Both Claude Code and OpenClaw use MCP natively. Any MCP server we configure works with either platform. This makes our tool integrations portable regardless of which orchestration approach we choose. 1,000+ community MCP servers available.

---

*This research was conducted March 2026. The landscape moves fast — verify current state before making decisions based on this document.*
