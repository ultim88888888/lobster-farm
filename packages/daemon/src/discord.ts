import { EventEmitter } from "node:events";
import { execFile, execFileSync } from "node:child_process";
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
  expand_home,
  write_yaml,
} from "@lobster-farm/shared";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { lobsterfarm_dir } from "@lobster-farm/shared";
import type { EntityRegistry } from "./registry.js";
import type { FeatureManager, CreateFeatureOptions } from "./features.js";
import { route_message, type RouteAction, type RoutedMessage } from "./router.js";
import type { TaskQueue } from "./queue.js";
import type { BotPool, PoolBot } from "./pool.js";

const exec = promisify(execFile);

/** Discord snowflake IDs are numeric strings, 17-20 digits. */
export function is_discord_snowflake(id: string): boolean {
  return /^\d{17,20}$/.test(id);
}

/**
 * Extract GitHub owner/repo (nwo) from a repo URL.
 * Handles both SSH (git@github.com:owner/repo.git) and
 * HTTPS (https://github.com/owner/repo.git) formats.
 * Returns undefined if the URL doesn't match either pattern.
 */
function nwo_from_url(url: string): string | undefined {
  // SSH: git@github.com:owner/repo.git
  const ssh_match = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (ssh_match) return ssh_match[1];
  return undefined;
}


// ── Formatting helpers ──

/** Format the duration between a start time and now as a human-readable string (e.g., "2h 14m"). */
export function format_duration(start: Date): string {
  const ms = Date.now() - start.getTime();
  if (ms < 0) return "0m";
  const total_minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(total_minutes / 60);
  const minutes = total_minutes % 60;
  if (hours > 0) return `${String(hours)}h ${String(minutes)}m`;
  return `${String(minutes)}m`;
}

// ── Channel index entry ──

interface ChannelEntry {
  entity_id: string;
  channel_type: ChannelType;
  assigned_feature?: string | null;
}

// ── Discord Bot ──

// ── Avatar cache paths ──

const AVATAR_EXTENSIONS = [".jpg", ".png", ".webp"];

function avatars_dir(): string {
  return join(lobsterfarm_dir(), "avatars");
}

function avatar_cache_path(config: LobsterFarmConfig): string {
  return join(lobsterfarm_dir(config.paths), "state", "avatar-urls.json");
}

export class DiscordBot extends EventEmitter {
  private client: Client;
  private channel_map = new Map<string, ChannelEntry>();
  private entity_channels = new Map<string, Map<ChannelType, string>>();
  private connected = false;
  /** Cached avatar CDN URLs keyed by lowercase agent name. */
  private avatar_urls = new Map<string, string>();

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

    const ready = new Promise<void>(resolve => {
      this.client.once("ready", () => {
        const tag = this.client.user?.tag ?? "unknown";
        console.log(`[discord] Connected as ${tag}`);
        this.connected = true;
        this.emit("connected");
        resolve();
      });
    });

    this.client.on("messageCreate", (message: Message) => {
      void this.handle_message(message);
    });

    await this.client.login(token);
    await ready;
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

  // ── Channel management ──

  /** Set a channel's topic. No-op if disconnected or channel not found. */
  async set_channel_topic(channel_id: string, topic: string): Promise<void> {
    if (!this.connected) return;
    try {
      const channel = await this.client.channels.fetch(channel_id);
      if (channel?.isTextBased() && !channel.isDMBased()) {
        await (channel as TextChannel).setTopic(topic);
      }
    } catch (err) {
      console.error(`[discord] Failed to set topic for ${channel_id}: ${String(err)}`);
    }
  }

  /** Create a text channel under a category. Returns the channel ID, or null on failure. */
  async create_channel(
    category_id: string,
    name: string,
    reason?: string,
  ): Promise<string | null> {
    const guild = await this.get_guild();
    if (!guild) return null;
    try {
      const channel = await guild.channels.create({
        name,
        type: DiscordChannelType.GuildText,
        parent: category_id,
        reason: reason ?? "LobsterFarm dynamic channel",
      });
      console.log(`[discord] Created #${name} (${channel.id})`);
      return channel.id;
    } catch (err) {
      console.error(`[discord] Failed to create channel "${name}": ${String(err)}`);
      return null;
    }
  }

  /** Delete a channel by ID. Returns true on success, false on failure. No-op (returns true) if disconnected or DM channel. */
  async delete_channel(channel_id: string): Promise<boolean> {
    if (!this.connected) return true;
    try {
      const channel = await this.client.channels.fetch(channel_id);
      if (!channel || channel.isDMBased()) return true;
      await channel.delete("LobsterFarm work room cleanup");
      console.log(`[discord] Deleted channel ${channel_id}`);
      return true;
    } catch (err) {
      console.error(`[discord] Failed to delete channel ${channel_id}: ${String(err)}`);
      return false;
    }
  }

  // ── Agent identity ──

  resolve_agent_identity(archetype: ArchetypeRole | "system"): { name: string; avatar_url: string | undefined } {
    if (archetype === "system") {
      const system_url = this.avatar_urls.get("lobsterfarm");
      return { name: "LobsterFarm", avatar_url: system_url };
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

    const name = names[archetype] ?? archetype;
    const avatar_url = this.avatar_urls.get(name.toLowerCase());
    return { name, avatar_url };
  }

  // ── Avatar management ──

  /** Load avatar URL cache from disk. Returns the parsed map (also populates this.avatar_urls). */
  async load_avatar_cache(): Promise<Map<string, string>> {
    try {
      const raw = await readFile(avatar_cache_path(this.config), "utf-8");
      const data: unknown = JSON.parse(raw);
      if (data && typeof data === "object" && !Array.isArray(data)) {
        for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
          if (typeof value === "string") {
            this.avatar_urls.set(key, value);
          }
        }
      }
    } catch {
      // File doesn't exist or is invalid — start with empty cache
    }
    return new Map(this.avatar_urls);
  }

  /** Save current avatar URL cache to disk. */
  async save_avatar_cache(): Promise<void> {
    const path = avatar_cache_path(this.config);
    await mkdir(join(path, ".."), { recursive: true });
    const obj: Record<string, string> = {};
    for (const [key, value] of this.avatar_urls) {
      obj[key] = value;
    }
    await writeFile(path, JSON.stringify(obj, null, 2), "utf-8");
  }

  /**
   * Upload agent avatars to Discord and cache the CDN URLs.
   *
   * For each configured agent, checks if an avatar file exists at
   * ~/.lobsterfarm/avatars/{name}.{jpg,png,webp}. If the URL is already
   * cached, skips the upload. Otherwise uploads to a system channel
   * and extracts the CDN URL from the resulting attachment.
   *
   * Must be called after Discord is connected.
   */
  async upload_avatars(): Promise<void> {
    // Load any existing cache from disk
    await this.load_avatar_cache();

    // Collect all agent names from config
    const agents = this.config.agents;
    const agent_names = [
      agents.planner.name.toLowerCase(),
      agents.designer.name.toLowerCase(),
      agents.builder.name.toLowerCase(),
      agents.operator.name.toLowerCase(),
      agents.commander.name.toLowerCase(),
    ];

    // Discover avatar files on disk
    let dir_entries: string[] = [];
    try {
      dir_entries = await readdir(avatars_dir());
    } catch {
      console.log("[discord:avatars] No avatars directory found — skipping avatar upload");
      return;
    }

    // Build a map of agent name → file path for files that exist on disk
    const avatar_files = new Map<string, string>();
    for (const filename of dir_entries) {
      const dot = filename.lastIndexOf(".");
      if (dot === -1) continue;
      const ext = filename.slice(dot).toLowerCase();
      if (!AVATAR_EXTENSIONS.includes(ext)) continue;
      const name = filename.slice(0, dot).toLowerCase();
      avatar_files.set(name, join(avatars_dir(), filename));
    }

    // Find a channel to upload to (system-status preferred, any entity channel as fallback)
    const upload_channel_id = this.find_upload_channel();
    if (!upload_channel_id) {
      console.log("[discord:avatars] No channel available for avatar upload — skipping");
      return;
    }

    let uploaded = 0;
    let cached = 0;

    for (const name of agent_names) {
      // Already cached — skip
      if (this.avatar_urls.has(name)) {
        cached++;
        continue;
      }

      const file_path = avatar_files.get(name);
      if (!file_path) continue;

      try {
        const url = await this.upload_avatar_file(upload_channel_id, name, file_path);
        if (url) {
          this.avatar_urls.set(name, url);
          uploaded++;
        }
      } catch (err) {
        console.error(`[discord:avatars] Failed to upload avatar for ${name}: ${String(err)}`);
      }
    }

    // Also upload any non-agent avatar files (e.g., "lobsterfarm" for system identity)
    for (const [name, file_path] of avatar_files) {
      if (agent_names.includes(name)) continue; // already handled
      if (this.avatar_urls.has(name)) {
        cached++;
        continue;
      }

      try {
        const url = await this.upload_avatar_file(upload_channel_id, name, file_path);
        if (url) {
          this.avatar_urls.set(name, url);
          uploaded++;
        }
      } catch (err) {
        console.error(`[discord:avatars] Failed to upload avatar for ${name}: ${String(err)}`);
      }
    }

    // Save cache to disk if anything changed
    if (uploaded > 0) {
      await this.save_avatar_cache();
    }

    console.log(
      `[discord:avatars] ${String(uploaded)} uploaded, ${String(cached)} cached, ${String(this.avatar_urls.size)} total`,
    );
  }

  /** Upload a single avatar file to Discord and return the CDN URL. */
  private async upload_avatar_file(
    channel_id: string,
    name: string,
    file_path: string,
  ): Promise<string | null> {
    const channel = await this.client.channels.fetch(channel_id);
    if (!channel?.isTextBased()) return null;

    const text_channel = channel as TextChannel;
    const message = await text_channel.send({
      content: `Avatar: ${name}`,
      files: [{ attachment: file_path, name: `${name}${file_path.slice(file_path.lastIndexOf("."))}` }],
    });

    const attachment = message.attachments.first();
    if (!attachment?.url) {
      console.log(`[discord:avatars] Upload succeeded but no attachment URL for ${name}`);
      return null;
    }

    // Delete the upload message — we only needed the CDN URL
    try {
      await message.delete();
    } catch {
      // Not critical — message stays in the channel but that's fine
    }

    return attachment.url;
  }

  /** Find a channel suitable for avatar uploads. Prefers system-status. */
  private find_upload_channel(): string | null {
    // Try to find system-status channel from global config
    // (it's not in entity_channels — check by iterating channels)
    for (const [channel_id] of this.channel_map) {
      return channel_id; // any mapped channel will work
    }

    // Fallback: try any entity's first channel
    for (const [, entity_map] of this.entity_channels) {
      for (const [, channel_id] of entity_map) {
        return channel_id;
      }
    }

    return null;
  }

  /** Get the current avatar URL for an agent name (for testing/inspection). */
  get_avatar_url(name: string): string | undefined {
    return this.avatar_urls.get(name.toLowerCase());
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
  protected async get_guild(): Promise<Guild | null> {
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
  ): Promise<{ category_id: string; channels: Array<{ type: string; id: string; purpose: string }> }> {
    const guild = await this.get_guild();
    if (!guild) return { category_id: "", channels: [] };

    const channels: Array<{ type: string; id: string; purpose: string }> = [];
    let category_id = "";

    try {
      // Create entity category
      const category_name = entity_name;
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
      category_id = category.id;

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

        // Set channel topic for work rooms
        if (ch.type === "work_room") {
          try {
            const text_channel = channel as TextChannel;
            await text_channel.setTopic("🟢 Available");
          } catch (topic_err) {
            console.log(`[discord] Could not set topic for #${ch.name}: ${String(topic_err)}`);
          }
        }
      }

      // Rebuild channel map to include new channels
      this.build_channel_map();
    } catch (err) {
      console.error(`[discord] Entity scaffold failed for ${entity_id}: ${String(err)}`);
    }

    return { category_id, channels };
  }

  /** Rebuild the channel → entity/type index from entity configs. */
  build_channel_map(): void {
    this.channel_map.clear();
    this.entity_channels.clear();

    for (const entity_config of this.registry.get_all()) {
      const entity_id = entity_config.entity.id;
      const entity_map = new Map<ChannelType, string>();

      for (const channel of entity_config.entity.channels.list) {
        if (!is_discord_snowflake(channel.id)) {
          console.log(
            `[discord] Skipping invalid channel ID "${channel.id}" ` +
            `in entity "${entity_id}" — not a Discord snowflake`,
          );
          continue;
        }

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
  private _pool: BotPool | null = null;

  set_managers(features: FeatureManager, queue: TaskQueue): void {
    this._features = features;
    this._queue = queue;
  }

  set_pool(pool: BotPool): void {
    this._pool = pool;

    // Register nickname handler so pool can set bot nicknames through the
    // daemon's Discord client — no pool bot tokens needed at runtime.
    pool.set_nickname_handler(async (user_id: string, display_name: string) => {
      const guild = await this.get_guild();
      if (!guild) return;
      const member = await guild.members.fetch(user_id);
      await member.setNickname(display_name);
    });

    // When a waiting-for-human bot is evicted, notify the channel
    pool.on("bot:parked_with_context", (info: { bot_id: number; channel_id: string | null; entity_id: string | null }) => {
      if (info.channel_id) {
        void this.send(
          info.channel_id,
          "This session was parked to free up a bot slot. " +
          "Your conversation is saved — it will resume when you send a new message.",
        );
      }
    });
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
      }
      // Non-command messages in unmapped channels are ignored.
      // Commander (Pat) handles #command-center via its own Discord bot.
      return;
    }

    // Handle !lf commands in entity channels
    if (message.content.trim().startsWith("!lf")) {
      const routed: RoutedMessage = {
        entity_id: entry.entity_id,
        channel_type: entry.channel_type,
        content: message.content,
        author: message.author.tag,
        channel_id: message.channelId,
        assigned_feature: entry.assigned_feature,
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
      return;
    }

    // Intercept !reset — release current bot, next real message triggers fresh assignment
    if (message.content.trim().toLowerCase() === "!reset") {
      if (this._pool) {
        // Clear session history so the next assignment starts fresh
        this._pool.clear_session_history(entry.entity_id, message.channelId);
        await this._pool.release(message.channelId);
        await this.reply(message, "Session reset. Send a message to start fresh.");
      }
      return;
    }

    // Non-command messages: auto-assign a pool bot if none is active on this channel
    if (this._pool) {
      let assignment = this._pool.get_assignment(message.channelId);

      // If a bot is assigned but its tmux session is dead, release it (preserving
      // session_id for resume) and fall through to the auto-assign branch below.
      // This is the lazy-resume path: the first message after a tmux death triggers
      // reassignment with session resume, so the user never sees a gap.
      if (assignment && !this._pool.is_session_alive(assignment.id)) {
        console.log(
          `[discord] Dead tmux detected for pool-${String(assignment.id)} on message ` +
          `— releasing with history`,
        );
        await this._pool.release_with_history(assignment.id);
        assignment = undefined;
      }

      if (!assignment) {
        // Determine archetype: check if channel has a feature with an active phase
        let archetype: ArchetypeRole = "planner"; // default
        if (this._features && entry.assigned_feature) {
          const feature = this._features.get_feature(entry.assigned_feature);
          if (feature) {
            const phase_archetypes: Record<string, ArchetypeRole> = {
              plan: "planner", design: "designer", build: "builder",
              review: "reviewer", ship: "planner", done: "planner",
            };
            archetype = phase_archetypes[feature.phase] ?? "planner";
          }
        }

        // Show the user we're working on it
        try { await message.react("⏳"); } catch { /* ignore */ }

        const result = await this._pool.assign(
          message.channelId,
          entry.entity_id,
          archetype,
          undefined, // resume_session_id — pool handles auto-resume from parked bots + session_history
          entry.channel_type,
        );
        if (result) {
          // Bridge the first message: write to file, wait for bot, send via tmux
          await this.bridge_first_message(result.tmux_session, message.content, message.author.displayName);
          try {
            await message.reactions.cache.get("⏳")?.users.remove(this.client.user!.id);
            await message.react("👀");
          } catch { /* ignore */ }
        } else {
          try {
            await message.reactions.cache.get("⏳")?.users.remove(this.client.user!.id);
          } catch { /* ignore */ }
          await this.reply(
            message,
            "All bots are busy right now. Your message will be picked up when a slot opens.",
          );
        }
      } else {
        // Bot is assigned and tmux is alive — touch for LRU tracking
        this._pool.touch(message.channelId);
      }
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
            "• `!lf swap <agent>` — swap active agent in this channel (gary, bob, pearl, ray)\n" +
            "• `!lf compact` — trigger context compaction on the active session\n" +
            "• `!lf status` — session/entity status for this channel\n" +
            "• `!lf features [entity]` — list features\n" +
            "• `!lf scaffold server` — create GLOBAL Discord channels\n" +
            "• `!lf scaffold entity <id> <name>` — create entity Discord channels\n" +
            "• `!lf help` — this message",
        );
        break;

      case "status":
        await this.handle_status_command(routed, message);
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

      case "swap":
        await this.handle_swap_command(args, message);
        break;

      case "compact":
        await this.handle_compact_command(message);
        break;

      default:
        await this.reply(message, `Unknown command: \`${name}\`. Try \`!lf help\`.`);
    }
  }

  private async handle_status_command(routed: RoutedMessage, message: Message): Promise<void> {
    const pool = this._pool;
    const features = this._features;
    const entity_id = routed.entity_id;
    const is_entity_channel = entity_id !== "_global";

    // Build pool summary (used in all contexts)
    const pool_summary = pool ? this.format_pool_summary(pool) : null;

    // No entity context — global channel (e.g., #command-center)
    if (!is_entity_channel) {
      await this.reply(message, "No active session in this channel." +
        (pool_summary ? `\n\n${pool_summary}` : ""));
      return;
    }

    // Entity-level channels without session-specific info (e.g., #alerts, #work-log)
    // Show entity summary without session details.
    const assignment = pool?.get_assignment(message.channelId);
    if (!assignment && routed.channel_type !== "general" && routed.channel_type !== "work_room") {
      const lines = this.format_entity_summary(entity_id, features);
      if (pool_summary) lines.push("", pool_summary);
      await this.reply(message, lines.join("\n"));
      return;
    }

    // Entity channel with no bot assigned
    if (!assignment) {
      const lines = ["No active session in this channel."];
      const entity_lines = this.format_entity_summary(entity_id, features);
      lines.push("", ...entity_lines);
      if (pool_summary) lines.push("", pool_summary);
      await this.reply(message, lines.join("\n"));
      return;
    }

    // Full session status — bot is assigned to this channel
    const lines = this.format_session_status(assignment, routed, features);
    if (pool_summary) lines.push("", pool_summary);
    await this.reply(message, lines.join("\n"));
  }

  /** Format the full session status block for a channel with an assigned bot. */
  private format_session_status(
    bot: PoolBot,
    routed: RoutedMessage,
    features: FeatureManager | null,
  ): string[] {
    const identity = bot.archetype
      ? this.resolve_agent_identity(bot.archetype)
      : null;
    const agent_label = identity
      ? `${identity.name} (${bot.archetype})`
      : "unknown";

    const lines = [
      "**Session Status**",
      `Agent: ${agent_label}`,
      `Entity: ${bot.entity_id ?? routed.entity_id}`,
      `Channel: <#${routed.channel_id}>`,
    ];

    if (bot.session_id) {
      lines.push(`Session: \`${bot.session_id.slice(0, 8)}\``);
    }

    // Uptime from assigned_at, falling back to last_active
    const start_time = bot.assigned_at ?? bot.last_active;
    if (start_time) {
      lines.push(`Uptime: ${format_duration(start_time)}`);
    }

    lines.push(`Bot: pool-${String(bot.id)} (lf-${String(bot.id)})`);

    // Active features for this entity
    if (features && bot.entity_id) {
      const entity_features = features.get_features_by_entity(bot.entity_id)
        .filter(f => f.phase !== "done");
      if (entity_features.length > 0) {
        lines.push("");
        lines.push("**Active features:**");
        for (const f of entity_features) {
          let entry = `- #${String(f.githubIssue)} ${f.title} -- ${f.phase} phase`;
          if (f.discordWorkRoom) {
            entry += ` (<#${f.discordWorkRoom}>)`;
          }
          if (f.blocked) entry += " **(BLOCKED)**";
          lines.push(entry);
        }
      }
    }

    return lines;
  }

  /** Format an entity-level summary (features, no session info). */
  private format_entity_summary(
    entity_id: string,
    features: FeatureManager | null,
  ): string[] {
    const lines = [`**${entity_id}**`];

    if (features) {
      const entity_features = features.get_features_by_entity(entity_id)
        .filter(f => f.phase !== "done");
      if (entity_features.length > 0) {
        lines.push("Active features:");
        for (const f of entity_features) {
          let entry = `- #${String(f.githubIssue)} ${f.title} -- ${f.phase} phase`;
          if (f.blocked) entry += " **(BLOCKED)**";
          lines.push(entry);
        }
      } else {
        lines.push("No active features.");
      }
    }

    return lines;
  }

  /** Format pool capacity summary. */
  private format_pool_summary(pool: BotPool): string {
    const status = pool.get_status();
    return `Pool: ${String(status.assigned)}/${String(status.total)} assigned, ${String(status.free)} free`;
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

    // Resolve the GitHub repo for issue creation
    const entity_config = this.registry.get(entity_id);
    if (!entity_config) {
      await this.reply(message, `Entity "${entity_id}" not found.`);
      return;
    }

    const repo = entity_config.entity.repos[0];
    if (!repo) {
      await this.reply(message, `Entity "${entity_id}" has no repos configured. Cannot create GitHub issue.`);
      return;
    }

    const nwo = nwo_from_url(repo.url);
    if (!nwo) {
      await this.reply(message, `Could not parse GitHub owner/repo from URL: ${repo.url}`);
      return;
    }

    // Create a real GitHub issue
    let issue_number: number;
    try {
      const repo_path = expand_home(repo.path);
      const { stdout } = await exec("gh", [
        "issue", "create",
        "--repo", nwo,
        "--title", title,
        "--body", "",
      ], { cwd: repo_path, timeout: 30_000 });

      // gh issue create outputs the issue URL, e.g. https://github.com/owner/repo/issues/42
      const url_match = stdout.trim().match(/\/issues\/(\d+)$/);
      if (!url_match) {
        await this.reply(message, `GitHub issue created but could not parse issue number from: ${stdout.trim()}`);
        return;
      }
      issue_number = Number(url_match[1]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.reply(message, `Failed to create GitHub issue: ${msg}`);
      return;
    }

    try {
      const feature = await features.create_feature({
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
      const { category_id, channels } = await this.scaffold_entity(entity_id, entity_name);

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
          blueprint: "software",
          repos: [{
            name: entity_id,
            url: repo_url || `git@github.com:org/${entity_id}.git`,
            path: `~/.lobsterfarm/entities/${entity_id}/repos/${entity_id}`,
            structure: "monorepo",
          }],
          accounts: {},
          channels: {
            category_id,
            list: channels,
          },
          memory: {
            path: entity_dir(paths, entity_id),
            auto_extract: true,
          },
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

  /** Bridge a message to a freshly spawned pool bot via tmux send-keys. */
  private async bridge_first_message(
    tmux_session: string,
    content: string,
    author_name: string,
  ): Promise<void> {
    const { execFileSync } = await import("node:child_process");
    const { writeFile: writeFileAsync, unlink } = await import("node:fs/promises");
    const pending_path = `/tmp/lf-pending-${tmux_session}.txt`;

    try {
      // Write the message to a file (avoids tmux escaping issues)
      await writeFileAsync(pending_path, `${author_name}: ${content}`, "utf-8");

      // Wait for the bot to be ready (polling for the ❯ prompt + Listening)
      const start = Date.now();
      const timeout = 20000;
      let ready = false;
      while (Date.now() - start < timeout) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        try {
          const output = execFileSync(
            "tmux", ["capture-pane", "-t", tmux_session, "-p"],
            { encoding: "utf-8", timeout: 2000 },
          );
          if (output.includes("Listening for channel messages") && output.includes("❯")) {
            ready = true;
            break;
          }
        } catch { /* ignore */ }
      }

      if (!ready) {
        console.log(`[discord] Bot ${tmux_session} not ready after ${String(timeout)}ms — message not bridged`);
        return;
      }

      // Small extra delay for the plugin to fully connect
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Send the prompt to the bot's tmux session
      const prompt = `A user just messaged you in Discord. Read ${pending_path} for their message and respond to them.`;
      execFileSync("tmux", ["send-keys", "-t", tmux_session, prompt, "Enter"], {
        stdio: "ignore",
        timeout: 5000,
      });

      console.log(`[discord] Bridged first message to ${tmux_session}`);

      // Clean up after a delay
      setTimeout(() => { void unlink(pending_path).catch(() => {}); }, 30000);
    } catch (err) {
      console.error(`[discord] Bridge failed: ${String(err)}`);
    }
  }

  private async handle_swap_command(args: string[], message: Message): Promise<void> {
    if (!this._pool) {
      await this.reply(message, "Bot pool not available.");
      return;
    }

    // Usage: !lf swap <archetype>
    const archetype_name = args[0]?.toLowerCase();
    const archetype_map: Record<string, ArchetypeRole> = {
      gary: "planner", planner: "planner",
      bob: "builder", builder: "builder",
      pearl: "designer", designer: "designer",
      ray: "operator", operator: "operator",
    };

    const archetype = archetype_map[archetype_name ?? ""];
    if (!archetype) {
      await this.reply(
        message,
        "Usage: `!lf swap <agent>` — gary, bob, pearl, or ray",
      );
      return;
    }

    const channel_id = message.channelId;
    const entry = this.channel_map.get(channel_id);
    if (!entry) {
      await this.reply(message, "This channel isn't mapped to an entity.");
      return;
    }

    // Release current bot, assign new one
    await this._pool.release(channel_id);
    const result = await this._pool.assign(channel_id, entry.entity_id, archetype);

    if (result) {
      const agent_display = this.config.agents[archetype === "reviewer" ? "planner" : archetype]?.name ?? archetype;
      await this.reply(message, `Swapping to ${agent_display}...`);
    } else {
      await this.reply(message, "No pool bots available for swap.");
    }
  }

  private async handle_compact_command(message: Message): Promise<void> {
    if (!this._pool) {
      await this.reply(message, "Bot pool not available.");
      return;
    }

    const assignment = this._pool.get_assignment(message.channelId);
    if (!assignment) {
      await this.reply(message, "No active session in this channel.");
      return;
    }

    try {
      execFileSync("tmux", ["send-keys", "-t", assignment.tmux_session, "/compact", "Enter"], {
        stdio: "ignore",
        timeout: 5000,
      });
      await message.react("\u2705");
    } catch {
      await this.reply(message, "Failed to send compact — session may be unresponsive.");
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
 * 1. DISCORD_BOT_TOKEN env var (preferred — set via env.sh or op run)
 * 2. ~/.lobsterfarm/.env file (written by setup wizard)
 *
 * If a 1Password reference is configured but the token isn't in the
 * environment, logs guidance on using `op run` to inject it safely.
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

  // 3. 1Password: `op read` is not used here because it exposes the token
  // to stdout (which gets logged in session JSONL files). Instead, the token
  // must be injected via env.sh (sourced before daemon startup) using:
  //   op run --env-file ~/.lobsterfarm/.env.op -- <daemon start command>
  // This keeps the secret in the process environment without stdout exposure.
  const op_ref = config.discord?.bot_token_ref;
  if (op_ref) {
    console.log(
      `[discord] 1Password reference configured (${op_ref}) but DISCORD_BOT_TOKEN is not set. ` +
      `Ensure env.sh or the daemon launcher uses 'op run --env-file .env.op' to inject the token.`,
    );
  }

  return null;
}
