# Terminology

The shared language of LobsterFarm. Every agent, document, and conversation uses these terms consistently.

---

## Entity

An isolated business or project. Comprised of codebase(s), documents, workflows, and agents. Entities are fully isolated from each other — an agent working on Entity Alpha cannot see Entity Beta's files, memory, or context.

Entities follow **blueprints** for their structure and implement **SOPs** for their workflows.

Examples: a trading platform, a SaaS product, a client project, LobsterFarm itself (entity zero).

## Archetype

An agent template. Defines WHO an agent is (soul) and WHAT expertise it defaults to (primary DNA). An archetype is NOT an agent — it's a blueprint for creating agents. Archetypes live in the **command layer** and are shared across all entities.

When an entity needs a builder, it instantiates the Builder archetype as an entity-scoped agent with its own memory.

Current archetypes: Planner (Gary), Designer (Pearl), Builder (Bob), Reviewer (unnamed, ephemeral), Operator (Ray).

## Soul

A component of an archetype that provides personality, preferences, values, and approach. How the agent thinks and communicates. What makes it push back, what it cares about, how it handles uncertainty.

Litmus test: "Would this be true if the agent switched from a TypeScript project to a Python project?" If yes → Soul. If no → DNA.

Example: "You feel the problem before solving it. Explore before converging." — this is Pearl's soul. It's true regardless of which project she's working on.

## DNA

A composable expertise lens — the standards, patterns, and preferences that define HOW work is done in a specific domain. DNA is called upon by archetypes but exists independently of them.

DNA is composable. A builder working on frontend loads `coding-dna + design-dna`. The same builder working on database schema loads `coding-dna + database-dna`. The DNA changes; the soul doesn't.

Current DNA profiles: coding-dna (~710 lines), design-dna (~778 lines), planning-dna, review-dna, database-dna.

DNA evolves over time as agents learn what works and what doesn't.

## Agent

An entity-level instance created from an archetype. What separates an agent from its archetype is **memory** — entity-specific accumulated knowledge, decisions, gotchas, and patterns.

An agent = archetype (soul + DNA) + entity-specific memory + entity-specific context.

The Builder archetype might produce 10 builder agents across 10 entities. They all share the same soul and coding-dna, but each has its own memory of the entity's architecture, quirks, and history.

## Memory

What separates an agent from its archetype. Entity-specific accumulated knowledge that persists across sessions. Includes architectural decisions, known gotchas, workarounds, patterns that worked or failed, and integration details.

Memory lives in the **entity layer**, never in the command layer. Improving memory improves one agent. Improving DNA improves all agents.

## SOP (Standard Operating Procedure)

Guidelines that entities follow to stay in line. SOPs come in two flavors:

**Deterministic workflows:** Coded state machines with defined steps, conditions, loops, and approval gates. Example: the build → review → fix → re-review → merge cycle.

**Best practices documents:** Written standards that agents follow. Example: "always use feature branches, never commit to main, use conventional commit messages."

SOPs live in the **command layer** and apply across all entities (unless an entity opts out). They standardize repeatable tasks so that standing up and managing entities is consistent.

## Blueprint

The structure an entity follows when it's created. Defines which SOPs apply, base channel layouts, scaffolding patterns, repo structure, CI/CD templates, and initial configuration.

Blueprints enable standing up production-grade entities quickly and consistently. A "web app" blueprint might include: monorepo structure, frontend/backend/shared packages, GitHub Actions CI/CD, Sentry integration, and a specific set of SOPs.

## Command Layer

Everything shared across entities. The "public" layer. Contains archetypes, souls, DNAs, SOPs, and blueprints. Changes here propagate to all entities.

Think of it as the company's playbook — the institutional knowledge that every project benefits from.

## Entity Layer

Entity-specific information. Where agents live with their memory. Fully isolated — one entity cannot see another's data.

Think of it as a specific project's workspace — everything unique to that engagement.

## Orchestrator

The background coordinator that manages agent lifecycles, handoffs between phases, deterministic workflows, and cross-entity status. It is NOT the front door — you talk directly to agents. The orchestrator handles what happens when you're not actively engaged.

---

*These terms are the shared language. Use them consistently in all documentation, conversations, and code.*
