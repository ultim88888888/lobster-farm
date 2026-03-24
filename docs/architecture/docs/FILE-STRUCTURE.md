# File Structure

The planned directory layout for LobsterFarm. Two layers, clear boundaries.

---

## Command Layer

Shared across all entities. Improving anything here improves every entity.

```
~/.lobsterfarm/                          # LobsterFarm home
├── config.yaml                          # Global daemon/system configuration
├── user.md                              # About Jax (preferences, style, contact)
├── tools.md                             # Machine infrastructure (accounts, services)
│
├── sops/                                # Standard Operating Procedures
│   ├── feature-lifecycle.yaml           # Plan → build → review → merge
│   ├── pr-review-merge.yaml             # Review cycle with fix loops
│   ├── entity-scaffolding.yaml          # New entity creation
│   └── ...                              # More SOPs as needed
│
├── blueprints/                          # Entity scaffolding templates
│   ├── web-app/                         # Template for web applications
│   │   ├── blueprint.yaml              # Structure, SOPs, channel layout
│   │   └── scaffolding/                # Template files
│   └── ...
│
├── entities/                            # Entity layer root
│   ├── alpha/                           # One entity
│   │   ├── config.yaml                  # Entity registration, channels, budgets
│   │   ├── MEMORY.md                    # Long-term curated knowledge (<200 lines)
│   │   ├── daily/                       # Session logs (staging for MEMORY.md)
│   │   │   ├── 2026-03-20.md
│   │   │   └── ...
│   │   ├── context/                     # Entity docs (architecture, decisions)
│   │   └── files/                       # Arbitrary files (presentations, brand kits)
│   └── beta/
│       └── ...
│
├── scripts/                             # Utility scripts
│   ├── extract-memory.py                # Stop hook — session learning extraction
│   └── ...
│
├── templates/                           # Templates for new entities
│   └── entity-config.yaml
│
└── logs/                                # Audit trail
    └── ...
```

## Claude Code Configuration

Agent profiles and DNA skills, loaded natively by Claude Code.

```
~/.claude/
├── CLAUDE.md                            # Shared soul foundation + universal rules
├── settings.json                        # bypassPermissions, hooks, env vars
├── agents/                              # Archetype definitions
│   ├── planner.md                       # Gary — planning, specs, discovery
│   ├── designer.md                      # Pearl — brand kits, UI/UX, components
│   ├── builder.md                       # Bob — full-stack implementation
│   ├── reviewer.md                      # Ephemeral code reviewer
│   └── operator.md                      # Ray — infrastructure, deployment
└── skills/                              # DNA profiles (composable)
    ├── coding-dna/SKILL.md              # Engineering standards (~710 lines)
    ├── design-dna/SKILL.md              # Design standards (~778 lines)
    ├── planning-dna/SKILL.md            # Spec writing standards
    ├── review-dna/SKILL.md              # Code review standards
    └── database-dna/SKILL.md            # Schema/query standards
```

## Entity Codebases

Each entity has its own repo(s) with entity-scoped context.

```
~/projects/{entity}/{repo}/
├── CLAUDE.md                            # Entity project facts, stack, commands
├── .claude/
│   ├── settings.json                    # Hooks for this entity
│   └── rules/                           # Path-scoped rules
├── packages/                            # Monorepo structure
│   ├── frontend/
│   ├── backend/
│   └── shared/
├── .github/workflows/                   # CI/CD
├── .env.example                         # Required env vars (no values)
├── .env.op                              # 1Password references (committed)
└── README.md
```

## What Goes Where (Quick Reference)

| Question | Location |
|----------|----------|
| Shared rules for ALL agents? | `~/.claude/CLAUDE.md` |
| Who IS this agent? (personality) | `~/.claude/agents/{name}.md` |
| HOW should work be done? (standards) | `~/.claude/skills/{dna}/SKILL.md` |
| Who is the human? | `~/.lobsterfarm/user.md` |
| Machine infrastructure? | `~/.lobsterfarm/tools.md` |
| How should a process work? | `~/.lobsterfarm/sops/` |
| Entity scaffolding template? | `~/.lobsterfarm/blueprints/` |
| Entity registration and config? | `~/.lobsterfarm/entities/{id}/config.yaml` |
| What has this entity learned? | `~/.lobsterfarm/entities/{id}/MEMORY.md` |
| Recent session activity? | `~/.lobsterfarm/entities/{id}/daily/` |
| Facts about a specific project? | `~/projects/{entity}/{repo}/CLAUDE.md` |

---

*The "no homeless content" rule: every piece of information belongs in exactly ONE location.*
