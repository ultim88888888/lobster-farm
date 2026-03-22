import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  Client,
  ChannelType as DiscordChannelType,
  GatewayIntentBits,
  type TextChannel,
  type Message,
  type Webhook,
  type Guild,
  type CategoryChannel,
} from "discord.js";
import type {
  LobsterFarmConfig,
  ChannelType,
  ArchetypeRole,
} from "@lobster-farm/shared";
import {
  entity_dir,
  entity_daily_dir,
  entity_context_dir,
  entity_files_dir,
  entity_config_path,
  entity_memory_path,
  write_yaml,
} from "@lobster-farm/shared";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EntityRegistry } from "./registry.js";
import type { FeatureManager, CreateFeatureOptions } from "./features.js";
import { route_message, type RouteAction, type RoutedMessage } from "./router.js";
import type { TaskQueue } from "./queue.js";

const exec = promisify(execFile);

// ── Channel index entry ──

interface ChannelEntry {
  entity_id: string;
  channel_type: ChannelType;
  assigned_feature?: string | null;
}

// ── Discord Bot ──

export class DiscordBot extends EventEmitter {
  private client: Client;
  private channel_map = new Map<string, ChannelEntry>();
  private entity_channels = new Map<string, Map<ChannelType, string>>();
  private connected = false;

  constructor(
    private config: LobsterFarmConfig,
    private registry: EntityRegistry,
  ) {
    super();
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
  }

  /** Connect to Discord. */
  async connect(token: string): Promise<void> {
    this.build_channel_map();

    this.client.on("ready", () => {
      const tag = this.client.user?.tag ?? "unknown";
      console.log(`[discord] Connected as ${tag}`);
      this.connected = true;
      this.emit("connected");
    });

    this.client.on("messageCreate", (message: Message) => {
      void this.handle_message(message);
    });

    await this.client.login(token);
  }

  /** Disconnect from Discord. */
  async disconnect(): Promise<void> {
    if (this.connected) {
      console.log("[discord] Disconnecting...");
      this.client.destroy();
      this.connected = false;
    }
  }

  /** Check if connected. */
  is_connected(): boolean {
    return this.connected;
  }

  /** Send a plain message to a channel (from the bot itself). */
  async send(channel_id: string, content: string): Promise<void> {
    if (!this.connected) {
      console.log(`[discord:offline] Would send to ${channel_id}: ${content}`);
      return;
    }

    try {
      const channel = await this.client.channels.fetch(channel_id);
      if (channel?.isTextBased()) {
        await (channel as TextChannel).send(content);
      }
    } catch (err) {
      console.error(`[discord] Failed to send to ${channel_id}: ${String(err)}`);
    }
  }

  /**
   * Send a message as a specific agent (with custom name + avatar via webhook).
   * Falls back to regular send if webhook creation fails.
   */
  async send_as_agent(
    channel_id: string,
    content: string,
    archetype: ArchetypeRole | "system",
  ): Promise<void> {
    if (!this.connected) {
      console.log(`[discord:offline] [${archetype}] ${content}`);
      return;
    }

    const identity = this.resolve_agent_identity(archetype);

    try {
      const webhook = await this.get_or_create_webhook(channel_id);
      if (webhook) {
        await webhook.send({
          content,
          username: identity.name,
          avatarURL: identity.avatar_url,
        });
        return;
      }
    } catch (err) {
      console.log(`[discord] Webhook send failed, falling back to bot: ${String(err)}`);
    }

    // Fallback: send as bot with agent prefix
    await this.send(channel_id, `**[${identity.name}]** ${content}`);
  }

  /** Send a message to an entity's channel by type, as a specific agent. */
  async send_to_entity(
    entity_id: string,
    channel_type: ChannelType,
    content: string,
    archetype?: ArchetypeRole | "system",
  ): Promise<void> {
    const entity_map = this.entity_channels.get(entity_id);
    if (!entity_map) {
      console.log(`[discord] No channel mapping for entity ${entity_id}`);
      return;
    }

    const channel_id = entity_map.get(channel_type);
    if (!channel_id) {
      console.log(`[discord] No ${channel_type} channel for entity ${entity_id}`);
      return;
    }

    if (archetype) {
      await this.send_as_agent(channel_id, content, archetype);
    } else {
      await this.send(channel_id, content);
    }
  }

  // ── Agent identity ──

  private resolve_agent_identity(archetype: ArchetypeRole | "system"): { name: string; avatar_url: string | undefined } {
    if (archetype === "system") {
      return { name: "LobsterFarm", avatar_url: undefined };
    }

    const agents = this.config.agents;
    const names: Record<string, string> = {
      planner: agents.planner.name,
      designer: agents.designer.name,
      builder: agents.builder.name,
      operator: agents.operator.name,
      commander: agents.commander.name,
      reviewer: "Reviewer",
    };

    // Emoji-based "avatars" as fallback — Discord webhooks can use avatar URLs
    // Users can configure real avatar URLs in the future
    const name = names[archetype] ?? archetype;
    return { name, avatar_url: undefined };
  }

  // ── Webhook management ──

  private webhook_cache = new Map<string, Webhook>();

  private async get_or_create_webhook(channel_id: string): Promise<Webhook | null> {
    // Check cache
    const cached = this.webhook_cache.get(channel_id);
    if (cached) return cached;

    try {
      const channel = await this.client.channels.fetch(channel_id);
      if (!channel?.isTextBased()) return null;

      const text_channel = channel as TextChannel;

      // Look for existing LobsterFarm webhook
      const webhooks = await text_channel.fetchWebhooks();
      let webhook = webhooks.find((w) => w.name === "LobsterFarm Agent");

      if (!webhook) {
        // Create one
        webhook = await text_channel.createWebhook({
          name: "LobsterFarm Agent",
          reason: "LobsterFarm agent identity support",
        });
        console.log(`[discord] Created webhook for channel ${channel_id}`);
      }

      this.webhook_cache.set(channel_id, webhook);
      return webhook;
    } catch (err) {
      console.log(`[discord] Failed to get/create webhook for ${channel_id}: ${String(err)}`);
      return null;
    }
  }

  // ── Server & Entity Scaffolding ──

  /** Get the guild (Discord server) from config. */
  private async get_guild(): Promise<Guild | null> {
    const server_id = this.config.discord?.server_id;
    if (!server_id) {
      console.log("[discord] No server_id in config — cannot scaffold");
      return null;
    }
    try {
      return await this.client.guilds.fetch(server_id);
    } catch (err) {
      console.error(`[discord] Failed to fetch guild ${server_id}: ${String(err)}`);
      return null;
    }
  }

  /**
   * Scaffold the global Discord structure on first connect.
   * Creates the GLOBAL category with #command-center and #system-status.
   * Returns the channel IDs created.
   */
  async scaffold_server(): Promise<{ command_center?: string; system_status?: string }> {
    const guild = await this.get_guild();
    if (!guild) return {};

    const result: { command_center?: string; system_status?: string } = {};

    try {
      // Find or create GLOBAL category
      let category = guild.channels.cache.find(
        (c) => c.name === "GLOBAL" && c.type === DiscordChannelType.GuildCategory,
      ) as CategoryChannel | undefined;

      if (!category) {
        category = await guild.channels.create({
          name: "GLOBAL",
          type: DiscordChannelType.GuildCategory,
          reason: "LobsterFarm global channels",
        });
        console.log("[discord] Created GLOBAL category");
      }

      // Create channels under GLOBAL
      const global_channels = [
        { name: "command-center", key: "command_center" as const },
        { name: "system-status", key: "system_status" as const },
      ];

      for (const ch of global_channels) {
        let channel = guild.channels.cache.find(
          (c) => c.name === ch.name && c.parentId === category!.id,
        );

        if (!channel) {
          channel = await guild.channels.create({
            name: ch.name,
            type: DiscordChannelType.GuildText,
            parent: category.id,
            reason: "LobsterFarm global channel",
          });
          console.log(`[discord] Created #${ch.name}`);
        }

        result[ch.key] = channel.id;
      }
    } catch (err) {
      console.error(`[discord] Server scaffold failed: ${String(err)}`);
    }

    return result;
  }

  /**
   * Scaffold Discord channels for a new entity.
   * Creates a category and standard channels (general, work-rooms, work-log, alerts).
   * Returns the channel mappings to store in entity config.
   */
  async scaffold_entity(
    entity_id: string,
    entity_name: string,
  ): Promise<Array<{ type: string; id: string; purpose: string }>> {
    const guild = await this.get_guild();
    if (!guild) return [];

    const channels: Array<{ type: string; id: string; purpose: string }> = [];

    try {
      // Create entity category
      const category_name = `${entity_name} [${entity_id}]`;
      let category = guild.channels.cache.find(
        (c) => c.name === category_name && c.type === DiscordChannelType.GuildCategory,
      ) as CategoryChannel | undefined;

      if (!category) {
        category = await guild.channels.create({
          name: category_name,
          type: DiscordChannelType.GuildCategory,
          reason: `LobsterFarm entity: ${entity_id}`,
        });
        console.log(`[discord] Created category "${category_name}"`);
      }

      // Standard entity channels
      const entity_channels = [
        { name: "general", type: "general", purpose: "Entity-level discussion" },
        { name: "work-room-1", type: "work_room", purpose: "Feature workspace 1" },
        { name: "work-room-2", type: "work_room", purpose: "Feature workspace 2" },
        { name: "work-room-3", type: "work_room", purpose: "Feature workspace 3" },
        { name: "work-log", type: "work_log", purpose: "Agent activity feed" },
        { name: "alerts", type: "alerts", purpose: "Approvals, blockers, questions" },
      ];

      for (const ch of entity_channels) {
        let channel = guild.channels.cache.find(
          (c) => c.name === ch.name && c.parentId === category!.id,
        );

        if (!channel) {
          channel = await guild.channels.create({
            name: ch.name,
            type: DiscordChannelType.GuildText,
            parent: category.id,
            reason: `LobsterFarm entity: ${entity_id}`,
          });
          console.log(`[discord] Created #${ch.name} in ${category_name}`);
        }

        channels.push({ type: ch.type, id: channel.id, purpose: ch.purpose });
      }

      // Rebuild channel map to include new channels
      this.build_channel_map();
    } catch (err) {
      console.error(`[discord] Entity scaffold failed for ${entity_id}: ${String(err)}`);
    }

    return channels;
  }

  /** Rebuild the channel → entity/type index from entity configs. */
  build_channel_map(): void {
    this.channel_map.clear();
    this.entity_channels.clear();

    for (const entity_config of this.registry.get_all()) {
      const entity_id = entity_config.entity.id;
      const entity_map = new Map<ChannelType, string>();

      for (const channel of entity_config.entity.channels) {
        this.channel_map.set(channel.id, {
          entity_id,
          channel_type: channel.type,
          assigned_feature: channel.assigned_feature,
        });

        // For send_to_entity, store the first channel of each type
        if (!entity_map.has(channel.type)) {
          entity_map.set(channel.type, channel.id);
        }
      }

      this.entity_channels.set(entity_id, entity_map);
    }

    console.log(
      `[discord] Channel map built: ${String(this.channel_map.size)} channels across ${String(this.entity_channels.size)} entities`,
    );
  }

  /** Set references to feature manager and queue for command handling. */
  private _features: FeatureManager | null = null;
  private _queue: TaskQueue | null = null;

  set_managers(features: FeatureManager, queue: TaskQueue): void {
    this._features = features;
    this._queue = queue;
  }

  // ── Internal message handling ──

  private async handle_message(message: Message): Promise<void> {
    // Ignore bot messages
    if (message.author.bot) return;

    // Look up channel in entity map
    const entry = this.channel_map.get(message.channelId);

    // If not in entity map, handle !lf commands OR route to Commander
    if (!entry) {
      if (message.content.trim().startsWith("!lf")) {
        const routed: RoutedMessage = {
          entity_id: "_global",
          channel_type: "general",
          content: message.content,
          author: message.author.tag,
          channel_id: message.channelId,
        };
        const { parse_command } = await import("./router.js");
        const cmd = parse_command(message.content);
        if (cmd) {
          try {
            await this.handle_command(cmd.name, cmd.args, routed, message);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await this.reply(message, `Error: ${msg}`);
          }
        }
      } else {
        // Natural language → Commander (in any unmapped channel, including #command-center)
        await this.handle_commander_message(message);
      }
      return;
    }

    const routed: RoutedMessage = {
      entity_id: entry.entity_id,
      channel_type: entry.channel_type,
      content: message.content,
      author: message.author.tag,
      channel_id: message.channelId,
      assigned_feature: entry.assigned_feature,
    };

    const action = route_message(routed);

    try {
      await this.execute_action(action, routed, message);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[discord] Error handling message: ${msg}`);
      await this.reply(message, `Error: ${msg}`);
    }
  }

  private async execute_action(
    action: RouteAction,
    routed: RoutedMessage,
    message: Message,
  ): Promise<void> {
    switch (action.type) {
      case "command":
        await this.handle_command(action.name, action.args, routed, message);
        break;

      case "classify":
        await this.reply(
          message,
          `Classified as **${action.archetype}** task. ` +
            `Use \`!lf plan ${routed.entity_id} "${action.prompt}"\` to create a feature, ` +
            `or I can handle it directly (coming soon).`,
        );
        break;

      case "route_to_session":
        await this.reply(
          message,
          `Routing to feature **${action.feature_id}** session (interactive routing coming soon).`,
        );
        break;

      case "approval_response":
        await this.reply(
          message,
          `Received approval response. Use \`!lf approve <feature-id>\` to approve a specific feature.`,
        );
        break;

      case "ask_clarification":
        await this.reply(message, action.message);
        break;

      case "ignore":
        break;
    }
  }

  private async handle_command(
    name: string,
    args: string[],
    routed: RoutedMessage,
    message: Message,
  ): Promise<void> {
    switch (name) {
      case "help":
        await this.reply(
          message,
          "**LobsterFarm Commands:**\n" +
            "• `!lf plan <entity> <title>` — create a feature in plan phase\n" +
            "• `!lf approve <feature-id>` — approve current phase gate\n" +
            "• `!lf advance <feature-id>` — advance to next phase\n" +
            "• `!lf status` — daemon status\n" +
            "• `!lf features [entity]` — list features\n" +
            "• `!lf scaffold server` — create GLOBAL Discord channels\n" +
            "• `!lf scaffold entity <id> <name>` — create entity Discord channels\n" +
            "• `!lf help` — this message",
        );
        break;

      case "status":
        await this.handle_status_command(message);
        break;

      case "plan":
        await this.handle_plan_command(args, routed, message);
        break;

      case "approve":
        await this.handle_approve_command(args, message);
        break;

      case "advance":
        await this.handle_advance_command(args, message);
        break;

      case "features":
        await this.handle_features_command(args, message);
        break;

      case "scaffold":
        await this.handle_scaffold_command(args, routed, message);
        break;

      default:
        await this.reply(message, `Unknown command: \`${name}\`. Try \`!lf help\`.`);
    }
  }

  private async handle_status_command(message: Message): Promise<void> {
    const features = this._features;
    const queue = this._queue;

    const lines = ["**LobsterFarm Status**"];
    lines.push(`Entities: ${String(this.registry.count())} (${String(this.registry.get_active().length)} active)`);

    if (queue) {
      const stats = queue.get_stats();
      lines.push(`Queue: ${String(stats.active)} active, ${String(stats.pending)} pending`);
    }

    if (features) {
      const all = features.list_features();
      const by_phase = new Map<string, number>();
      for (const f of all) {
        by_phase.set(f.phase, (by_phase.get(f.phase) ?? 0) + 1);
      }
      if (all.length > 0) {
        const phase_summary = [...by_phase.entries()]
          .map(([p, c]) => `${p}: ${String(c)}`)
          .join(", ");
        lines.push(`Features: ${String(all.length)} total (${phase_summary})`);
      } else {
        lines.push("Features: none");
      }
    }

    lines.push(`Discord: connected`);
    await this.reply(message, lines.join("\n"));
  }

  private async handle_plan_command(
    args: string[],
    routed: RoutedMessage,
    message: Message,
  ): Promise<void> {
    const features = this._features;
    if (!features) {
      await this.reply(message, "Feature manager not available.");
      return;
    }

    // Parse: !lf plan <entity_id> <title>
    // If entity_id is omitted, use the channel's entity
    let entity_id: string;
    let title: string;

    if (args.length === 0) {
      await this.reply(message, "Usage: `!lf plan <entity> <title>` or `!lf plan <title>` (in an entity channel)");
      return;
    }

    // Check if first arg is a known entity
    const first_arg = args[0]!;
    if (this.registry.get(first_arg)) {
      entity_id = first_arg;
      title = args.slice(1).join(" ");
    } else {
      entity_id = routed.entity_id;
      title = args.join(" ");
    }

    if (!title) {
      await this.reply(message, "Please provide a title for the feature.");
      return;
    }

    // Generate a GitHub issue number (placeholder — in production, create the actual issue)
    const issue_number = Date.now() % 10000;

    try {
      const feature = features.create_feature({
        entity_id,
        title,
        github_issue: issue_number,
      });

      await this.reply(
        message,
        `Feature **${feature.id}** created: "${title}"\n` +
          `Phase: plan | Issue: #${String(issue_number)}\n` +
          `Approve with \`!lf approve ${feature.id}\`, then advance with \`!lf advance ${feature.id}\``,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.reply(message, `Failed to create feature: ${msg}`);
    }
  }

  private async handle_approve_command(args: string[], message: Message): Promise<void> {
    const features = this._features;
    if (!features) {
      await this.reply(message, "Feature manager not available.");
      return;
    }

    const feature_id = args[0];
    if (!feature_id) {
      await this.reply(message, "Usage: `!lf approve <feature-id>`");
      return;
    }

    try {
      const feature = features.approve_phase(feature_id);
      await this.reply(
        message,
        `Approved phase **${feature.phase}** for ${feature_id}. ` +
          `Use \`!lf advance ${feature_id}\` to proceed.`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.reply(message, `Failed to approve: ${msg}`);
    }
  }

  private async handle_advance_command(args: string[], message: Message): Promise<void> {
    const features = this._features;
    if (!features) {
      await this.reply(message, "Feature manager not available.");
      return;
    }

    const feature_id = args[0];
    if (!feature_id) {
      await this.reply(message, "Usage: `!lf advance <feature-id>`");
      return;
    }

    try {
      const feature = await features.advance_feature(feature_id);
      await this.reply(
        message,
        `Feature **${feature_id}** advanced to **${feature.phase}** phase.`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.reply(message, `Failed to advance: ${msg}`);
    }
  }

  private async handle_features_command(args: string[], message: Message): Promise<void> {
    const features = this._features;
    if (!features) {
      await this.reply(message, "Feature manager not available.");
      return;
    }

    const entity_filter = args[0];
    const all = entity_filter
      ? features.get_features_by_entity(entity_filter)
      : features.list_features();

    if (all.length === 0) {
      await this.reply(message, "No features found.");
      return;
    }

    const lines = all.map((f) => {
      let status = `**${f.id}** — ${f.title} [${f.phase}]`;
      if (f.blocked) status += " (BLOCKED)";
      if (f.approved) status += " (approved)";
      if (f.sessionId) status += " (active session)";
      return status;
    });

    await this.reply(message, lines.join("\n"));
  }

  private async handle_scaffold_command(
    args: string[],
    routed: RoutedMessage,
    message: Message,
  ): Promise<void> {
    const sub = args[0];

    if (sub === "entity") {
      // Usage: !lf scaffold entity <id> <name> [--repo <url>]
      const entity_id = args[1];
      if (!entity_id || !/^[a-z0-9-]+$/.test(entity_id)) {
        await this.reply(message, "Usage: `!lf scaffold entity <id> <name>`\nID must be lowercase alphanumeric with hyphens.");
        return;
      }

      // Check if entity already exists
      if (this.registry.get(entity_id)) {
        await this.reply(message, `Entity **${entity_id}** already exists.`);
        return;
      }

      // Parse remaining args for name and optional --repo
      const remaining = args.slice(2);
      let repo_url = "";
      const name_parts: string[] = [];
      for (let i = 0; i < remaining.length; i++) {
        if (remaining[i] === "--repo" && remaining[i + 1]) {
          repo_url = remaining[i + 1]!;
          i++;
        } else {
          name_parts.push(remaining[i]!);
        }
      }
      const entity_name = name_parts.join(" ") || entity_id;

      await this.reply(message, `Setting up entity **${entity_id}** ("${entity_name}")...`);

      // 1. Create Discord channels
      const channels = await this.scaffold_entity(entity_id, entity_name);

      // 2. Create directory structure
      const paths = this.config.paths;
      const dirs = [
        entity_dir(paths, entity_id),
        entity_daily_dir(paths, entity_id),
        entity_context_dir(paths, entity_id),
        entity_files_dir(paths, entity_id),
      ];
      for (const dir of dirs) {
        await mkdir(dir, { recursive: true });
      }

      // 3. Create entity config
      const entity_config = {
        entity: {
          id: entity_id,
          name: entity_name,
          description: "",
          status: "active",
          repo: {
            url: repo_url || `git@github.com:org/${entity_id}.git`,
            path: `~/projects/${entity_id}/${entity_id}`,
            structure: "monorepo",
          },
          accounts: {},
          channels,
          agent_mode: "hybrid",
          models: {},
          budget: { monthly_warning_pct: 80, monthly_limit: null },
          memory: {
            path: entity_dir(paths, entity_id),
            auto_extract: true,
          },
          active_sops: [
            "feature-lifecycle",
            "pr-review-merge",
            "secrets-management",
            "readme-maintenance",
          ],
          secrets: {
            vault: "1password",
            vault_name: `entity-${entity_id}`,
          },
        },
      };

      const config_path = entity_config_path(paths, entity_id);
      await write_yaml(config_path, entity_config);

      // 4. Create MEMORY.md and context files
      const mem_path = entity_memory_path(paths, entity_id);
      await writeFile(
        mem_path,
        `# ${entity_name} — Memory\n\n_Curated project knowledge. Updated by agents, reviewed periodically._\n`,
        "utf-8",
      );

      const ctx_dir = entity_context_dir(paths, entity_id);
      await writeFile(
        join(ctx_dir, "decisions.md"),
        `# ${entity_name} — Decision Log\n\n_Append-only. Record significant decisions with rationale._\n`,
        "utf-8",
      );
      await writeFile(
        join(ctx_dir, "gotchas.md"),
        `# ${entity_name} — Known Gotchas\n\n_Issues, workarounds, and things to watch out for._\n`,
        "utf-8",
      );

      // 5. Reload entity into registry
      await this.registry.load_all();

      // 6. Report
      const channel_lines = channels.map((c) => `  • #${c.purpose} → ${c.type}`);
      await this.reply(
        message,
        `Entity **${entity_id}** fully scaffolded:\n` +
          `• Config: \`${config_path}\`\n` +
          `• Memory: \`${mem_path}\`\n` +
          `• Discord: ${String(channels.length)} channels\n` +
          channel_lines.join("\n") + "\n\n" +
          `Ready to use. Try \`!lf plan ${entity_id} "Your first feature"\``,
      );
    } else if (sub === "server") {
      await this.reply(message, "Scaffolding global Discord structure...");
      const result = await this.scaffold_server();
      const created = Object.entries(result).filter(([_, v]) => v).length;
      await this.reply(message, `Global scaffold complete. ${String(created)} channels configured.`);
    } else {
      await this.reply(
        message,
        "Usage:\n• `!lf scaffold server` — create GLOBAL channels\n• `!lf scaffold entity <id> <name>` — create entity channels",
      );
    }
  }

  private async handle_commander_message(message: Message): Promise<void> {
    const { run_commander } = await import("./commander.js");

    // Show typing indicator (refresh every 8s since Claude Code takes a while)
    let typing = true;
    const typing_interval = setInterval(() => {
      if (typing) {
        message.channel.sendTyping().catch(() => {});
      }
    }, 8000);
    try { await message.channel.sendTyping(); } catch { /* ignore */ }

    try {
      const response = await run_commander(
        message.content,
        this.config,
        this.registry,
        this._features!,
        this._queue!,
      );

      typing = false;
      clearInterval(typing_interval);

      // Discord has a 2000 char limit — split if needed
      if (response.length <= 1900) {
        await this.send_as_agent(message.channelId, response, "commander");
      } else {
        // Split into chunks
        const chunks = response.match(/[\s\S]{1,1900}/g) ?? [response.slice(0, 1900)];
        for (const chunk of chunks) {
          await this.send_as_agent(message.channelId, chunk, "commander");
        }
      }

      // Reload entities in case Commander created/modified any
      await this.registry.load_all();
      this.build_channel_map();
    } catch (err) {
      typing = false;
      clearInterval(typing_interval);
      const msg = err instanceof Error ? err.message : String(err);
      await this.reply(message, `Commander error: ${msg}`);
    }
  }

  private async reply(message: Message, content: string): Promise<void> {
    try {
      await message.reply(content);
    } catch {
      // If reply fails, try sending to channel directly
      await this.send(message.channelId, content);
    }
  }
}

// ── Token resolution ──

/** Resolve the Discord bot token. Resolution order:
 * 1. DISCORD_BOT_TOKEN env var
 * 2. ~/.lobsterfarm/.env file (written by setup wizard)
 * 3. 1Password reference (if configured)
 */
export async function resolve_bot_token(
  config: LobsterFarmConfig,
): Promise<string | null> {
  // 1. Environment variable
  const env_token = process.env["DISCORD_BOT_TOKEN"];
  if (env_token) {
    console.log("[discord] Using bot token from DISCORD_BOT_TOKEN env var");
    return env_token;
  }

  // 2. .env file in lobsterfarm dir
  try {
    const { lobsterfarm_dir } = await import("@lobster-farm/shared");
    const { readFile } = await import("node:fs/promises");
    const env_path = `${lobsterfarm_dir(config.paths)}/.env`;
    const env_content = await readFile(env_path, "utf-8");
    const match = env_content.match(/^DISCORD_BOT_TOKEN=(.+)$/m);
    if (match?.[1]) {
      console.log("[discord] Using bot token from .env file");
      return match[1].trim();
    }
  } catch {
    // .env file doesn't exist — continue
  }

  // 3. 1Password reference
  const op_ref = config.discord?.bot_token_ref;
  if (op_ref) {
    try {
      const { stdout } = await exec("op", ["read", op_ref]);
      const token = stdout.trim();
      if (token) {
        console.log("[discord] Using bot token from 1Password");
        return token;
      }
    } catch {
      console.log("[discord] Failed to read bot token from 1Password");
    }
  }

  return null;
}
