---
name: coding-dna
description: >
  Core engineering standards and architectural preferences. Auto-loads when
  implementing features, writing code, debugging, making architectural decisions,
  or working with databases and APIs. The foundational DNA for all code work.
---

# CODE-DNA.md — Engineering Standards

_How we write code. Universal standards that apply across every project and entity._

_Domain-specific conventions (naming, schemas, API patterns) live in each entity's codebase. This is the shared foundation._

---

## Philosophy

**Lightweight, modular, fast.** Every module should feel like a building block — focused, reusable, composable. Code that's easy to read is easy to trust, and code that's easy to trust ships faster.

**Understand before building.** Read existing code before writing new code. Understand the data before modeling it. Understand the problem before architecting the solution.

**No bloat.** AI-generated code tends toward verbosity — dozens of files, unnecessary abstractions, over-engineered class hierarchies for simple problems. Fight this instinct. If a function can be 15 lines, it shouldn't be 50. If a flat module works, don't wrap it in a class. Complexity is earned, not default.

**Standardize everything that repeats.** Column names, parameter conventions, error handling patterns, project structure. When things are consistent, you can plug any block into any context without re-reading the docs. This is how you scale across many projects without drowning.

**Fast by default.** Async where possible, indexed queries, lazy loading on the frontend. Speed shouldn't come at the cost of quality — but most of the time, the fast way *is* the correct way. Slow code usually means you're doing something wrong.

---

## Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| **Frontend** | TypeScript, Next.js, Tailwind CSS | Custom CSS when Tailwind can't express it. {{DESIGNER_NAME}} handles advanced styling. |
| **Backend** | Python 3.11+ | Unless otherwise specified per-project. |
| **API** | FastAPI | Async-native, Pydantic validation, auto-generated docs. |
| **Async HTTP** | aiohttp | For outbound data pipelines. httpx for simpler cases. |
| **Database** | PostgreSQL (default) | See Database section for when to use alternatives. |
| **Secrets** | 1Password | Secrets never touch disk. See Security section. |

---

## Python Standards

### Naming

**snake_case everywhere.** Variables, functions, modules, columns. No exceptions on the Python side.

**Standardize domain vocabulary per-entity/project.** Each project should define its canonical column names and parameter conventions in its own docs. The principle is universal: pick one name for each concept and use it everywhere. Never have the same thing called `symbol` in one function and `ticker` in another.

Examples of good standardization (from a trading context — adapt for your domain):
```python
# Pick ONE name per concept, document it, use it everywhere
# asset identifier → "base" (not symbol, ticker, coin, token)
# timestamp → "time" (not ts, timestamp, date, datetime) — always UTC
# candle interval → "interval" (not timeframe, granularity, period)
```

### Typing

**Type everything.** Function signatures, return types, variables where ambiguous. This isn't just for correctness — it's documentation that stays current and enables IDE autocompletion.

```python
# ✅ Good — typed, clear, self-documenting
def fetch_data(
    symbols: list[str] | str,
    interval: Interval = Interval.HOUR_1,
    start: datetime | None = None,
    end: datetime | None = None,
    errors: ErrorAction = ErrorAction.WARN,
) -> pd.DataFrame:

# ❌ Bad — untyped, ambiguous
def fetch_data(symbols, interval='1h', start=None, end=None, errors='warn'):
```

**Use `isinstance()`, never `type() ==`:**
```python
# ✅
if isinstance(start, str):
    start = pd.to_datetime(start)

# ❌
if type(start) == str:
```

**Use `list[str]` (lowercase) over `List[str]` for Python 3.11+.** The `typing.List` import is legacy.

### Enums — StrEnum

`StrEnum` (Python 3.11+) is the right tool for constrained string parameters that also get passed to external APIs. The values behave as plain strings — they serialize naturally in JSON, work in f-strings, pass directly as query params — while giving you:

- **Runtime validation**: `Interval("invalid")` raises `ValueError`
- **IDE autocompletion**: Type `Interval.` and see all options
- **Docstring self-documentation**: The enum *is* the docs for valid values
- **Method attachment**: You can add computed properties and conversions directly on the enum

```python
from enum import StrEnum
from datetime import timedelta

class Interval(StrEnum):
    MIN_1 = "1m"
    MIN_5 = "5m"
    HOUR_1 = "1h"
    DAY_1 = "1d"

    def to_timedelta(self) -> timedelta:
        """Attach behavior directly to your enums."""
        mapping = {
            Interval.MIN_1: timedelta(minutes=1),
            Interval.MIN_5: timedelta(minutes=5),
            Interval.HOUR_1: timedelta(hours=1),
            Interval.DAY_1: timedelta(days=1),
        }
        return mapping[self]
```

**When to use `StrEnum` vs `Literal`:**
- **`StrEnum`**: When the values are a domain concept reused across modules. When you need methods or runtime validation.
- **`Literal`**: For one-off function params with 2–3 options that don't warrant a class. `how: Literal["left", "right"] = "left"`.

**Keep enums centralized.** Shared enums live in a `models/` or `types/` module, not scattered across files. Project-specific enums stay in that project's types.

### Docstrings

**Google style, concise.** Every public function gets a docstring. Internal helpers get a one-liner if the name isn't self-explanatory.

```python
def fetch_candles(
    symbols: list[str] | str,
    interval: Interval = Interval.HOUR_1,
    start: datetime | None = None,
    errors: ErrorAction = ErrorAction.WARN,
) -> pd.DataFrame:
    """Fetch OHLCV candles from the exchange API.

    Args:
        symbols: Asset symbol(s). Accepts single string or list.
        interval: Candle interval. Defaults to 1h.
        start: Start time (UTC). Fetches max history if None.
        errors: Error handling strategy.

    Returns:
        DataFrame with columns: time, symbol, open, high, low, close, volume
    """
```

**The return schema matters.** For any function returning a DataFrame, document the columns. This is your contract.

### Comments

**Comment the *why*, not the *what*.** If the code needs a comment to explain what it does, the code should be clearer. Comments explain decisions, gotchas, and non-obvious reasoning.

```python
# ✅ Good — explains a non-obvious quirk
# API returns timestamps in milliseconds despite docs saying seconds
df["time"] = pd.to_datetime(df.time, unit="ms", utc=True)

# ❌ Bad — restates the code
# convert time to datetime
df["time"] = pd.to_datetime(df.time, unit="ms", utc=True)
```

**Section comments are fine** for organizing longer functions (`# config`, `# query`, `# enrich`). Keep them lowercase, brief.

### Error Handling

**Never use bare `except:`.** This catches `KeyboardInterrupt`, `SystemExit`, and other things you absolutely do not want to silently swallow.

```python
# ✅ Good — specific, contextual
except (ValueError, KeyError) as e:
    if errors == ErrorAction.WARN:
        logger.warning(f"Failed to process {symbol}: {e}")
        return pd.DataFrame()

# ❌ Bad — catches everything, hides bugs
except:
    return pd.DataFrame()
```

**The `ErrorAction` pattern is strong.** `IGNORE` / `WARN` / `RAISE` covers the universe of error handling needs for data pipelines:

```python
class ErrorAction(StrEnum):
    IGNORE = "ignore"   # silently return empty/default
    WARN = "warn"       # log warning, return empty/default
    RAISE = "raise"     # raise the exception
```

Use `logging` instead of `print()` for warnings. Loggers are configurable, filterable, and don't pollute stdout.

**Guard inputs early, fail fast:**
```python
def fetch_data(symbols: list[str] | str) -> pd.DataFrame:
    symbols = ensure_list(symbols)  # normalize immediately
    if not symbols:
        return pd.DataFrame()      # nothing to fetch — don't waste an API call
```

### Input Normalization

Accept flexible inputs, normalize immediately. This pattern shows up constantly:

```python
def ensure_list(x: T | list[T]) -> list[T]:
    """Normalize a value or list of values to a list."""
    return x if isinstance(x, list) else [x]
```

This belongs in shared utils. Name it clearly — `ensure_list` over `check_cast_list`.

---

## Async Patterns

### Core Principle: Async-Native with Sync Wrappers

Make the real implementation async. Provide a sync wrapper for convenience. This gives you composability when you need it and simplicity when you don't.

```python
async def fetch_data_async(
    symbols: list[str] | str,
    session: aiohttp.ClientSession | None = None,
    semaphore: asyncio.Semaphore | None = None,
) -> pd.DataFrame:
    """Async implementation — composable, supports shared sessions and semaphores."""
    ...

def fetch_data(symbols: list[str] | str, **kwargs) -> pd.DataFrame:
    """Sync convenience wrapper."""
    return asyncio.run(fetch_data_async(symbols, **kwargs))
```

**Why this matters:** If you have two data-fetching functions and you call them both synchronously, they run sequentially — two separate event loops, two separate connection pools. With async-native functions, you compose them:

```python
# Both calls share one event loop, one connection pool, one rate limiter
async def get_snapshot(symbol: str) -> tuple[pd.DataFrame, pd.DataFrame]:
    sem = asyncio.Semaphore(10)  # shared rate limit
    async with aiohttp.ClientSession() as session:
        prices, funding = await asyncio.gather(
            fetch_prices_async(symbol, session=session, semaphore=sem),
            fetch_funding_async(symbol, session=session, semaphore=sem),
        )
    return prices, funding
```

### Semaphore Pattern for Rate Limiting

```python
async def _fetch(
    session: aiohttp.ClientSession,
    url: str,
    params: dict,
    headers: dict,
    semaphore: asyncio.Semaphore | None = None,
) -> dict:
    """Single request with optional rate limiting."""
    sem = semaphore or asyncio.Semaphore(100)  # effectively unlimited if not provided
    async with sem:
        async with session.get(url, params=params, headers=headers) as resp:
            return await resp.json()
```

### Rules

- **`asyncio.run()` belongs at the top level only** — in sync wrappers, CLI entry points, or scripts. Never nested inside library code.
- **Pass `session` and `semaphore` as optional params** — callers who need composition provide them; casual callers don't care.
- **One `ClientSession` per logical batch** — sessions manage connection pooling. Don't create one per request.
- **For notebooks / marimo**: Use `await` directly (they support top-level await) or use `nest_asyncio` at the notebook level only, never in library code.

---

## Project Structure

### Python Backend / Data Projects

```
project/
├── src/
│   ├── pipe/              # External data source connectors
│   │   ├── __init__.py
│   │   └── <source>.py    # One module per API/data source
│   ├── support/           # Shared utilities
│   │   ├── __init__.py
│   │   ├── async_utils.py # Shared async helpers (fetch, semaphore patterns)
│   │   ├── pandas_utils.py
│   │   ├── time_utils.py
│   │   └── text.py
│   ├── models/            # Types, enums, schemas, Pydantic models
│   │   ├── __init__.py
│   │   ├── enums.py       # Shared enums (Interval, ErrorAction, etc.)
│   │   └── schemas.py     # Pydantic models for API I/O
│   ├── db/                # Database operations
│   │   ├── __init__.py
│   │   ├── connection.py
│   │   └── queries/
│   ├── services/          # Business logic
│   └── api/               # FastAPI routes
│       ├── __init__.py
│       └── routes/
├── tests/
├── scripts/               # One-off or scheduled scripts
├── notebooks/             # Marimo / Jupyter notebooks
├── .env.example           # Documents required env vars (checked in)
├── pyproject.toml
└── README.md
```

**Every directory gets a brief README.md.** What's in here, what each module does. When you're jumping between projects, a 10-line README saves 10 minutes of code reading.

```markdown
# pipe/

External data source connectors. Each module wraps one API.

- **exchange.py** — Market data (candles, funding rates, OI)
- **analytics.py** — On-chain and protocol metrics
```

### Frontend (Next.js)

```
app/
├── (routes)/
│   └── page.tsx
├── components/
│   ├── ui/               # Reusable primitives (buttons, inputs, cards)
│   └── features/         # Feature-specific composed components
├── lib/
│   ├── api/              # API client functions
│   ├── hooks/            # Custom React hooks
│   ├── utils/            # Shared utilities
│   └── types/            # TypeScript types and interfaces
├── styles/
│   └── globals.css       # Tailwind + custom CSS
└── public/
```

{{DESIGNER_NAME}} handles most advanced styling. We implement their designs faithfully. If it looks different from {{DESIGNER_NAME}}'s intent, it's a bug.

---

## DRY — Extract Repeated Patterns

When multiple functions follow the same structure with minor differences, extract the pattern and parameterize the difference. This is the building-block philosophy applied to the blocks themselves.

**Smell:** You have 3+ functions that look 90% identical, differing only in an endpoint, a column name, or an enrichment step.

**Fix:** Extract a base function:

```python
def _chart_query(
    items: list[str] | str,
    endpoint_template: str,
    value_col: str,
    pivot: bool = False,
) -> pd.DataFrame | pd.Series:
    """Base function for chart-style API queries."""
    items = ensure_list(items)
    multi = len(items) > 1

    def fetch_one(item: str) -> pd.DataFrame:
        data = query(endpoint_template.format(item=item))
        if not data:
            logger.warning(f"{item} not found")
            return pd.DataFrame()
        df = pd.DataFrame(data, columns=["time", value_col])
        df["time"] = pd.to_datetime(df["time"], unit="s", utc=True)
        if multi:
            df.insert(1, "item", item)
        return df

    df = pd.concat([fetch_one(i) for i in items], ignore_index=True)

    if pivot:
        return df.pivot(index="time", columns="item", values=value_col)
    if not multi:
        return df.set_index("time")[value_col]
    return df


# Now each variant is a one-liner
def volume(items, pivot=False):
    """Daily trading volume (USD)."""
    return _chart_query(items, "/summary/{item}?chart=true", "volume", pivot)

def revenue(items, pivot=False):
    """Daily revenue (USD)."""
    return _chart_query(items, "/summary/fees/{item}?dataType=dailyRevenue", "revenue", pivot)

def fees(items, pivot=False):
    """Daily fees (USD)."""
    return _chart_query(items, "/summary/fees/{item}", "fees", pivot)
```

Don't over-abstract — if two functions share 30% of their code, they're probably fine as separate functions. This pattern is for when the duplication is 80%+.

---

## Database Standards

### Choosing the Right Database

**Relational (PostgreSQL)** is our default. Use it unless the data or workload genuinely demands something else. It handles structured data, relationships, transactions, JSON, full-text search, and moderate time-series well.

| Data / Workload | Database Type | Examples | When to reach for it |
|----------------|---------------|----------|---------------------|
| Structured data, relationships, transactions | **Relational** | PostgreSQL | Default. User data, app state, business logic, most CRUD. |
| Caching, sessions, rate limiting, pub/sub | **Key-Value / Cache** | Redis, Valkey | Ephemeral data, sub-millisecond reads, data you can afford to lose. |
| Embeddings, semantic search, RAG | **Vector** | pgvector, Pinecone, Qdrant | AI/ML features — similarity search, recommendation, retrieval-augmented generation. Start with pgvector (Postgres extension) before reaching for a standalone vector DB. |
| Flexible/nested schemas, rapid prototyping | **Document** | MongoDB, Firestore | Truly schema-less data where structure varies per record. Honestly rare — PostgreSQL JSONB columns cover 90% of document-store use cases without a separate database. |
| High-volume time-series (billions of rows) | **Time-Series** | TimescaleDB, InfluxDB | When Postgres starts struggling with time-series volume. TimescaleDB is a Postgres extension — same SQL, same tooling, adds automatic partitioning and compression. Try it before leaving the Postgres ecosystem. |
| Lightweight local tools, single-user apps | **Embedded** | SQLite | Zero-config, single-file. Great for CLI tools, local dev, scripts that need persistence without a server. |
| Relationship-heavy queries (social graphs, knowledge graphs) | **Graph** | Neo4j | When you're constantly traversing relationships 3+ levels deep. Rare for us. |

**Rule of thumb:** Start with PostgreSQL. Add pgvector if you need embeddings. Add Redis if you need caching. Only introduce a separate specialized database when Postgres genuinely can't handle the workload — every additional database is another thing to operate, back up, and secure.

### Hosting / Providers

| Provider | What it is | Good for |
|----------|-----------|----------|
| **Supabase** | Hosted Postgres + auth + storage + realtime + edge functions | Full-stack apps where you want backend-as-a-service. Built-in auth, row-level security, and a dashboard. Great for shipping fast. Includes pgvector. |
| **Neon** | Serverless Postgres with branching | Auto-scaling, database branching for dev/preview environments. Good for projects with variable load. |
| **Railway / Render** | Simple managed Postgres | Quick to spin up, minimal config. Good for staging or smaller projects. |
| **AWS RDS / GCP Cloud SQL** | Managed Postgres at scale | Production workloads that need fine-grained control, replicas, automated backups. More ops overhead. |
| **Docker (local)** | Self-hosted Postgres | Local development. Same engine as prod, zero cost. |

Choose provider per-entity/project based on needs. Supabase is a strong default when you want more than just a database (auth, storage, realtime). Plain managed Postgres when you just need a database and handle everything else yourself.

### Indexing — The #1 Performance Lever

Most slow database operations aren't slow because of the database — they're slow because of missing or wrong indexes.

**Rules:**
1. **Index every column used in `WHERE`, `JOIN`, or `ORDER BY`** — this is non-negotiable
2. **Composite indexes for common query patterns** — if you always query `WHERE symbol = ? AND time > ?`, create `CREATE INDEX idx_data_symbol_time ON data (symbol, time)`
3. **Column order matters in composite indexes** — equality columns first (`symbol`), range columns last (`time`)
4. **Time-series tables always get a time index** — usually as part of a composite with the entity identifier
5. **Use `UNIQUE` indexes as constraints** — `UNIQUE(symbol, time, exchange)` prevents duplicate data AND speeds up lookups AND enables `UPSERT`

### UPSERT — Idempotent Writes

**Always prefer `INSERT ... ON CONFLICT` (UPSERT) for data pipeline writes.** Running the same data load twice should produce the same result. No duplicates, no errors.

```sql
INSERT INTO market_data (symbol, time, open, high, low, close, volume)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (symbol, time) DO UPDATE SET
    open = EXCLUDED.open,
    high = EXCLUDED.high,
    low = EXCLUDED.low,
    close = EXCLUDED.close,
    volume = EXCLUDED.volume;
```

This requires a `UNIQUE` constraint on the conflict columns. Plan your unique constraints at schema design time.

### Batch Operations

- **Bulk inserts**: Use `COPY` or `executemany` with prepared statements — not individual `INSERT` loops
- **Batch size**: 1,000–5,000 rows per batch is usually optimal
- **Transactions**: Wrap batch operations in explicit transactions. Don't auto-commit per row.

### Connection Management

- **Always use connection pooling** — `asyncpg.create_pool()` or SQLAlchemy's async pool
- **Don't create connections per request** — pool at the application level
- **Close properly** — use context managers (`async with pool.acquire() as conn:`)

### Migrations

Use **Alembic** for schema migrations. Every schema change is a versioned migration file that can be applied forward and rolled back. No manual SQL in production.

### Entity Separation

Each entity gets its own database (preferred) or schema. Never mix entity data in the same tables. Organizational principle and security boundary.

### Local Dev

**Use local PostgreSQL in development.** Same engine as production means no surprises. Docker makes this trivial:

```yaml
# docker-compose.dev.yml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_DB: project_dev
      POSTGRES_PASSWORD: dev
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
```

---

## Security & Secrets

### 1Password Everywhere

Secrets are managed through 1Password exclusively. No plaintext `.env` files with real credentials, not even locally. The 1Password CLI (`op`) injects secrets at runtime — they exist only in process memory, never on disk.

**How it works:**

```bash
# .env.op — checked into git, contains 1Password references (not secrets)
DATABASE_URL=op://vault/database/url
API_KEY=op://vault/service/api-key
JWT_SECRET=op://vault/auth/jwt-secret

# Run your app with secrets injected
op run --env-file .env.op -- python main.py
op run --env-file .env.op -- uvicorn api:app
```

**In code, secrets come from environment variables — same as always:**
```python
import os

DATABASE_URL = os.environ["DATABASE_URL"]
API_KEY = os.environ["API_KEY"]
```

The code never knows or cares that 1Password is involved. It just reads env vars. But the secrets never exist as files on disk.

**For production / deployed environments:**
- 1Password Service Accounts or Connect servers inject secrets the same way
- Container orchestration: `op run` in the entrypoint, or 1Password's Kubernetes operator
- CI/CD: 1Password GitHub Actions integration

**Why not `.env.local`?**
- Plaintext files on disk are a risk — anyone with file access sees everything
- Files get accidentally committed, copied, backed up, synced
- `op run` is just as convenient once set up, and dramatically more secure
- One source of truth for secrets across local, staging, and production

### Security Rules

- **Secrets never touch disk as plaintext.** 1Password references only.
- **Secrets never appear in logs.** Don't log env vars, API responses with auth headers, etc.
- **`.env.example`** is checked in — documents required env vars with placeholder descriptions, not values.
- **No secrets in code.** Not even "temporary" ones. Not even in comments.
- **Entity isolation** — each entity has its own 1Password vault. Never share credentials across entities.

---

## Git & Environments

### Branching

- **`main`** — production. Always deployable.
- **Feature branches** — `feat/<desc>` or `fix/<desc>`. Short-lived.

**Branch naming:** `feat/add-funding-endpoint`, `fix/pagination-bug`

Git workflow (branching rules, PR process, merge policy) is defined per-project in each repo's `CLAUDE.md`. Read it before starting work.

### Commits

**Conventional commits:**
```
feat: add historical data endpoint
fix: handle empty API response gracefully
refactor: extract common query pattern
chore: update dependencies
docs: add pipe module README
```

Keep commits atomic. One logical change per commit. If you're writing "and" in your commit message, it's probably two commits.

### Environment Separation

| Environment | Branch | Database | Secrets | Deployment |
|-------------|--------|----------|---------|------------|
| **Local** | any | local postgres | `op run --env-file .env.op` | manual |
| **Staging** | `dev` | staging DB | 1Password service account | auto on merge |
| **Production** | `main` | prod DB | 1Password service account | auto on merge |

**Environment detection:**
```python
import os

# ✅ Explicit environment variable
ENV = os.getenv("ENV", "local")  # "local", "staging", "production"
IS_LOCAL = ENV == "local"

# ❌ Fragile path inspection — don't do this
LOCAL = True if os.getcwd().split('/')[1] == 'Users' else False
```

---

## PR Workflow

### Check the Spec's Verification Requirement

Before opening a PR, check the GitHub issue spec for the `## Verification` section:

**When `verification: none` (or not specified for non-artifact changes):**
- Build, commit, push, open PR immediately
- Current behavior — AutoReviewer handles the rest

**When `verification: user`:**
1. Build the feature, commit, and push to the branch
2. Do NOT open a PR
3. Post to the channel:
   - What was built (brief summary)
   - How to test locally: `git pull && git checkout <branch> && <run command>`
   - What to look for (specific things to verify)
4. Wait for user response:
   - "Looks good" / "Ship it" → open the PR with full body and `Closes #<issue>`
   - Feedback / "Fix X" → fix the issue, push, ask again
   - No response → do NOT open the PR. The user will come back when ready.

The PR gate is about product correctness, not code quality. Code quality is the AutoReviewer's job. The user gate catches "it compiles but does the wrong thing."

### PR Watch Registration

After opening a PR, register it with the daemon so you'll be notified when it merges:

```bash
curl -s -X POST http://localhost:7749/pr/watch \
  -H 'Content-Type: application/json' \
  -d '{"repo":"owner/repo","pr_number":N,"channel_id":"CHANNEL_ID"}'
```

The daemon will inject a message into your session when the PR reaches a terminal state (merged, closed, or review feedback). You don't need to poll — just continue with other work or wait.

---

## Frontend Standards

_Brief for now — {{DESIGNER_NAME}} drives the design system. We implement faithfully._

### TypeScript

- **Strict mode always.** `"strict": true` in tsconfig.
- **Type everything.** Props interfaces, API response types, utility return types.
- **No `any`.** Use `unknown` if you truly don't know the type, then narrow it.

### Next.js

- **App Router** (not Pages Router) — server components by default
- **Server components for data fetching** — client components only when you need interactivity
- **API routes** for BFF patterns when the Python backend isn't the right fit

### Styling

- **Tailwind first** — utility classes for 90% of styling
- **Custom CSS** when Tailwind can't express it (complex animations, pseudo-element tricks)
- **Component-scoped styles** via CSS modules if needed
- **Design tokens** from {{DESIGNER_NAME}}'s system — colors, spacing, typography are not ad-hoc

### Performance

- **Lazy load below-the-fold** — `next/dynamic` for heavy components
- **Image optimization** — always use `next/image`
- **Waterfall prevention** — parallel data fetching, streaming where applicable

---

## Code Quality

### Logging Over Printing

```python
import logging

logger = logging.getLogger(__name__)

# ✅
logger.warning(f"Failed to fetch {symbol}: {e}")
logger.info(f"Fetched {len(df)} rows for {symbol}")

# ❌
print(f"FAILED: {symbol}")
```

Loggers are configurable per-environment. In prod you want structured logs. In dev you want verbose output. `print()` gives you neither.

### Testing

- **Test the contract, not the implementation** — does the function return the right shape with the right types?
- **Fixtures for external data** — don't hit APIs in tests. Mock responses or use recorded fixtures.
- **pytest as the runner** — simple, powerful, well-supported
- **Test the sad paths** — what happens with a 429? Empty response? Invalid input?

### Dependencies

- **`pyproject.toml`** for Python projects (not `requirements.txt`)
- **Pin major versions, allow minor**: `aiohttp = "^3.9"`
- **Dev dependencies separate**: `[project.optional-dependencies]` or poetry groups

---

## Anti-Patterns — Things We Don't Do

| Don't | Do Instead |
|-------|-----------|
| Bare `except:` | Catch specific exceptions |
| `type(x) == str` | `isinstance(x, str)` |
| `print()` for logging | `logging.getLogger(__name__)` |
| `from typing import List, Dict` | `list[str]`, `dict[str, int]` (3.11+) |
| Secrets in files or code | 1Password `op run` injection |
| Path-based env detection | `ENV` environment variable |
| Copy-paste across similar functions | Extract base pattern, parameterize |
| `asyncio.run()` inside library code | Async-native functions + sync wrappers |
| One massive `utils.py` | Split by domain: `time_utils`, `text`, `pandas_utils` |
| `inplace=True` parameter pattern | Always return new objects. Immutability is clarity. |

---

## Conventions Quick Reference

```python
# Normalize inputs
items = ensure_list(items)

# Timestamps — always UTC
time = pd.to_datetime(raw_ts, unit="ms", utc=True)

# DataFrames — snake_case columns, standardized names
df.columns = format_cols(df)  # camelCase → snake_case

# Error handling
errors: ErrorAction = ErrorAction.WARN

# Enum usage
class Status(StrEnum):
    ACTIVE = "active"
    PAUSED = "paused"

# Async pattern
async def fetch_async(...): ...  # real implementation
def fetch(...): ...              # sync wrapper via asyncio.run()

# Secrets — from environment, injected by 1Password
API_KEY = os.environ["API_KEY"]
```

---

_This file evolves. When we discover a pattern worth codifying, it goes here. When something stops serving us, it gets cut. Domain-specific conventions live in entity codebases, not here. The DNA is alive._
