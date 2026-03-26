---
name: secrets-guideline
description: >
  Secret management and credential security standards. Auto-loads when
  working with API keys, tokens, environment variables, authentication,
  connecting external services, or any code that touches credentials.
---

# Secrets Guideline

_Operational requirement. How we handle secrets across every entity._

---

## The Rule

**Never handle raw secrets.** Not in code. Not in variables. Not in commands. Not "temporarily." Not in test fixtures.

## 1Password is the Source of Truth

All secrets live in 1Password. No exceptions.

### Vault Structure

| Vault | Contains | Example |
|-------|----------|---------|
| `command-center` | Global service profiles shared across all entities | Sentry DSN, Vercel token, domain registrar |
| `lobsterfarm` | Platform-level credentials | Discord bot tokens, daemon secrets |
| `entity-{id}` | Entity-specific secrets | Supabase keys, third-party API keys for that project |

### Access Patterns

**For running commands that need secrets:**
```bash
op run --env-file .env.op -- <command>
```

The `.env.op` file maps env var names to 1Password references:
```
SUPABASE_KEY=op://entity-my-app/supabase/api-key
SENTRY_DSN=op://command-center/sentry/dsn
DISCORD_TOKEN=op://lobsterfarm/discord-daemon/token
```

`op run` resolves references at runtime. Secrets are injected as env vars into the child process. They never touch disk, shell history, `ps` output, or stdout.

**For code that reads config at startup:**
```
# .env.op (committed — contains references, not values)
DATABASE_URL=op://entity-my-app/supabase/connection-string

# Usage
op run --env-file .env.op -- node server.js
```

## What NOT to Do

### Never use `op read` in agent sessions
```bash
# BAD — secret goes to stdout, gets captured in session logs
TOKEN=$(op read "op://vault/item/field")
curl -H "Authorization: Bearer $TOKEN" ...

# GOOD — secret never visible to the agent
op run --env-file .env.op -- curl -H "Authorization: Bearer $ENV_VAR" ...
```

`op read` outputs the secret to stdout. In a Claude Code session, tool results (including stdout) are logged to JSONL session files on disk. The secret is now in plain text in `~/.claude/projects/*/session.jsonl`. This is a leak.

### Never hardcode secrets in commands
```bash
# BAD — token in command args, visible in ps, logged in session
curl -H "Authorization: Bearer sk-abc123..." https://api.example.com

# GOOD — use op run
op run --env-file .env.op -- curl -H "Authorization: Bearer $API_KEY" https://api.example.com
```

### Never put secrets in files (even temporarily)
```bash
# BAD
echo "sk-abc123" > .env
echo "export TOKEN=sk-abc123" >> ~/.zshrc

# GOOD — .env.op with references only
echo "API_KEY=op://entity-my-app/service/api-key" > .env.op
```

## File Conventions

| File | Contains | Committed |
|------|----------|-----------|
| `.env.op` | 1Password references (`op://...`) | Yes |
| `.env.example` | Required var names, no values | Yes |
| `.env` | Resolved values (runtime only) | **Never** — gitignored |

## When the Daemon Has the Secret

Some operations don't need agent access to secrets at all. If the daemon already has a connection (e.g., Discord), use the daemon's API endpoint instead of accessing the credential yourself.

```bash
# BAD — agent fetches Discord token and hits API directly
op run --env-file .env.op -- curl https://discord.com/api/...

# GOOD — agent asks the daemon, which already has the connection
curl -s -X POST http://localhost:7749/scaffold/entity \
  -H 'Content-Type: application/json' \
  -d '{"entity_id": "my-app", "entity_name": "My App"}'
```

## Onboarding a New Service

1. Add credentials to the appropriate 1Password vault
2. Create or update `.env.op` with the reference
3. If the service needs a persistent connection or receives webhooks, add a daemon endpoint
4. Update `~/.lobsterfarm/tools.md` with the service entry
5. Test with `op run` before using in production

## Escalation

**Always escalate to the user** before:
- Creating new 1Password vaults
- Modifying vault access policies
- Adding credentials for services that cost money
- Any action that could expose secrets to external systems
