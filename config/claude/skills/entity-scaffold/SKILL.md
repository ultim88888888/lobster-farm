---
name: entity-scaffold
description: >
  Entity scaffolding process — creating a new entity from a blueprint.
  Auto-loads when setting up a new entity, creating a project, or
  scaffolding infrastructure for a new business/client.
---

# Entity Scaffold SOP

_The process for standing up a new entity in LobsterFarm._

---

## Inputs

Three required, one optional:

| Input | Required | Example |
|-------|----------|---------|
| **Entity name** | Yes | "My SaaS App" |
| **Description** | Yes | "B2B invoicing platform" |
| **Blueprint** | Yes | `software` |
| **Repo strategy** | Optional | `new`, `clone`, `existing`, or `none` (default: ask) |

Do NOT ask for tech stack — that's determined during planning, not scaffolding. Do NOT ask unnecessary questions. If something has a sensible default, use it.

## Entity ID

Derive from the entity name: lowercase, alphanumeric, hyphens only. Example: "My SaaS App" → `my-saas-app`.

## Steps

### 1. Read the blueprint

```bash
cat ~/.lobsterfarm/blueprints/{blueprint}/blueprint.yaml
```

The blueprint defines: archetypes, SOPs, guidelines, channel structure, model tiers, and scaffolding defaults. All subsequent steps reference this.

### 2. Create entity directory structure

```
~/.lobsterfarm/entities/{id}/
├── config.yaml          # Entity configuration
├── MEMORY.md            # Shared entity knowledge
├── context/             # Reference docs
│   ├── decisions.md     # Append-only decision log
│   └── gotchas.md       # Known issues and workarounds
├── daily/               # Session logs (staging for MEMORY.md)
├── files/               # Arbitrary entity files
└── repos/               # Entity codebases (optional)
    └── {repo-name}/     # Git repo(s)
```

```bash
mkdir -p ~/.lobsterfarm/entities/{id}/context
mkdir -p ~/.lobsterfarm/entities/{id}/daily
mkdir -p ~/.lobsterfarm/entities/{id}/files
mkdir -p ~/.lobsterfarm/entities/{id}/repos
```

### 3. Write entity config

The config references the blueprint. Only include overrides if the entity deviates from blueprint defaults. Model tiers and SOPs come from the blueprint — don't duplicate them here.

```yaml
entity:
  id: {id}
  name: {name}
  description: {description}
  status: active
  blueprint: {blueprint}

  repos:                     # Optional — omit for non-code entities
    - name: {repo_name}
      url: {repo_url}
      path: {local_path}
      structure: monorepo  # or polyrepo

  accounts:
    github:
      user: {github_user}

  channels:
    category_id: ""        # Populated by step 6
    list: []               # Populated by step 6

  # Override blueprint defaults only if needed:
  # sop_overrides:
  #   remove: [sentry-triage]
  #   add: [custom-deploy]
  # guideline_overrides:
  #   remove: [sentry-guideline]

  memory:
    path: ~/.lobsterfarm/entities/{id}
    auto_extract: true

  secrets:
    vault: 1password
    vault_name: entity-{id}
```

### 4. Initialize memory

Write `MEMORY.md`:

```markdown
# {Entity Name} — Entity Memory

## Overview
{description}

## Architecture Decisions
_(to be filled as decisions are made)_

## Gotchas
_(to be filled as discovered)_
```

Write `context/decisions.md` and `context/gotchas.md` from blueprint templates.

### 5. Handle repo

Based on the repo strategy:

**`new`** — Create a GitHub repo and clone it:
```bash
cd ~/.lobsterfarm/entities/{id}/repos
gh repo create {github_org}/{id} --private --clone --description "{description}"
```

**`clone`** — Clone an existing repo:
```bash
git clone {repo_url} ~/.lobsterfarm/entities/{id}/repos/{repo_name}
```

**`existing`** — Move or symlink an already-cloned repo:
```bash
mv {existing_path} ~/.lobsterfarm/entities/{id}/repos/{repo_name}
# or symlink if you want to keep the original location:
ln -sf {existing_path} ~/.lobsterfarm/entities/{id}/repos/{repo_name}
```

**`none`** — Skip repo setup. Entity has no codebase (personal assistant, content entity, research entity, etc.). The entity still gets MEMORY.md, context/, and daily/ — memory is the primary artifact.

If the repo exists, ensure it has a `CLAUDE.md` with project-level facts (stack, how to run tests, structure). Create one if missing.

### 6. Scaffold Discord channels

Use the daemon API to create the entity's Discord category and channels (defined by the blueprint):

```bash
curl -s -X POST http://localhost:7749/scaffold/entity \
  -H 'Content-Type: application/json' \
  -d '{"entity_id": "{id}", "entity_name": "{name}"}'
```

The daemon handles Discord authentication internally — **never access Discord tokens directly.** See the `secrets-guideline` skill.

The endpoint returns the category ID and channel IDs. Update the entity config with these.

### 7. Register with daemon

Tell the daemon to reload its entity registry so it picks up the new entity:

```bash
curl -s -X POST http://localhost:7749/reload
```

### 8. Confirm

Report what was created:
- Entity ID and name
- Blueprint used
- Config path
- Repo status (created/cloned/linked/none)
- Discord channels created (count and category name)
- Any errors or workarounds used

**Always report errors and workarounds, even if you found a fallback path.**

## What NOT to do

- Don't ask for tech stack (determined during planning)
- Don't list SOPs or model tiers in entity config (they come from the blueprint)
- Don't skip Discord scaffolding without explaining why
- Don't report success if core files are missing
- Don't create files the blueprint doesn't specify
- Don't access Discord tokens or any secrets directly — use daemon endpoints or `op run`
