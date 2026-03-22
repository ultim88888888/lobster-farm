# LobsterFarm

Autonomous orchestration platform built on Claude Code. Turns a single machine into a structured consultancy with specialized agents, deterministic workflows, and project isolation.

## Quick Start

```bash
# Prerequisites: Node.js 22+, npm
npm install -g pnpm

# Clone and build
git clone https://github.com/ultim88888888/lobster-farm.git
cd lobster-farm
pnpm install && pnpm build

# Run the setup wizard (handles everything)
node packages/cli/dist/index.js init
```

The setup wizard will:
- Check for Claude Code, 1Password, and sudo access
- Configure your user profile and agent names
- Set up Discord bot token
- Generate all config files and directory structure

## After Setup

```bash
# Start the daemon
node packages/cli/dist/index.js start

# Or run directly (see logs in terminal)
node packages/daemon/dist/index.js
```

Then in Discord:
```
!lf scaffold entity alpha "Trading Platform" --repo git@github.com:org/alpha.git
!lf plan alpha "First feature"
!lf approve alpha-1
!lf advance alpha-1
!lf status
!lf help
```

## Architecture

```
CLI (lobsterfarm)          Daemon (always-on)              Claude Code CLI
  init                       HTTP API (:7749)                Agents (Gary, Pearl, Bob...)
  entity create/list         Session Manager                 Skills (DNA profiles)
  start/stop/status          Task Queue                      Hooks (SOP enforcement)
                             Feature Lifecycle                CLAUDE.md hierarchy
                             Discord Bot + Router
                             Persistence
```

**Entities** — isolated projects with their own repos, memory, and Discord channels

**Archetypes** — specialized agent identities (planner, designer, builder, reviewer, operator)

**DNA** — composable domain expertise (coding standards, design principles, review criteria)

**SOPs** — deterministic workflows executed by the daemon (feature lifecycle, PR review)

## Project Structure

```
packages/
  shared/     Config schemas, path resolver, template engine, YAML loader
  cli/        lobsterfarm init, entity create/list, start/stop/status
  daemon/     HTTP server, session manager, task queue, feature lifecycle,
              Discord bot, deterministic router, persistence
config/       Default templates (agents, skills, user/tools configs)
docs/         Architecture specs
```

## Commands

| Command | Description |
|---------|-------------|
| `lobsterfarm init` | Setup wizard — first-time configuration |
| `lobsterfarm entity create` | Create a new entity (project) |
| `lobsterfarm entity list` | List configured entities |
| `lobsterfarm start` | Start the daemon |
| `lobsterfarm stop` | Stop the daemon |
| `lobsterfarm status` | Show daemon status |

## Discord Commands

| Command | Description |
|---------|-------------|
| `!lf help` | Show all commands |
| `!lf status` | Daemon status |
| `!lf scaffold entity <id> <name>` | Create entity with Discord channels |
| `!lf plan <entity> <title>` | Create a feature |
| `!lf approve <feature-id>` | Approve current phase gate |
| `!lf advance <feature-id>` | Advance to next phase |
| `!lf features [entity]` | List features |

## License

Private.
