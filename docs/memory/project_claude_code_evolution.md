---
name: Claude Code feature tracking
description: Claude Code features relevant to LobsterFarm - channels, agent teams limitations, skills auto-loading, hooks
type: project
---

LobsterFarm is built entirely on Claude Code as sole runtime. New features directly improve the platform.

## Features We Use

**Agent profiles** (`~/.claude/agents/`): Where archetypes live. Soul, model selection, tool restrictions per archetype.

**Skills system** (`~/.claude/skills/`): Where DNA lives. Auto-loaded by task match — agents get the right expertise without manual intervention.

**Hooks** (PreToolUse, PostToolUse, Stop): Hard enforcement layer of governance. Block writes to main, detect hardcoded secrets, extract session learnings on stop.

**CLAUDE.md hierarchy** (global, project, per-directory): Auto-merged context. Global CLAUDE.md is the shared soul foundation.

**Channels** (shipped March 19, 2026): Discord + Telegram. Research preview. We use this for Pat's persistent #command-center session. Two-bot architecture: Pat's bot via channels plugin, daemon bot for entity routing.

**Subagents**: Custom profiles, tool restrictions, isolated context windows. Useful for scoped sub-tasks within a session.

**Chrome browser control via `--chrome`**: Pixel-level control within Chrome tabs — click, type, screenshot, scroll, navigate, fill forms, run JS, inspect console/network. Scoped to Chrome, NOT the full desktop. Enables agents to write code and verify it in a browser in the same session. Full desktop computer use (any app) is in the Claude API and Desktop app but not yet in the CLI.

## Known Limitations

**Agent Teams cannot use custom agent profiles** — open feature request #24316. Teammates are generic, can't leverage our archetype system. Also broken when launched from custom agent sessions (bug #23506). Until this ships, our orchestrator handles multi-agent coordination externally.

**No mid-session YOLO mode toggle** — must restart with `--dangerously-skip-permissions` flag.

**No native orchestration or deterministic workflow system** — Claude Code is an execution engine, not a coordinator. Our daemon fills this gap.

**Channels is research preview** — reliability unproven at scale. We depend on it for Pat.

## Future Features to Watch
- Agent Teams with custom profile support (would enable archetype-aware multi-agent within Claude Code)
- `/review` and `/simplify` built-in skills (integrate into SOPs)
- Any new slash commands that map to SOP steps

**Why:** The platform depends on Claude Code. Its evolution directly shapes what we need to build ourselves vs what we get for free.

**How to apply:** When Claude Code ships new features, evaluate whether they replace something we built custom. When hitting limitations, check if there's an open issue to track.
