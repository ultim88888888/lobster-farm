# Skills

DNA, guidelines, and SOPs that agents load as context. Each skill is a directory containing a `SKILL.md` file with YAML frontmatter (name, description) and markdown body. Claude Code auto-loads skills based on task keyword matching against the description.

Skills fall into three categories:

- **DNA** -- Deep domain knowledge. How we write code, design interfaces, plan features, manage databases. Loaded by the primary archetype for that domain.
- **Guidelines** -- Operational requirements. Secret handling, code review standards, README maintenance, Discord management. Loaded across archetypes as needed.
- **SOPs** -- Step-by-step procedures. PR review-merge workflow, entity scaffolding process. Loaded when executing a specific process.

## Directories

- `coding-dna/` -- Engineering standards and architectural preferences. The foundational DNA for all code work.
- `database-dna/` -- Database design, schema architecture, query optimization. PostgreSQL/Prisma/SQLAlchemy patterns.
- `design-dna/` -- Visual systems, UI implementation, animation, and design-in-code principles.
- `planning-dna/` -- Spec writing, scope management, socratic discovery methodology.
- `review-guideline/` -- Code review priority order, comment format, quality bars.
- `secrets-guideline/` -- 1Password-based secret management. The "never handle raw secrets" rule.
- `readme-guideline/` -- Directory documentation standards. When and how to write READMEs.
- `discord-guideline/` -- Discord server management. Channel scaffolding, bot architecture, webhook patterns.
- `pr-review-merge/` -- SOP for the PR review, feedback, and merge workflow.
- `entity-scaffold/` -- SOP for standing up a new entity from a blueprint.
