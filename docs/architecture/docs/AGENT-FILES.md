# Agent Files

Complete inventory of archetype definitions and DNA profiles. These files have been designed and written. They are ready to install into `~/.claude/`.

---

## Where They Go

```
~/.claude/
├── CLAUDE.md                    # Shared soul foundation (all agents inherit this)
├── agents/
│   ├── planner.md               # Gary
│   ├── designer.md              # Pearl
│   ├── builder.md               # Bob
│   ├── reviewer.md              # Unnamed, ephemeral
│   └── operator.md              # Ray
└── skills/
    ├── coding-dna/SKILL.md      # ~710 lines
    ├── design-dna/SKILL.md      # ~778 lines
    ├── planning-dna/SKILL.md    # ~94 lines
    ├── review-dna/SKILL.md      # ~88 lines
    └── database-dna/SKILL.md    # ~113 lines
```

## Global CLAUDE.md (~118 lines)

Shared soul foundation loaded by every Claude Code session. Contains:

- **Core truths:** Partner not tool, have opinions, be resourceful, take your time, earn trust. Written once here, never repeated in archetype souls.
- **Session startup procedure:** Read MEMORY.md, check daily logs, read feature spec.
- **Memory routing:** Where to read, where to write.
- **Role map:** Which archetype does what, handoff boundaries.
- **Universal rules:** Git workflow, secrets management, escalation triggers, communication patterns.
- **Pointers:** References to user.md and tools.md.

## Archetype Definitions (~25-30 lines each)

Each file has YAML frontmatter (name, description, model, tools) and a markdown body (the soul).

### planner.md (Gary)
Socratic planner. Sees the whole board. Thinks in systems. Asks the questions that reveal what's actually needed. Tight scope management. Specs are contracts — the builder should never have to come back with clarifying questions.

### designer.md (Pearl)
Design engineer. Feels the problem before solving it. Sweats details. Builds in code, not mockups. Designs systems over one-offs. The kind of designer who makes engineers excited to build what she designs.

### builder.md (Bob)
Full-stack engineer. Writes code as if maintaining it sleep-deprived in 6 months. Understands before building. Complexity is earned, not default. Implements designs faithfully. Owns the full lifecycle.

### reviewer.md (Ephemeral)
Has never seen this code before. Evaluates against clear standards. Priority order: correctness, security, robustness, performance, maintainability. Distinguishes blocking vs suggestions. Not the architect — doesn't second-guess approved approaches.

### operator.md (Ray)
Best infrastructure is invisible. Thinks defensively. Automates relentlessly. Conservative with production. Documents everything operational.

## DNA Profiles

### coding-dna (~710 lines)
Ported from battle-tested CODE-DNA.md. Covers: philosophy (lightweight, modular, fast), Python standards (naming, typing, StrEnum, docstrings, comments, error handling), async patterns, database patterns (PostgreSQL, Docker Compose), security (1Password everywhere), git workflow, frontend standards (TypeScript strict, Next.js App Router, Tailwind), code quality, anti-patterns, conventions quick reference.

### design-dna (~778 lines)
Ported from battle-tested DESIGN-DNA.md. Covers: philosophy (alive not busy, restraint is expression), stack (Next.js, Tailwind, Motion, GSAP, CSS Scroll-Driven Animations, Remotion), color principles and palette architecture, typography, animation and motion (intention test, technical vocabulary), layout patterns, case studies (Monument Valley, Clear Street, Burocratik, OpenClaw as anti-reference), design process, handoff to engineering, build checklist.

### planning-dna (~94 lines)
Spec writing and discovery standards. Covers: philosophy, socratic discovery flow, spec format (GitHub Issue template with context, spec, acceptance criteria, technical notes, out of scope), anti-patterns.

### review-dna (~88 lines)
Code review standards. Covers: review priority order (correctness → security → robustness → performance → maintainability), comment format (blocking/suggestion/praise), standards, reviewer anti-patterns.

### database-dna (~113 lines)
Schema and query optimization standards. Covers: philosophy (schema decisions are permanent), primary keys (UUID), timestamps (UTC), naming conventions, types, relationships, indexing strategy, query patterns, ORM standards (Prisma + SQLAlchemy), anti-patterns.

## Supporting Files

### user.md (~37 lines)
About Jax. Partner not user. Preferences: precision, show-don't-tell, no filler. When to ask vs act autonomously. Contact info.

### tools.md (~38 lines)
Machine infrastructure. Farm (Mac mini, arm64). Accounts (GitHub, 1Password, Vercel). Peekaboo (macOS UI automation). Grows as infrastructure is added.

## Origin

The coding-dna and design-dna were built by Jax riffing with agents over months of real work. They represent battle-tested preferences and conventions extracted from actual code and design reviews. The other DNA profiles (planning, review, database) were designed during the LobsterFarm architecture session and are solid but less battle-tested.

All archetype souls were informed by existing OpenClaw workspace files (SOUL.md, IDENTITY.md, AGENTS.md) from the working Gary/Pearl/Bob agents, refined to eliminate overlap with the shared soul foundation in global CLAUDE.md.

---

*These files are the starting point. They evolve through real work via the DNA evolution pipeline.*
