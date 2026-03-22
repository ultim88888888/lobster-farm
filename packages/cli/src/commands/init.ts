import { Command } from "commander";
import * as p from "@clack/prompts";
import {
  LobsterFarmConfigSchema,
  TemplateVariablesSchema,
  type LobsterFarmConfig,
  type TemplateVariables,
} from "@lobster-farm/shared";
import { detect_machine, check_sudo, check_onepassword } from "./init/detect.js";
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
  .action(async () => {
    // ── Welcome ──
    p.intro("LobsterFarm — Autonomous Software Consultancy");

    p.note(
      "LobsterFarm runs a team of specialized Claude agents on your machine.\n" +
        "Each agent has a role (planner, designer, builder, operator) and works\n" +
        "autonomously on your projects via a local daemon.\n\n" +
        "This wizard will configure your machine, name your agents, and set up\n" +
        "the directory structure and config files.",
      "Welcome",
    );

    // ── Step 1: User name ──
    const user_name = await prompt_user_name();

    // ── Step 2: Agent names ──
    const agent_names = await prompt_agent_names();

    // ── Step 3: Machine detection ──
    const spin = p.spinner();
    spin.start("Detecting machine info...");
    const machine = detect_machine();
    spin.stop(`Machine: ${machine.name} (${machine.hardware})`);

    // ── Step 4: Sudo check ──
    spin.start("Checking sudo access...");
    const sudo = await check_sudo();
    spin.stop(`Sudo: ${sudo.status}`);

    // ── Step 5: 1Password check ──
    spin.start("Checking 1Password CLI...");
    const op = await check_onepassword();
    spin.stop(`1Password: ${op.status}`);

    // ── Step 6: Discord (optional) ──
    const discord_server_id = await prompt_discord();

    // ── Step 7: GitHub ──
    const github = await prompt_github();

    // ── Step 8: Projects directory ──
    const projects_dir = await prompt_projects_dir();

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
    const config_input: Record<string, unknown> = {
      version: 1,
      paths: { projects_dir },
      user: { name: user_name },
      machine: { name: machine.name, hardware: machine.hardware },
      agents: {
        planner: { name: agent_names.planner },
        designer: { name: agent_names.designer },
        builder: { name: agent_names.builder },
        operator: { name: agent_names.operator },
      },
    };

    if (discord_server_id) {
      config_input["discord"] = { server_id: discord_server_id };
    }

    const config: LobsterFarmConfig = LobsterFarmConfigSchema.parse(config_input);

    // ── Generate everything ──
    spin.start("Creating directory structure...");
    const dirs = await create_directory_structure();
    spin.stop(`Created ${dirs.length} directories`);

    spin.start("Writing configuration files...");
    const config_path = await write_global_config(config);
    const files = await generate_config_files(vars, agent_names);
    const settings_path = await generate_settings();
    spin.stop(`Wrote ${files.length + 2} configuration files`);

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

    if (discord_server_id) {
      summary_lines.push(`Discord:    server ${discord_server_id}`);
    }

    if (github.username) {
      summary_lines.push(`GitHub:     ${github.username}${github.org ? ` (org: ${github.org})` : ""}`);
    }

    p.note(summary_lines.join("\n"), "Setup Complete");

    p.outro(
      "Run `lobsterfarm start` to launch the daemon. Happy building!",
    );
  });
