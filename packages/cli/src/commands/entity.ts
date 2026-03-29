import { Command } from "commander";
import * as p from "@clack/prompts";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type PathConfig,
  entity_dir,
  entity_daily_dir,
  entity_context_dir,
  entity_files_dir,
  entity_config_path,
  entity_memory_path,
  write_yaml,
} from "@lobster-farm/shared";
import { readdir } from "node:fs/promises";
import { parse } from "yaml";
import { readFile } from "node:fs/promises";

export const entity_command = new Command("entity")
  .description("Manage LobsterFarm entities");

entity_command
  .command("list")
  .description("List all configured entities")
  .option("--prefix <dir>", "Use a custom prefix directory instead of ~/")
  .action(async (options: { prefix?: string }) => {
    // Simpler: just scan the entities directory
    const entities_base = join(
      options.prefix ? `${options.prefix}/.lobsterfarm` : `${process.env["HOME"] ?? "~"}/.lobsterfarm`,
      "entities",
    );

    try {
      const entries = await readdir(entities_base, { withFileTypes: true });
      const entities: Array<{ id: string; name: string; status: string }> = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const config_file = join(entities_base, entry.name, "config.yaml");
        try {
          const content = await readFile(config_file, "utf-8");
          const data = parse(content) as { entity?: { id?: string; name?: string; status?: string } };
          entities.push({
            id: data.entity?.id ?? entry.name,
            name: data.entity?.name ?? "Unknown",
            status: data.entity?.status ?? "unknown",
          });
        } catch {
          entities.push({ id: entry.name, name: "(invalid config)", status: "error" });
        }
      }

      if (entities.length === 0) {
        console.log("No entities configured. Create one with: lobsterfarm entity create");
        return;
      }

      console.log("Entities:");
      for (const e of entities) {
        const status_icon = e.status === "active" ? "●" : e.status === "paused" ? "◌" : "○";
        console.log(`  ${status_icon} ${e.id} — ${e.name} (${e.status})`);
      }
    } catch {
      console.log("No entities directory found. Run `lobsterfarm init` first.");
    }
  });

entity_command
  .command("create")
  .description("Create a new entity (project)")
  .option("--prefix <dir>", "Use a custom prefix directory instead of ~/")
  .option("--id <id>", "Entity ID (non-interactive)")
  .option("--name <name>", "Display name (non-interactive)")
  .option("--repo-url <url>", "Git repo URL (non-interactive)")
  .option("--non-interactive", "Skip prompts, use provided flags")
  .action(async (options: { prefix?: string; id?: string; name?: string; repoUrl?: string; nonInteractive?: boolean }) => {
    const prefix = options.prefix;
    const ni = options.nonInteractive ?? false;
    const path_overrides: Partial<PathConfig> | undefined = prefix
      ? {
          lobsterfarm_dir: `${prefix}/.lobsterfarm`,
          claude_dir: `${prefix}/.claude`,
          projects_dir: `${prefix}/projects`,
        }
      : undefined;

    if (ni && (!options.id || !options.name || !options.repoUrl)) {
      console.error("Error: --non-interactive requires --id, --name, and --repo-url");
      process.exit(1);
    }

    p.intro("Create a new LobsterFarm entity");

    // Entity ID
    let entity_id: string;
    let entity_name: string;
    let description: string;
    let repo_url: string;
    let repo_path: string;
    let github_org: string;
    let setup_discord_flag: boolean;

    if (ni) {
      entity_id = options.id!;
      entity_name = options.name!;
      description = "";
      repo_url = options.repoUrl!;
      repo_path = `~/projects/${entity_id}/${entity_id}`;
      github_org = "";
      setup_discord_flag = false;
    } else {
    const id_result = await p.text({
      message: "Entity ID (lowercase, hyphens only)",
      placeholder: "my-project",
      validate: (value) => {
        if (!value) return "Required";
        if (!/^[a-z0-9-]+$/.test(value)) return "Must be lowercase alphanumeric with hyphens";
        return undefined;
      },
    });
    if (p.isCancel(id_result)) { p.cancel("Cancelled"); process.exit(0); }
    entity_id = id_result;

    const name_result = await p.text({
      message: "Display name",
      placeholder: "My Project",
    });
    if (p.isCancel(name_result)) { p.cancel("Cancelled"); process.exit(0); }
    entity_name = name_result;

    const desc_result = await p.text({
      message: "Description (optional)",
      placeholder: "A brief description of this project",
      defaultValue: "",
    });
    if (p.isCancel(desc_result)) { p.cancel("Cancelled"); process.exit(0); }
    description = desc_result;

    const repo_result = await p.text({
      message: "Git repo URL",
      placeholder: "git@github.com:org/repo.git",
    });
    if (p.isCancel(repo_result)) { p.cancel("Cancelled"); process.exit(0); }
    repo_url = repo_result;

    const default_path = `~/projects/${entity_id}/${entity_id}`;
    const path_result = await p.text({
      message: "Local repo path",
      placeholder: default_path,
      defaultValue: default_path,
    });
    if (p.isCancel(path_result)) { p.cancel("Cancelled"); process.exit(0); }
    repo_path = path_result;

    const github_org_result = await p.text({
      message: "GitHub org/username for this entity (optional)",
      placeholder: "my-org",
      defaultValue: "",
    });
    if (p.isCancel(github_org_result)) { p.cancel("Cancelled"); process.exit(0); }
    github_org = github_org_result;

    const setup_discord_result = await p.confirm({
      message: "Configure Discord channels for this entity?",
      initialValue: false,
    });
    if (p.isCancel(setup_discord_result)) { p.cancel("Cancelled"); process.exit(0); }
    setup_discord_flag = setup_discord_result;
    } // end interactive block

    interface DiscordChannel {
      type: string;
      id: string;
      purpose?: string;
    }
    const channels: DiscordChannel[] = [];

    if (setup_discord_flag) {
      // Work rooms are created on demand via /room slash command
      const channel_types = [
        { type: "general", purpose: "Entity-level discussion" },
        { type: "alerts", purpose: "Approvals, blockers, questions" },
      ];

      for (const ch of channel_types) {
        const ch_id = await p.text({
          message: `Discord channel ID for ${ch.purpose} (${ch.type})`,
          placeholder: "Discord channel ID",
        });
        if (p.isCancel(ch_id)) { p.cancel("Cancelled"); process.exit(0); }
        if (ch_id) {
          channels.push({ type: ch.type, id: ch_id, purpose: ch.purpose });
        }
      }
    }

    // Build entity config
    const entity_config = {
      entity: {
        id: entity_id,
        name: entity_name,
        description: description || "",
        status: "active",
        blueprint: "software",
        repos: [{
          name: entity_id,
          url: repo_url,
          path: repo_path,
          structure: "monorepo",
        }],
        accounts: {
          ...(github_org ? { github: { org: github_org } } : {}),
        },
        channels: {
          category_id: "",
          list: channels,
        },
        memory: {
          path: entity_dir(path_overrides, entity_id),
          auto_extract: true,
        },
        secrets: {
          vault: "1password",
          vault_name: `entity-${entity_id}`,
        },
      },
    };

    // Create directory structure
    const spin = p.spinner();
    spin.start("Creating entity directories...");

    const dirs = [
      entity_dir(path_overrides, entity_id),
      entity_daily_dir(path_overrides, entity_id),
      entity_context_dir(path_overrides, entity_id),
      entity_files_dir(path_overrides, entity_id),
    ];
    for (const dir of dirs) {
      await mkdir(dir, { recursive: true });
    }
    spin.stop(`Created ${String(dirs.length)} directories`);

    // Write config
    spin.start("Writing entity config...");
    const config_path = entity_config_path(path_overrides, entity_id);
    await write_yaml(config_path, entity_config);
    spin.stop(`Config: ${config_path}`);

    // Create MEMORY.md
    const mem_path = entity_memory_path(path_overrides, entity_id);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      mem_path,
      `# ${entity_name} — Memory\n\n_Curated project knowledge. Updated by agents, reviewed periodically._\n`,
      "utf-8",
    );

    // Create context/ files
    const ctx_dir = entity_context_dir(path_overrides, entity_id);
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

    // Create entity CLAUDE.md template (to be placed in repo root)
    const entity_claude_md = [
      `# ${entity_name}`,
      ``,
      `_Project context for Claude Code agents. This file is auto-loaded by Claude Code._`,
      ``,
      `## Project`,
      ``,
      `- **Entity:** ${entity_id}`,
      `- **Description:** ${description || "TODO: Add project description"}`,
      `- **Repo:** ${repo_url}`,
      ``,
      `## Tech Stack`,
      ``,
      `TODO: Document the tech stack (languages, frameworks, databases, etc.)`,
      ``,
      `## Build & Run`,
      ``,
      `\`\`\`bash`,
      `# TODO: Add build/run/test commands`,
      `\`\`\``,
      ``,
      `## Memory`,
      ``,
      `- **MEMORY.md:** ${mem_path}`,
      `- **Daily logs:** ${entity_daily_dir(path_overrides, entity_id)}/`,
      `- **Context docs:** ${ctx_dir}/`,
      ``,
      `Read MEMORY.md at the start of every session for accumulated project knowledge.`,
      `Check daily logs for recent session context.`,
      `Read context/decisions.md and context/gotchas.md for architectural context.`,
      ``,
      `## Conventions`,
      ``,
      `_Document any project-specific conventions that differ from global DNA here._`,
      ``,
    ].join("\n");

    const claude_md_output = join(entity_dir(path_overrides, entity_id), "CLAUDE.md.template");
    await writeFile(claude_md_output, entity_claude_md, "utf-8");

    // Summary
    p.note(
      [
        `ID:          ${entity_id}`,
        `Name:        ${entity_name}`,
        `Config:      ${config_path}`,
        `Memory:      ${mem_path}`,
        `Repo:        ${repo_url}`,
        `Local path:  ${repo_path}`,
        channels.length > 0 ? `Discord:     ${String(channels.length)} channels configured` : "Discord:     not configured",
      ].join("\n"),
      "Entity Created",
    );

    p.outro(`Entity "${entity_id}" is ready. The daemon will pick it up on next restart (or reload).`);
  });
