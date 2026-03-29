---
name: discord-guideline
description: >
  Discord server management — creating channels, categories, webhooks,
  and managing permissions. Auto-loads when tasks involve Discord setup,
  channel scaffolding, or bot configuration.
---

# Discord Guideline

_How to manage Discord servers in LobsterFarm. Covers the daemon API for scaffolding and direct discord.js patterns when needed._

---

## Architecture

LobsterFarm uses two Discord bots:

**Daemon bot** — server management. Has Manage Server permissions. Handles channel creation, category scaffolding, webhooks for agent identity, entity channel routing.

**Commander bot** — persistent Claude Code session in #command-center. Minimal permissions (View, Send, Read History, Attach Files, Add Reactions). Connected via `--channels plugin:discord@claude-plugins-official`.

## Scaffolding via Daemon API

The daemon bot handles all Discord scaffolding. Use the HTTP API:

```bash
# Scaffold global structure (GLOBAL category + #command-center + #system-status)
curl -s -X POST http://localhost:7749/scaffold/server

# Scaffold entity channels (category + channels per blueprint)
curl -s -X POST http://localhost:7749/scaffold/entity \
  -H 'Content-Type: application/json' \
  -d '{"entity_id": "my-entity", "entity_name": "My Entity"}'
```

Entity scaffolding is also available via the `/scaffold` slash command in Discord.

## Channel Structure

### Global (GLOBAL category)
- `#command-center` — Commander's channel. Platform-level admin.
- `#system-status` — Daemon health, alerts, system events.

### Per-Entity ({Entity Name} [{entity-id}] category)
Channel structure is defined by the entity's blueprint. For the `software` blueprint:
- `#general` — entity discussion and coordination
- `#work-room-1` through `#work-room-3` — feature workspaces
- `#work-log` — agent activity feed
- `#alerts` — approvals, blockers, questions

## discord.js Patterns

When working directly with discord.js (in daemon code):

### Create a category
```typescript
const category = await guild.channels.create({
  name: "Entity Name [entity-id]",
  type: ChannelType.GuildCategory,
  reason: "LobsterFarm entity: entity-id",
});
```

### Create a text channel under a category
```typescript
const channel = await guild.channels.create({
  name: "channel-name",
  type: ChannelType.GuildText,
  parent: category.id,
  reason: "LobsterFarm entity: entity-id",
});
```

### Find existing channel (idempotent scaffolding)
```typescript
const existing = guild.channels.cache.find(
  (c) => c.name === "channel-name" && c.parentId === category.id,
);
if (!existing) {
  // create it
}
```

### Create a webhook for agent identity
```typescript
const webhook = await textChannel.createWebhook({
  name: "LobsterFarm Agent",
  reason: "Agent identity support",
});

// Send as a specific agent
await webhook.send({
  content: "message",
  username: "Bob",
  avatarURL: "https://...",
});
```

### Channel types
```typescript
import { ChannelType } from "discord.js";
// ChannelType.GuildText — standard text channel
// ChannelType.GuildCategory — category (container)
// ChannelType.GuildVoice — voice channel
```

## Naming Conventions

- Categories: `{Entity Name} [{entity-id}]` (e.g. "My SaaS [my-saas]")
- Channels: lowercase, hyphenated (e.g. `work-room-1`, `work-log`)
- Global category: `GLOBAL` (uppercase)
- Webhooks: `LobsterFarm Agent` (shared per channel, agents differentiate via username)

## Permissions

**Daemon bot needs:**
- Manage Server (for guild-level operations)
- Manage Channels (create/delete channels and categories)
- Manage Webhooks (create webhooks for agent identity)
- View Channels, Send Messages, Read Message History

**Commander bot needs:**
- View Channels
- Send Messages, Send Messages in Threads
- Read Message History
- Attach Files
- Add Reactions

## IDs

Discord uses snowflake IDs (large numeric strings). Enable Developer Mode in Discord (User Settings → Advanced) to copy IDs via right-click.

- Server ID: right-click server name → Copy Server ID
- Channel ID: right-click channel → Copy Channel ID
- User ID: right-click user → Copy User ID
- Message ID: right-click message → Copy Message ID
