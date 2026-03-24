---
name: LobsterFarm terminology
description: Canonical definitions for all key terms - entity, archetype, soul, DNA, agent, memory, SOP, blueprint, command/entity layer, orchestrator
type: project
---

## Core Terms

**Entity:** An isolated business or project. Has its own codebase(s), documents, workflows, and agents. Entities are fully isolated from each other. Examples: a trading platform, a SaaS product, a client project, LobsterFarm itself (entity zero).

**Archetype:** An agent template, NOT an agent itself. Defines WHO an agent is (soul) and WHAT expertise it defaults to (primary DNA). Lives in the command layer, shared across all entities. Current archetypes: Planner (Gary), Designer (Pearl), Builder (Bob), Reviewer (unnamed, ephemeral), Operator (Ray).

**Soul:** A component of an archetype. Personality, values, approach, how it thinks and communicates. Shared across all entities.

**DNA:** A composable expertise lens. Standards, patterns, preferences for HOW work is done in a specific domain. Composable (builder loads coding-dna + design-dna for frontend work). Lives as skills in `~/.claude/skills/`. Evolves over time.

**Agent:** An entity-level instance created from an archetype. Agent = archetype (soul + DNA) + entity-specific memory. The Builder archetype produces 10 builder agents across 10 entities; same soul, same DNA, different memory.

**Memory:** What separates an agent from its archetype. Entity-specific accumulated knowledge. Lives in the entity layer, never in the command layer. Improving memory improves one agent. Improving DNA improves all agents.

**SOP (Standard Operating Procedure):** Guidelines entities follow. Two flavors: deterministic workflows (coded state machines) and best-practices documents (written standards). Live in the command layer, apply across all entities unless opted out.

**Blueprint:** The structure an entity follows. Defines which SOPs apply, channel layouts, scaffolding patterns, repo structure, CI/CD templates. Enables standing up entities quickly and consistently.

**Command Layer:** Everything shared across entities. Archetypes, souls, DNAs, SOPs, blueprints. The company's playbook.

**Entity Layer:** Entity-specific information. Where agents live with their memory. Fully isolated per entity.

**Orchestrator:** Background coordinator. Manages agent lifecycles, handoffs, deterministic workflows, cross-entity status. NOT the front door — you talk to agents directly.

## Litmus Tests

**Soul vs DNA:** "Would this be true if the agent switched from a TypeScript project to a Python project?" If yes, it is Soul. If no, it is DNA.

**Command layer vs Entity layer:** "Would this be true on a different project?" If yes, it belongs in the command layer. If no, it belongs in the entity layer.

**Why:** Consistent terminology prevents miscommunication between agents and across sessions. The litmus tests resolve ambiguity when deciding where content belongs.

**How to apply:** Use these terms precisely in all documentation, conversations, and code. When unsure where something belongs, apply the litmus tests.
