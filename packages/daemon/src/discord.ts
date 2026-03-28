import { EventEmitter } from "node:events";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import {
  Client,
  ChannelType as DiscordChannelType,
  GatewayIntentBits,
  SlashCommandBuilder,
  type TextChannel,
  type Message,
  type Webhook,
  type Guild,
  type CategoryChannel,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
} from "discord.js";
import type {
  LobsterFarmConfig,
  ChannelType,
  ChannelMapping,
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
import { access, mkdir, writeFile, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { lobsterfarm_dir } from "@lobster-farm/shared";
import type { EntityRegistry } from "./registry.js";
import type { FeatureManager, CreateFeatureOptions } from "./features.js";
import { route_message, type RouteAction, type RoutedMessage } from "./router.js";
import type { TaskQueue } from "./queue.js";
import type { BotPool, PoolBot } from "./pool.js";
import { fetch_subscription_usage } from "./usage-api.js";
import { read_session_context } from "./session-context.js";
import * as sentry from "./sentry.js";

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

// ── Command target abstraction ──
// Unified interface that command handlers use to reply to the user.
// Both text messages and slash commands produce a CommandTarget.

export interface CommandTarget {
  /** Reply to the user. Handles ephemeral for slash commands. */
  reply: (content: string) => Promise<void>;
  /** The channel ID where the command was issued. */
  channel_id: string;
  /** React to the original message/interaction (no-op for slash commands). */
  react: (emoji: string) => Promise<void>;
  /** Display name of the command author. */
  author_name: string;
}

// ── Slash command definitions ──

export function build_slash_commands(): SlashCommandBuilder[] {
  return [
    new SlashCommandBuilder()
      .setName("help")
      .setDescription("Show available LobsterFarm commands"),

    new SlashCommandBuilder()
      .setName("status")
      .setDescription("Show session and entity status")
      .addStringOption(opt =>
        opt.setName("scope").setDescription("Scope").addChoices(
          { name: "entity", value: "entity" },
          { name: "all", value: "all" },
        ),
      ) as SlashCommandBuilder,

    new SlashCommandBuilder()
      .setName("features")
      .setDescription("List active features"),

    new SlashCommandBuilder()
      .setName("plan")
      .setDescription("Create a new feature in the plan phase")
      .addStringOption(opt =>
        opt.setName("title").setDescription("Feature title").setRequired(true),
      ) as SlashCommandBuilder,

    // NOTE: Spec defines `feature` as optional for /approve and /advance, but we
    // mark it required because there's no "infer from active channel" mechanism yet.
    // Requiring the ID is safer than silently failing. Tracked as a deliberate
    // deviation — revisit when per-channel feature inference is implemented.
    new SlashCommandBuilder()
      .setName("approve")
      .setDescription("Approve the current phase gate for a feature")
      .addStringOption(opt =>
        opt.setName("feature").setDescription("Feature ID").setRequired(true),
      ) as SlashCommandBuilder,

    new SlashCommandBuilder()
      .setName("advance")
      .setDescription("Advance a feature to the next phase")
      .addStringOption(opt =>
        opt.setName("feature").setDescription("Feature ID").setRequired(true),
      ) as SlashCommandBuilder,

    new SlashCommandBuilder()
      .setName("swap")
      .setDescription("Swap the active agent in this channel")
      .addStringOption(opt =>
        opt.setName("agent").setDescription("Agent to swap to").setRequired(true).addChoices(
          { name: "Gary (planner)", value: "planner" },
          { name: "Bob (builder)", value: "builder" },
          { name: "Pearl (designer)", value: "designer" },
          { name: "Ray (operator)", value: "operator" },
        ),
      ) as SlashCommandBuilder,

    new SlashCommandBuilder()
      .setName("scaffold")
      .setDescription("Scaffold Discord channels")
      .addStringOption(opt =>
        opt.setName("name").setDescription("Entity ID or 'server'").setRequired(true),
      )
      .addStringOption(opt =>
        opt.setName("blueprint").setDescription("Blueprint name (default: software)"),
      ) as SlashCommandBuilder,

    new SlashCommandBuilder()
      .setName("room")
      .setDescription("Create an on-demand work room with a pool bot")
      .addStringOption(opt =>
        opt.setName("name").setDescription("Room name").setRequired(true),
      ) as SlashCommandBuilder,

    new SlashCommandBuilder()
      .setName("close")
      .setDescription("Archive and close the current work room")
      .addBooleanOption(opt =>
        opt.setName("force").setDescription("Force close even if a feature is active"),
      ) as SlashCommandBuilder,

    new SlashCommandBuilder()
      .setName("resume")
      .setDescription("Restore an archived work room session")
      .addStringOption(opt =>
        opt.setName("name").setDescription("Archived room name").setRequired(true).setAutocomplete(true),
      ) as SlashCommandBuilder,

    new SlashCommandBuilder()
      .setName("compact")
      .setDescription("Trigger context compaction on the active session"),

    new SlashCommandBuilder()
      .setName("reset")
      .setDescription("Reset the current session and start fresh"),
  ] as SlashCommandBuilder[];
}

// Commands whose responses should be ephemeral (only visible to the invoker).
export const EPHEMERAL_COMMAND_NAMES = ["help", "status", "features"] as const;
const EPHEMERAL_COMMANDS = new Set<string>(EPHEMERAL_COMMAND_NAMES);

// Commands that perform external I/O and may exceed Discord's 3-second
// interaction response window. These get deferReply() before processing.
const DEFERRED_COMMANDS = new Set(["plan", "scaffold", "room", "resume", "close"]);

/** Minimal interface for the subset of ChatInputCommandInteraction used by extract_slash_args. */
export interface SlashInteractionLike {
  commandName: string;
  options: {
    getString(name: string): string | null;
    getBoolean(name: string): boolean | null;
  };
}

/**
 * Extract slash command options into the positional args array that
 * the shared handle_command dispatch expects. Each slash command
 * maps its named options to the legacy positional format.
 */
export function extract_slash_args(interaction: SlashInteractionLike): string[] {
  const name = interaction.commandName;

  switch (name) {
    case "status": {
      const scope = interaction.options.getString("scope");
      return scope ? [scope] : [];
    }
    case "plan": {
      const title = interaction.options.getString("title") ?? "";
      return [title];
    }
    case "approve":
    case "advance": {
      const feature = interaction.options.getString("feature");
      return feature ? [feature] : [];
    }
    case "swap": {
      const agent = interaction.options.getString("agent") ?? "";
      return [agent];
    }
    case "scaffold": {
      // /scaffold name:"my-entity" maps to args: ["entity", "my-entity"]
      const scaffold_name = interaction.options.getString("name") ?? "";
      if (scaffold_name === "server") return ["server"];
      const blueprint = interaction.options.getString("blueprint");
      const result = ["entity", scaffold_name];
      if (blueprint) result.push("--blueprint", blueprint);
      return result;
    }
    case "room": {
      const room_name = interaction.options.getString("name") ?? "";
      return [room_name];
    }
    case "close": {
      const force = interaction.options.getBoolean("force");
      return force ? ["--force"] : [];
    }
    case "resume": {
      const resume_name = interaction.options.getString("name") ?? "";
      return [resume_name];
    }
    default:
      return [];
  }
}

/** Create a CommandTarget from a Discord text message. */
function target_from_message(message: Message, send_fallback: (channel_id: string, content: string) => Promise<void>): CommandTarget {
  return {
    channel_id: message.channelId,
    author_name: message.author.displayName,
    async reply(content: string) {
      try {
        await message.reply(content);
      } catch {
        await send_fallback(message.channelId, content);
      }
    },
    async react(emoji: string) {
      try { await message.react(emoji); } catch { /* ignore */ }
    },
  };
}

/** Create a CommandTarget from a slash command interaction. */
function target_from_interaction(interaction: ChatInputCommandInteraction, ephemeral: boolean, deferred = false): CommandTarget {
  let replied = false;
  return {
    channel_id: interaction.channelId,
    author_name: interaction.user.displayName,
    async reply(content: string) {
      try {
        if (deferred && !replied) {
          // editReply inherits the ephemeral flag from the earlier deferReply()
          // call — no need to pass ephemeral here.
          await interaction.editReply({ content });
        } else if (!replied) {
          await interaction.reply({ content, ephemeral });
        } else {
          await interaction.followUp({ content, ephemeral });
        }
        replied = true;
      } catch (err) {
        console.error(`[discord:slash] Reply failed: ${String(err)}`);
      }
    },
    async react(_emoji: string) {
      // Slash commands don't support reactions — no-op
    },
  };
}

// ── Discord Bot ──

// ── Avatar cache paths ──

const AVATAR_EXTENSIONS = [".jpg", ".png", ".webp"];

function avatars_dir(): string {
  return join(lobsterfarm_dir(), "avatars");
}

/**
 * Set a pool bot's Discord profile avatar using a raw REST call.
 * Reads the bot's token from its .env file, reads the avatar image from disk,
 * and PATCHes /users/@me. The token is only held in memory for the duration
 * of the fetch call — never stored, logged, or passed to other modules.
 *
 * @param state_dir - The pool bot's channel directory (contains .env with token)
 * @param agent_name - Lowercase agent name (e.g., "gary") used to find the avatar file
 */
export async function set_bot_profile_avatar(
  state_dir: string,
  agent_name: string,
): Promise<void> {
  // Read bot token from .env file
  const env_content = await readFile(join(state_dir, ".env"), "utf-8");
  const token_match = env_content.match(/DISCORD_BOT_TOKEN=(.+)/);
  const token = token_match?.[1]?.trim();
  if (!token) {
    throw new Error(`No DISCORD_BOT_TOKEN in ${state_dir}/.env`);
  }

  // Find avatar file on disk
  const base_dir = avatars_dir();
  let avatar_path: string | null = null;
  for (const ext of AVATAR_EXTENSIONS) {
    const candidate = join(base_dir, `${agent_name}${ext}`);
    try {
      await access(candidate);
      avatar_path = candidate;
      break;
    } catch {
      continue;
    }
  }

  if (!avatar_path) {
    throw new Error(`No avatar file found for "${agent_name}" in ${base_dir}`);
  }

  // Read file and encode as data URI for Discord API
  const avatar_buffer = await readFile(avatar_path);
  const ext = avatar_path.split(".").pop()!;
  const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  const data_uri = `data:${mime};base64,${avatar_buffer.toString("base64")}`;

  // PATCH /users/@me with the bot's own token.
  // 10s timeout prevents a hung connection from bricking the assignment path.
  const controller = new AbortController();
  const timeout_id = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch("https://discord.com/api/v10/users/@me", {
      method: "PATCH",
      headers: {
        "Authorization": `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ avatar: data_uri }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Discord API ${String(response.status)}: ${body}`);
    }
  } finally {
    clearTimeout(timeout_id);
  }
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

        // Register guild-specific slash commands (instant, no propagation delay)
        void this.register_slash_commands();

        this.emit("connected");
        resolve();
      });
    });

    this.client.on("messageCreate", (message: Message) => {
      void this.handle_message(message);
    });

    this.client.on("interactionCreate", (interaction) => {
      if (interaction.isAutocomplete()) {
        void this.handle_autocomplete(interaction as AutocompleteInteraction);
        return;
      }
      if (interaction.isChatInputCommand()) {
        void this.handle_slash_command(interaction as ChatInputCommandInteraction);
      }
    });

    await this.client.login(token);
    await ready;

    sentry.addBreadcrumb({
      category: "daemon.lifecycle",
      message: "Discord connected",
      data: { tag: this.client.user?.tag },
    });
  }

  /** Register slash commands on the guild for instant availability. */
  private async register_slash_commands(): Promise<void> {
    const guild = await this.get_guild();
    if (!guild) {
      console.log("[discord] No guild available — slash commands not registered");
      return;
    }

    try {
      const commands = build_slash_commands();
      await guild.commands.set(commands);
      console.log(`[discord] Registered ${String(commands.length)} slash commands on guild`);
    } catch (err) {
      console.error(`[discord] Failed to register slash commands: ${String(err)}`);
      sentry.captureException(err, {
        tags: { component: "discord", operation: "register_slash_commands" },
        extra: { hint: "Most likely missing applications.commands OAuth2 scope" },
      });
    }
  }

  /** Disconnect from Discord. */
  async disconnect(): Promise<void> {
    if (this.connected) {
      console.log("[discord] Disconnecting...");
      sentry.addBreadcrumb({
        category: "daemon.lifecycle",
        message: "Discord disconnecting",
      });
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
      sentry.captureException(err, {
        tags: { module: "discord", action: "send" },
      });
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
      sentry.captureException(err, {
        tags: { module: "discord", action: "set_topic" },
      });
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
      sentry.captureException(err, {
        tags: { module: "discord", action: "create_channel" },
      });
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
      sentry.captureException(err, {
        tags: { module: "discord", action: "delete_channel" },
      });
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
      sentry.captureException(err, {
        tags: { module: "discord", action: "fetch_guild" },
      });
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
      sentry.captureException(err, {
        tags: { module: "discord", action: "scaffold_server" },
      });
    }

    return result;
  }

  /**
   * Scaffold Discord channels for a new entity.
   * Creates a category and standard channels (general, alerts).
   * Work rooms are created on demand via /room (or !lf room).
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

      // Standard entity channels — work rooms are created on demand via !lf room
      const entity_channels = [
        { name: "general", type: "general", purpose: "Entity-level discussion" },
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
      sentry.captureException(err, {
        tags: { module: "discord", action: "scaffold_entity", entity: entity_id },
      });
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

    // Register avatar handler so pool can set bot profile pictures.
    // Uses a raw REST call with the bot's own token — the daemon bot
    // cannot change another bot's profile avatar via the gateway.
    pool.set_avatar_handler(async (state_dir: string, agent_name: string) => {
      await set_bot_profile_avatar(state_dir, agent_name);
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
          const target = target_from_message(message, (ch, c) => this.send(ch, c));
          try {
            await this.handle_command(cmd.name, cmd.args, routed, target);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await target.reply(`Error: ${msg}`);
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
        const target = target_from_message(message, (ch, c) => this.send(ch, c));
        try {
          await this.handle_command(cmd.name, cmd.args, routed, target);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await target.reply(`Error: ${msg}`);
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
        const target = target_from_message(message, (ch, c) => this.send(ch, c));
        await target.reply("Session reset. Send a message to start fresh.\n-# Tip: use `/reset` instead of `!reset`");
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
          try {
            await message.reply("All bots are busy right now. Your message will be picked up when a slot opens.");
          } catch {
            await this.send(message.channelId, "All bots are busy right now. Your message will be picked up when a slot opens.");
          }
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
    target: CommandTarget,
  ): Promise<void> {
    switch (action.type) {
      case "command":
        await this.handle_command(action.name, action.args, routed, target);
        break;

      case "classify":
        await target.reply(
          `Classified as **${action.archetype}** task. ` +
            `Use \`/plan ${action.prompt}\` to create a feature, ` +
            `or I can handle it directly (coming soon).`,
        );
        break;

      case "route_to_session":
        await target.reply(
          `Routing to feature **${action.feature_id}** session (interactive routing coming soon).`,
        );
        break;

      case "approval_response":
        await target.reply(
          `Received approval response. Use \`/approve <feature-id>\` to approve a specific feature.`,
        );
        break;

      case "ask_clarification":
        await target.reply(action.message);
        break;

      case "ignore":
        break;
    }
  }

  private async handle_command(
    name: string,
    args: string[],
    routed: RoutedMessage,
    target: CommandTarget,
  ): Promise<void> {
    switch (name) {
      case "help":
        await target.reply(
          "**LobsterFarm Commands:**\n" +
            "• `/plan <title>` — create a feature in plan phase\n" +
            "• `/approve [feature-id]` — approve current phase gate\n" +
            "• `/advance [feature-id]` — advance to next phase\n" +
            "• `/swap <agent>` — swap active agent in this channel\n" +
            "• `/compact` — trigger context compaction on the active session\n" +
            "• `/room <name>` — create an on-demand work room with a pool bot\n" +
            "• `/close` — archive and delete the current work room\n" +
            "• `/resume <name>` — restore an archived work room session\n" +
            "• `/status` — session/entity status for this channel\n" +
            "• `/features` — list features\n" +
            "• `/scaffold <name>` — create Discord channels\n" +
            "• `/reset` — reset the current session\n" +
            "• `/help` — this message",
        );
        break;

      case "status":
        await this.handle_status_command(routed, target);
        break;

      case "plan":
        await this.handle_plan_command(args, routed, target);
        break;

      case "approve":
        await this.handle_approve_command(args, target);
        break;

      case "advance":
        await this.handle_advance_command(args, target);
        break;

      case "features":
        await this.handle_features_command(args, target);
        break;

      case "scaffold":
        await this.handle_scaffold_command(args, routed, target);
        break;

      case "swap":
        await this.handle_swap_command(args, target);
        break;

      case "compact":
        await this.handle_compact_command(target);
        break;

      case "room":
        await this.handle_room_command(args, routed, target);
        break;

      case "close":
        await this.handle_close_command(args, routed, target);
        break;

      case "resume":
        await this.handle_resume_command(args, routed, target);
        break;

      case "reset":
        await this.handle_reset_command(routed, target);
        break;

      default:
        await target.reply(`Unknown command: \`${name}\`. Try \`/help\`.`);
    }
  }

  private async handle_status_command(routed: RoutedMessage, target: CommandTarget): Promise<void> {
    const pool = this._pool;
    const features = this._features;
    const entity_id = routed.entity_id;
    const is_entity_channel = entity_id !== "_global";

    // Build pool summary (used in all contexts)
    const pool_summary = pool ? this.format_pool_summary(pool) : null;

    // No entity context — global channel (e.g., #command-center)
    if (!is_entity_channel) {
      await target.reply("No active session in this channel." +
        (pool_summary ? `\n\n${pool_summary}` : ""));
      return;
    }

    // Entity-level channels without session-specific info (e.g., #alerts, #work-log)
    // Show entity summary without session details.
    const assignment = pool?.get_assignment(target.channel_id);
    if (!assignment && routed.channel_type !== "general" && routed.channel_type !== "work_room") {
      const lines = this.format_entity_summary(entity_id, features);
      if (pool_summary) lines.push("", pool_summary);
      await target.reply(lines.join("\n"));
      return;
    }

    // Entity channel with no bot assigned
    if (!assignment) {
      const lines = ["No active session in this channel."];
      const entity_lines = this.format_entity_summary(entity_id, features);
      lines.push("", ...entity_lines);
      if (pool_summary) lines.push("", pool_summary);
      await target.reply(lines.join("\n"));
      return;
    }

    // Full session status — bot is assigned to this channel.
    // Fetch context and subscription usage on demand from direct data sources:
    // - Context: parsed from the session's JSONL transcript file
    // - Subscription: fetched from Anthropic's OAuth API
    // Both are best-effort — failures are silently swallowed, we show what we can.
    const lines = await this.format_session_status(assignment, routed, features);
    if (pool_summary) lines.push("", pool_summary);
    await target.reply(lines.join("\n"));
  }

  /** Format the full session status block for a channel with an assigned bot.
   * Fetches context and subscription usage on demand from live data sources. */
  private async format_session_status(
    bot: PoolBot,
    routed: RoutedMessage,
    features: FeatureManager | null,
  ): Promise<string[]> {
    const identity = bot.archetype
      ? this.resolve_agent_identity(bot.archetype)
      : null;
    const agent_label = identity
      ? `${identity.name} (${bot.archetype})`
      : "unknown";

    const lines = [
      "**Session Status**",
      `Agent: ${agent_label}`,
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

    if (bot.model) {
      lines.push(`Model: ${bot.model}`);
    }
    if (bot.effort) {
      lines.push(`Effort: ${bot.effort}`);
    }

    // Fetch context and subscription usage on demand.
    // Both calls are best-effort: try/catch prevents either from blocking the response.
    const [context_usage, subscription_usage] = await Promise.all([
      bot.session_id ? read_session_context(bot.session_id) : Promise.resolve(null),
      fetch_subscription_usage(),
    ]);

    if (context_usage) {
      lines.push(`Context: ${context_usage.summary}`);
    }
    if (subscription_usage) {
      lines.push(`Usage: ${subscription_usage.summary}`);
    }

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
    target: CommandTarget,
  ): Promise<void> {
    const features = this._features;
    if (!features) {
      await target.reply("Feature manager not available.");
      return;
    }

    // Parse: !lf plan <entity_id> <title> OR /plan title:"..."
    // If entity_id is omitted, use the channel's entity
    let entity_id: string;
    let title: string;

    if (args.length === 0) {
      await target.reply("Usage: `/plan <title>` (in an entity channel)");
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
      await target.reply("Please provide a title for the feature.");
      return;
    }

    // Resolve the GitHub repo for issue creation
    const entity_config = this.registry.get(entity_id);
    if (!entity_config) {
      await target.reply(`Entity "${entity_id}" not found.`);
      return;
    }

    const repo = entity_config.entity.repos[0];
    if (!repo) {
      await target.reply(`Entity "${entity_id}" has no repos configured. Cannot create GitHub issue.`);
      return;
    }

    const nwo = nwo_from_url(repo.url);
    if (!nwo) {
      await target.reply(`Could not parse GitHub owner/repo from URL: ${repo.url}`);
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
        await target.reply(`GitHub issue created but could not parse issue number from: ${stdout.trim()}`);
        return;
      }
      issue_number = Number(url_match[1]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await target.reply(`Failed to create GitHub issue: ${msg}`);
      return;
    }

    try {
      const feature = await features.create_feature({
        entity_id,
        title,
        github_issue: issue_number,
      });

      await target.reply(
        `Feature **${feature.id}** created: "${title}"\n` +
          `Phase: plan | Issue: #${String(issue_number)}\n` +
          `Approve with \`/approve ${feature.id}\`, then advance with \`/advance ${feature.id}\``,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await target.reply(`Failed to create feature: ${msg}`);
    }
  }

  private async handle_approve_command(args: string[], target: CommandTarget): Promise<void> {
    const features = this._features;
    if (!features) {
      await target.reply("Feature manager not available.");
      return;
    }

    const feature_id = args[0];
    if (!feature_id) {
      await target.reply("Usage: `/approve <feature-id>`");
      return;
    }

    try {
      const feature = features.approve_phase(feature_id);
      await target.reply(
        `Approved phase **${feature.phase}** for ${feature_id}. ` +
          `Use \`/advance ${feature_id}\` to proceed.`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await target.reply(`Failed to approve: ${msg}`);
    }
  }

  private async handle_advance_command(args: string[], target: CommandTarget): Promise<void> {
    const features = this._features;
    if (!features) {
      await target.reply("Feature manager not available.");
      return;
    }

    const feature_id = args[0];
    if (!feature_id) {
      await target.reply("Usage: `/advance <feature-id>`");
      return;
    }

    try {
      const feature = await features.advance_feature(feature_id);
      await target.reply(
        `Feature **${feature_id}** advanced to **${feature.phase}** phase.`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await target.reply(`Failed to advance: ${msg}`);
    }
  }

  private async handle_features_command(args: string[], target: CommandTarget): Promise<void> {
    const features = this._features;
    if (!features) {
      await target.reply("Feature manager not available.");
      return;
    }

    const entity_filter = args[0];
    const all = entity_filter
      ? features.get_features_by_entity(entity_filter)
      : features.list_features();

    if (all.length === 0) {
      await target.reply("No features found.");
      return;
    }

    const lines = all.map((f) => {
      let status = `**${f.id}** — ${f.title} [${f.phase}]`;
      if (f.blocked) status += " (BLOCKED)";
      if (f.approved) status += " (approved)";
      if (f.sessionId) status += " (active session)";
      return status;
    });

    await target.reply(lines.join("\n"));
  }

  private async handle_scaffold_command(
    args: string[],
    _routed: RoutedMessage,
    target: CommandTarget,
  ): Promise<void> {
    const sub = args[0];

    if (sub === "entity") {
      // Usage: /scaffold name:<id> OR !lf scaffold entity <id> <name> [--repo <url>]
      const entity_id = args[1];
      if (!entity_id || !/^[a-z0-9-]+$/.test(entity_id)) {
        await target.reply("Usage: `/scaffold <id>` or `!lf scaffold entity <id> <name>`\nID must be lowercase alphanumeric with hyphens.");
        return;
      }

      // Check if entity already exists
      if (this.registry.get(entity_id)) {
        await target.reply(`Entity **${entity_id}** already exists.`);
        return;
      }

      // Parse remaining args for name, optional --repo, and optional --blueprint
      const remaining = args.slice(2);
      let repo_url = "";
      let blueprint = "software";
      const name_parts: string[] = [];
      for (let i = 0; i < remaining.length; i++) {
        if (remaining[i] === "--repo" && remaining[i + 1]) {
          repo_url = remaining[i + 1]!;
          i++;
        } else if (remaining[i] === "--blueprint" && remaining[i + 1]) {
          blueprint = remaining[i + 1]!;
          i++;
        } else {
          name_parts.push(remaining[i]!);
        }
      }
      const entity_name = name_parts.join(" ") || entity_id;

      await target.reply(`Setting up entity **${entity_id}** ("${entity_name}")...`);

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
          blueprint,
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
      await target.reply(
        `Entity **${entity_id}** fully scaffolded:\n` +
          `• Config: \`${config_path}\`\n` +
          `• Memory: \`${mem_path}\`\n` +
          `• Discord: ${String(channels.length)} channels\n` +
          channel_lines.join("\n") + "\n\n" +
          `Ready to use. Try \`/plan "Your first feature"\``,
      );
    } else if (sub === "server") {
      await target.reply("Scaffolding global Discord structure...");
      const result = await this.scaffold_server();
      const created = Object.entries(result).filter(([_, v]) => v).length;
      await target.reply(`Global scaffold complete. ${String(created)} channels configured.`);
    } else {
      await target.reply(
        "Usage:\n• `/scaffold server` — create GLOBAL channels\n• `/scaffold <id>` — create entity channels",
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
      sentry.captureException(err, {
        tags: { module: "discord", action: "bridge" },
      });
    }
  }

  private async handle_swap_command(args: string[], target: CommandTarget): Promise<void> {
    if (!this._pool) {
      await target.reply("Bot pool not available.");
      return;
    }

    // Usage: /swap agent:<archetype> OR !lf swap <archetype>
    const archetype_name = args[0]?.toLowerCase();
    const archetype_map: Record<string, ArchetypeRole> = {
      gary: "planner", planner: "planner",
      bob: "builder", builder: "builder",
      pearl: "designer", designer: "designer",
      ray: "operator", operator: "operator",
    };

    const archetype = archetype_map[archetype_name ?? ""];
    if (!archetype) {
      await target.reply(
        "Usage: `/swap <agent>` — planner, builder, designer, or operator",
      );
      return;
    }

    const channel_id = target.channel_id;
    const entry = this.channel_map.get(channel_id);
    if (!entry) {
      await target.reply("This channel isn't mapped to an entity.");
      return;
    }

    // Release current bot, assign new one
    await this._pool.release(channel_id);
    const result = await this._pool.assign(channel_id, entry.entity_id, archetype);

    if (result) {
      const agent_display = this.config.agents[archetype === "reviewer" ? "planner" : archetype]?.name ?? archetype;
      await target.reply(`Swapping to ${agent_display}...`);
    } else {
      await target.reply("No pool bots available for swap.");
    }
  }

  private async handle_compact_command(target: CommandTarget): Promise<void> {
    if (!this._pool) {
      await target.reply("Bot pool not available.");
      return;
    }

    const assignment = this._pool.get_assignment(target.channel_id);
    if (!assignment) {
      await target.reply("No active session in this channel.");
      return;
    }

    try {
      execFileSync("tmux", ["send-keys", "-t", assignment.tmux_session, "/compact", "Enter"], {
        stdio: "ignore",
        timeout: 5000,
      });
      await target.reply("✅ Compact triggered.");
    } catch {
      await target.reply("Failed to send compact — session may be unresponsive.");
    }
  }

  // ── Dynamic room commands ──

  /**
   * /room name:<name> OR !lf room <name> [initial context]
   * Creates an on-demand work room under the entity's category,
   * assigns a pool bot, and optionally bridges initial context.
   */
  private async handle_room_command(
    args: string[],
    routed: RoutedMessage,
    target: CommandTarget,
  ): Promise<void> {
    if (!this._pool) {
      await target.reply("Bot pool not available.");
      return;
    }

    const entity_config = this.registry.get(routed.entity_id);
    if (!entity_config) {
      await target.reply("This channel isn't mapped to an entity.");
      return;
    }

    const category_id = entity_config.entity.channels.category_id;
    if (!category_id) {
      await target.reply("Entity has no Discord category configured.");
      return;
    }

    // Parse name and optional context
    const raw_name = args[0];
    if (!raw_name) {
      // Generate a default name with timestamp
      args.unshift(`room-${String(Date.now())}`);
    }
    const name = sanitize_channel_name(args[0]!);
    const context = args.slice(1).join(" ");

    // Check for name collision with active channels
    if (this.find_channel_by_name(entity_config.entity.channels, name)) {
      await target.reply(`A room named **${name}** already exists.`);
      return;
    }

    // Create Discord channel
    const channel_id = await this.create_channel(
      category_id,
      name,
      `On-demand work room for ${routed.entity_id}`,
    );
    if (!channel_id) {
      await target.reply("Failed to create Discord channel.");
      return;
    }

    // Add to entity config
    entity_config.entity.channels.list.push({
      type: "work_room",
      id: channel_id,
      purpose: name,
      dynamic: true,
    });

    // Persist and rebuild
    await this.persist_entity_config(entity_config);
    this.build_channel_map();

    // Assign a pool bot (planner by default)
    const assignment = await this._pool.assign(
      channel_id,
      routed.entity_id,
      "planner",
      undefined,
      "work_room",
    );

    // Post confirmation in both source channel and new room
    await target.reply(`Room **#${name}** created. Session started.`);
    if (assignment) {
      await this.send(channel_id, "Room created. Session started.");

      // Bridge initial context if provided
      if (context) {
        await this.bridge_first_message(
          assignment.tmux_session,
          context,
          target.author_name,
        );
      }
    }
  }

  /**
   * /close OR !lf close [--force]
   * Archives the current work room's session and deletes the channel.
   * Only works in work_room channels.
   * If there's an active feature lifecycle in this room, warns the user
   * and requires --force to proceed.
   */
  private async handle_close_command(
    args: string[],
    routed: RoutedMessage,
    target: CommandTarget,
  ): Promise<void> {
    // Verify this is a work_room channel
    if (routed.channel_type !== "work_room") {
      await target.reply("Can't close this channel. `/close` only works in work rooms.");
      return;
    }

    const entity_config = this.registry.get(routed.entity_id);
    if (!entity_config) {
      await target.reply("Entity not found.");
      return;
    }

    const channel_id = target.channel_id;
    const channel_entry = entity_config.entity.channels.list.find(
      (c: ChannelMapping) => c.id === channel_id,
    );
    if (!channel_entry) {
      await target.reply("Channel not found in entity config.");
      return;
    }

    // Guard: warn if there's an active feature lifecycle in this room
    if (this._features) {
      const active_features = this._features.get_features_by_entity(routed.entity_id).filter(
        f => f.discordWorkRoom === channel_id && !["done", "cancelled"].includes(f.phase),
      );
      if (active_features.length > 0 && !args.includes("--force")) {
        const title = active_features[0]!.title ?? active_features[0]!.id;
        await target.reply(
          `This room has an active feature (**${title}**). Close anyway? Use \`/close\` with the \`force\` option, or \`!lf close --force\`.`,
        );
        return;
      }
    }

    // Determine the room name from the purpose field or the channel name
    const room_name = channel_entry.purpose ?? `room-${channel_id}`;

    // Archive the session
    const now = new Date().toISOString();
    const archive_entry: RoomArchive = {
      name: room_name,
      channel_id,
      session_id: null,
      entity_id: routed.entity_id,
      archetype: "planner",
      archived_at: now,
      closed_at: now,
    };

    // Get session info from pool bot if assigned
    if (this._pool) {
      const assignment = this._pool.get_assignment(channel_id);
      if (assignment) {
        archive_entry.session_id = assignment.session_id ?? null;
        archive_entry.archetype = assignment.archetype ?? "planner";
      }
    }

    // Write archive atomically
    await write_room_archive(routed.entity_id, archive_entry, this.config.paths);

    // Release the pool bot
    if (this._pool) {
      await this._pool.release(channel_id);
    }

    // Find the entity's general channel for the farewell message.
    // The work room channel is deleted below, so the farewell goes to #general instead.
    const general_channel = entity_config.entity.channels.list.find(
      (c: ChannelMapping) => c.type === "general",
    );

    // Delete Discord channel
    await this.delete_channel(channel_id);

    // Remove from entity config
    entity_config.entity.channels.list = entity_config.entity.channels.list.filter(
      (c: ChannelMapping) => c.id !== channel_id,
    );

    // Persist and rebuild
    await this.persist_entity_config(entity_config);
    this.build_channel_map();

    // Send farewell to general (skip if general has a placeholder ID)
    if (general_channel && is_discord_snowflake(general_channel.id)) {
      await this.send(
        general_channel.id,
        `Session archived as \`${room_name}\`. Use \`/resume ${room_name}\` to restore.`,
      );
    }

    // Acknowledge the interaction. For slash commands, the interaction token
    // remains valid even after the channel is deleted.
    await target.reply(`Session archived. Use \`/resume ${room_name}\` to restore.`);
  }

  /**
   * /resume name:<name> OR !lf resume <name>
   * Restores an archived work room session. Creates a new channel,
   * assigns a pool bot with the archived session_id for resume.
   */
  private async handle_resume_command(
    args: string[],
    routed: RoutedMessage,
    target: CommandTarget,
  ): Promise<void> {
    if (!this._pool) {
      await target.reply("Bot pool not available.");
      return;
    }

    const entity_config = this.registry.get(routed.entity_id);
    if (!entity_config) {
      await target.reply("Entity not found.");
      return;
    }

    const category_id = entity_config.entity.channels.category_id;
    if (!category_id) {
      await target.reply("Entity has no Discord category configured.");
      return;
    }

    const search_name = args[0];
    if (!search_name) {
      await target.reply("Usage: `/resume <name>`");
      return;
    }

    // Look up archives
    const archives = await load_room_archives(routed.entity_id, this.config.paths);
    const matches = archives.filter(a => a.name === search_name);

    if (matches.length === 0) {
      const available = [...new Set(archives.map(a => a.name))];
      if (available.length === 0) {
        await target.reply(`No archived sessions found for this entity.`);
      } else {
        await target.reply(
          `No archived session found with name **${search_name}**.\nAvailable: ${available.map(n => `\`${n}\``).join(", ")}`,
        );
      }
      return;
    }

    if (matches.length > 1) {
      // Multiple matches — list them with timestamps for disambiguation
      const lines = matches.map((a, i) =>
        `${String(i + 1)}. \`${a.name}\` — closed ${a.closed_at}`,
      );
      await target.reply(
        `Multiple archived sessions named **${search_name}**:\n${lines.join("\n")}\n\nMost recent will be used. To specify, re-close to create distinct names.`,
      );
      // Use the most recent match
    }

    // Use the most recent match (last in sorted order)
    const archive = matches[matches.length - 1]!;

    // Check for name collision with active channels
    if (this.find_channel_by_name(entity_config.entity.channels, search_name)) {
      await target.reply(`A room named **${search_name}** already exists.`);
      return;
    }

    // Create new Discord channel
    const channel_id = await this.create_channel(
      category_id,
      search_name,
      `Resumed work room for ${routed.entity_id}`,
    );
    if (!channel_id) {
      await target.reply("Failed to create Discord channel.");
      return;
    }

    // Add to entity config
    entity_config.entity.channels.list.push({
      type: "work_room",
      id: channel_id,
      purpose: search_name,
      dynamic: true,
    });

    // Persist and rebuild
    await this.persist_entity_config(entity_config);
    this.build_channel_map();

    // Assign pool bot with resumed session_id
    const resume_session_id = archive.session_id ?? undefined;
    const assignment = await this._pool.assign(
      channel_id,
      routed.entity_id,
      (archive.archetype || "planner") as ArchetypeRole,
      resume_session_id,
      "work_room",
    );

    // Consume the archive file now that the room is live again.
    // Failure to delete is non-fatal — log and move on.
    await delete_room_archive(routed.entity_id, archive, this.config.paths);

    if (assignment) {
      await this.send(channel_id, `Session \`${search_name}\` resumed.`);
      await target.reply(`Session **${search_name}** resumed in <#${channel_id}>.`);
    } else {
      await target.reply(`Room created but no pool bots available. Send a message in <#${channel_id}> to auto-assign.`);
    }
  }

  // ── Helpers ──

  /** Persist an entity's config back to YAML. */
  private async persist_entity_config(entity_config: { entity: { id: string } } & Record<string, unknown>): Promise<void> {
    const config_path = entity_config_path(this.config.paths, entity_config.entity.id);
    await write_yaml(config_path, entity_config);
    console.log(`[discord] Persisted entity config for ${entity_config.entity.id}`);
  }

  /** Find a channel in an entity's channel list by its purpose/name field. */
  private find_channel_by_name(
    channels: { list: ChannelMapping[] },
    name: string,
  ): ChannelMapping | undefined {
    return channels.list.find(
      (c: ChannelMapping) => c.type === "work_room" && c.purpose === name,
    );
  }

  // ── Slash command handling ──

  /** Handle an incoming slash command interaction. */
  private async handle_slash_command(interaction: ChatInputCommandInteraction): Promise<void> {
    const command_name = interaction.commandName;
    const ephemeral = EPHEMERAL_COMMANDS.has(command_name);
    const deferred = DEFERRED_COMMANDS.has(command_name);

    // Long-running commands must defer within 3 seconds to avoid
    // Discord's "This application did not respond" error.
    if (deferred) {
      try {
        await interaction.deferReply({ ephemeral });
      } catch (err) {
        console.error(`[discord:slash] deferReply failed for /${command_name}: ${String(err)}`);
        return; // Can't respond — Discord already timed out or errored
      }
    }

    const target = target_from_interaction(interaction, ephemeral, deferred);

    // Build entity context from channel map
    const entry = this.channel_map.get(interaction.channelId);
    const routed: RoutedMessage = {
      entity_id: entry?.entity_id ?? "_global",
      channel_type: entry?.channel_type ?? "general",
      content: "",
      author: interaction.user.tag,
      channel_id: interaction.channelId,
      assigned_feature: entry?.assigned_feature,
    };

    // Extract args from interaction options, mapping to the same
    // positional format that the text command handlers expect
    const args = extract_slash_args(interaction);

    try {
      await this.handle_command(command_name, args, routed, target);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await target.reply(`Error: ${msg}`);
    }
  }

  /** Handle autocomplete interactions (e.g., /resume name suggestions). */
  private async handle_autocomplete(interaction: AutocompleteInteraction): Promise<void> {
    if (interaction.commandName !== "resume") return;

    const focused = interaction.options.getFocused();
    const entry = this.channel_map.get(interaction.channelId);
    if (!entry) {
      await interaction.respond([]);
      return;
    }

    try {
      const archives = await load_room_archives(entry.entity_id, this.config.paths);
      // Deduplicate by name, keep most recent
      const name_map = new Map<string, RoomArchive>();
      for (const a of archives) {
        name_map.set(a.name, a);
      }

      const choices = [...name_map.values()]
        .filter(a => a.name.toLowerCase().includes(focused.toLowerCase()))
        .slice(0, 25) // Discord limit
        .map(a => ({ name: a.name, value: a.name }));

      await interaction.respond(choices);
    } catch {
      await interaction.respond([]);
    }
  }

  /** Handle /reset — release current bot, next message triggers fresh assignment. */
  private async handle_reset_command(_routed: RoutedMessage, target: CommandTarget): Promise<void> {
    if (!this._pool) {
      await target.reply("Bot pool not available.");
      return;
    }

    const entry = this.channel_map.get(target.channel_id);
    if (!entry) {
      await target.reply("This channel isn't mapped to an entity.");
      return;
    }

    this._pool.clear_session_history(entry.entity_id, target.channel_id);
    await this._pool.release(target.channel_id);
    await target.reply("Session reset. Send a message to start fresh.");
  }
}

// ── Channel name sanitization ──

/** Sanitize a string for use as a Discord channel name.
 * Lowercase, hyphens only, no spaces, max 100 chars. */
export function sanitize_channel_name(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")  // Replace non-alphanumeric with hyphens
    .replace(/-+/g, "-")           // Collapse multiple hyphens
    .replace(/^-|-$/g, "")         // Trim leading/trailing hyphens
    .slice(0, 100);                // Discord channel name limit
}

// ── Room archive types and I/O ──

export interface RoomArchive {
  name: string;
  channel_id: string;
  session_id: string | null;
  entity_id: string;
  archetype: string;
  /** When the room was archived (same as closed_at for backward compat with older archives). */
  archived_at: string;
  closed_at: string;
}

/** Write a room archive entry atomically. */
export async function write_room_archive(
  entity_id: string,
  archive: RoomArchive,
  paths?: Record<string, string>,
): Promise<void> {
  const archives_dir = join(entity_dir(paths, entity_id), "archives");
  await mkdir(archives_dir, { recursive: true });

  const timestamp = archive.closed_at.replace(/[:.]/g, "-");
  const filename = `${archive.name}-${timestamp}.json`;
  const filepath = join(archives_dir, filename);
  const tmp_path = `${filepath}.tmp`;

  await writeFile(tmp_path, JSON.stringify(archive, null, 2), "utf-8");
  await rename(tmp_path, filepath);

  console.log(`[discord] Archived room ${archive.name} to ${filepath}`);
}

/** Delete a specific archive file. Returns true if deleted, false on error. */
export async function delete_room_archive(
  entity_id: string,
  archive: RoomArchive,
  paths?: Record<string, string>,
): Promise<boolean> {
  const archives_dir = join(entity_dir(paths, entity_id), "archives");
  const timestamp = archive.closed_at.replace(/[:.]/g, "-");
  const filename = `${archive.name}-${timestamp}.json`;
  const filepath = join(archives_dir, filename);
  try {
    await unlink(filepath);
    console.log(`[discord] Deleted consumed archive: ${filepath}`);
    return true;
  } catch (err) {
    console.warn(`[discord] Failed to delete archive ${filepath}: ${err}`);
    return false;
  }
}

/** Load all room archives for an entity, sorted by closed_at ascending. */
export async function load_room_archives(
  entity_id: string,
  paths?: Record<string, string>,
): Promise<RoomArchive[]> {
  const archives_dir = join(entity_dir(paths, entity_id), "archives");
  let entries: string[];
  try {
    entries = await readdir(archives_dir);
  } catch {
    return []; // No archives directory
  }

  const archives: RoomArchive[] = [];
  for (const filename of entries) {
    if (!filename.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(archives_dir, filename), "utf-8");
      const data = JSON.parse(raw) as RoomArchive;
      archives.push(data);
    } catch {
      console.log(`[discord] Skipping invalid archive file: ${filename}`);
    }
  }

  // Sort by closed_at ascending (oldest first)
  archives.sort((a, b) => a.closed_at.localeCompare(b.closed_at));
  return archives;
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
