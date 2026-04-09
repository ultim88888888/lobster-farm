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

### Input Normalization

Accept flexible inputs, normalize immediately. This pattern shows up constantly:

```python
def ensure_list(x: T | list[T]) -> list[T]:
    """Normalize a value or list of values to a list."""
    return x if isinstance(x, list) else [x]
```

This belongs in shared utils. Name it clearly — `ensure_list` over `check_cast_list`.

---

## Error Handling

### Philosophy

Errors are data. They should be:
- **Typed** — callers can catch specific failures and handle them differently
- **Informative** — include what was being done, what input caused it, whether it's retryable
- **Bounded** — each layer catches what it can handle and lets the rest propagate
- **Visible** — silent failures are bugs; if you catch it, log it with context

Never catch an exception just to make the stack trace go away. If you can't do something useful with it (retry, fallback, translate to a better error), let it propagate.

### Exception Hierarchies

Every non-trivial project should define a base exception and domain-specific subclasses:

```python
class AppError(Exception):
    """Base exception for this application."""
    def __init__(self, message: str, *, retryable: bool = False):
        super().__init__(message)
        self.retryable = retryable

class DataLoadError(AppError):
    """Failed to load or fetch data from an external source."""
    pass

class ExternalAPIError(AppError):
    """An external API returned an unexpected response."""
    def __init__(self, message: str, *, status_code: int | None = None, retryable: bool = False):
        super().__init__(message, retryable=retryable)
        self.status_code = status_code

class ValidationError(AppError):
    """Input validation failed — caller provided bad data."""
    pass

class NotFoundError(AppError):
    """Requested resource does not exist."""
    pass

class ConflictError(AppError):
    """Resource conflict — duplicate entry or state violation."""
    pass

class DatabaseError(AppError):
    """Database operation failed."""
    pass
```

**Why:** `except ExternalAPIError` is infinitely more useful than `except Exception`. Callers can handle a timeout differently from invalid input. The `retryable` flag lets orchestration layers decide whether to retry automatically.

### HTTP API Error Mapping

API routes are error boundaries — they translate domain exceptions into HTTP responses. Never let raw exceptions leak to clients.

```python
# ❌ BAD — generic 500 for everything
@router.get("/items/{id}")
async def get_item(id: str):
    try:
        return await service.get_item(id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ✅ GOOD — specific status codes, informative responses
@router.get("/items/{id}")
async def get_item(id: str):
    try:
        return await service.get_item(id)
    except NotFoundError:
        raise HTTPException(status_code=404, detail=f"Item {id} not found")
    except ValidationError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except ExternalAPIError as e:
        status = 503 if e.retryable else 502
        raise HTTPException(status_code=status, detail=str(e))
    # Let unexpected errors propagate — FastAPI returns 500, Sentry captures
```

**Status code guide:**
- **400** — caller's fault (bad input, missing params, invalid format)
- **404** — resource doesn't exist
- **409** — conflict (duplicate, state violation)
- **422** — structurally valid but semantically wrong (invalid enum, out-of-range)
- **502** — upstream API returned an error (permanent)
- **503** — upstream API is temporarily unavailable (retryable)
- **500** — our bug (let it propagate, Sentry captures it)

**Never return 500 with `detail=str(e)`.** That leaks internal state to clients. Let unexpected exceptions propagate as unhandled — the framework returns a generic 500 and Sentry captures the full traceback.

### Database Error Handling

Map database exceptions to domain exceptions at the repository/query layer:

```python
import asyncpg

async def get_user(user_id: str, conn: asyncpg.Connection) -> User:
    try:
        row = await conn.fetchrow("SELECT * FROM users WHERE id = $1", user_id)
    except asyncpg.PostgresError as e:
        # Assumes transient failure — callers using `retryable` for retry logic should
        # handle specific non-transient cases (e.g. SyntaxOrAccessError) separately.
        raise DatabaseError(f"Failed to fetch user {user_id}: {e}", retryable=True)
    if row is None:
        raise NotFoundError(f"User {user_id} not found")
    return User(**dict(row))

async def create_order(order: Order, conn: asyncpg.Connection) -> None:
    try:
        await conn.execute("INSERT INTO orders ...", ...)
    except asyncpg.UniqueViolationError:
        raise ConflictError(f"Order {order.id} already exists")
    except asyncpg.ForeignKeyViolationError as e:
        raise ValidationError(f"Invalid reference: {e}")
    except asyncpg.PostgresError as e:
        raise DatabaseError(f"Failed to create order: {e}", retryable=True)
```

**Key principle:** The service layer should never see `asyncpg.PostgresError`. It should see `NotFoundError`, `ConflictError`, `DatabaseError` — domain concepts, not driver internals.

### Catch Specificity Rules

1. **Catch the narrowest exception you can name.** If you know it's a `ValueError`, catch `ValueError`, not `Exception`.
2. **Group related exceptions:** `except (ValueError, KeyError, TypeError) as e:` is fine.
3. **`except Exception` is a code smell.** Valid uses:
   - Top-level error boundaries (API routes, task runners, CLI entry points)
   - Best-effort operations where ANY failure is acceptable (metrics, analytics, non-critical logging)
   - Must ALWAYS log with full context and `exc_info=True`
4. **Never bare `except:`.** It catches `KeyboardInterrupt`, `SystemExit`, `GeneratorExit`. Always `except Exception` minimum.
5. **Never `except Exception: pass`.** If it's worth catching, it's worth logging.

### Structured Error Logging

Errors should be logged with enough context to diagnose without reproducing:

```python
# ❌ BAD
except Exception as e:
    logger.warning(f"Failed: {e}")

# ✅ GOOD — structlog (keyword args as context)
except ExternalAPIError as e:
    logger.warning(
        "exchange_api_failed",
        exchange=exchange_id,
        symbol=symbol,
        error_type=type(e).__name__,
        error_message=str(e),
        retryable=e.retryable,
    )

# ✅ GOOD — stdlib logging (context via `extra={}`)
except ExternalAPIError as e:
    logger.warning(
        "exchange_api_failed: %s",
        str(e),
        extra={
            "exchange": exchange_id,
            "symbol": symbol,
            "error_type": type(e).__name__,
            "retryable": e.retryable,
        },
        exc_info=True,
    )
```

> **Note:** The structlog example passes context as keyword args directly. stdlib `logging` only accepts `exc_info`, `stack_info`, `stacklevel`, and `extra` as kwargs — pass context via `extra={...}` instead, or you'll get a `TypeError` at runtime.

Always include: **what** was being done, **which** input/entity triggered it, **what type** of error, and **whether it's retryable**.

### The ErrorAction Pattern (Data Pipelines)

For batch processing where individual item failures shouldn't abort the pipeline:

```python
class ErrorAction(StrEnum):
    IGNORE = "ignore"   # Return default, no log
    WARN = "warn"       # Return default, log warning
    RAISE = "raise"     # Propagate exception

async def fetch_candles(
    symbol: str,
    *,
    errors: ErrorAction = ErrorAction.WARN,
) -> pd.DataFrame:
    try:
        return await self._get(f"/candles/{symbol}")
    except ExternalAPIError as e:
        if errors == ErrorAction.RAISE:
            raise
        if errors == ErrorAction.WARN:
            logger.warning("candle_fetch_failed", symbol=symbol, error=str(e))
        return pd.DataFrame()
```

Use this pattern for any function that processes items in a collection where partial success is acceptable. The **caller** decides the error tolerance, not the callee.

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

### Next.js 15 (App Router)

#### Server-First Architecture

Server components are the default. Every component is a server component unless it needs interactivity. This is the single most important pattern in modern Next.js.

**The rule:** Push `"use client"` as far DOWN the component tree as possible. Never at the layout or shell level. A page should be a server component that fetches data and passes it to client children.

```tsx
// ✅ GOOD — server page, client child
// app/tools/funding/page.tsx (SERVER)
import { FundingTable } from "./funding-table";

export default async function FundingPage() {
  const data = await fetchFundingRates();
  return <FundingTable data={data} />;
}

// app/tools/funding/funding-table.tsx (CLIENT)
"use client";
export function FundingTable({ data }: { data: FundingRate[] }) {
  const [sortBy, setSortBy] = useState("rate");
  // Interactive table with sorting, filtering, etc.
}

// ❌ BAD — entire page is client
// app/tools/funding/page.tsx
"use client";
export default function FundingPage() {
  const { data } = useFunding(); // fetches client-side
  return <table>...</table>;
}
```

**When to use `"use client"`:**
- useState, useEffect, useRef, or any React hook
- Event handlers (onClick, onChange, onSubmit)
- Browser APIs (window, document, localStorage)
- Third-party libraries that use hooks (charts, animations, drag-and-drop)

**When NOT to use `"use client"`:**
- Components that only render props/children (no hooks, no browser APIs)
- Layout shells and structural wrappers that pass children through unchanged
- Pages that fetch data server-side and pass it to client children
- Components that only use server-compatible features

> **Context providers are the exception** — they always need `"use client"` because `createContext` is a client API. The pattern: mark the *provider file* as client, keep the *layout* as server.

#### Data Fetching

**Server components fetch data directly — no useEffect, no TanStack Query needed:**

```tsx
// Server component — fetch happens at request time, no client JS
export default async function DashboardPage() {
  const metrics = await fetch("https://api.example.com/metrics", {
    next: { revalidate: 60 }, // ISR: revalidate every 60 seconds
  });
  return <Dashboard data={await metrics.json()} />;
}
```

**Use TanStack Query only in client components that need:**
- Real-time polling (refetchInterval)
- Optimistic updates
- Infinite scroll / pagination with client state
- User-triggered refetches

**Data fetching decision tree:**
1. Can this data be fetched at build time? → `generateStaticParams` + static rendering
2. Can it be fetched at request time on the server? → Server component + `fetch()`
3. Does it need real-time updates? → Client component + TanStack Query or WebSocket
4. Is it user-triggered (search, filter)? → Client component + TanStack Query

#### Loading & Error States

**Always provide loading and error boundaries:**

```
app/
  tools/
    funding/
      page.tsx        # Server component
      loading.tsx      # Instant loading skeleton (shown while page.tsx streams)
      error.tsx        # Error boundary with retry
      funding-table.tsx # Client component for interactivity
```

```tsx
// loading.tsx — shown immediately while the server component fetches
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-[400px] w-full" />
    </div>
  );
}

// error.tsx — must be "use client"
"use client";

export default function Error({
  error,
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  return (
    <div>
      <h2>Something went wrong</h2>
      <button onClick={reset}>Try again</button>
    </div>
  );
}
```

**Use Suspense boundaries for granular loading within a page:**

```tsx
import { Suspense } from "react";

export default function DashboardPage() {
  return (
    <div>
      <h1>Dashboard</h1>
      <Suspense fallback={<MetricsSkeleton />}>
        <Metrics />  {/* async server component */}
      </Suspense>
      <Suspense fallback={<ChartSkeleton />}>
        <RecentActivity />  {/* async server component */}
      </Suspense>
    </div>
  );
}
```

#### Caching

**Three caching layers — use all of them:**

1. **Server-side fetch cache** — `fetch()` in server components auto-deduplicates. Add `next: { revalidate: N }` for time-based revalidation.
2. **Route handler headers** — Set `Cache-Control` on API responses for browser/CDN caching:
   ```tsx
   return NextResponse.json(data, {
     headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" },
   });
   ```
3. **Client cache (TanStack Query)** — For client components only. Set appropriate `staleTime` and `gcTime`.

#### Real-Time Data

- **WebSocket or SSE** for truly live data (prices, order updates, streaming feeds). Do not poll at <10s intervals — that's expensive and wasteful.
- **Polling (refetchInterval)** is fine for slow-changing data (>30s intervals) or when WebSocket infrastructure isn't available.
- **Server-Sent Events (SSE)** are simpler than WebSocket when you only need server→client push.

#### Component Boundaries

```
// Layout of a well-structured page:

ServerLayout (server)
  └── ServerPage (server) — fetches data
        ├── StaticHeader (server) — just renders props
        ├── InteractiveTable (client) — needs sorting, filtering
        │     └── TableRow (server-compatible) — no hooks needed
        └── Chart (client) — needs refs, WebSocket
```

Never mark a layout, shell, or wrapper as `"use client"`. If the shell needs one interactive element (e.g., a hamburger menu), extract that element into its own client component and keep the shell as a server component.

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

### Pre-commit Hooks

All LobsterFarm repos use husky + lint-staged. Every commit automatically runs Biome lint+format on staged files. **Never skip hooks** (`--no-verify` is banned). If the hook fails, fix the issue — don't bypass it.

As a belt-and-suspenders habit: run `pnpm lint` before committing to catch issues early. But the hook is the real safety net.

---

## Anti-Patterns — Things We Don't Do

| Don't | Do Instead |
|-------|-----------|
| Bare `except:` | `except SpecificError` or `except Exception` minimum |
| `except Exception: pass` | Log with context, or don't catch |
| `except Exception as e: raise HTTPException(500, str(e))` | Map domain exceptions to specific status codes |
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
