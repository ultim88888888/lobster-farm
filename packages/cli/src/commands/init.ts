import { Command } from "commander";
import * as p from "@clack/prompts";
import {
  LobsterFarmConfigSchema,
  TemplateVariablesSchema,
  type LobsterFarmConfig,
  type TemplateVariables,
  type PathConfig,
} from "@lobster-farm/shared";
import { detect_machine, check_sudo, check_onepassword, check_claude_code } from "./init/detect.js";
import {
  prompt_user_name,
  prompt_agent_names,
  prompt_discord,
  prompt_github,
  prompt_projects_dir,
} from "./init/prompts.js";
import {
  generate_config_files,
  generate_settings,
  create_directory_structure,
  write_global_config,
} from "./init/generate.js";

export const init_command = new Command("init")
  .description("Initialize LobsterFarm — setup wizard for first-time configuration")
  .option("--prefix <dir>", "Write output to <dir>/.claude/ and <dir>/.lobsterfarm/ instead of ~/")
  .option("--name <name>", "User name (skips interactive prompt)")
  .option("--non-interactive", "Use defaults for all prompts (requires --name)")
  .action(async (options: { prefix?: string; name?: string; nonInteractive?: boolean }) => {
    const prefix = options.prefix;
    const non_interactive = options.nonInteractive ?? false;
    const path_overrides: Partial<PathConfig> | undefined = prefix
      ? {
          lobsterfarm_dir: `${prefix}/.lobsterfarm`,
          claude_dir: `${prefix}/.claude`,
          projects_dir: `${prefix}/projects`,
        }
      : undefined;

    if (prefix) {
      p.log.info(`Using prefix: ${prefix} (files will NOT be written to ~/)`);
    }

    if (non_interactive && !options.name) {
      console.error("Error: --non-interactive requires --name");
      process.exit(1);
    }

    // ── Welcome ──
    p.intro("LobsterFarm — Autonomous Software Consultancy");

    if (!non_interactive) {
      p.note(
        "LobsterFarm runs a team of specialized Claude agents on your machine.\n" +
          "Each agent has a role (planner, designer, builder, operator) and works\n" +
          "autonomously on your projects via a local daemon.\n\n" +
          "This wizard will configure your machine, name your agents, and set up\n" +
          "the directory structure and config files.",
        "Welcome",
      );
    }

    // ── Step 1: User name ──
    const user_name = non_interactive ? options.name! : await prompt_user_name();

    // ── Step 2: Agent names ──
    const agent_names = non_interactive
      ? { planner: "Gary", designer: "Pearl", builder: "Bob", operator: "Ray" }
      : await prompt_agent_names();

    // ── Step 3: Machine detection ──
    const spin = p.spinner();
    spin.start("Detecting machine info...");
    const machine = detect_machine();
    spin.stop(`Machine: ${machine.name} (${machine.hardware})`);

    // ── Step 4: Claude Code check ──
    spin.start("Checking Claude Code...");
    const claude = await check_claude_code();
    spin.stop(`Claude Code: ${claude.status}`);

    if (!claude.installed && !non_interactive) {
      p.log.warning(
        "Claude Code CLI is required for LobsterFarm to function.\n" +
          "Install it from: https://docs.anthropic.com/en/docs/claude-code\n" +
          "Then re-run this setup.",
      );
      const proceed = await p.confirm({ message: "Continue setup anyway?" });
      if (p.isCancel(proceed) || !proceed) {
        p.cancel("Install Claude Code first, then re-run `lobsterfarm init`.");
        process.exit(0);
      }
    }

    // ── Step 5: Sudo check ──
    spin.start("Checking sudo access...");
    const sudo = await check_sudo();
    spin.stop(`Sudo: ${sudo.status}`);

    // ── Step 6: 1Password check ──
    spin.start("Checking 1Password CLI...");
    const op = await check_onepassword();
    spin.stop(`1Password: ${op.status}`);

    // ── Step 7-9: Prompts (skipped in non-interactive mode) ──
    const discord_setup = non_interactive ? undefined : await prompt_discord();
    const github = non_interactive ? { username: "", org: "" } : await prompt_github();
    const projects_dir = non_interactive
      ? (path_overrides?.projects_dir ?? "~/projects")
      : await prompt_projects_dir();

    // ── Build TemplateVariables ──
    const permissions_parts: string[] = [];
    if (sudo.has_passwordless_sudo) permissions_parts.push("sudo");
    if (op.cli_installed && op.token_configured) permissions_parts.push("1password");
    const permissions_status =
      permissions_parts.length > 0
        ? permissions_parts.join(", ") + " configured"
        : "not fully configured";

    const vars: Partial<TemplateVariables> = TemplateVariablesSchema.parse({
      USER_NAME: user_name,
      MACHINE_NAME: machine.name,
      MACHINE_HARDWARE: machine.hardware,
      SUDO_STATUS: sudo.status,
      PERMISSIONS_STATUS: permissions_status,
      PLANNER_NAME: agent_names.planner,
      DESIGNER_NAME: agent_names.designer,
      BUILDER_NAME: agent_names.builder,
      OPERATOR_NAME: agent_names.operator,
      PLANNER_NAME_LOWER: agent_names.planner.toLowerCase(),
      DESIGNER_NAME_LOWER: agent_names.designer.toLowerCase(),
      BUILDER_NAME_LOWER: agent_names.builder.toLowerCase(),
      OPERATOR_NAME_LOWER: agent_names.operator.toLowerCase(),
      PROJECTS_DIR: projects_dir,
      GITHUB_USERNAME: github.username,
      GITHUB_ORG: github.org,
    });

    // ── Build LobsterFarmConfig ──
    const config_paths: Record<string, string> = { projects_dir };
    if (path_overrides?.lobsterfarm_dir) config_paths["lobsterfarm_dir"] = path_overrides.lobsterfarm_dir;
    if (path_overrides?.claude_dir) config_paths["claude_dir"] = path_overrides.claude_dir;

    const config_input: Record<string, unknown> = {
      version: 1,
      paths: config_paths,
      user: { name: user_name },
      machine: { name: machine.name, hardware: machine.hardware },
      agents: {
        planner: { name: agent_names.planner },
        designer: { name: agent_names.designer },
        builder: { name: agent_names.builder },
        operator: { name: agent_names.operator },
      },
    };

    if (discord_setup) {
      config_input["discord"] = { server_id: discord_setup.server_id };
    }

    const config: LobsterFarmConfig = LobsterFarmConfigSchema.parse(config_input);

    // ── Generate everything ──
    spin.start("Creating directory structure...");
    const dirs = await create_directory_structure(path_overrides);
    spin.stop(`Created ${dirs.length} directories`);

    spin.start("Writing configuration files...");
    const config_path = await write_global_config(config, path_overrides);
    const files = await generate_config_files(vars, agent_names, path_overrides);
    const settings_path = await generate_settings(path_overrides);

    // Write .env with secrets (bot token)
    if (discord_setup?.bot_token) {
      const { writeFile, mkdir: mkdirFs } = await import("node:fs/promises");
      const { lobsterfarm_dir: lf_dir } = await import("@lobster-farm/shared");
      const env_dir = lf_dir(path_overrides);
      await mkdirFs(env_dir, { recursive: true });
      const env_path = `${env_dir}/.env`;
      await writeFile(env_path, `DISCORD_BOT_TOKEN=${discord_setup.bot_token}\n`, { mode: 0o600 });
      files.push(env_path);
    }

    spin.stop(`Wrote ${String(files.length + 2)} configuration files`);

    // ── Summary ──
    const summary_lines = [
      `Config:     ${config_path}`,
      `Settings:   ${settings_path}`,
      `Agents:     ${agent_names.planner} (planner), ${agent_names.designer} (designer), ${agent_names.builder} (builder), ${agent_names.operator} (operator)`,
      `Projects:   ${projects_dir}`,
      `Machine:    ${machine.name}`,
      `Sudo:       ${sudo.status}`,
      `1Password:  ${op.status}`,
    ];

    if (discord_setup) {
      summary_lines.push(`Discord:    server ${discord_setup.server_id} (token saved)`);
    }

    if (github.username) {
      summary_lines.push(`GitHub:     ${github.username}${github.org ? ` (org: ${github.org})` : ""}`);
    }

    p.note(summary_lines.join("\n"), "Setup Complete");

    p.outro(
      "Run `lobsterfarm start` to launch the daemon. Happy building!",
    );
  });
