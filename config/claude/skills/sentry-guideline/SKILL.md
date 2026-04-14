---
name: sentry-guideline
description: >
  Sentry error monitoring integration standards. Auto-loads when integrating
  Sentry, adding error tracking, setting up observability, or configuring
  alerting. Covers SDK init, error capture, breadcrumbs, cron monitoring,
  source maps, noise reduction, and webhook forwarding.
---

# Sentry Integration Guideline

_Universal standards for integrating Sentry into any LobsterFarm entity. Not project-specific -- this is the shared foundation._

---

## Philosophy

**Errors should wake you up, not drown you.** Good observability means every real problem surfaces quickly, and every non-problem stays quiet. The goal is a Sentry dashboard where every unresolved issue is actionable.

**Context is everything.** A bare stack trace is barely useful. Tags for filtering, structured context for debugging, breadcrumbs for the timeline -- these turn "something broke" into "here's exactly what happened."

**Capture at the boundary, not everywhere.** Instrument error boundaries, catch blocks, and integration points. Don't sprinkle `captureException` in every function -- that creates noise and duplicates.

---

## SDK Init Pattern

### Dedicated instrument file

Create a separate `instrument.ts` that initializes Sentry before anything else. The v8 SDK uses OpenTelemetry under the hood, so it **must** load before all other imports.

```typescript
// src/instrument.ts
import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || 'production',
  release: `{package-name}@${process.env.GIT_SHA || 'unknown'}`,
  sampleRate: 1.0,
  normalizeDepth: 5,
  attachStacktrace: true,
  maxBreadcrumbs: 50,
  sendDefaultPii: false,
  ignoreErrors: [
    /ECONNRESET/,
    /ECONNREFUSED/,
    /socket hang up/,
  ],
  beforeSend(event, hint) {
    // Filter known operational noise
    return event;
  },
});
```

### Loading order

For ESM projects (Node 18.19+), use the `--import` flag:

```bash
node --import ./dist/instrument.js ./dist/index.js
```

The `instrument.ts` must be a **separate build entry point** so it compiles independently. In tsup:

```typescript
entry: ['src/index.ts', 'src/instrument.ts'],
```

### DSN from environment

DSN comes from 1Password, injected via `op run`. Never hardcoded.

```
# .env.op
SENTRY_DSN=op://command-center/sentry/dsn
```

### Required config fields

| Field | Value | Why |
|-------|-------|-----|
| `dsn` | From env | Connection string |
| `environment` | `NODE_ENV` or `'production'` | Filters in Sentry UI |
| `release` | `{pkg}@{git-sha}` | Regression detection, source maps |
| `sampleRate` | `1.0` | All errors captured |
| `normalizeDepth` | `5` | Deep enough for nested context objects |
| `attachStacktrace` | `true` | Stack traces on `captureMessage` too |
| `maxBreadcrumbs` | `50` | Enough history without bloat |
| `sendDefaultPii` | `false` | No user IPs, cookies, etc. |

### tracesSampleRate

Set based on traffic volume:

- **Low-traffic services** (daemons, crons): `1.0` -- capture everything
- **Medium-traffic APIs**: `0.1` to `0.5`
- **High-traffic services**: `0.01` to `0.1`
- **Omit entirely** if you do not want tracing -- setting `0` still initializes OpenTelemetry machinery

---

## Error Capturing Standards

### captureException vs captureMessage

- `Sentry.captureException(error)` -- for Error objects (stack traces, grouping)
- `Sentry.captureMessage(msg, level)` -- for informational events without an error

### Never capture AND re-throw

This creates duplicates. Pick one:

```typescript
// WRONG: captured twice if caller also catches
catch (err) {
  Sentry.captureException(err);
  throw err;
}

// RIGHT: capture at the boundary, log for local visibility
catch (err) {
  console.error(`[module] Operation failed: ${err}`);
  Sentry.captureException(err, {
    tags: { module: 'module-name' },
    contexts: { operation: { /* relevant context */ } },
  });
}
```

### Always add context

Bare `captureException(error)` is an anti-pattern. Always include:

- **Tags** -- low-cardinality values for filtering/searching in the Sentry UI
- **Contexts** -- structured data viewable on the issue detail page

```typescript
Sentry.captureException(err, {
  tags: {
    module: 'webhook',
    entity: entity_id,
    webhook_source: 'github',
  },
  contexts: {
    pr: { number: pr.number, title: pr.title, branch: pr.headRefName },
  },
});
```

### Tag taxonomy

Standard tags every project should use:

| Tag | Description | Example values |
|-----|-------------|----------------|
| `module` | Which subsystem | `server`, `webhook`, `cron`, `pool` |
| `entity` | Which project/entity | `lobster-farm`, `alpha` |
| `environment` | Deploy environment | `production`, `staging`, `development` |

Plus domain-specific tags defined per project. Keep tag **values** low-cardinality. High-cardinality IDs (session IDs, PR numbers) go in `contexts`, not tags.

### Isolation scopes for non-HTTP work

For cron jobs, queue handlers, and subprocess execution, wrap in `withIsolationScope()` to prevent context bleed:

```typescript
Sentry.withIsolationScope(async (scope) => {
  scope.setTag('cron.job', 'pr-review');
  scope.setContext('tick', { entity_id, pr_count: prs.length });
  await process_tick();
});
```

---

## Breadcrumb Standards

### When to add manual breadcrumbs

- State transitions (lifecycle changes, phase advances)
- External service calls (API calls, webhook sends)
- Decision points (branching logic that affects behavior)

### When NOT to add breadcrumbs

- High-frequency events (every request, every heartbeat)
- Redundant with automatic instrumentation (HTTP requests are auto-captured)

### Category naming

Use `{domain}.{subcategory}`:

- `daemon.lifecycle` -- startup, shutdown, restart
- `daemon.pool` -- bot assignment, release, park, resume
- `daemon.feature` -- phase transitions
- `daemon.api` -- external API calls
- `daemon.state` -- config reloads, state mutations

```typescript
Sentry.addBreadcrumb({
  category: 'daemon.pool',
  message: `Assigned pool-${bot_id} to channel ${channel_id}`,
  level: 'info',
  data: { bot_id, channel_id, entity_id, archetype },
});
```

---

## Cron Monitoring

Wrap recurring tasks with `Sentry.captureCheckIn()`:

```typescript
const checkInId = Sentry.captureCheckIn(
  { monitorSlug: 'job-name', status: 'in_progress' },
  {
    schedule: { type: 'interval', value: 30, unit: 'minute' },
    checkinMargin: 5,
    maxRuntime: 15,
    failureIssueThreshold: 3,
    recoveryThreshold: 2,
  },
);

try {
  await run_job();
  Sentry.captureCheckIn({ checkInId, monitorSlug: 'job-name', status: 'ok' });
} catch (err) {
  Sentry.captureCheckIn({ checkInId, monitorSlug: 'job-name', status: 'error' });
  Sentry.captureException(err);
}
```

### Configuration guidelines

| Field | Rule |
|-------|------|
| `schedule` | Match the actual interval |
| `checkinMargin` | How late a check-in can be before considered missed. Set <= interval |
| `maxRuntime` | Based on expected duration + generous buffer |
| `failureIssueThreshold` | `3` -- avoid noise from single transient failures |
| `recoveryThreshold` | `2` -- require sustained recovery before resolving |

---

## Source Maps

### Build-time upload via esbuild plugin

For tsup/esbuild projects, use `@sentry/esbuild-plugin`:

```typescript
import { sentryEsbuildPlugin } from '@sentry/esbuild-plugin';

export default defineConfig({
  sourcemap: true,
  esbuildPlugins: process.env.SENTRY_AUTH_TOKEN ? [
    sentryEsbuildPlugin({
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
    }),
  ] : [],
});
```

### Conditional activation

The plugin only activates when `SENTRY_AUTH_TOKEN` is present. Local `npm run build` works without credentials. CI/CD builds inject secrets via `op run`.

### Build-time secrets

```
# .env.op (add alongside SENTRY_DSN)
SENTRY_AUTH_TOKEN=op://command-center/sentry/token
SENTRY_ORG=op://command-center/sentry/org
SENTRY_PROJECT=op://command-center/sentry/project
```

Build command: `op run --env-file .env.op -- npm run build`

---

## Release Tracking

### Format

`{package-name}@{git-sha-short}`

Example: `lobsterfarm-daemon@a1b2c3d`

For tagged releases, use semver: `lobsterfarm-daemon@1.2.3`

### Injection

Capture git SHA at build or startup time:

```bash
export GIT_SHA=$(git rev-parse --short HEAD)
```

Pass as environment variable to the running process.

---

## Noise Reduction

### beforeSend hook

Drop expected operational states that are handled by application logic:

```typescript
beforeSend(event, hint) {
  const err = hint.originalException;
  // Rate limits handled by retry logic
  if (err instanceof Error && err.message.includes('rate limit')) return null;
  return event;
},
```

### beforeSendTransaction hook

Drop high-frequency, low-value transactions:

```typescript
beforeSendTransaction(event) {
  if (event.transaction === 'GET /status') return null;
  return event;
},
```

### ignoreErrors

Regex patterns for transient network errors that resolve themselves:

```typescript
ignoreErrors: [
  /ECONNRESET/,
  /ECONNREFUSED/,
  /socket hang up/,
  /ETIMEDOUT/,
],
```

### Custom fingerprinting

When error messages contain dynamic data (IDs, timestamps), set a stable fingerprint:

```typescript
Sentry.captureException(err, {
  fingerprint: ['webhook-handler', entity_id, 'spawn-failure'],
});
```

Without this, each unique message creates a new issue.

### Alert rules

Configure in Sentry UI:
- Frequency thresholds, not every-event
- Different thresholds for different environments
- Digest mode for high-volume alerts

---

## Webhook Forwarding

### Sentry to Discord

For daemon-managed projects, forward Sentry alerts to the entity's Discord `#alerts` channel:

1. Create a Sentry Internal Integration with a webhook URL
2. Subscribe to `issue` events (created, resolved, assigned, archived)
3. Verify HMAC-SHA256 signature (`Sentry-Hook-Signature` header)
4. Read `Sentry-Hook-Resource` header for event type
5. Respond 200 within 1 second (Sentry timeout) -- process asynchronously
6. Map Sentry project to entity, format embed, post to `#alerts`

### Signature verification

```typescript
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify_sentry_signature(body: string, signature: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}
```

---

## Graceful Shutdown

Call `Sentry.flush()` before process exit to ensure pending events are sent:

```typescript
process.on('SIGTERM', async () => {
  await Sentry.flush(2000); // 2 second timeout
  process.exit(0);
});
```

For uncaught exceptions, flush synchronously before crashing:

```typescript
process.on('uncaughtException', async (err) => {
  Sentry.captureException(err, { tags: { severity: 'fatal' } });
  await Sentry.flush(2000);
  process.exit(1);
});
```

---

## Background Task Safety Nets

Errors inside fire-and-forget background tasks silently vanish unless explicitly handled. This is the #1 source of invisible production failures. **Every project needs both layers.**

### Python (asyncio)

**Layer 1: Global safety net** — catches ANY unhandled exception from ANY `create_task()` call. Set once at startup, inside your async entry point (where a loop is guaranteed to be running):

```python
import sentry_sdk

def handle_task_exception(loop, context):
    exception = context.get("exception")
    if exception:
        logger.error("unhandled_task_exception", error=str(exception), exc_info=exception)
        sentry_sdk.capture_exception(exception)

async def main():
    loop = asyncio.get_running_loop()
    loop.set_exception_handler(handle_task_exception)
    # ... rest of startup
```

> **Note:** Use `asyncio.get_running_loop()` inside an `async def`, not `asyncio.get_event_loop()` at module level. The latter is deprecated in Python 3.10+ and can raise `RuntimeError` in 3.12+ outside the main thread.

**Layer 2: Per-task wrapper** — for tasks you want structured logging and error handling on:

```python
def create_monitored_task(coro, *, name=None):
    async def _wrapper():
        try:
            return await coro
        except Exception:
            logger.error("background_task_failed", task=name, exc_info=True)
            sentry_sdk.capture_exception()
    return asyncio.create_task(_wrapper(), name=name)
```

Replace all bare `asyncio.create_task()` calls with `create_monitored_task()`. The global handler is the fallback for anything you miss.

### Node.js / TypeScript

**Layer 1: Global safety net** — unhandled promise rejections:

```typescript
process.on('unhandledRejection', (reason) => {
  Sentry.captureException(reason, { tags: { source: 'unhandledRejection' } });
  console.error('[sentry] Unhandled rejection:', reason);
});
```

**Layer 2: Per-task wrapper** — for fire-and-forget async work:

```typescript
function monitoredTask(fn: () => Promise<void>, name: string): void {
  fn().catch((err) => {
    Sentry.captureException(err, { tags: { task: name } });
    console.error(`[${name}] Background task failed:`, err);
  });
}
```

### The rule

**Never use bare `create_task()` or fire-and-forget `Promise` in production code.** Every background task must have an error path that reports to Sentry. The global handler is the safety net, not the primary mechanism.

---

## Deployment Verification

SDK integration in code is not enough. Every deployment target must have Sentry enabled and configured at the environment level. Sonar had the SDK wired in but `SENTRY_ENABLED` missing from ECS service definitions — resulting in months of silent failures.

### Required environment variables per deployment target

Every service, scheduled task, Lambda, or worker that runs in production:

| Variable | Value | Notes |
|----------|-------|-------|
| `SENTRY_DSN` | From 1Password | Per-project DSN — SDK is inert without it |
| `SENTRY_ENABLED` | `true` | Infrastructure-level gate (see below) |
| `SENTRY_ENVIRONMENT` | `production` / `staging` | Filters in Sentry UI |

**How SENTRY_ENABLED and SENTRY_DSN relate:** `SENTRY_ENABLED` is an infrastructure-level gate, not a code-level guard. You do **not** need an `if (SENTRY_ENABLED)` check before `Sentry.init()` — the SDK is inert when `dsn` is undefined/empty. The purpose of `SENTRY_ENABLED` is to ensure that deployment tooling (Terraform, ECS task definitions, CI pipelines) explicitly includes the DSN in each target's environment. Without it, a deployment target can silently omit `SENTRY_DSN` and nobody notices until months later. Think of it as a deployment checklist flag: if `SENTRY_ENABLED=true` is set but `SENTRY_DSN` is missing, your deployment config has a bug.

### Verification checklist

After enabling Sentry on any deployment target:

1. **Trigger a test error** — throw an intentional exception in each service
2. **Confirm it appears in Sentry** — check the project dashboard within 60 seconds
3. **Confirm daemon webhook fires** — check the entity's #alerts channel for the triage alert
4. **Audit all deployment targets** — list every ECS service, task definition, Lambda, cron job. Each one must have the three env vars above. If any are missing, fix immediately.

### Common gaps

- ECS **task definitions** vs **services** — a task def can have Sentry, but if the service uses an older revision, it's not active. Always verify the running revision.
- **Scheduled tasks** (EventBridge rules) — these often use separate task definitions from the main service. Check each one.
- **Frontend SSR** — Next.js server-side rendering runs in a different context than the client. Both need Sentry configs (`sentry.server.config.ts` + `sentry.client.config.ts`).

---

## Adding Sentry to an Existing Entity

Step-by-step checklist for wiring Sentry into an entity that was created without it.

### 1. Create Sentry project(s)

One project per deployable service (e.g., `canal-street-backend`, `canal-street-frontend`). Create in the Sentry dashboard or via API.

### 2. Store credentials in 1Password

In the entity's vault (`entity-{id}`):

```
sentry/dsn          → the project DSN
sentry/token        → auth token (for source maps, if needed)
sentry/org          → org slug
sentry/project      → project slug
```

### 3. Update entity config

Add to `~/.lobsterfarm/entities/{id}/config.yaml`:

```yaml
accounts:
  sentry:
    projects:
      - slug: {entity}-backend
        type: backend
        repo: {repo-name}
      - slug: {entity}-frontend
        type: frontend
        repo: {repo-name}
```

### 4. Update entity CLAUDE.md

Add an Observability section so every agent session knows Sentry is required:

```markdown
## Observability
- **Sentry**: enabled. Projects: `{entity}-backend`, `{entity}-frontend`
- DSN: `op://entity-{id}/sentry/dsn`
- Load `sentry-guideline` skill when adding error tracking to any new service
- All deployable services must have Sentry integrated before first production deploy
```

### 5. Wire SDK into each service

Follow the SDK Init Pattern section above. Key points:
- Dedicated `instrument.ts` (Node) or `sentry.py` (Python) loaded before all other imports
- DSN from environment, never hardcoded
- Add `.env.op` entries for `SENTRY_DSN`

### 6. Add background task safety nets

Follow the Background Task Safety Nets section above. Both layers:
- Global exception handler (asyncio / unhandledRejection)
- Per-task monitored wrapper for all `create_task()` / fire-and-forget calls

### 7. Enable in ALL deployment targets

Every ECS service, task definition, scheduled task, Lambda — set `SENTRY_ENABLED=true`, `SENTRY_DSN`, `SENTRY_ENVIRONMENT` in each one. See Deployment Verification section.

### 8. Set up daemon webhook

If not already done for this entity:
- Ensure the Sentry Internal Integration webhook points at the daemon (`POST /webhooks/sentry`)
- Webhook secret stored in 1Password: `op://entity-{id}/sentry/webhook-secret`
- Entity config has `accounts.sentry.projects` mapping so the daemon routes events correctly

### 9. Verify end-to-end

- [ ] Trigger a test error in each service
- [ ] Error appears in Sentry dashboard
- [ ] Daemon webhook fires and posts to entity's #alerts
- [ ] Ray triage spawns (if auto-triage is configured)

---

## Anti-Patterns

| Anti-pattern | Why it's bad | Fix |
|-------------|-------------|-----|
| Capturing every 4xx | Floods dashboard with expected behavior | Only capture 5xx and unexpected 4xx |
| Dynamic data in error messages | `"Failed for PR #${n}"` creates N separate issues | Use stable message + context/tags for the variable part |
| Bare `captureException(error)` | No context makes triage impossible | Always add tags and contexts |
| `tracesSampleRate: 0` | Still initializes OpenTelemetry machinery | Omit the field entirely to disable tracing |
| Never resolving issues | Kills regression detection -- new occurrences blend in | Resolve issues when fixed; Sentry reopens on regression |
| Capturing AND re-throwing | Duplicates every error | Capture at the boundary only |
| Hardcoded DSN in source | Credential leak, can't rotate | Use env var via 1Password |
| Bare `create_task()` / fire-and-forget Promise | Errors silently vanish | Use `create_monitored_task()` + global exception handler |
| `SENTRY_ENABLED` missing from deployment target | Code has SDK but runtime never initializes | Audit every ECS service, task def, Lambda — all need the env var |

---

## Secrets

All Sentry credentials in 1Password:

```
# .env.op
SENTRY_DSN=op://command-center/sentry/dsn
SENTRY_AUTH_TOKEN=op://command-center/sentry/token
SENTRY_ORG=op://command-center/sentry/org
SENTRY_PROJECT=op://command-center/sentry/project
```

- DSN injected at runtime via `op run`
- Auth token injected at build time for source map upload
- Never in code, never in CI env vars directly, never in `.env` files committed to git
