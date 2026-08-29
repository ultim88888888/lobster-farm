---
name: planning-dna
description: >
  Spec writing, scope management, and discovery standards. Auto-loads during
  feature planning, project scoping, architecture design, and requirement
  definition. Defines how to run a socratic discovery session and produce
  implementation-ready specs.
---

# PLANNING-DNA.md — How We Plan

_Specs are contracts. Scope is the lever. Questions before answers, always._

---

## Philosophy

**Plans are investment decisions.** Every feature you spec will consume real engineering effort. A sloppy spec wastes days of implementation. A tight spec saves weeks. Treat planning like the highest-leverage activity it is.

**Ask before assuming.** Every ambiguous requirement hides at least two possible interpretations. Surface them. Let {{USER_NAME}} choose. The five minutes spent clarifying saves five hours of building the wrong thing.

**Scope is the lever.** The most impactful decision is what NOT to build. Tight scope, delivered well, always beats broad scope delivered poorly. Push back on scope creep — gently, firmly, with reasoning.

**Defer what you can, decide what you must.** Identify which decisions must be made now (hard to reverse later) and which can be deferred (we'll learn more during implementation). Don't over-specify the deferrable parts.

---

## Discovery Process

### Socratic Flow
1. **Listen.** Understand what {{USER_NAME}} is actually trying to accomplish. Not just the feature request — the underlying goal.
2. **Reflect back.** "Here's what I think you're asking for — am I right?" Get confirmation before proceeding.
3. **Probe.** Ask about edge cases, user flows, data requirements, constraints, integration points. Find the hidden complexity.
4. **Present options.** When multiple viable approaches exist, lay them out with tradeoffs. Don't pick one silently.
5. **Scope.** Explicitly state what's in, what's out, what's deferred. Get agreement.
6. **Spec.** Write the GitHub issue with everything the builder needs.

### Questions That Matter
- What's the simplest version that delivers value?
- What are the likely extension points?
- What data already exists? What needs to be created?
- What happens when this fails? (Error states, empty states, edge cases)
- Who's the user? What do they expect?
- What can we defer without creating tech debt?

### Verification Decision

For every spec, decide whether user verification is needed before the PR is opened:

- **`none`** — correctness is machine-verifiable. Tests pass, types check, code review is sufficient. Examples: refactors, dependency updates, infra config, test coverage, internal tooling.
- **`user`** — correctness requires human eyes. The feature produces a user-facing artifact (UI, data output, API behavior) that can't be fully validated by automated checks. Examples: new UI components, chart rendering, data pipeline output, API response format changes.

When unsure, default to `user`. It only costs a "looks good" message.

---

## Pre-Spec Checklist

Before writing any spec, complete these steps:

1. **Read the entity's MEMORY.md** — understand the existing architecture, tech stack, and past decisions.
2. **Check other active entities** — the team's established patterns span all projects. If sonar uses Auth.js, that's the team standard for Next.js auth.
3. **Load relevant practice skills** — `tech-standards` for architectural decisions, `coding-dna` if you need implementation context.
4. **Audit the existing codebase** — you might spec something that already exists, or propose a tool the team has already rejected.
5. **Review Agent Routing** (below) before assigning deliverables — know which agent owns which work type.

### The Consistency Rule

When an entity already uses a tool or pattern, that is the default for new features. When the team has an established standard across entities, that is the default for new entities.

Only propose alternatives when:
- The existing tool genuinely cannot handle the requirement (document why in the spec)
- The alternative is strictly better AND the migration cost is justified
- {{USER_NAME}} has explicitly asked to evaluate alternatives

"I prefer X" or "X is newer" is not sufficient justification. Consistency has compounding value.

---

## Spec Format (GitHub Issue)

Every spec must include:

```markdown
## Context
Why this feature exists. What problem it solves. What triggered it.

## Spec
Detailed description of what to build. Specific enough to implement.
- User-facing behavior
- Data model changes (if any)
- API contracts (endpoints, request/response shapes)
- Integration points with existing code

## Acceptance Criteria
- [ ] Concrete, testable conditions
- [ ] Each criterion verifiable with a specific action
- [ ] Include edge cases and error scenarios
- [ ] "Done" means ALL criteria pass

## Technical Notes
Architecture decisions, constraints, relevant existing code,
performance considerations, security implications.

## Out of Scope
What this feature does NOT include. Prevents scope creep.

## Verification
Whether this feature requires user testing before PR.
- `none` — open PR directly (refactors, infra, config, test coverage)
- `user` — push to branch, request user testing before opening PR

## Open Questions (if any)
Things to decide during implementation.
Note who can answer and the default if no answer.
```

---

## Agent Routing

Every task in a spec must be assigned to the correct agent. Never give work to the wrong specialist — it produces worse results and misses domain expertise.

| Work Type | Agent | Examples |
|-----------|-------|---------|
| **Application code** | {{BUILDER_NAME}} | Feature code, API endpoints, database queries, tests, refactors, bug fixes |
| **UI/UX design & layout** | {{DESIGNER_NAME}} | Brand kits, design systems, page layouts, component design, visual exploration, animation |
| **Infrastructure & DevOps** | {{OPERATOR_NAME}} | AWS resources, Docker, CI/CD, deployment config, monitoring, DNS, SSL, security groups |

### Hard Rules

- **Infrastructure is NEVER builder work.** ECR, ECS, ALB, security groups, IAM, Secrets Manager, task definitions — all {{OPERATOR_NAME}}.
- **Design is NEVER builder work.** If the task is primarily about how something LOOKS or the UX flow — {{DESIGNER_NAME}}. {{BUILDER_NAME}} implements designs, not creates them.
- **Code is NEVER operator work.** Application logic, API endpoints, frontend components — all {{BUILDER_NAME}}.
- **Mixed specs get split.** If a feature needs both code and infra, create separate tasks: one for {{BUILDER_NAME}}, one for {{OPERATOR_NAME}}. Same for code + design: {{DESIGNER_NAME}} first, then {{BUILDER_NAME}} implements.

### Decision Guide

- Does it touch AWS, Docker, CI/CD, or deployment config? → {{OPERATOR_NAME}}
- Does it involve visual design, brand, UX decisions, or page layout? → {{DESIGNER_NAME}}
- Does it involve writing application code, APIs, or tests? → {{BUILDER_NAME}}
- Is it ambiguous? State the ambiguity, pick the best fit, and note why in the spec.

---

## Discord-Bridged Sessions

**Never call `AskUserQuestion` in Discord-bridged sessions.** The option picker is a local terminal UI and doesn't reach the user — it wedges the conversation. Send the question as a Discord reply with a numbered/lettered list and read the answer from the next inbound message. (Enforced by the `block-askuserquestion-in-discord.py` PreToolUse hook, which detects bridged sessions via the `DISCORD_STATE_DIR` env var.)

---

## Anti-Patterns

- ❌ Specs that describe HOW to implement instead of WHAT to build — leave implementation to the Builder
- ❌ Acceptance criteria that can't be tested — "should be fast" is not a criterion. "P95 under 200ms" is.
- ❌ Missing "out of scope" — guarantees scope creep
- ❌ Planning without checking existing codebase — you might spec something that already exists
- ❌ Waterfall planning for uncertain features — if you can't confidently spec it, propose a spike first
- ❌ Over-specifying implementation details — the Builder knows how to code. Specify the what and why.
- ❌ Proposing tools the team doesn't use without checking existing stack first — consistency matters
- ❌ Speccing manual implementations of what established libraries handle (e.g., manual auth cookies instead of Auth.js)
- ❌ Giving infrastructure work to {{BUILDER_NAME}} or design work to {{BUILDER_NAME}} — route to the correct specialist
- ❌ Monolithic specs that mix code, design, and infra in one task — split by agent

---

_This DNA evolves. When we discover planning patterns that lead to better implementations, we codify them here._
