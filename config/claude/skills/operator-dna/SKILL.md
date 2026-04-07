---
name: operator-dna
description: >
  CI/CD, deployment, and infrastructure standards. Auto-loads when setting up
  CI pipelines, configuring deploys, managing branch protection, or handling
  infrastructure for any entity. The operational counterpart to coding-dna.
---

# OPERATOR-DNA.md — Infrastructure Standards

_How we ship. CI catches mistakes, deploys are automated, failures are loud._

---

## Philosophy

**Automate the guardrails.** Every production repo should have CI that catches lint, type, and build errors before merge. Humans review logic; machines catch syntax.

**Deploys should be boring.** Push to main, it deploys. No manual steps, no SSH, no "run this script." If a deploy needs a human, the pipeline is incomplete.

**Failures are loud.** A failing deploy that nobody notices is worse than no deploy at all. Every failure surfaces in #alerts within seconds.

**Secrets never touch disk.** Not in workflow files, not in env vars committed to git, not in "temporary" scripts. 1Password is the source of truth; GitHub secrets is the delivery mechanism for CI.

---

## CI Pipeline Standards

### Requirements

Every repo with production code must have CI workflows. No exceptions.

**Minimum checks:**

| Language | Checks | Tools |
|----------|--------|-------|
| TypeScript / JavaScript | Lint, Type-check, Build | Biome, `tsc --noEmit`, `next build` or `vite build` |
| Python | Lint, Type-check | Ruff, mypy |

### Workflow Structure

**Naming:** One workflow per deployable unit. For monorepos, split by service:
```
.github/workflows/
  ci-frontend.yml     # not "ci.yml" — be specific
  ci-backend.yml
  deploy.yml          # single deploy workflow with path-filtered jobs
```

**Trigger:** Pull requests targeting `main`:
```yaml
on:
  pull_request:
    branches: [main]
    paths:
      - "apps/frontend/**"    # path-filter for monorepos
```

**Job naming:** Descriptive names that make sense in GitHub's UI and branch protection:
```yaml
jobs:
  ci:
    name: Lint / Type-check / Build    # not "ci" or "test"
```

### Path Filtering for Monorepos

Only run checks for code that changed. A frontend-only PR shouldn't wait for backend CI:
```yaml
on:
  pull_request:
    paths:
      - "apps/backend/**"
```

**Gotcha:** If a required status check doesn't run (because paths didn't match), GitHub may block the PR. Solutions:
- Use `dorny/paths-filter` inside a single workflow instead of `on.paths`
- Or set required checks to only the ones that always run

> **Pin third-party actions to a commit SHA in production.** Version tags like `@v3` are mutable — the maintainer can push breaking changes to the tag at any time. Use `@<commit-sha>` with a version comment: `uses: dorny/paths-filter@de90cc6415e2769e4909a7b1e1eb6ecd11855ea2  # v3.0.2`

---

## Deploy Pipeline Standards

### Structure

Deploys trigger on push to `main` (post-merge). Never from feature branches.

```yaml
name: Deploy

on:
  push:
    branches: [main]

concurrency:
  group: deploy-${{ github.ref }}
  cancel-in-progress: true          # new merge cancels in-progress deploy
```

### Docker + ECR + ECS Pattern

This is our standard deploy flow for containerized services:

```
1. Detect changes (path filter — only deploy changed services)
2. Configure AWS credentials
3. Login to ECR
4. Build Docker image (with BuildKit caching)
5. Push to ECR (tagged :latest and :sha)
6. Force new ECS deployment
7. Wait for service stability
```

**Image tagging:** Always tag with both `latest` and the short SHA:
```yaml
- name: Get short SHA
  id: vars
  run: echo "sha=$(git rev-parse --short HEAD)" >> "$GITHUB_OUTPUT"

# Then in the docker/build-push-action step:
tags: |
  ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:latest
  ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ steps.vars.outputs.sha }}
```

**Build caching:** Use GitHub Actions cache to speed up Docker builds:
```yaml
cache-from: type=gha,scope=backend
cache-to: type=gha,mode=max,scope=backend
```

**Stability check:** Always wait for the service to stabilize after deploy:
```yaml
- name: Wait for deployment stability
  run: |
    aws ecs wait services-stable \
      --cluster $CLUSTER \
      --services $SERVICE
```

### Change Detection

For monorepos, only deploy services with changed files:

```yaml
jobs:
  changes:
    name: Detect changes
    runs-on: ubuntu-latest
    outputs:
      backend: ${{ steps.filter.outputs.backend }}
      frontend: ${{ steps.filter.outputs.frontend }}
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5           # v4.3.1
      - uses: dorny/paths-filter@d1c1ffe0248fe513906c8e24db8ea791d46f8590        # v3.0.3
        id: filter
        with:
          filters: |
            backend:
              - 'apps/backend/**'
            frontend:
              - 'apps/frontend/**'

  deploy-backend:
    needs: changes
    if: needs.changes.outputs.backend == 'true'
    # ...
```

---

## Branch Protection

### Setup

Required for all repos with production code. Configure via GitHub API:

```bash
gh api repos/{owner}/{repo}/branches/main/protection \
  --method PUT \
  --field "required_status_checks[strict]=false" \
  --field "required_status_checks[contexts][]=Lint / Type-check / Build" \
  --field "required_status_checks[contexts][]=Lint / Type-check" \
  --field "enforce_admins=false" \
  --field "required_pull_request_reviews=null" \
  --field "restrictions=null"
# Note: --field sends JSON null for "null" values (not the string "null").
# Don't use --raw-field here — it would send the string "null" and break the API call.
```

### Rules

- **Require CI status checks to pass** — add the CI job names as required checks
- **Do NOT require deploy checks** — deploy runs post-merge on main, not on PRs
- **Do NOT require "up to date with base"** — auto-rebase (#166) handles diverged branches
- **Do NOT require PR reviews** — the AutoReviewer handles this programmatically

### Required Checks

The check names must match the `jobs.<job_id>.name` field in your CI workflow:

```yaml
# ci-frontend.yml
jobs:
  ci:
    name: Lint / Type-check / Build    # this is the required check name
```

Add each CI job name to the branch protection rule. For a monorepo with frontend and backend:
- `Lint / Type-check / Build` (frontend)
- `Lint / Type-check` (backend)

---

## Secrets Management for CI

### GitHub Secrets

Secrets for CI/CD live in GitHub repo settings, Secrets and variables, Actions.

**Setting secrets via CLI** (preferred — avoids web UI whitespace issues):
```bash
gh secret set AWS_ACCESS_KEY_ID --repo owner/repo
# Prompts for value via stdin — paste cleanly, no whitespace issues

gh secret set AWS_SECRET_ACCESS_KEY --repo owner/repo
gh secret set AWS_REGION --repo owner/repo
```

**Common secrets:**

| Secret | Purpose | Source |
|--------|---------|--------|
| `AWS_ACCESS_KEY_ID` | ECR/ECS deploy authentication | AWS IAM, stored in 1Password |
| `AWS_SECRET_ACCESS_KEY` | ECR/ECS deploy authentication | AWS IAM, stored in 1Password |
| `AWS_REGION` | AWS region for deploy | Entity config |

### Rules

- **Source of truth is 1Password.** When you create AWS credentials or API keys, store them in the entity's 1Password vault first, then set the GitHub secret from there.
- **Never hardcode in workflow files.** Always reference via `${{ secrets.NAME }}`.
- **Document required secrets** in the repo's `.env.example` or README so it's clear what needs to be configured.
- **Rotate regularly.** When rotating, update both 1Password and `gh secret set`.

### 1Password GitHub Actions Integration

For repos where avoiding manual GitHub Secrets sync is worth the added complexity, the `1password/load-secrets-action` lets workflows pull secrets directly from 1Password at runtime. This eliminates the dual-update problem on rotation — update the secret in 1Password and CI picks it up automatically.

```yaml
- uses: 1password/load-secrets-action@581a835fb51b8e7ec56b71cf2ffddd7e68bb25e0  # v2.0.0
  with:
    export-env: true
  env:
    OP_SERVICE_ACCOUNT_TOKEN: ${{ secrets.OP_SERVICE_ACCOUNT_TOKEN }}
    AWS_ACCESS_KEY_ID: op://vault/item/access-key-id
    AWS_SECRET_ACCESS_KEY: op://vault/item/secret-access-key
```

**Trade-off:** Requires a 1Password Service Account and a single `OP_SERVICE_ACCOUNT_TOKEN` GitHub secret. The benefit is that all other secrets are managed exclusively in 1Password — no more `gh secret set` on every rotation. Use this for repos with many secrets or frequent rotation; stick with plain GitHub Secrets for simpler setups.

---

## Failure Handling

### CI Failure on PR

1. Branch protection blocks merge
2. AutoReviewer checks `gh pr checks` and won't merge if failing
3. Builder sees failures and can fix in the same session

### Deploy Failure on Main

1. Daemon receives `workflow_run` webhook with `conclusion: failure`
2. Daemon sends alert to entity's #alerts channel
3. Agent or human investigates

### Persistent Failures

If the same deploy keeps failing:
1. First failure: automatic #alerts notification
2. Check the workflow logs: `gh run view <run-id> --log-failed --repo owner/repo`
3. Common causes: expired credentials, Docker build errors, ECS task definition issues
4. Fix and push to main — concurrency setting cancels stale deploys

### Escalation

Escalate to the user when:
- Deploy failure requires credential rotation or IAM changes
- Infrastructure needs modification (ECS task definitions, cluster config)
- The failure pattern suggests an architectural issue, not a config bug

---

## Environment Strategy

### Current Model

```
local dev > feature branch > PR (CI runs) > merge to main > deploy to production
```

- **Local:** Developer runs the app locally, tests manually
- **Feature branch:** Code changes on a branch, PR opened
- **CI:** Lint, type-check, build — must pass before merge
- **Main:** Merge triggers deploy to production
- **User verification:** For features with user-facing artifacts, user tests locally before PR is opened (verification gate)

### Future: Staging

When the user base grows and zero-downtime matters:
- Add a staging environment (separate ECS service, separate DB)
- Deploy to staging on merge to main
- Promote to production manually or after automated smoke tests
- This is a future decision — not needed yet

---

## Anti-Patterns

| Don't | Do Instead |
|-------|-----------|
| Skip CI for "small changes" | Every PR gets CI. Small changes break things too. |
| Deploy from feature branches | Always deploy from main, post-merge. |
| Manual deploys via SSH | Automated pipeline. If you're SSH-ing to deploy, the pipeline is broken. |
| Hardcode secrets in workflows | `${{ secrets.NAME }}` — always. |
| Set secrets via GitHub web UI | Use `gh secret set` — avoids whitespace/encoding issues. |
| Require deploy checks for PR merge | Deploy runs post-merge. Only require CI checks. |
| One big `ci.yml` for monorepos | Split by service: `ci-frontend.yml`, `ci-backend.yml`. |
| Ignore deploy failures | Every failure hits #alerts. Investigate immediately. |

---

_This DNA evolves. As we add monitoring, staging environments, and more infrastructure patterns, they get codified here._
