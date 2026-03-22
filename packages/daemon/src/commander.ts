import { execFile } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import type { EntityRegistry } from "./registry.js";
import type { FeatureManager } from "./features.js";
import type { TaskQueue } from "./queue.js";
import type { DiscordBot } from "./discord.js";

const exec = promisify(execFile);

const COMMANDER_PROMPT = `You are the LobsterFarm Commander — the admin agent for an autonomous orchestration platform.

You manage the system through natural conversation. When the user asks you to do something, you respond conversationally AND include action directives that the system will execute.

## What you can do

### Entity Management
- Create entities: ACTION:SCAFFOLD_ENTITY:id:name:repo_url
- List entities: ACTION:LIST_ENTITIES

### Feature Management
- Create features: ACTION:CREATE_FEATURE:entity_id:title:github_issue_number
- Approve features: ACTION:APPROVE:feature_id
- Advance features: ACTION:ADVANCE:feature_id
- List features: ACTION:LIST_FEATURES

### System
- Show status: ACTION:STATUS

## Current System State
{system_state}

## Rules
- Be conversational and helpful. You're a partner, not a command parser.
- Ask clarifying questions when the request is ambiguous.
- When you need info (like entity ID or repo URL), ask for it naturally.
- Include ACTION directives on their own lines when you want to execute something.
- If no action is needed (just conversation), don't include any ACTION lines.
- Keep responses concise.
- Entity IDs must be lowercase with hyphens only.
- Generate reasonable defaults when you can (e.g., entity ID from the name).`;

function build_system_state(
  registry: EntityRegistry,
  features: FeatureManager,
  queue: TaskQueue,
): string {
  const entities = registry.get_all();
  const all_features = features.list_features();
  const stats = queue.get_stats();

  const lines: string[] = [];
  lines.push(`Entities: ${String(entities.length)}`);
  for (const e of entities) {
    lines.push(`  - ${e.entity.id}: ${e.entity.name} (${e.entity.status})`);
  }
  lines.push(`Features: ${String(all_features.length)}`);
  for (const f of all_features) {
    lines.push(`  - ${f.id}: ${f.title} [${f.phase}]${f.blocked ? " BLOCKED" : ""}`);
  }
  lines.push(`Queue: ${String(stats.active)} active, ${String(stats.pending)} pending`);

  return lines.join("\n");
}

export interface CommanderResult {
  response: string;
  actions: string[];
}

/** Send a message to the Commander (Opus) and get a response with optional actions. */
export async function ask_commander(
  message: string,
  config: LobsterFarmConfig,
  registry: EntityRegistry,
  features: FeatureManager,
  queue: TaskQueue,
): Promise<CommanderResult> {
  const system_state = build_system_state(registry, features, queue);
  const system_prompt = COMMANDER_PROMPT.replace("{system_state}", system_state);

  const claude_bin = process.env["CLAUDE_BIN"] ?? "claude";

  // Write system prompt to temp file (avoids shell escaping issues with long prompts)
  const prompt_file = join(tmpdir(), `lf-commander-${Date.now()}.txt`);
  await writeFile(prompt_file, system_prompt, "utf-8");

  try {
    const { stdout } = await exec(claude_bin, [
      "-p",
      "--model", "claude-opus-4-6",
      "--no-session-persistence",
      "--system-prompt-file", prompt_file,
      "--print",
      message,
    ], { timeout: 120_000, maxBuffer: 1024 * 1024 });

    const full_response = stdout.trim();

    // Extract ACTION lines
    const lines = full_response.split("\n");
    const actions: string[] = [];
    const response_lines: string[] = [];

    for (const line of lines) {
      if (line.trim().startsWith("ACTION:")) {
        actions.push(line.trim());
      } else {
        response_lines.push(line);
      }
    }

    return {
      response: response_lines.join("\n").trim(),
      actions,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      response: `Commander error: ${msg}`,
      actions: [],
    };
  } finally {
    await unlink(prompt_file).catch(() => {});
  }
}

/** Execute a Commander action directive. Returns a status message. */
export async function execute_action(
  action: string,
  registry: EntityRegistry,
  features: FeatureManager,
  discord: DiscordBot | null,
): Promise<string> {
  const parts = action.replace("ACTION:", "").split(":");

  switch (parts[0]) {
    case "SCAFFOLD_ENTITY": {
      const id = parts[1];
      const name = parts[2] ?? id;
      const repo = parts[3] ?? `git@github.com:org/${id ?? "unknown"}.git`;

      if (!id) return "Error: entity ID required";
      if (!discord) return "Error: Discord not connected — cannot scaffold channels";

      // This calls the full scaffold method on the discord bot
      const channels = await discord.scaffold_entity(id, name);

      // Create entity config + directories (same as !lf scaffold entity)
      // Import needed functions
      const {
        entity_dir, entity_daily_dir, entity_context_dir, entity_files_dir,
        entity_config_path, entity_memory_path, write_yaml,
      } = await import("@lobster-farm/shared");
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");

      const config = discord["config"] as LobsterFarmConfig;
      const paths = config.paths;

      const dirs = [
        entity_dir(paths, id), entity_daily_dir(paths, id),
        entity_context_dir(paths, id), entity_files_dir(paths, id),
      ];
      for (const dir of dirs) await mkdir(dir, { recursive: true });

      const entity_config = {
        entity: {
          id, name, description: "", status: "active",
          repo: { url: repo, path: `~/entities/${id}/${id}`, structure: "monorepo" },
          accounts: {}, channels, agent_mode: "hybrid", models: {},
          budget: { monthly_warning_pct: 80, monthly_limit: null },
          memory: { path: entity_dir(paths, id), auto_extract: true },
          active_sops: ["feature-lifecycle", "pr-review-merge", "secrets-management", "readme-maintenance"],
          secrets: { vault: "1password", vault_name: `entity-${id}` },
        },
      };

      await write_yaml(entity_config_path(paths, id), entity_config);
      const mem = entity_memory_path(paths, id);
      await writeFile(mem, `# ${name} — Memory\n\n_Curated project knowledge._\n`, "utf-8");
      await writeFile(join(entity_context_dir(paths, id), "decisions.md"), `# ${name} — Decision Log\n`, "utf-8");
      await writeFile(join(entity_context_dir(paths, id), "gotchas.md"), `# ${name} — Gotchas\n`, "utf-8");

      await registry.load_all();
      return `Entity **${id}** scaffolded with ${String(channels.length)} Discord channels.`;
    }

    case "LIST_ENTITIES": {
      const entities = registry.get_all();
      if (entities.length === 0) return "No entities configured.";
      return entities.map((e) => `• **${e.entity.id}** — ${e.entity.name} (${e.entity.status})`).join("\n");
    }

    case "CREATE_FEATURE": {
      const entity_id = parts[1];
      const title = parts[2];
      const issue = parseInt(parts[3] ?? String(Date.now() % 10000), 10);
      if (!entity_id || !title) return "Error: need entity_id and title";
      try {
        const feature = features.create_feature({ entity_id, title, github_issue: issue });
        return `Feature **${feature.id}** created: "${title}" (phase: plan)`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case "APPROVE": {
      const fid = parts[1];
      if (!fid) return "Error: feature ID required";
      try {
        features.approve_phase(fid);
        return `Phase approved for **${fid}**.`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case "ADVANCE": {
      const fid = parts[1];
      if (!fid) return "Error: feature ID required";
      try {
        const f = await features.advance_feature(fid);
        return `**${fid}** advanced to **${f.phase}** phase.`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case "LIST_FEATURES": {
      const all = features.list_features();
      if (all.length === 0) return "No features.";
      return all.map((f) => `• **${f.id}** — ${f.title} [${f.phase}]${f.blocked ? " BLOCKED" : ""}`).join("\n");
    }

    case "STATUS": {
      return "Use `!lf status` for full status.";
    }

    default:
      return `Unknown action: ${parts[0] ?? "empty"}`;
  }
}
