import { EventEmitter } from "node:events";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ArchetypeRole, LobsterFarmConfig } from "@lobster-farm/shared";
import { lobsterfarm_dir, entity_dir } from "@lobster-farm/shared";
import type { ChannelType } from "@lobster-farm/shared";
import { save_pool_state, load_pool_state } from "./persistence.js";
import type { PersistedPoolBot } from "./persistence.js";
import type { EntityRegistry } from "./registry.js";
import { sq } from "./shell.js";

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
  /** When this bot was assigned to its current channel. Used for uptime calculation. */
  assigned_at: Date | null;
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

/** Activity state computed on demand from observable signals (tmux pane, timestamps). */
export type ActivityState = "idle" | "working" | "waiting_for_human" | "active_conversation";

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

/** Extract bot user ID from a Discord bot token (first segment is base64-encoded user ID).
 * Returns only the non-secret user ID — the token itself is not retained. */
function bot_user_id_from_token(token: string): string | null {
  try {
    const first_segment = token.split(".")[0];
    if (!first_segment) return null;
    return Buffer.from(first_segment, "base64").toString("utf-8");
  } catch {
    return null;
  }
}

/** Callback for setting a bot's Discord nickname. Provided by the Discord module
 * so the pool doesn't need direct access to bot tokens or the Discord API. */
export type NicknameHandler = (user_id: string, display_name: string) => Promise<void>;

// ── Pool Manager ──

export class BotPool extends EventEmitter {
  private bots: PoolBot[] = [];
  private config: LobsterFarmConfig;
  private _draining = false;
  private health_timer: ReturnType<typeof setInterval> | null = null;
  /** In-flight lock: channels currently being assigned. Prevents check-then-act races. */
  private assigning_channels = new Set<string>();
  /** In-flight lock: channels currently being released. Prevents double-release races. */
  private releasing_channels = new Set<string>();
  private bot_user_ids = new Map<number, string>();
  private nickname_handler: NicknameHandler | null = null;
  /** Bots that were actively assigned before shutdown and should be proactively resumed.
   * Populated during initialize(), consumed by resume_parked_bots(). */
  private resume_candidates: PersistedPoolBot[] = [];
  /** Maps "{entity_id}:{channel_id}" → session_id. Preserves session context
   * across evictions so a channel can resume its old session when reassigned. */
  private session_history = new Map<string, string>();

  constructor(config: LobsterFarmConfig) {
    super();
    this.config = config;
  }

  /** Register a callback for setting bot nicknames via Discord.
   * Called by the Discord module after connecting — allows the pool to
   * set nicknames through the daemon bot without touching pool bot tokens. */
  set_nickname_handler(handler: NicknameHandler): void {
    this.nickname_handler = handler;
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

  /** Discover pool bot directories, restore persisted state, and initialize. */
  async initialize(registry?: EntityRegistry): Promise<void> {
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

      // Verify the bot has a token and extract its user ID for nickname management.
      // Only the non-secret user ID (base64 first segment) is retained — the full
      // token is never stored in daemon memory or used for API calls.
      try {
        const env_content = await readFile(join(state_dir, ".env"), "utf-8");
        const token_match = env_content.match(/DISCORD_BOT_TOKEN=(.+)/);
        if (!token_match?.[1]?.trim()) {
          console.log(`[pool] Skipping ${dir_name}: no bot token`);
          continue;
        }
        const user_id = bot_user_id_from_token(token_match[1].trim());
        if (user_id) {
          this.bot_user_ids.set(id, user_id);
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
        assigned_at: is_running ? new Date() : null,
        state_dir,
      });
    }

    // Restore persisted assignments from last run
    const saved_state = await load_pool_state(this.config);
    if (saved_state.bots.length > 0) {
      console.log(`[pool] Loaded ${String(saved_state.bots.length)} saved bot entries from pool-state.json`);
      for (const entry of saved_state.bots) {
        console.log(
          `[pool]   pool-${String(entry.id)}: state=${entry.state}, ` +
          `channel=${entry.channel_id}, session=${entry.session_id?.slice(0, 8) ?? "none"}`,
        );
      }
    } else {
      console.log("[pool] No saved bot entries found in pool-state.json");
    }

    let restored = 0;
    this.resume_candidates = [];

    // Restore session history from persisted state
    for (const [key, session_id] of Object.entries(saved_state.session_history)) {
      this.session_history.set(key, session_id);
    }
    if (this.session_history.size > 0) {
      console.log(`[pool] Restored ${String(this.session_history.size)} session history entries`);
    }

    for (const entry of saved_state.bots) {
      const bot = this.bots.find(b => b.id === entry.id);
      if (!bot) continue; // Bot directory removed since last run

      // Validate entity/channel still exist (if registry available)
      if (registry && !this.validate_saved_entry(entry, registry)) {
        console.log(
          `[pool] Skipping stale entry for pool-${String(entry.id)}: ` +
          `entity/channel no longer configured`,
        );
        continue;
      }

      if (bot.state === "assigned") {
        // tmux is still running (survived restart, e.g. launchd) — restore metadata.
        // BUT the Claude process inside has a stale MCP connection to the old daemon.
        // We mark it as a resume candidate so resume_parked_bots() will kill the old
        // tmux and spawn a fresh Claude process with --resume (fresh MCP connection).
        bot.channel_id = entry.channel_id;
        bot.entity_id = entry.entity_id;
        bot.archetype = entry.archetype;
        bot.channel_type = entry.channel_type;
        bot.session_id = entry.session_id;
        bot.last_active = entry.last_active ? new Date(entry.last_active) : null;
        bot.assigned_at = entry.assigned_at ? new Date(entry.assigned_at) : bot.last_active;

        // Add to resume candidates — the live tmux session has a dead MCP socket.
        // resume_parked_bots() will kill it and spawn fresh with --resume.
        if (entry.state === "assigned" && entry.session_id) {
          this.resume_candidates.push(entry);
          console.log(
            `[pool] pool-${String(bot.id)} has live tmux but stale MCP — ` +
            `queued for fresh resume (session: ${entry.session_id.slice(0, 8)})`,
          );
        }
      } else {
        // tmux is dead — mark as parked with preserved session ID.
        // When someone messages the channel, existing parked-bot auto-resume
        // logic in assign() reclaims this bot with --resume {session_id}.
        bot.state = "parked";
        bot.channel_id = entry.channel_id;
        bot.entity_id = entry.entity_id;
        bot.archetype = entry.archetype;
        bot.channel_type = entry.channel_type;
        bot.session_id = entry.session_id;
        bot.last_active = entry.last_active ? new Date(entry.last_active) : null;
        bot.assigned_at = entry.assigned_at ? new Date(entry.assigned_at) : bot.last_active;

        // If this bot was actively assigned (not already parked) before shutdown
        // and has a session_id, it's a candidate for proactive resume.
        // Bots saved as "parked" were already idle — don't resume those.
        if (entry.state === "assigned" && entry.session_id) {
          this.resume_candidates.push(entry);
        }
      }

      restored++;
    }

    if (restored > 0) {
      console.log(`[pool] Restored ${String(restored)} bot assignment(s) from persisted state`);
    }

    // Deduplicate: if multiple bots claim the same channel (from a prior race condition),
    // keep only the first (lowest pool-id) and free the rest. This prevents stale
    // persisted state from causing duplicate assignments on restart.
    const seen_channels = new Set<string>();
    for (const bot of this.bots) {
      if (bot.state === "free" || !bot.channel_id) continue;
      if (seen_channels.has(bot.channel_id)) {
        console.log(
          `[pool] Dedup: pool-${String(bot.id)} has duplicate claim on channel ${bot.channel_id} — freeing`,
        );
        bot.state = "free";
        bot.channel_id = null;
        bot.entity_id = null;
        bot.archetype = null;
        bot.channel_type = null;
        bot.session_id = null;
        bot.last_active = null;
        // Clear the stale access.json so the bot doesn't listen on the old channel
        await this.write_access_json(bot.state_dir, null);
      } else {
        seen_channels.add(bot.channel_id);
      }
    }

    // Reconcile access.json for every bot to match the daemon's resolved state.
    // This is the critical step: the daemon is the single source of truth for channel
    // assignments. access.json files may be stale from a previous run (e.g., a bot that
    // was reassigned or freed but whose tmux survived the restart). Rewriting them all
    // ensures the Discord plugin only listens to channels the daemon actually assigned.
    for (const bot of this.bots) {
      // Only assigned bots (with live tmux) should listen on their channel.
      // Parked and free bots get empty access.json — their channel claim is
      // preserved in memory/pool-state.json for resume, not in access.json.
      const expected_channel = bot.state === "assigned" ? bot.channel_id : null;
      await this.write_access_json(bot.state_dir, expected_channel);
    }
    console.log(`[pool] Reconciled access.json for ${String(this.bots.length)} bots`);

    // Persist cleaned state (stale entries removed, duplicates resolved, current snapshot)
    await this.persist();

    console.log(
      `[pool] Initialized ${String(this.bots.length)} pool bots ` +
      `(${String(this.bots.filter(b => b.state === "free").length)} free, ` +
      `${String(this.bots.filter(b => b.state === "parked").length)} parked, ` +
      `${String(this.bots.filter(b => b.state === "assigned").length)} assigned)`,
    );
  }

  /**
   * Proactively resume bots that were actively assigned before daemon shutdown.
   * Call AFTER Discord is connected so notifications can be sent.
   *
   * For each resume candidate: write access.json, set nickname, start tmux
   * with --resume, update state to assigned, emit bot:resumed.
   * Clears resume_candidates when done (or on skip) to prevent stale state.
   */
  async resume_parked_bots(): Promise<void> {
    if (this.resume_candidates.length === 0) return;

    console.log(
      `[pool] Proactively resuming ${String(this.resume_candidates.length)} bot(s) ` +
      `that were assigned before shutdown`,
    );

    let resumed = 0;
    for (const candidate of this.resume_candidates) {
      // Match both parked bots (tmux died) and assigned bots (tmux survived but
      // has stale MCP connection). Both need a fresh Claude process with --resume.
      const bot = this.bots.find(
        b => b.id === candidate.id
          && (b.state === "parked" || b.state === "assigned")
          && b.channel_id === candidate.channel_id,
      );
      if (!bot) continue;

      const had_live_tmux = bot.state === "assigned";

      try {
        // Kill any surviving tmux session — the Claude process inside has a stale
        // MCP connection to the old daemon and can't reply through Discord.
        // This is safe even if the tmux session is already dead.
        if (had_live_tmux) {
          console.log(
            `[pool] Killing stale tmux for pool-${String(bot.id)} ` +
            `(MCP connection is dead after daemon restart)`,
          );
        }
        this.kill_tmux(bot.tmux_session);

        // Write access.json so the Discord plugin listens on this channel
        await this.write_access_json(bot.state_dir, candidate.channel_id);

        // Set Discord nickname to match the archetype
        await this.set_bot_nickname(bot, candidate.archetype);

        // Spawn a fresh Claude process with --resume — establishes a new MCP
        // connection to this daemon while preserving conversation context
        const working_dir = entity_dir(this.config.paths, candidate.entity_id);
        await this.start_tmux(bot, candidate.archetype, candidate.entity_id, working_dir, candidate.session_id!, true);

        // Update bot state to assigned
        bot.state = "assigned";
        bot.last_active = new Date();
        bot.assigned_at = new Date(); // Reset uptime — new process

        resumed++;
        console.log(
          `[pool] Resumed pool-${String(bot.id)} with fresh MCP connection ` +
          `(session: ${candidate.session_id!.slice(0, 8)}, ` +
          `was: ${had_live_tmux ? "stale tmux" : "parked"})`,
        );

        this.emit("bot:resumed", {
          bot_id: bot.id,
          channel_id: bot.channel_id,
          entity_id: bot.entity_id,
        });
      } catch (err) {
        console.error(
          `[pool] Failed to resume pool-${String(bot.id)}: ${String(err)}`,
        );
        // Leave the bot in its current state — parked bots can still be resumed
        // on next message; assigned bots with dead tmux will be caught by health monitor
      }
    }

    // Clear candidates regardless of success — prevents stale resumes
    // if the daemon stays running through another restart cycle
    this.resume_candidates = [];

    if (resumed > 0) {
      await this.persist();
      console.log(`[pool] Proactively resumed ${String(resumed)} bot(s)`);
    }
  }

  /** Assign a pool bot to a channel with a specific archetype. */
  async assign(
    channel_id: string,
    entity_id: string,
    archetype: ArchetypeRole,
    resume_session_id?: string,
    channel_type?: ChannelType,
    working_dir?: string,
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

    // Synchronous in-flight lock: if another assign() call for this channel is
    // already past the "already assigned?" check but hasn't written state yet,
    // treat it as already assigned. This closes the check-then-act race where
    // two concurrent callers both pass the check above before either writes.
    if (this.assigning_channels.has(channel_id)) {
      console.log(`[pool] Channel ${channel_id} has an in-flight assignment — skipping`);
      return null;
    }
    this.assigning_channels.add(channel_id);

    try {
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

      // Check session_history for a previously evicted session on this channel.
      // Only used if no explicit resume_session_id was provided and no parked bot
      // was found (parked bots carry their own session_id).
      if (!resume_session_id) {
        const history_key = `${entity_id}:${channel_id}`;
        const history_session = this.session_history.get(history_key);
        if (history_session) {
          resume_session_id = history_session;
          console.log(
            `[pool] Found session history for channel ${channel_id}: ` +
            `${resume_session_id.slice(0, 8)}`,
          );
        }
      }

      // Find a free bot if we don't have a returning one
      if (!bot) {
        bot = this.bots.find(b => b.state === "free");
      }

      // Activity-aware eviction: free → parked → idle assigned → waiting_for_human → FLOOR
      // Within each tier: general channels before work rooms, then LRU.
      const eviction_sort = (a: PoolBot, b: PoolBot) => {
        const type_a = a.channel_type === "work_room" ? 1 : 0;
        const type_b = b.channel_type === "work_room" ? 1 : 0;
        if (type_a !== type_b) return type_a - type_b;
        return (a.last_active?.getTime() ?? 0) - (b.last_active?.getTime() ?? 0);
      };

      // Tier 2: Parked bots (cheapest eviction — already suspended)
      if (!bot) {
        const parked = this.bots
          .filter(b => b.state === "parked")
          .sort(eviction_sort);

        if (parked.length > 0) {
          bot = parked[0];
          console.log(`[pool] Evicting parked bot pool-${String(bot!.id)} (${bot!.channel_type ?? "unknown"} channel, LRU)`);
        }
      }

      // Tier 3: Idle assigned bots (>= 30 min since last human interaction)
      if (!bot) {
        const idle_assigned = this.bots
          .filter(b => b.state === "assigned" && this.compute_activity_state(b) === "idle")
          .sort(eviction_sort);

        if (idle_assigned.length > 0) {
          bot = idle_assigned[0];
          console.log(`[pool] Evicting idle bot pool-${String(bot!.id)} — parking`);
          await this.park_bot(bot!);
        }
      }

      // Tier 4: Waiting-for-human bots (3-30 min since last interaction — expensive but necessary)
      if (!bot) {
        const waiting = this.bots
          .filter(b => b.state === "assigned" && this.compute_activity_state(b) === "waiting_for_human")
          .sort(eviction_sort);

        if (waiting.length > 0) {
          bot = waiting[0];
          console.log(`[pool] Evicting waiting-for-human bot pool-${String(bot!.id)} — parking`);
          await this.park_bot(bot!);
          // Notify that this session was parked with active context
          this.emit("bot:parked_with_context", {
            bot_id: bot!.id,
            channel_id: bot!.channel_id,
            entity_id: bot!.entity_id,
          });
        }
      }

      // FLOOR: active_conversation and working bots are NEVER evicted
      if (!bot) {
        console.log("[pool] All bots at floor (active/working) — no eviction possible");
        return null;
      }

      // Stash session history for the evicted bot's channel before overwriting.
      // Only stash if the bot is being reassigned away from a different channel
      // (i.e., not a returning parked bot reclaiming its own channel, and not a free bot).
      if (bot.channel_id && bot.entity_id && bot.session_id && bot.channel_id !== channel_id) {
        const evict_key = `${bot.entity_id}:${bot.channel_id}`;
        this.session_history.set(evict_key, bot.session_id);
        console.log(
          `[pool] Stashed session history for ${evict_key}: ${bot.session_id.slice(0, 8)}`,
        );
      }

      // Kill any existing tmux session
      this.kill_tmux(bot.tmux_session);

      // Update access.json with the channel ID
      await this.write_access_json(bot.state_dir, channel_id);

      // Set Discord nickname to match the archetype
      await this.set_bot_nickname(bot, archetype);

      // Start the tmux session — use override working_dir if provided (e.g., feature worktree)
      // For fresh sessions, generate a UUID so pool-state.json always has a session_id
      // for proactive resume on daemon restart.
      const session_id = resume_session_id ?? randomUUID();
      const resolved_dir = working_dir ?? entity_dir(this.config.paths, entity_id);
      await this.start_tmux(bot, archetype, entity_id, resolved_dir, session_id, !!resume_session_id);

      // Update bot state
      bot.state = "assigned";
      bot.channel_id = channel_id;
      bot.entity_id = entity_id;
      bot.archetype = archetype;
      bot.channel_type = channel_type ?? null;
      bot.session_id = session_id;
      bot.last_active = new Date();
      bot.assigned_at = new Date();

      // Consume session history entry now that it's been used
      const assign_key = `${entity_id}:${channel_id}`;
      if (this.session_history.has(assign_key)) {
        this.session_history.delete(assign_key);
        console.log(`[pool] Consumed session history for ${assign_key}`);
      }

      await this.persist();

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
    } finally {
      this.assigning_channels.delete(channel_id);
    }
  }

  /** Release a bot from its channel assignment. */
  async release(channel_id: string): Promise<void> {
    const bot = this.bots.find(b => b.channel_id === channel_id);
    if (!bot) return;

    // Synchronous in-flight lock: prevents double-release when two callers
    // (e.g., health monitor + explicit release) race on the same channel.
    if (this.releasing_channels.has(channel_id)) {
      console.log(`[pool] Channel ${channel_id} already being released — skipping`);
      return;
    }
    this.releasing_channels.add(channel_id);

    try {
      const bot_id = bot.id;
      this.kill_tmux(bot.tmux_session);

      bot.state = "free";
      bot.channel_id = null;
      bot.entity_id = null;
      bot.archetype = null;
      bot.channel_type = null;
      bot.session_id = null;
      bot.last_active = null;
      bot.assigned_at = null;

      // Clear access.json
      await this.write_access_json(bot.state_dir, null);

      await this.persist();

      console.log(`[pool] Released pool-${String(bot_id)}`);
      this.emit("bot:released", { bot_id });
    } finally {
      this.releasing_channels.delete(channel_id);
    }
  }

  /** Park a bot — preserve session ID for later resume, free the bot. */
  private async park_bot(bot: PoolBot): Promise<void> {
    this.kill_tmux(bot.tmux_session);
    bot.state = "parked";
    // session_id, channel_id, entity_id, archetype preserved for resume in memory.
    // Clear access.json on disk so no stale channel config survives if the bot's
    // tmux session is somehow restarted outside the normal assign() path.
    await this.write_access_json(bot.state_dir, null);
    await this.persist();
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

  /** Clear session history for a specific channel. Used by !reset and feature completion. */
  clear_session_history(entity_id: string, channel_id: string): void {
    const key = `${entity_id}:${channel_id}`;
    if (this.session_history.delete(key)) {
      console.log(`[pool] Cleared session history for ${key}`);
    }
  }

  /** Check if an assigned bot's tmux session is still alive.
   * Returns false if the bot is not found, not assigned, or its tmux session is dead.
   * Used by discord.ts handle_message() to detect dead sessions on incoming messages. */
  is_session_alive(bot_id: number): boolean {
    const bot = this.bots.find(b => b.id === bot_id);
    if (!bot || bot.state !== "assigned") return false;
    return this.is_tmux_alive(bot.tmux_session);
  }

  /** Release a bot while preserving its session_id in history for future resume.
   * Stashes session_id before calling release(), which nulls all bot metadata.
   * Used by discord.ts when a message arrives for a bot with a dead tmux session. */
  async release_with_history(bot_id: number): Promise<void> {
    const bot = this.bots.find(b => b.id === bot_id);
    if (!bot || !bot.channel_id) return;

    if (bot.session_id && bot.entity_id) {
      const key = `${bot.entity_id}:${bot.channel_id}`;
      this.session_history.set(key, bot.session_id);
      console.log(
        `[pool] Stashed session history for ${key}: ${bot.session_id.slice(0, 8)}`,
      );
    }

    // release() uses channel_id to find the bot — grab it before it's nulled
    const channel_id = bot.channel_id;
    await this.release(channel_id);
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

  /**
   * Compute the activity state of a bot from observable signals.
   * Derived on demand from tmux pane state and last_active timestamp — never stored.
   */
  compute_activity_state(bot: PoolBot): ActivityState {
    if (bot.state !== "assigned") return "idle";

    // Check if bot is actively processing (tmux pane has no prompt)
    if (!this.is_bot_idle(bot)) return "working";

    // Check recency of last human interaction
    const idle_minutes = bot.last_active
      ? (Date.now() - bot.last_active.getTime()) / 60_000
      : Infinity;

    // < 3 min: active conversation — don't touch
    if (idle_minutes < 3) return "active_conversation";
    // 3-30 min: bot asked a question or showed output recently — evictable as last resort
    if (idle_minutes < 30) return "waiting_for_human";
    // >= 30 min: fair game
    return "idle";
  }

  /**
   * Check if a single bot is idle at the prompt (not actively processing).
   *
   * Semantics: returns true when the last line of the tmux pane contains a prompt
   * character (❯) or a permissions dialog. This is a heuristic for "has prompt
   * visible" — the bot is not actively generating output or running a command.
   *
   * Fails open (returns true) when the tmux pane can't be read, which is the safe
   * default for eviction checks: we'd rather evict a bot we can't observe than
   * refuse to evict when the pool is exhausted.
   */
  protected is_bot_idle(bot: PoolBot): boolean {
    try {
      const output = execFileSync(
        "tmux", ["capture-pane", "-t", bot.tmux_session, "-p"],
        { encoding: "utf-8", timeout: 2000 },
      );
      const lines = output.trim().split("\n");
      const last_line = lines[lines.length - 1] ?? "";
      // "bypass permissions" matches the Claude Code workspace trust dialog text.
      // This is UI-text dependent and may break if Claude Code changes the dialog wording.
      return last_line.includes("❯") || last_line.includes("bypass permissions");
    } catch {
      return true; // Can't check — assume idle (fail-open for eviction)
    }
  }

  /** Check if any pool bots are actively working (not idle at prompt). */
  has_active_work(): { active: boolean; working_bots: Array<{ id: number; archetype: string; channel_id: string }> } {
    const working: Array<{ id: number; archetype: string; channel_id: string }> = [];

    for (const bot of this.bots) {
      if (bot.state !== "assigned") continue;

      if (!this.is_bot_idle(bot)) {
        working.push({
          id: bot.id,
          archetype: bot.archetype ?? "unknown",
          channel_id: bot.channel_id ?? "",
        });
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

  /**
   * Start the tmux session health monitor.
   * Checks every 30 seconds for assigned bots whose tmux sessions have died.
   * Emits "bot:session_ended" and cleans up bot state when a dead session is found.
   */
  start_health_monitor(): void {
    if (this.health_timer) return; // already running

    this.health_timer = setInterval(() => {
      this.check_assigned_health();
    }, 30_000);

    console.log("[pool] Health monitor started (30s interval)");
  }

  /** Stop the health monitor. */
  stop_health_monitor(): void {
    if (this.health_timer) {
      clearInterval(this.health_timer);
      this.health_timer = null;
      console.log("[pool] Health monitor stopped");
    }
  }

  /**
   * Check all assigned bots for dead tmux sessions.
   * Protected so tests can call it directly without waiting for the interval.
   */
  protected async check_assigned_health(): Promise<void> {
    if (this._draining) return;

    let changed = false;

    for (const bot of this.bots) {
      if (bot.state !== "assigned") continue;
      if (this.is_tmux_alive(bot.tmux_session)) continue;

      // Tmux session died — emit event and clean up
      const event_data = {
        bot_id: bot.id,
        channel_id: bot.channel_id,
        entity_id: bot.entity_id,
      };

      console.log(
        `[pool] Detected dead tmux session for pool-${String(bot.id)} ` +
        `(channel: ${bot.channel_id ?? "none"})`,
      );

      // Preserve session_id in history so the channel can resume when reassigned.
      // This is the safety net for when the health monitor fires before a message
      // triggers the lazy-resume path in handle_message().
      if (bot.session_id && bot.channel_id && bot.entity_id) {
        const key = `${bot.entity_id}:${bot.channel_id}`;
        this.session_history.set(key, bot.session_id);
        console.log(
          `[pool] Stashed session history for ${key}: ${bot.session_id.slice(0, 8)}`,
        );
      }

      // Reset bot to free state
      bot.state = "free";
      bot.channel_id = null;
      bot.entity_id = null;
      bot.archetype = null;
      bot.channel_type = null;
      bot.session_id = null;
      bot.last_active = null;
      bot.assigned_at = null;
      changed = true;

      this.emit("bot:session_ended", event_data);
      this.emit("bot:released", { bot_id: bot.id });
    }

    if (changed) await this.persist();
  }

  /** Stop all pool bot sessions. Used during daemon shutdown. */
  async shutdown(): Promise<void> {
    this.stop_health_monitor();

    // Snapshot current state before killing tmux — this is what the next
    // daemon startup will load for proactive resume.
    await this.persist();

    for (const bot of this.bots) {
      if (bot.state === "assigned") {
        this.kill_tmux(bot.tmux_session);
      }
    }
    console.log("[pool] All pool sessions stopped");
  }

  // ── Persistence ──

  /**
   * Persist current pool state to disk. Called after every state mutation
   * (assign, release, park) for crash resilience — no shutdown hook dependency.
   * Only persists assigned and parked bots; free bots have no meaningful state.
   */
  private async persist(): Promise<void> {
    const to_save: PersistedPoolBot[] = this.bots
      .filter(b => b.state !== "free" && b.channel_id && b.entity_id && b.archetype)
      .map(b => ({
        id: b.id,
        state: b.state as "assigned" | "parked",
        channel_id: b.channel_id!,
        entity_id: b.entity_id!,
        archetype: b.archetype!,
        channel_type: b.channel_type,
        session_id: b.session_id,
        last_active: b.last_active?.toISOString() ?? null,
        assigned_at: b.assigned_at?.toISOString() ?? null,
      }));

    // Convert session_history Map to a plain object for serialization
    const history_obj: Record<string, string> = {};
    for (const [key, value] of this.session_history) {
      history_obj[key] = value;
    }

    try {
      await save_pool_state(to_save, this.config, history_obj);
    } catch (err) {
      // Non-fatal: log and continue. Next mutation will retry the write.
      console.error(`[pool] Failed to persist state: ${String(err)}`);
    }
  }

  /**
   * Validate that a persisted entry still references a valid entity and channel.
   * Returns false for stale entries (entity removed, channel deleted, or null metadata).
   */
  private validate_saved_entry(
    entry: PersistedPoolBot,
    registry: EntityRegistry,
  ): boolean {
    if (!entry.entity_id || !entry.channel_id) {
      console.log(
        `[pool] Rejecting pool-${String(entry.id)}: null metadata ` +
        `(entity: ${String(entry.entity_id)}, channel: ${String(entry.channel_id)})`,
      );
      return false;
    }

    const entity = registry.get(entry.entity_id);
    if (!entity) {
      console.log(
        `[pool] Rejecting pool-${String(entry.id)}: entity "${entry.entity_id}" not in registry`,
      );
      return false;
    }

    const channel = entity.entity.channels.list.find(
      ch => ch.id === entry.channel_id,
    );
    if (!channel) {
      console.log(
        `[pool] Rejecting pool-${String(entry.id)}: channel "${entry.channel_id}" ` +
        `not found in entity "${entry.entity_id}"`,
      );
      return false;
    }

    return true;
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
    session_id: string,
    is_resume: boolean = false,
  ): Promise<void> {
    const claude_bin = process.env["CLAUDE_BIN"] ?? "claude";
    const agent_name = resolve_agent_name(archetype, this.config);

    const claude_args = [
      sq(claude_bin),
      "--channels", "plugin:discord@claude-plugins-official",
      "--agent", sq(agent_name),
      "--model", "claude-opus-4-6",
      "--permission-mode", "bypassPermissions",
      "--add-dir", sq(working_dir),
      "--add-dir", sq(homedir()),
    ];

    if (is_resume) {
      claude_args.push("--resume", sq(session_id));
    } else {
      // Fresh session — pass explicit session ID so pool-state.json can
      // persist it for proactive resume on future daemon restarts.
      claude_args.push("--session-id", sq(session_id));
    }

    // Note: entity context is NOT injected via --append-system-prompt for pool bots.
    // Multi-line context strings break tmux command parsing. Pool bots load context
    // naturally via CLAUDE.md, skills, and entity memory in the working directory.

    const display_name = resolve_agent_display_name(archetype, this.config);
    const git_env = `GIT_AUTHOR_NAME=${sq(`${display_name} (LobsterFarm)`)} GIT_AUTHOR_EMAIL=${sq(`${agent_name}@lobsterfarm.dev`)} GIT_COMMITTER_NAME=${sq(`${display_name} (LobsterFarm)`)} GIT_COMMITTER_EMAIL=${sq(`${agent_name}@lobsterfarm.dev`)}`;
    const claude_cmd = claude_args.join(" ");

    return new Promise<void>((resolve, reject) => {
      const proc = spawn("tmux", [
        "new-session", "-d",
        "-s", bot.tmux_session,
        "-x", "200", "-y", "50",
        `DISCORD_STATE_DIR=${sq(bot.state_dir)} ${git_env} ${claude_cmd}`,
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

  /** Set a pool bot's server nickname via the daemon bot's Discord client.
   * Uses the cached user ID (extracted during initialize) and the nickname
   * handler (provided by the Discord module) — never reads bot tokens at runtime. */
  private async set_bot_nickname(
    bot: PoolBot,
    archetype: ArchetypeRole,
  ): Promise<void> {
    const display_name = resolve_agent_display_name(archetype, this.config);

    if (!this.nickname_handler) {
      console.log(`[pool] No nickname handler registered — skipping nickname set for pool-${String(bot.id)}`);
      return;
    }

    const user_id = this.bot_user_ids.get(bot.id);
    if (!user_id) {
      console.log(`[pool] No cached user ID for pool-${String(bot.id)} — skipping nickname set`);
      return;
    }

    try {
      await this.nickname_handler(user_id, display_name);
      console.log(`[pool] Set pool-${String(bot.id)} nickname to "${display_name}"`);
    } catch (err) {
      console.log(`[pool] Nickname set failed for pool-${String(bot.id)}: ${String(err)}`);
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
