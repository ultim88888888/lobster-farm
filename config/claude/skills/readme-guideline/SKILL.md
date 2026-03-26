---
name: readme-guideline
description: >
  Directory documentation standards. Auto-loads when creating new directories,
  adding files to a directory, restructuring code, or modifying what a README
  describes.
---

# README Guideline

_Operational requirement. How we document directories across every project._

---

## The Rule

**Every significant directory gets a README.md.** A directory is significant if it contains more than one file that someone might need to understand, or if its purpose isn't obvious from its name and location alone.

**Update the README when you change what it describes.** Same commit. Not later. Not in a follow-up. If you add a file, update the file list. If you change a directory's responsibility, update the description. A stale README is worse than no README.

## What Goes in a Directory README

### Required

**Purpose** — what this directory is and why it exists. One to three sentences.

```markdown
# workers

Background job processors. Each worker handles a specific job type
from the task queue. Workers are spawned by the scheduler and run
independently.
```

**File inventory** — one line per file describing what it does.

```markdown
## Files

- `scheduler.ts` — Polls the queue, spawns workers, manages concurrency
- `email.worker.ts` — Sends transactional emails via Postmark
- `invoice.worker.ts` — Generates PDF invoices and uploads to S3
- `types.ts` — Shared types for job payloads and worker config
```

### Include When Useful

**Key concepts** — patterns, conventions, or non-obvious design choices that aren't clear from reading any single file.

```markdown
## Patterns

Workers follow a standard interface: `process(job: Job): Promise<Result>`.
The scheduler retries failed jobs with exponential backoff (max 3 attempts).
New workers must be registered in `scheduler.ts` to be discoverable.
```

**Relationships** — how this directory relates to other parts of the codebase, if not obvious.

```markdown
## Dependencies

Workers import job types from `../queue/types.ts`. Email templates
live in `../templates/email/` — workers reference them by name.
```

### Do NOT Include

- **Individual function or class signatures.** The code and types are the authority. A function list goes stale the moment someone adds a helper without updating the README.
- **Implementation details.** Don't duplicate what the code says. The README is a map, not a mirror.
- **Setup instructions for the whole project.** That belongs in the root README, not every subdirectory.
- **Changelogs or history.** That's what git is for.

## When to Create a README

- When you create a new directory with 2+ files
- When you notice a directory has no README and you're working in it
- When a directory's purpose has shifted and the existing README (or lack thereof) no longer reflects reality

## When to Update a README

- When you add, remove, or rename a file in the directory
- When you change a directory's responsibility or scope
- When you notice the README is wrong while working in the directory

**Do it in the same commit as the change.** Not as a follow-up task.

## Root README

The repository root README has a different job. It should cover:

- What the project is
- How to install and run it
- How to run tests
- High-level directory structure (pointing to subdirectory READMEs for detail)
- Any non-obvious setup steps

Keep it practical. Someone cloning the repo for the first time should be able to get running from the root README alone.
