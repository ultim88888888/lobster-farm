import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  ArchetypeRole,
  LobsterFarmConfig,
  ModelTier,
} from "@lobster-farm/shared";
import { readdir } from "node:fs/promises";
import {
  entity_memory_path,
  entity_daily_dir,
  entity_context_dir,
  entity_dir,
} from "@lobster-farm/shared";
import { build_model_flags } from "./models.js";

// ── Interfaces ──

export interface SessionSpawnOptions {
  entity_id: string;
  feature_id: string;
  archetype: ArchetypeRole;
  dna: string[];
  model: ModelTier;
  worktree_path: string;
  prompt: string;
  interactive: boolean;
  /** If set, resume this prior session instead of starting fresh. */
  resume_session_id?: string;
  /** Extra environment variables to inject into the subprocess (e.g. GH_TOKEN). */
  env?: Record<string, string>;
}

export interface ActiveSession {
  session_id: string;
  entity_id: string;
  feature_id: string;
  archetype: ArchetypeRole;
  resume: boolean;
  started_at: Date;
  pid: number | null;
  tmux_pane: string | null;
}

export interface SessionResult {
  session_id: string;
  exit_code: number;
  output_lines: string[];
}

export interface SessionManager {
  spawn(options: SessionSpawnOptions): Promise<ActiveSession>;
  resume(session_id: string): Promise<ActiveSession>;
  kill(session_id: string): Promise<void>;
  get_active(): ActiveSession[];
  get_by_entity(entity_id: string): ActiveSession[];
  get_by_feature(feature_id: string): ActiveSession | null;
}

// ── Events ──

export interface SessionEvents {
  "session:started": (session: ActiveSession) => void;
  "session:output": (session_id: string, line: string) => void;
  "session:completed": (result: SessionResult) => void;
  "session:failed": (session_id: string, error: string) => void;
}

// ── Agent name resolution ──

function resolve_agent_name(
  archetype: ArchetypeRole,
  config: LobsterFarmConfig,
): string {
  const agents = config.agents;
  switch (archetype) {
    case "planner":
      return agents.planner.name.toLowerCase();
    case "designer":
      return agents.designer.name.toLowerCase();
    case "builder":
      return agents.builder.name.toLowerCase();
    case "operator":
      return agents.operator.name.toLowerCase();
    case "commander":
      return agents.commander.name.toLowerCase();
    case "reviewer":
      return "reviewer";
  }
}

// ── Build entity context for --append-system-prompt ──

async function find_recent_daily_logs(
  entity_id: string,
  config: LobsterFarmConfig,
  max_count: number = 5,
): Promise<string[]> {
  const daily_path = entity_daily_dir(config.paths, entity_id);
  try {
    const entries = await readdir(daily_path);
    // Filter for .md files, sort descending (most recent first)
    const logs = entries
      .filter((e) => e.endsWith(".md"))
      .sort()
      .reverse()
      .slice(0, max_count);
    return logs.map((f) => `${daily_path}/${f}`);
  } catch {
    return [];
  }
}

export async function build_entity_context(
  entity_id: string,
  feature_id: string,
  config: LobsterFarmConfig,
): Promise<string> {
  const mem_path = entity_memory_path(config.paths, entity_id);
  const ctx_path = entity_context_dir(config.paths, entity_id);
  const recent_logs = await find_recent_daily_logs(entity_id, config);

  const lines = [
    `## Entity Context (injected by LobsterFarm daemon)`,
    ``,
    `Entity: ${entity_id}`,
    `Feature: ${feature_id}`,
    ``,
    `### Session Startup`,
    `1. Read the entity's MEMORY.md at: ${mem_path}`,
    `2. Read context files at: ${ctx_path}/ (architecture.md, decisions.md, gotchas.md if they exist)`,
  ];

  if (recent_logs.length > 0) {
    lines.push(`3. Check recent daily logs:`);
    for (const log of recent_logs) {
      lines.push(`   - ${log}`);
    }
  }

  lines.push(
    ``,
    `### Memory Rules`,
    `- Write session learnings and progress to today's daily log`,
    `- Update MEMORY.md when you make decisions future sessions need to know`,
    `- Update context/decisions.md for significant architectural or design decisions`,
    `- Update context/gotchas.md for known issues or workarounds discovered`,
    ``,
    `When you finish your work, commit and push your changes.`,
  );

  return lines.join("\n");
}

// ── Find claude binary ──

function claude_binary(): string {
  return process.env["CLAUDE_BIN"] ?? "claude";
}

// ── Implementation ──

export class ClaudeSessionManager extends EventEmitter implements SessionManager {
  private sessions = new Map<string, ActiveSession>();
  private processes = new Map<string, ChildProcess>();
  private output_buffers = new Map<string, string[]>();
  private config: LobsterFarmConfig;

  constructor(config: LobsterFarmConfig) {
    super();
    this.config = config;
  }

  /** Build the full CLI arguments for spawning a claude session. */
  async build_command(options: SessionSpawnOptions): Promise<{ command: string; args: string[] }> {
    const command = claude_binary();
    const agent_name = resolve_agent_name(options.archetype, this.config);
    const is_resume = Boolean(options.resume_session_id);
    const session_id = options.resume_session_id ?? randomUUID();

    const args: string[] = [];

    // Autonomous mode
    args.push("-p");
    args.push("--output-format", "stream-json");
    args.push("--verbose");

    // Agent and model
    args.push("--agent", agent_name);
    args.push(...build_model_flags(options.model));

    // Permissions
    args.push("--permission-mode", "bypassPermissions");

    // Session identity — resume or fresh
    if (is_resume) {
      args.push("--resume", session_id);
    } else {
      args.push("--session-id", session_id);
    }
    args.push("-n", `${options.entity_id}-${options.feature_id}`);

    // Entity context
    const entity_context = await build_entity_context(
      options.entity_id,
      options.feature_id,
      this.config,
    );
    args.push("--append-system-prompt", entity_context);

    // Grant access to entity memory directory
    const ent_dir = entity_dir(this.config.paths, options.entity_id);
    args.push("--add-dir", ent_dir);

    // Prompt is piped via stdin (not positional) to avoid arg parsing issues
    // with --append-system-prompt containing newlines

    return { command, args };
  }

  async spawn(options: SessionSpawnOptions): Promise<ActiveSession> {
    if (options.interactive) {
      throw new Error(
        "Interactive sessions are not yet implemented. " +
          "Coming with Discord integration.",
      );
    }

    const { command, args } = await this.build_command(options);
    // Extract session_id from args — could be --session-id (fresh) or --resume (resumed)
    const fresh_idx = args.indexOf("--session-id");
    const resume_idx = args.indexOf("--resume");
    const session_id_idx = fresh_idx !== -1 ? fresh_idx : resume_idx;
    const session_id = args[session_id_idx + 1]!;

    const is_resume = Boolean(options.resume_session_id);

    const session: ActiveSession = {
      session_id,
      entity_id: options.entity_id,
      feature_id: options.feature_id,
      archetype: options.archetype,
      resume: is_resume,
      started_at: new Date(),
      pid: null,
      tmux_pane: null,
    };

    // Spawn the process — prompt is piped via stdin
    const proc = spawn(command, args, {
      cwd: options.worktree_path,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...options.env },
    });

    // Write prompt to stdin and close it
    if (proc.stdin) {
      proc.stdin.write(options.prompt);
      proc.stdin.end();
    }

    session.pid = proc.pid ?? null;
    this.sessions.set(session_id, session);
    this.processes.set(session_id, proc);
    this.output_buffers.set(session_id, []);

    console.log(
      `[session] Spawned ${options.archetype} session ${session_id} ` +
        `(pid: ${String(session.pid)}) for ${options.entity_id}/${options.feature_id}`,
    );

    this.emit("session:started", session);

    // Capture stdout (stream-json)
    proc.stdout?.on("data", (chunk: Buffer) => {
      const lines = chunk.toString("utf-8").split("\n").filter(Boolean);
      const buffer = this.output_buffers.get(session_id);
      for (const line of lines) {
        buffer?.push(line);
        this.emit("session:output", session_id, line);
      }
    });

    // Capture stderr
    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8").trim();
      if (text) {
        console.log(`[session:${session_id.slice(0, 8)}] stderr: ${text}`);
      }
    });

    // Handle exit
    proc.on("close", (code) => {
      const exit_code = code ?? 1;
      const output = this.output_buffers.get(session_id) ?? [];

      // Clean up
      this.sessions.delete(session_id);
      this.processes.delete(session_id);
      this.output_buffers.delete(session_id);

      console.log(
        `[session] Session ${session_id.slice(0, 8)} exited with code ${String(exit_code)}`,
      );

      if (exit_code === 0) {
        const result: SessionResult = {
          session_id,
          exit_code,
          output_lines: output,
        };
        this.emit("session:completed", result);
      } else {
        this.emit(
          "session:failed",
          session_id,
          `Process exited with code ${String(exit_code)}`,
        );
      }
    });

    // Handle spawn errors
    proc.on("error", (err) => {
      this.sessions.delete(session_id);
      this.processes.delete(session_id);
      this.output_buffers.delete(session_id);

      console.error(`[session] Failed to spawn session ${session_id}:`, err.message);
      this.emit("session:failed", session_id, err.message);
    });

    return session;
  }

  async resume(_session_id: string): Promise<ActiveSession> {
    throw new Error(
      "Session resume is not yet implemented. " +
        "Coming with interactive session support.",
    );
  }

  async kill(session_id: string): Promise<void> {
    const proc = this.processes.get(session_id);
    if (!proc) {
      console.log(`[session] No active process for session ${session_id}`);
      return;
    }

    console.log(`[session] Killing session ${session_id.slice(0, 8)}...`);

    // Try graceful SIGTERM first
    proc.kill("SIGTERM");

    // If still alive after 5s, force kill
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.processes.has(session_id)) {
          proc.kill("SIGKILL");
        }
        resolve();
      }, 5000);

      proc.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  get_active(): ActiveSession[] {
    return [...this.sessions.values()];
  }

  get_by_entity(entity_id: string): ActiveSession[] {
    return this.get_active().filter((s) => s.entity_id === entity_id);
  }

  get_by_feature(feature_id: string): ActiveSession | null {
    return this.get_active().find((s) => s.feature_id === feature_id) ?? null;
  }

  /** Kill all active sessions. Used during daemon shutdown. */
  async kill_all(): Promise<void> {
    const sessions = this.get_active();
    await Promise.all(sessions.map((s) => this.kill(s.session_id)));
  }
}
