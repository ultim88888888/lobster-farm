import { execFileSync, spawn } from "node:child_process";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ArchetypeRole, LobsterFarmConfig } from "@lobster-farm/shared";
import { lobsterfarm_dir, entity_dir } from "@lobster-farm/shared";
import type { ChannelType } from "@lobster-farm/shared";
import type { EntityRegistry } from "./registry.js";

// ── Types ──

export interface PoolBot {
  id: number;
  state: "free" | "assigned" | "parked";
  channel_id: string | null;
  entity_id: string | null;
  archetype: ArchetypeRole | null;
  channel_type: ChannelType | null;
  session_id: string | null;
  tmux_session: string;
  last_active: Date | null;
  state_dir: string;
}

export interface PoolAssignment {
  bot_id: number;
  channel_id: string;
  entity_id: string;
  archetype: ArchetypeRole;
  session_id: string | null;
  tmux_session: string;
}

export interface PoolStatus {
  total: number;
  free: number;
  assigned: number;
  parked: number;
  assignments: Array<{
    bot_id: number;
    channel_id: string;
    entity_id: string;
    archetype: string;
    state: string;
    last_active: string | null;
  }>;
}

// ── Agent name resolution ──

function resolve_agent_name(
  archetype: ArchetypeRole,
  config: LobsterFarmConfig,
): string {
  switch (archetype) {
    case "planner": return config.agents.planner.name.toLowerCase();
    case "designer": return config.agents.designer.name.toLowerCase();
    case "builder": return config.agents.builder.name.toLowerCase();
    case "operator": return config.agents.operator.name.toLowerCase();
    case "commander": return config.agents.commander.name.toLowerCase();
    case "reviewer": return "reviewer";
  }
}

function resolve_agent_display_name(
  archetype: ArchetypeRole,
  config: LobsterFarmConfig,
): string {
  switch (archetype) {
    case "planner": return config.agents.planner.name;
    case "designer": return config.agents.designer.name;
    case "builder": return config.agents.builder.name;
    case "operator": return config.agents.operator.name;
    case "commander": return config.agents.commander.name;
    case "reviewer": return "Reviewer";
  }
}

/** Extract bot user ID from a Discord bot token (first segment is base64-encoded user ID). */
function bot_user_id_from_token(token: string): string | null {
  try {
    const first_segment = token.split(".")[0];
    if (!first_segment) return null;
    return Buffer.from(first_segment, "base64").toString("utf-8");
  } catch {
    return null;
  }
}

// ── Pool Manager ──

export class BotPool {
  private bots: PoolBot[] = [];
  private config: LobsterFarmConfig;
  private _draining = false;

  constructor(config: LobsterFarmConfig) {
    this.config = config;
  }

  /** Enter drain mode — no new assignments accepted. */
  drain(): void {
    this._draining = true;
    console.log("[pool] Entering drain mode — no new assignments");
  }

  /** Check if pool is draining. */
  get draining(): boolean {
    return this._draining;
  }

  /** Discover pool bot directories and initialize state. */
  async initialize(): Promise<void> {
    const channels_dir = join(lobsterfarm_dir(this.config.paths), "channels");
    const pool_dirs: string[] = [];

    // Scan for pool-N directories
    try {
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(channels_dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith("pool-")) {
          pool_dirs.push(entry.name);
        }
      }
    } catch {
      console.log("[pool] No channels directory found");
      return;
    }

    // Sort by number
    pool_dirs.sort((a, b) => {
      const num_a = parseInt(a.replace("pool-", ""), 10);
      const num_b = parseInt(b.replace("pool-", ""), 10);
      return num_a - num_b;
    });

    for (const dir_name of pool_dirs) {
      const id = parseInt(dir_name.replace("pool-", ""), 10);
      const state_dir = join(channels_dir, dir_name);

      // Verify the bot has a token
      try {
        const env_content = await readFile(join(state_dir, ".env"), "utf-8");
        if (!env_content.includes("DISCORD_BOT_TOKEN=")) {
          console.log(`[pool] Skipping ${dir_name}: no bot token`);
          continue;
        }
      } catch {
        console.log(`[pool] Skipping ${dir_name}: no .env file`);
        continue;
      }

      // Check if there's already a tmux session running for this bot
      const tmux_session = `pool-${String(id)}`;
      const is_running = this.is_tmux_alive(tmux_session);

      this.bots.push({
        id,
        state: is_running ? "assigned" : "free",
        channel_id: null,
        entity_id: null,
        archetype: null,
        channel_type: null,
        session_id: null,
        tmux_session,
        last_active: is_running ? new Date() : null,
        state_dir,
      });
    }

    console.log(
      `[pool] Initialized ${String(this.bots.length)} pool bots ` +
      `(${String(this.bots.filter(b => b.state === "free").length)} free)`,
    );
  }

  /** Assign a pool bot to a channel with a specific archetype. */
  async assign(
    channel_id: string,
    entity_id: string,
    archetype: ArchetypeRole,
    resume_session_id?: string,
    channel_type?: ChannelType,
  ): Promise<PoolAssignment | null> {
    if (this._draining) {
      console.log("[pool] Rejecting assignment — draining");
      return null;
    }

    // Check if this channel already has an assignment
    const existing = this.bots.find(b => b.channel_id === channel_id && b.state === "assigned");
    if (existing) {
      console.log(`[pool] Channel ${channel_id} already assigned to pool-${String(existing.id)}`);
      return {
        bot_id: existing.id,
        channel_id,
        entity_id,
        archetype: existing.archetype!,
        session_id: existing.session_id,
        tmux_session: existing.tmux_session,
      };
    }

    // Check for a parked bot that was previously on this channel — auto-resume
    const returning = this.bots.find(
      b => b.state === "parked" && b.channel_id === channel_id && b.entity_id === entity_id,
    );
    let bot: PoolBot | undefined;
    if (returning) {
      resume_session_id = resume_session_id ?? returning.session_id ?? undefined;
      bot = returning;
      console.log(
        `[pool] Reclaiming parked bot pool-${String(bot.id)} for channel ${channel_id} ` +
        `(session: ${resume_session_id?.slice(0, 8) ?? "fresh"})`,
      );
    }

    // Find a free bot if we don't have a returning one
    if (!bot) {
      bot = this.bots.find(b => b.state === "free");
    }

    // If none free, evict the least recently active (parked first, then assigned)
    // Eviction priority: general-channel bots evicted before work-room bots
    if (!bot) {
      const parked = this.bots
        .filter(b => b.state === "parked")
        .sort((a, b) => {
          // General channels evicted before work rooms
          const type_a = a.channel_type === "work_room" ? 1 : 0;
          const type_b = b.channel_type === "work_room" ? 1 : 0;
          if (type_a !== type_b) return type_a - type_b;
          return (a.last_active?.getTime() ?? 0) - (b.last_active?.getTime() ?? 0);
        });

      if (parked.length > 0) {
        bot = parked[0];
        console.log(`[pool] Evicting parked bot pool-${String(bot!.id)} (${bot!.channel_type ?? "unknown"} channel, LRU)`);
      } else {
        // Evict least recently active assigned bot (general first)
        const assigned = this.bots
          .filter(b => b.state === "assigned")
          .sort((a, b) => {
            const type_a = a.channel_type === "work_room" ? 1 : 0;
            const type_b = b.channel_type === "work_room" ? 1 : 0;
            if (type_a !== type_b) return type_a - type_b;
            return (a.last_active?.getTime() ?? 0) - (b.last_active?.getTime() ?? 0);
          });

        if (assigned.length > 0) {
          bot = assigned[0];
          console.log(`[pool] Evicting assigned bot pool-${String(bot!.id)} (LRU) — parking session`);
          await this.park_bot(bot!);
        }
      }
    }

    if (!bot) {
      console.error("[pool] No bots available — pool exhausted");
      return null;
    }

    // Kill any existing tmux session
    this.kill_tmux(bot.tmux_session);

    // Update access.json with the channel ID
    await this.write_access_json(bot.state_dir, channel_id);

    // Set Discord nickname to match the archetype
    await this.set_bot_nickname(bot.state_dir, archetype);

    // Start the tmux session
    const working_dir = entity_dir(this.config.paths, entity_id);
    await this.start_tmux(bot, archetype, entity_id, working_dir, resume_session_id);

    // Update bot state
    bot.state = "assigned";
    bot.channel_id = channel_id;
    bot.entity_id = entity_id;
    bot.archetype = archetype;
    bot.channel_type = channel_type ?? null;
    bot.session_id = resume_session_id ?? null;
    bot.last_active = new Date();

    console.log(
      `[pool] Assigned pool-${String(bot.id)} to channel ${channel_id} ` +
      `as ${archetype} for entity ${entity_id}`,
    );

    return {
      bot_id: bot.id,
      channel_id,
      entity_id,
      archetype,
      session_id: bot.session_id,
      tmux_session: bot.tmux_session,
    };
  }

  /** Release a bot from its channel assignment. */
  async release(channel_id: string): Promise<void> {
    const bot = this.bots.find(b => b.channel_id === channel_id);
    if (!bot) return;

    this.kill_tmux(bot.tmux_session);

    bot.state = "free";
    bot.channel_id = null;
    bot.entity_id = null;
    bot.archetype = null;
    bot.channel_type = null;
    bot.session_id = null;
    bot.last_active = null;

    // Clear access.json
    await this.write_access_json(bot.state_dir, null);

    console.log(`[pool] Released pool-${String(bot.id)}`);
  }

  /** Park a bot — preserve session ID for later resume, free the bot. */
  private async park_bot(bot: PoolBot): Promise<void> {
    this.kill_tmux(bot.tmux_session);
    bot.state = "parked";
    // session_id, channel_id, entity_id, archetype preserved for resume
    console.log(
      `[pool] Parked pool-${String(bot.id)} ` +
      `(session: ${bot.session_id?.slice(0, 8) ?? "none"}, ` +
      `channel: ${bot.channel_id})`,
    );
  }

  /** Get the assignment for a channel. */
  get_assignment(channel_id: string): PoolBot | undefined {
    return this.bots.find(b => b.channel_id === channel_id && b.state === "assigned");
  }

  /** Get pool status. */
  get_status(): PoolStatus {
    return {
      total: this.bots.length,
      free: this.bots.filter(b => b.state === "free").length,
      assigned: this.bots.filter(b => b.state === "assigned").length,
      parked: this.bots.filter(b => b.state === "parked").length,
      assignments: this.bots
        .filter(b => b.state !== "free")
        .map(b => ({
          bot_id: b.id,
          channel_id: b.channel_id ?? "",
          entity_id: b.entity_id ?? "",
          archetype: b.archetype ?? "",
          state: b.state,
          last_active: b.last_active?.toISOString() ?? null,
        })),
    };
  }

  /** Check if any pool bots are actively working (not idle at prompt). */
  has_active_work(): { active: boolean; working_bots: Array<{ id: number; archetype: string; channel_id: string }> } {
    const working: Array<{ id: number; archetype: string; channel_id: string }> = [];

    for (const bot of this.bots) {
      if (bot.state !== "assigned") continue;

      try {
        const output = execFileSync(
          "tmux", ["capture-pane", "-t", bot.tmux_session, "-p"],
          { encoding: "utf-8", timeout: 2000 },
        );
        // If the pane shows a spinner/working indicator (no ❯ prompt at the end),
        // the bot is actively processing
        const lines = output.trim().split("\n");
        const last_line = lines[lines.length - 1] ?? "";
        const is_idle = last_line.includes("❯") || last_line.includes("bypass permissions");
        if (!is_idle) {
          working.push({
            id: bot.id,
            archetype: bot.archetype ?? "unknown",
            channel_id: bot.channel_id ?? "",
          });
        }
      } catch {
        // Can't check — assume not working
      }
    }

    return { active: working.length > 0, working_bots: working };
  }

  /** Update last_active timestamp for a channel's bot. */
  touch(channel_id: string): void {
    const bot = this.bots.find(b => b.channel_id === channel_id && b.state === "assigned");
    if (bot) {
      bot.last_active = new Date();
    }
  }

  /** Stop all pool bot sessions. Used during daemon shutdown. */
  async shutdown(): Promise<void> {
    for (const bot of this.bots) {
      if (bot.state === "assigned") {
        this.kill_tmux(bot.tmux_session);
      }
    }
    console.log("[pool] All pool sessions stopped");
  }

  // ── Internal ──

  private async write_access_json(
    state_dir: string,
    channel_id: string | null,
  ): Promise<void> {
    const groups: Record<string, { requireMention: boolean; allowFrom: string[] }> = {};
    if (channel_id) {
      groups[channel_id] = { requireMention: false, allowFrom: [] };
    }

    const access = {
      dmPolicy: "allowlist",
      allowFrom: ["732686813856006245"], // Jax's user ID
      groups,
      pending: {},
      ackReaction: "👀",
      replyToMode: "first",
      textChunkLimit: 2000,
      chunkMode: "newline",
    };

    await writeFile(join(state_dir, "access.json"), JSON.stringify(access, null, 2), "utf-8");
  }

  private async start_tmux(
    bot: PoolBot,
    archetype: ArchetypeRole,
    entity_id: string,
    working_dir: string,
    resume_session_id?: string,
  ): Promise<void> {
    const claude_bin = process.env["CLAUDE_BIN"] ?? "claude";
    const agent_name = resolve_agent_name(archetype, this.config);

    const claude_args = [
      claude_bin,
      "--channels", "plugin:discord@claude-plugins-official",
      "--agent", agent_name,
      "--model", "claude-opus-4-6",
      "--permission-mode", "bypassPermissions",
      "--add-dir", working_dir,
      "--add-dir", homedir(),
    ];

    if (resume_session_id) {
      claude_args.push("--resume", resume_session_id);
    }

    // Note: entity context is NOT injected via --append-system-prompt for pool bots.
    // Multi-line context strings break tmux command parsing. Pool bots load context
    // naturally via CLAUDE.md, skills, and entity memory in the working directory.

    const display_name = resolve_agent_display_name(archetype, this.config);
    const git_env = `GIT_AUTHOR_NAME="${display_name} (LobsterFarm)" GIT_AUTHOR_EMAIL="${agent_name}@lobsterfarm.dev" GIT_COMMITTER_NAME="${display_name} (LobsterFarm)" GIT_COMMITTER_EMAIL="${agent_name}@lobsterfarm.dev"`;
    const claude_cmd = claude_args.join(" ");

    return new Promise<void>((resolve, reject) => {
      const proc = spawn("tmux", [
        "new-session", "-d",
        "-s", bot.tmux_session,
        "-x", "200", "-y", "50",
        `DISCORD_STATE_DIR=${bot.state_dir} ${git_env} ${claude_cmd}`,
      ], {
        cwd: working_dir,
        stdio: "ignore",
        env: {
          ...process.env,
          DISCORD_STATE_DIR: bot.state_dir,
          GIT_AUTHOR_NAME: `${display_name} (LobsterFarm)`,
          GIT_AUTHOR_EMAIL: `${agent_name}@lobsterfarm.dev`,
          GIT_COMMITTER_NAME: `${display_name} (LobsterFarm)`,
          GIT_COMMITTER_EMAIL: `${agent_name}@lobsterfarm.dev`,
        },
      });

      proc.on("close", (code) => {
        if (code !== 0) {
          console.error(`[pool] tmux new-session failed for pool-${String(bot.id)} (code ${String(code)})`);
          reject(new Error(`tmux failed with code ${String(code)}`));
          return;
        }

        if (this.is_tmux_alive(bot.tmux_session)) {
          // Auto-accept workspace trust dialog
          setTimeout(() => {
            try {
              execFileSync("tmux", ["send-keys", "-t", bot.tmux_session, "Enter"], {
                stdio: "ignore",
              });
            } catch { /* dialog may not appear */ }
          }, 3000);

          console.log(`[pool] pool-${String(bot.id)} running as ${agent_name} in tmux`);
          resolve();
        } else {
          console.error(`[pool] tmux session did not start for pool-${String(bot.id)}`);
          reject(new Error("tmux session did not start"));
        }
      });
    });
  }

  /** Set the bot's server nickname via Discord API. */
  private async set_bot_nickname(
    state_dir: string,
    archetype: ArchetypeRole,
  ): Promise<void> {
    const display_name = resolve_agent_display_name(archetype, this.config);
    const server_id = this.config.discord?.server_id;
    if (!server_id) return;

    try {
      const env_content = await readFile(join(state_dir, ".env"), "utf-8");
      const token_match = env_content.match(/DISCORD_BOT_TOKEN=(.+)/);
      const token = token_match?.[1]?.trim();
      if (!token) return;

      const res = await fetch(
        `https://discord.com/api/v10/guilds/${server_id}/members/@me`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bot ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ nick: display_name }),
        },
      );

      if (res.ok) {
        console.log(`[pool] Set nickname to "${display_name}"`);
      } else {
        console.log(`[pool] Failed to set nickname: ${String(res.status)}`);
      }
    } catch (err) {
      console.log(`[pool] Nickname set failed: ${String(err)}`);
    }
  }

  /** Pre-assign bots to entity #general channels on daemon startup. */
  async pre_assign_generals(registry: EntityRegistry): Promise<void> {
    for (const entity_config of registry.get_active()) {
      const entity_id = entity_config.entity.id;
      const general_channel = entity_config.entity.channels.list.find(
        ch => ch.type === "general",
      );
      if (!general_channel) continue;

      const existing = this.get_assignment(general_channel.id);
      if (existing) continue;

      await this.assign(general_channel.id, entity_id, "planner");
    }
  }

  private is_tmux_alive(session_name: string): boolean {
    try {
      execFileSync("tmux", ["has-session", "-t", session_name], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  private kill_tmux(session_name: string): void {
    try {
      execFileSync("tmux", ["kill-session", "-t", session_name], { stdio: "ignore" });
    } catch { /* may not exist */ }
  }
}
