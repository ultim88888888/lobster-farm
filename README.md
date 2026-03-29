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

Then in Discord, use slash commands:
```
/scaffold entity:alpha name:"Trading Platform"
/plan entity:alpha title:"First feature"
/status
/help
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

## Discord Slash Commands

| Command | Description |
|---------|-------------|
| `/help` | Show all commands |
| `/status` | Daemon and session status |
| `/scaffold` | Create entity with Discord channels |
| `/plan` | Create a feature |
| `/features` | List features |
| `/swap` | Switch agent archetype in a work room |
| `/room` | Create a new work room |
| `/close` | Close and archive a work room session |
| `/resume` | Restore an archived session |
| `/archives` | List archived sessions |
| `/reset` | Release current bot, fresh assignment on next message |

## License

Private.
