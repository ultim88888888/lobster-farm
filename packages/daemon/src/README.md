# Daemon Source

The LobsterFarm daemon process. Manages entities, spawns Claude Code agent sessions, routes Discord messages, and exposes an HTTP API for the CLI and Commander to interact with. Runs as a macOS launchd service.

## Files

- `index.ts` -- Entrypoint. Wires up all subsystems (registry, sessions, queue, Discord, Commander, pool) and handles graceful shutdown.
- `config.ts` -- Loads and validates the global `~/.lobsterfarm/config.yaml` file.
- `registry.ts` -- `EntityRegistry` class. Scans `~/.lobsterfarm/entities/` on startup, validates each entity's `config.yaml`, and provides lookup by ID.
- `session.ts` -- `ClaudeSessionManager`. Spawns Claude Code as child processes with the correct agent, model, DNA, permissions, and entity context. Tracks active sessions, captures output, emits lifecycle events.
- `queue.ts` -- `TaskQueue`. Priority-ordered queue that feeds sessions to the session manager, respecting the configured concurrency limit. Processes next task when a slot opens.
- `server.ts` -- HTTP API server. Routes for status, entities, tasks, pool management, entity scaffolding, reload, and webhook endpoints.
- `router.ts` -- Discord message router. Deterministic rules: channel-type routing (alerts, general), keyword-based intent classification. Legacy `!lf` prefix parsing retained for test coverage.
- `discord.ts` -- `DiscordBot` class. Connects to Discord via discord.js, builds a channel-to-entity index from entity configs, handles incoming messages via the router, sends messages as webhooks for agent identity, and scaffolds new entity Discord categories/channels.
- `commander-process.ts` -- `CommanderProcess`. Manages Pat (the Commander) as a persistent Claude Code session inside a tmux session with the Discord channel plugin. Health-checks every 10s, auto-restarts with exponential backoff.
- `pool.ts` -- `BotPool`. Manages a pool of Discord bot accounts (pool-0 through pool-N) for assigning to channels. Handles assignment, release, LRU eviction, parking (session preservation), nickname setting, and pre-assignment of planners to entity #general channels.
- `actions.ts` -- Side-effect functions: git worktree create/cleanup, GitHub PR create/merge via `gh`, test runner, and Discord notification dispatch.
- `review-utils.ts` -- Utility functions for PR review feedback: fetch review comments from GitHub and build fix prompts for the auto-fix loop.
- `hooks.ts` -- Post-session hooks. Extracts session learnings via Haiku and appends them to daily logs. Also manages the global learnings file.
- `models.ts` -- Maps abstract model tiers (opus/sonnet/haiku + think level) to Claude CLI flags.
- `persistence.ts` -- JSON file persistence for PR review state, pool state, PR watches, deploy triage, and context alert state. Saves to and loads from `~/.lobsterfarm/state/`.
- `context-alerts.ts` -- Periodic context-size sweep. Every 15 min, reads each assigned pool session's context via `/context` and alerts when it crosses 200k/500k/800k tokens. Fires once per breach with hysteresis (re-arms when usage drops below a threshold, so a session that regrows after `/compact` alerts again). Dedupe state is keyed by `session_id` and persisted to `state/context-alerts.json`.
- `pid.ts` -- PID file management. Write, read, remove, and check if the daemon is already running.
- `pr-cron.ts` -- `PRReviewCron`. Polls entity repos for open PRs, spawns headless reviewer sessions, and routes outcomes (approve/merge, fix, escalate).
- `auth-watchdog.ts` -- `AuthWatchdog`. Per shared Claude credential (config dir), runs a periodic fresh-process canary probe plus a best-effort keychain read of the *re-login deadline*. On a logged-out/invalid-grant credential it quarantines poisoned session transcripts, captures a re-login URL, and alerts the owner in the configured channel; the owner pastes the OAuth code back (owner-only security boundary), which completes the login and recycles the affected pool bots. Network/rate failures are never treated as auth incidents. See "Auth watchdog alarms" below for what does and does not open an incident.
- `webhook-handler.ts` -- GitHub webhook handler. Receives PR events, verifies signatures, maps repos to entities, and spawns reviewer/fixer sessions. On v1 entities an approval that lands while CI is still running is *parked* (persisted as `approved` + `v1_approved_sha`), never merged past the running checks.
- `check-suite-handler.ts` -- `check_suite.completed` dispatch. Drives the whole review/merge/fix loop for `pr_lifecycle: v2` entities; for v1 entities it does exactly one thing — merge a parked approval once its CI completes green (#355).

## Key Concepts

- **Session spawning**: The daemon never runs Claude Code interactively. It spawns headless sessions with `--output-format stream-json` and pipes the prompt via stdin.
- **Bot pool**: Discord bot accounts are a limited resource. The pool assigns them to channels on demand, evicts via LRU when full, and parks sessions for later resume.
- **Commander (Pat)**: The only agent that runs persistently. Lives in a tmux session, connected to Discord via the channel plugin, operating at the platform level rather than entity level.
- **PR review loop**: PRs are reviewed by spawning headless reviewer sessions. If changes are requested, a builder is spawned to fix. GitHub issues and PRs are the source of truth.
- **Auth watchdog alarms**: A stored Claude credential carries two clocks, and only one of them means anything to a human. `expiresAt` is the access token — hours, rotated silently by the CLI. `refreshTokenExpiresAt` is the session — weeks, and once it lapses only `/login` can fix it. The watchdog measures the second one exclusively (`expiry_warn_minutes`, default 24h); alarming on the first kept two perfectly healthy accounts under a permanent siren and caused a real misdiagnosis (#363). Each credential holds at most one open incident, updated in place rather than re-posted, and it auto-resolves — recycling the affected bots — as soon as the credential authenticates again. Every incident carries something to act on: the captured authorize URL, or the exact `CLAUDE_CONFIG_DIR=… claude` command.
