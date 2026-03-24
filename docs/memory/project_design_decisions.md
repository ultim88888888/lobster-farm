---
name: Architecture design decisions
description: Key design decisions - entity isolation via directory scoping, governance model, SOP engine direction, shared vaults
type: project
---

## Entity Isolation

**Entity isolation is structural via directory scoping, NOT worktrees.** Each Claude Code session spawns in a specific entity's workspace directory. The agent literally cannot see another entity's files. This is a significant advantage over instructional isolation ("don't cross-reference entities" in prompts).

**Worktrees are for parallel branch work within a single entity,** not for entity isolation. An entity's builder might have multiple worktrees for concurrent feature branches, but the entity boundary is the directory scope.

## Governance Model

Four layers, hardest to softest:

1. **Hard enforcement (universal, deterministic, no LLM):** Claude Code hooks block writes to main branch and hardcoded secrets. System enforces budget/concurrency/session lifecycle. Filesystem enforces entity isolation.
2. **Escalation rules (universal, agent judgment, in global CLAUDE.md):** Irreversible decisions, scope changes, genuine uncertainty, external actions, security decisions. Everything not listed: autonomous.
3. **Phase gates (blueprint-specific, SOP-driven):** Plan->Build requires human spec approval. Build->Review requires tests passing. Review->Ship requires reviewer approval. DNA evolution always requires human approval. These gates are defined per blueprint, not universally.
4. **Budget governance (universal):** Per-entity budgets with soft warnings (80%) and hard stops (100%). Human can override.

## SOP Engine Direction

**SOPs should eventually be YAML state machines, not hardcoded TypeScript.** Lobster (OpenClaw's workflow engine) already does what our SOP engine needs. Whether we use Lobster directly or build our own equivalent is an open decision, but the target representation is declarative YAML with deterministic `run:` steps, LLM `pipeline:` steps, and `approval:` gates.

## Other Decisions

**GitHub accounts are per-entity, not global.** Different GitHub orgs/accounts for different entities. GitHub config belongs in entity config, not tools.md.

**Shared services vault pattern.** Some services (Vercel, Sentry, domain registrar) operate at account level managing multiple entities. Master 1Password vault (`lobsterfarm`) for shared services, per-entity vaults (`entity-{id}`) for entity-specific secrets.

**user.md has no contact info.** Contact details don't belong in the user profile. Account identifiers go in tools.md (shared) or entity config (per-entity).

**Sudo and permissions are setup steps, not defaults.** The setup wizard configures or guides through these.

**Why:** These decisions establish the structural guarantees that make the system trustworthy. Structural isolation beats instructional. Declarative SOPs beat hardcoded workflows. Clear vault boundaries prevent secret leakage.

**How to apply:** Entity config schema needs an `accounts` section for GitHub org, repo URL, and entity-specific service accounts. SOP implementation should target YAML representation even if initially implemented in TypeScript.
