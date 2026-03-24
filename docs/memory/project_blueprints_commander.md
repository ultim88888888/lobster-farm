---
name: Blueprints and Commander archetype
description: Blueprint system for entity scaffolding, Commander (Pat) as global admin, entity-level orchestration open question
type: project
---

## Blueprints

Blueprints are reusable templates that entities inherit from. Entity config gains a `blueprint: software` field. At load time, daemon merges blueprint defaults with entity overrides.

A blueprint defines:
- Active archetypes and DNA profiles per archetype
- Enabled SOPs (which ones apply to this entity type)
- Default model tiers per task type
- Channel structure and layouts
- Scaffolding patterns and repo structure
- CI/CD templates
- Any other entity config defaults

Example: `web-app` blueprint = monorepo structure, frontend/backend/shared packages, GitHub Actions CI/CD, Sentry integration, specific set of SOPs.

Updating a blueprint propagates to all entities following it. Entities can override specific settings. Blueprint files: `~/.lobsterfarm/blueprints/{name}/blueprint.yaml`

**Phase gates are blueprint-specific,** not universal. A software entity might require "tests passing" before review, while a content entity might not have that gate at all.

## Commander (Pat)

**Pat is the only agent with memory at the command layer.** All other agents have entity-scoped memory only. Pat operates globally because Pat manages the system itself.

Capabilities: create/manage entities (using blueprints or custom config), modify system config, adjust blueprints (propagates to following entities), query status across all entities, create new archetypes and SOPs, plan new blueprints.

Commander DNA: `commander-dna` — meta-knowledge about LobsterFarm's own architecture, config schemas, SOP definitions, archetype system. Can also load planning-dna for designing new entity workflows.

Lives in GLOBAL Discord category in `#command-center`. Opus high think. Natural language admin interface.

## Entity-Level Orchestration (Open Question)

How autonomous workflows run at the entity level is still open. Options include:
- Pat instances scoped to individual entities (same archetype, different context)
- A different archetype purpose-built for entity-level coordination
- The daemon handling entity orchestration directly (current approach)

This is a design decision to make after running the first real entities.

**Why:** Blueprints make standing up production-grade entities fast and consistent. Pat makes the system manageable from Discord (phone). Without Pat, admin tasks require SSH + CLI.

**How to apply:** Blueprint support needs: blueprint schema, blueprint loading in daemon, entity config inheritance/merge logic. Entity orchestration approach should be driven by real friction, not speculation.
