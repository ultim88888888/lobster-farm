import { statSync } from "node:fs";
import { mkdir, readdir, copyFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  write_resolved,
  write_yaml,
  lobsterfarm_dir,
  agents_dir,
  skills_dir,
  claude_settings_path,
  claude_md_path,
  user_md_path,
  tools_md_path,
  entities_dir,
  sop_dir,
  queue_dir,
  logs_dir,
  scripts_dir,
  templates_dir,
  dna_versions_dir,
  global_config_path,
  type LobsterFarmConfig,
  type TemplateVariables,
  type PathConfig,
} from "@lobster-farm/shared";

/** Resolve the monorepo config/ directory from the CLI source location. */
function config_templates_dir(): string {
  const this_file = fileURLToPath(import.meta.url);
  // Walk up from the current file until we find a directory containing config/
  let dir = dirname(this_file);
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, "config");
    try {
      if (statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      // not found at this level, keep going up
    }
    dir = dirname(dir);
  }
  throw new Error(
    "Could not locate config/ directory in the monorepo. " +
      "Make sure you're running from the lobster-farm monorepo.",
  );
}

/** Agent archetype role to template filename mapping. */
const AGENT_TEMPLATE_MAP: Record<string, string> = {
  planner: "planner.md",
  designer: "designer.md",
  builder: "builder.md",
  operator: "operator.md",
  commander: "commander.md",
};

/**
 * Generate all configuration files from templates.
 *
 * Writes to ~/.lobsterfarm/ and ~/.claude/ using the provided template variables.
 */
export async function generate_config_files(
  vars: Partial<TemplateVariables>,
  agent_names: Record<"planner" | "designer" | "builder" | "operator", string>,
  path_overrides?: Partial<PathConfig>,
): Promise<string[]> {
  const created: string[] = [];
  const config_dir = config_templates_dir();

  // ── ~/.claude/CLAUDE.md ──
  const claude_template = join(config_dir, "claude", "CLAUDE.md");
  const claude_out = claude_md_path(path_overrides);
  await write_resolved(claude_template, claude_out, vars);
  created.push(claude_out);

  // ── ~/.lobsterfarm/user.md ──
  const user_template = join(config_dir, "lobsterfarm", "user.md");
  const user_out = user_md_path(path_overrides);
  await write_resolved(user_template, user_out, vars);
  created.push(user_out);

  // ── ~/.lobsterfarm/tools.md ──
  const tools_template = join(config_dir, "lobsterfarm", "tools.md");
  const tools_out = tools_md_path(path_overrides);
  await write_resolved(tools_template, tools_out, vars);
  created.push(tools_out);

  // ── Agent files: rename based on user-chosen names ──
  for (const [role, template_file] of Object.entries(AGENT_TEMPLATE_MAP)) {
    const name = agent_names[role as keyof typeof agent_names];
    const agent_template = join(config_dir, "claude", "agents", template_file);
    const output_filename = `${name.toLowerCase()}.md`;
    const agent_out = join(agents_dir(path_overrides), output_filename);
    await write_resolved(agent_template, agent_out, vars);
    created.push(agent_out);
  }

  // ── Reviewer agent (not renamed — always "reviewer") ──
  const reviewer_template = join(config_dir, "claude", "agents", "reviewer.md");
  const reviewer_out = join(agents_dir(path_overrides), "reviewer.md");
  await write_resolved(reviewer_template, reviewer_out, vars);
  created.push(reviewer_out);

  // ── Skills: copy all skill directories ──
  const skills_src = join(config_dir, "claude", "skills");
  try {
    const skill_dirs = await readdir(skills_src, { withFileTypes: true });
    for (const entry of skill_dirs) {
      if (!entry.isDirectory()) continue;
      const skill_name = entry.name;
      const src_skill_file = join(skills_src, skill_name, "SKILL.md");
      const dest_skill_dir = join(skills_dir(path_overrides), skill_name);
      const dest_skill_file = join(dest_skill_dir, "SKILL.md");
      await mkdir(dest_skill_dir, { recursive: true });
      await copyFile(src_skill_file, dest_skill_file);
      created.push(dest_skill_file);
    }
  } catch {
    // skills directory might not exist — not fatal
  }

  return created;
}

/** Generate the ~/.claude/settings.json with bypass permissions and hooks. */
export async function generate_settings(path_overrides?: Partial<PathConfig>): Promise<string> {
  const settings = {
    permissions: {
      bypassPermissions: true,
    },
    hooks: {
      PreToolUse: [
        {
          matcher: "Edit|Write",
          hooks: [{
            type: "command",
            command: 'bash -c \'BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null); if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then echo "BLOCK: Direct edits to $BRANCH are not allowed. Create a feature branch first." >&2; exit 2; fi\'',
          }],
        },
        {
          matcher: "Edit|Write",
          hooks: [{
            type: "command",
            command: "bash -c 'if echo \"$TOOL_INPUT\" | grep -qiE \"(sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36,}|AKIA[A-Z0-9]{16}|xox[bpras]-[a-zA-Z0-9-]+|-----BEGIN (RSA |EC |DSA )?PRIVATE KEY-----)\"; then echo \"BLOCK: Detected potential hardcoded secret in tool input.\" >&2; exit 2; fi'",
          }],
        },
      ],
      Stop: [
        {
          matcher: "",
          hooks: [{
            type: "command",
            command: "curl -s -X POST http://localhost:7749/hooks/stop -H 'Content-Type: application/json' -d '{\"session_id\": \"'\"$CLAUDE_SESSION_ID\"'\", \"working_dir\": \"'\"$(pwd)\"'\"}' || true",
            timeout: 10,
          }],
        },
      ],
    },
  };

  const out = claude_settings_path(path_overrides);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  return out;
}

/** Create the directory structure under ~/.lobsterfarm/. */
export async function create_directory_structure(path_overrides?: Partial<PathConfig>): Promise<string[]> {
  const dirs = [
    lobsterfarm_dir(path_overrides),
    entities_dir(path_overrides),
    sop_dir(path_overrides),
    queue_dir(path_overrides),
    logs_dir(path_overrides),
    scripts_dir(path_overrides),
    templates_dir(path_overrides),
    dna_versions_dir(path_overrides),
    agents_dir(path_overrides),
    skills_dir(path_overrides),
  ];

  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
  }

  return dirs;
}

/** Write the global config.yaml. */
export async function write_global_config(
  config: LobsterFarmConfig,
  path_overrides?: Partial<PathConfig>,
): Promise<string> {
  const out = global_config_path(path_overrides);
  await write_yaml(out, config);
  return out;
}
