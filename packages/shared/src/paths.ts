import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface PathConfig {
  projects_dir: string;
  lobsterfarm_dir: string;
  claude_dir: string;
}

const DEFAULT_PATHS: PathConfig = {
  projects_dir: "~/projects",
  lobsterfarm_dir: "~/.lobsterfarm",
  claude_dir: "~/.claude",
};

/** Replace leading ~ with the user's home directory. */
export function expand_home(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return join(homedir(), p.slice(1));
  }
  return resolve(p);
}

function paths(config?: Partial<PathConfig>): PathConfig {
  return { ...DEFAULT_PATHS, ...config };
}

// ── Global paths ──

export function lobsterfarm_dir(config?: Partial<PathConfig>): string {
  return expand_home(paths(config).lobsterfarm_dir);
}

export function claude_dir(config?: Partial<PathConfig>): string {
  return expand_home(paths(config).claude_dir);
}

export function projects_dir(config?: Partial<PathConfig>): string {
  return expand_home(paths(config).projects_dir);
}

// ── LobsterFarm subdirectories ──

export function entities_dir(config?: Partial<PathConfig>): string {
  return join(lobsterfarm_dir(config), "entities");
}

export function sop_dir(config?: Partial<PathConfig>): string {
  return join(lobsterfarm_dir(config), "sops");
}

export function queue_dir(config?: Partial<PathConfig>): string {
  return join(lobsterfarm_dir(config), "queue");
}

export function logs_dir(config?: Partial<PathConfig>): string {
  return join(lobsterfarm_dir(config), "logs");
}

export function scripts_dir(config?: Partial<PathConfig>): string {
  return join(lobsterfarm_dir(config), "scripts");
}

export function templates_dir(config?: Partial<PathConfig>): string {
  return join(lobsterfarm_dir(config), "templates");
}

export function dna_versions_dir(config?: Partial<PathConfig>): string {
  return join(lobsterfarm_dir(config), "dna-versions");
}

export function global_config_path(config?: Partial<PathConfig>): string {
  return join(lobsterfarm_dir(config), "config.yaml");
}

export function pid_file_path(config?: Partial<PathConfig>): string {
  return join(lobsterfarm_dir(config), "lobsterfarm.pid");
}

export function daemon_log_path(config?: Partial<PathConfig>): string {
  return join(logs_dir(config), "daemon.log");
}

export function user_md_path(config?: Partial<PathConfig>): string {
  return join(lobsterfarm_dir(config), "user.md");
}

export function tools_md_path(config?: Partial<PathConfig>): string {
  return join(lobsterfarm_dir(config), "tools.md");
}

// ── Claude subdirectories ──

export function agents_dir(config?: Partial<PathConfig>): string {
  return join(claude_dir(config), "agents");
}

export function skills_dir(config?: Partial<PathConfig>): string {
  return join(claude_dir(config), "skills");
}

export function claude_settings_path(config?: Partial<PathConfig>): string {
  return join(claude_dir(config), "settings.json");
}

export function claude_md_path(config?: Partial<PathConfig>): string {
  return join(claude_dir(config), "CLAUDE.md");
}

// ── Per-entity paths ──

export function entity_dir(config: Partial<PathConfig> | undefined, entity_id: string): string {
  return join(entities_dir(config), entity_id);
}

export function entity_config_path(config: Partial<PathConfig> | undefined, entity_id: string): string {
  return join(entity_dir(config, entity_id), "config.yaml");
}

export function entity_memory_path(config: Partial<PathConfig> | undefined, entity_id: string): string {
  return join(entity_dir(config, entity_id), "MEMORY.md");
}

export function entity_daily_dir(config: Partial<PathConfig> | undefined, entity_id: string): string {
  return join(entity_dir(config, entity_id), "daily");
}

export function entity_context_dir(config: Partial<PathConfig> | undefined, entity_id: string): string {
  return join(entity_dir(config, entity_id), "context");
}

export function entity_files_dir(config: Partial<PathConfig> | undefined, entity_id: string): string {
  return join(entity_dir(config, entity_id), "files");
}

export function entity_logs_dir(config: Partial<PathConfig> | undefined, entity_id: string): string {
  return join(logs_dir(config), "entities", entity_id);
}

// ── Per-entity project paths ──

export function entity_repo_path(
  config: Partial<PathConfig> | undefined,
  entity_id: string,
  repo_name: string,
): string {
  return join(projects_dir(config), entity_id, repo_name);
}

export function entity_worktree_path(
  config: Partial<PathConfig> | undefined,
  entity_id: string,
  repo_name: string,
  slug: string,
): string {
  return join(entity_repo_path(config, entity_id, repo_name), "worktrees", slug);
}
