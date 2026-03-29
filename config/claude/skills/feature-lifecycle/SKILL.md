---
name: feature-lifecycle
description: >
  The feature lifecycle — how features move from idea to shipped.
  Auto-loads when creating features, planning work, managing the build loop,
  or understanding how work flows through the system.
---

# Feature Lifecycle SOP

_How a feature moves from idea to shipped code in LobsterFarm._

---

## Overview

The planner (Gary) is the orchestrator for each entity. Features start as conversations — you riff with Gary in #general or a work room. When a feature is ready to build, Gary creates the GitHub issue, spawns Bob (builder) as a subagent, and manages the flow. You stay in Discord for everything — approvals, questions, feedback.

```
Riff with Gary → spec ready → GitHub issue created → Bob builds (subagent) → PR → review-merge SOP → shipped
```

## How It Works

### 1. Discovery (in Discord)

You describe what you want in #general or a work room. Gary does socratic discovery — asks questions, proposes approaches, scopes the work. This is a conversation, not a form to fill out.

When the spec is solid, Gary creates a GitHub issue as the record. The issue is the OUTPUT of planning, not the input.

### 2. Approval (in Discord)

Gary posts the spec summary in the work room and asks for approval. You approve right there in the chat — "looks good, let's build it."

Gary decides whether pre-PR approval is needed based on the feature type:
- **Visual work (UI, design):** show screenshots/preview before PR
- **Backend/infra:** PR can go up directly, user reviews the code

### 3. Build (subagent)

Gary spawns Bob as a subagent within his session. Bob inherits full context from the planning conversation — no information loss. Bob:
- Creates a feature branch
- Implements the feature following the spec
- Writes tests
- Runs `/simplify` to clean up
- Commits and pushes
- Creates a PR with `Closes #{issue}` in the body

Gary reports the result back to you in Discord.

### 4. Review & Merge (pr-review-merge SOP)

The PR triggers the `pr-review-merge` SOP independently. See that skill for details. When the PR merges, the GitHub issue auto-closes.

### 5. Design (when needed)

For visual work, Gary can spawn Pearl (designer) as a subagent, or you can ask to talk to Pearl directly via `/swap pearl`. Pearl creates design artifacts — brand kits, component libraries, UI prototypes. Swap back to Gary when done.

## Agent Model

**Gary is the front door for each entity.** One Gary session per entity #general channel, always available. You riff with Gary, Gary delegates.

**Subagents, not phase cycling.** Gary spawns Bob, Pearl, or Ray as subagents within his session. No pool bot cycling, no cold starts, no context loss. The subagent inherits Gary's full conversation context.

**Direct agent access via swap.** If you want to riff directly with Pearl on design or Bob on implementation, use `/swap pearl` or `/swap bob` in a work room. The daemon swaps the pool bot's archetype.

## Agent Behavior

**Agents are collaborators, not task executors.** During any phase, agents should surface discoveries that could affect decisions. Plans drift during implementation — new information should be communicated, not suppressed. Ask genuine questions. Don't assume.

**PR bodies must include `Closes #{issue}`.** This auto-closes the GitHub issue on merge. The spec, the PR, and the issue are linked.

**Run `/simplify` before pushing.** Less noise for the reviewer.

**Update daily logs.** After completing work, write to `daily/YYYY-MM-DD.md` with what was done, decisions made, and any open questions.

## Work Room Management

- **Channel topics:** each work room's topic shows current status, updated by the daemon
  - `🟢 Available`
  - `🔵 Secret Scanning Hook — Plan`
  - `🟡 Secret Scanning Hook — Build`
- **Auto-assignment:** messaging an empty work room auto-assigns a planner
- **Room release:** when a feature ships, the room status resets to available

## What NOT to Do

- Don't skip the planning conversation for non-trivial features
- Don't create PRs without `Closes #{issue}` in the body
- Don't merge PRs outside the review-merge SOP — it tracks PR state
- Don't suppress discoveries — if you learned something that matters, say it
