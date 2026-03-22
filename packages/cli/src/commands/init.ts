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
      const install_it = await p.confirm({
        message: "Claude Code is required but not installed. Install it now?",
        initialValue: true,
      });
      if (p.isCancel(install_it)) { p.cancel("Setup cancelled."); process.exit(0); }

      if (install_it) {
        spin.start("Installing Claude Code...");
        const { exec_command } = await import("../lib/process.js");
        // Use Claude's official install script
        const result = await exec_command("curl -fsSL https://claude.ai/install.sh | bash");
        if (result.exitCode === 0) {
          // Add ~/.local/bin to PATH for this session
          const home = process.env["HOME"] ?? "";
          process.env["PATH"] = `${home}/.local/bin:${process.env["PATH"] ?? ""}`;
          spin.stop("Claude Code installed successfully");
        } else {
          spin.stop("Claude Code installation failed");
          p.log.warning(`Install manually: curl -fsSL https://claude.ai/install.sh | bash\n${result.stderr}`);
        }
      } else {
        p.log.warning("Continuing without Claude Code. Install it before starting the daemon.");
      }
    }

    // ── Step 5: Sudo check ──
    spin.start("Checking sudo access...");
    const sudo = await check_sudo();
    spin.stop(`Sudo: ${sudo.status}`);

    if (!sudo.has_passwordless_sudo && !non_interactive) {
      const setup_sudo = await p.confirm({
        message: "Set up passwordless sudo? (adds NOPASSWD to sudoers)",
        initialValue: true,
      });
      if (p.isCancel(setup_sudo)) { p.cancel("Setup cancelled."); process.exit(0); }

      if (setup_sudo) {
        const user = process.env["USER"] ?? "unknown";
        p.log.info(`Enter your password when prompted to configure sudo for "${user}"...`);

        // Use spawnSync with inherited stdio so the password prompt is visible
        const { spawnSync } = await import("node:child_process");
        const result = spawnSync("sudo", ["sh", "-c", `echo '${user} ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/lobsterfarm`], {
          stdio: "inherit",
        });

        if (result.status === 0) {
          sudo.has_passwordless_sudo = true;
          sudo.status = "passwordless sudo configured";
          p.log.success("Passwordless sudo configured");
        } else {
          p.log.warning("Sudo setup failed — configure manually");
        }
      }
    }

    // ── Step 6: 1Password check ──
    spin.start("Checking 1Password CLI...");
    const op = await check_onepassword();
    spin.stop(`1Password: ${op.status}`);

    if (!op.cli_installed && !non_interactive) {
      const install_op = await p.confirm({
        message: "Install 1Password CLI? (via Homebrew)",
        initialValue: true,
      });
      if (p.isCancel(install_op)) { p.cancel("Setup cancelled."); process.exit(0); }

      if (install_op) {
        spin.start("Installing 1Password CLI...");
        const { exec_command } = await import("../lib/process.js");
        const result = await exec_command("brew install --cask 1password-cli");
        if (result.exitCode === 0) {
          op.cli_installed = true;
          op.status = "op CLI installed";
          spin.stop("1Password CLI installed");
        } else {
          spin.stop("1Password CLI installation failed");
          p.log.warning("Install manually: brew install --cask 1password-cli");
        }
      }
    }

    if (op.cli_installed && !op.token_configured && !non_interactive) {
      p.note(
        "Create a service account at https://my.1password.com → Developer → Service Accounts\n\n" +
          "Grant it:\n" +
          "  • Create and manage vaults (each entity gets its own vault)\n" +
          "  • Read/write access to a master \"lobsterfarm\" vault for shared credentials",
        "1Password Setup",
      );

      const op_token = await p.password({
        message: "1Password service account token (or press Enter to skip):",
      });
      if (p.isCancel(op_token)) { p.cancel("Setup cancelled."); process.exit(0); }

      if (op_token && op_token.trim()) {
        const { appendFile } = await import("node:fs/promises");
        const home = process.env["HOME"] ?? "";
        await appendFile(`${home}/.zshrc`, `\nexport OP_SERVICE_ACCOUNT_TOKEN="${op_token.trim()}"\n`);
        process.env["OP_SERVICE_ACCOUNT_TOKEN"] = op_token.trim();
        op.token_configured = true;
        op.status = "op CLI installed, service account token configured";
        p.log.success("1Password token saved to ~/.zshrc");
      }
    }

    // ── Step 7: macOS Full Disk Access ──
    if (machine.platform === "darwin" && !non_interactive) {
      const { exec_command } = await import("../lib/process.js");
      const { spawnSync } = await import("node:child_process");
      const fda_check = await exec_command("ls ~/Library/Mail/ 2>&1");
      const likely_missing = fda_check.exitCode !== 0 && fda_check.stderr.includes("Operation not permitted");

      if (likely_missing) {
        const setup_fda = await p.confirm({
          message: "Full Disk Access is needed for Terminal, node, and tmux. Attempt to configure?",
          initialValue: true,
        });
        if (p.isCancel(setup_fda)) { p.cancel("Setup cancelled."); process.exit(0); }

        if (setup_fda) {
          // Find paths to the apps we need to grant FDA
          const apps_to_grant = [
            { name: "Terminal", bundle: "com.apple.Terminal" },
            { name: "node", path: null as string | null },
            { name: "tmux", path: null as string | null },
          ];

          // Resolve node and tmux paths
          const node_which = await exec_command("which node");
          if (node_which.exitCode === 0) apps_to_grant[1]!.path = node_which.stdout.trim();
          const tmux_which = await exec_command("which tmux");
          if (tmux_which.exitCode === 0) apps_to_grant[2]!.path = tmux_which.stdout.trim();

          // Attempt TCC database modification (requires sudo)
          spin.start("Attempting to grant Full Disk Access via TCC database...");
          const tcc_db = "/Library/Application Support/com.apple.TCC/TCC.db";
          let tcc_success = true;

          // Grant Terminal by bundle ID
          const terminal_result = spawnSync("sudo", [
            "sqlite3", tcc_db,
            `INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version) VALUES ('kTCCServiceSystemPolicyAllFiles', 'com.apple.Terminal', 0, 2, 4, 1);`,
          ], { stdio: "inherit" });

          if (terminal_result.status !== 0) {
            tcc_success = false;
          }

          // Grant node and tmux by path
          for (const app of apps_to_grant.slice(1)) {
            if (!app.path) continue;
            const result = spawnSync("sudo", [
              "sqlite3", tcc_db,
              `INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version) VALUES ('kTCCServiceSystemPolicyAllFiles', '${app.path}', 1, 2, 4, 1);`,
            ], { stdio: "inherit" });
            if (result.status !== 0) {
              tcc_success = false;
            }
          }

          if (tcc_success) {
            spin.stop("Full Disk Access granted via TCC database");
          } else {
            spin.stop("TCC database method failed — opening System Settings");
            p.log.info("Manually enable Full Disk Access for Terminal, node, and tmux.");

            // Fallback: open System Settings to the right page
            spawnSync("open", [
              "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
            ]);

            const node_path = apps_to_grant[1]?.path ?? "not found";
            const tmux_path = apps_to_grant[2]?.path ?? "not installed";
            p.note(
              "System Settings has been opened to Full Disk Access.\n\n" +
                "Click the + button and add:\n" +
                `  • Terminal (should be listed)\n` +
                `  • node: ${node_path}\n` +
                `  • tmux: ${tmux_path}\n\n` +
                "Tip: In the file picker, press Cmd+Shift+G to type a path directly.",
              "Manual Setup Required",
            );

            const ack = await p.confirm({ message: "Done configuring Full Disk Access?" });
            if (p.isCancel(ack)) { p.cancel("Setup cancelled."); process.exit(0); }
          }
        }
      }
    }

    // ── Step 8-10: Prompts (skipped in non-interactive mode) ──
    const discord_setup = non_interactive ? undefined : await prompt_discord();
    const github = non_interactive ? { username: "" } : await prompt_github();
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
      GITHUB_ORG: "",
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
      summary_lines.push(`GitHub:     ${github.username}`);
    }

    p.note(summary_lines.join("\n"), "Setup Complete");

    p.outro(
      "Run `lobsterfarm start` to launch the daemon. Happy building!",
    );
  });
