import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ArchetypeRole,
  LobsterFarmConfig,
  EntityConfig,
} from "@lobster-farm/shared";
import {
  entity_memory_path,
  entity_daily_dir,
  expand_home,
} from "@lobster-farm/shared";

export interface CompiledContext {
  worktree_path: string;
  claude_md_content: string;
  memory_path: string;
  daily_log_paths: string[];
  archetype: string;
  dna: string[];
}

function format_date(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Compile the context needed before spawning a Claude Code session.
 *
 * Resolves entity memory path, daily log paths, and reads the project CLAUDE.md.
 */
export async function compile_context(options: {
  entity_id: string;
  feature_id: string;
  github_issue: number;
  archetype: ArchetypeRole;
  dna: string[];
  config: LobsterFarmConfig;
  entity_config: EntityConfig;
}): Promise<CompiledContext> {
  const { entity_id, archetype, dna, config, entity_config } = options;

  // Resolve entity memory path
  const memory_path = entity_memory_path(config.paths, entity_id);

  // Resolve daily log dir and find today's and yesterday's log files
  const daily_dir = entity_daily_dir(config.paths, entity_id);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const today_log = join(daily_dir, `${format_date(today)}.md`);
  const yesterday_log = join(daily_dir, `${format_date(yesterday)}.md`);
  const daily_log_paths = [today_log, yesterday_log];

  // Read project CLAUDE.md from repo root
  const repo_path = expand_home(entity_config.entity.repos[0]?.path ?? ".");
  const claude_md_file = join(repo_path, "CLAUDE.md");
  let claude_md_content: string;
  try {
    claude_md_content = await readFile(claude_md_file, "utf-8");
  } catch {
    claude_md_content = `# CLAUDE.md not found\n\nNo CLAUDE.md found at ${claude_md_file}. This file should be created in the repository root.`;
  }

  // The worktree_path would normally be created by the session manager,
  // but for context compilation we compute what it would be.
  const worktree_path = repo_path;

  return {
    worktree_path,
    claude_md_content,
    memory_path,
    daily_log_paths,
    archetype,
    dna,
  };
}
