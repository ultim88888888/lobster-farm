import { Command } from "commander";
import * as p from "@clack/prompts";
import {
  LobsterFarmConfigSchema,
  TemplateVariablesSchema,
  type LobsterFarmConfig,
  type TemplateVariables,
  type PathConfig,
} from "@lobster-farm/shared";
import { detect_machine, check_sudo, check_onepassword, check_claude_code, check_bun, check_tmux, check_github_cli } from "./init/detect.js";
import { setup_tool_integrations } from "./init/tools.js";
import {
  prompt_user_name,
  prompt_agent_names,
  prompt_discord,
  prompt_github,
  // prompt_projects_dir removed — always defaults to ~/entities
} from "./init/prompts.js";
import {
  generate_config_files,
  generate_settings,
  create_directory_structure,
  write_global_config,
} from "./init/generate.js";

async function prompt_and_save_op_token(_path_overrides?: Partial<PathConfig>): Promise<void> {
  const op_token = await p.password({
    message: "1Password service account token (or press Enter to skip):",
  });
  if (p.isCancel(op_token)) { p.cancel("Setup cancelled."); process.exit(0); }

  if (op_token && op_token.trim()) {
    const { readFile, writeFile: writeF } = await import("node:fs/promises");
    const home = process.env["HOME"] ?? "";
    const zshrc_path = `${home}/.zshrc`;
    try {
      let content = await readFile(zshrc_path, "utf-8");
      if (content.includes("OP_SERVICE_ACCOUNT_TOKEN")) {
        content = content.replace(/export OP_SERVICE_ACCOUNT_TOKEN="[^"]*"/g, `export OP_SERVICE_ACCOUNT_TOKEN="${op_token.trim()}"`);
      } else {
        content += `\nexport OP_SERVICE_ACCOUNT_TOKEN="${op_token.trim()}"\n`;
      }
      await writeF(zshrc_path, content);
    } catch {
      const { appendFile } = await import("node:fs/promises");
      await appendFile(zshrc_path, `\nexport OP_SERVICE_ACCOUNT_TOKEN="${op_token.trim()}"\n`);
    }
    process.env["OP_SERVICE_ACCOUNT_TOKEN"] = op_token.trim();
    p.log.success("1Password token saved to ~/.zshrc");
  }
}

export const init_command = new Command("init")
  .description("Initialize LobsterFarm — setup wizard for first-time configuration")
  .option("--prefix <dir>", "Write output to <dir>/.claude/ and <dir>/.lobsterfarm/ instead of ~/")
  .option("--name <name>", "User name (skips interactive prompt)")
  .option("--non-interactive", "Use defaults for all prompts (requires --name)")
  .option("--tools <list>", "Comma-separated list of tools to install (tailscale,docker,vercel,supabase,sentry)")
  .option("--tailscale-authkey <key>", "Tailscale auth key for non-interactive setup")
  .option("--sentry-token <token>", "Sentry auth token")
  .option("--supabase-token <token>", "Supabase access token")
  .action(async (options: {
    prefix?: string;
    name?: string;
    nonInteractive?: boolean;
    tools?: string;
    tailscaleAuthkey?: string;
    sentryToken?: string;
    supabaseToken?: string;
  }) => {
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
      ? { planner: "Gary", designer: "Pearl", builder: "Bob", operator: "Ray", commander: "Pat" }
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

    // Check if Claude Code is logged in
    if (claude.installed || !non_interactive) {
      const { exec_command } = await import("../lib/process.js");
      const auth_check = await exec_command("claude --version 2>&1");
      // Try a quick auth test
      const auth_test = await exec_command("echo 'test' | claude -p --print --no-session-persistence 2>&1");
      if (auth_test.stderr.includes("login") || auth_test.stderr.includes("Not logged in") || auth_test.stdout.includes("Not logged in")) {
        const do_login = await p.confirm({
          message: "Claude Code is not logged in. Log in now? (opens browser)",
          initialValue: true,
        });
        if (p.isCancel(do_login)) { p.cancel("Setup cancelled."); process.exit(0); }

        if (do_login) {
          p.log.info("Opening browser for Claude Code login...");
          const { spawnSync } = await import("node:child_process");
          spawnSync("claude", ["/login"], { stdio: "inherit" });
        }
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

    if (op.cli_installed && !non_interactive) {
      if (op.token_configured) {
        const overwrite_op = await p.confirm({
          message: "1Password service account token already configured. Update it?",
          initialValue: false,
        });
        if (p.isCancel(overwrite_op)) { p.cancel("Setup cancelled."); process.exit(0); }
        if (!overwrite_op) {
          p.log.info("Keeping existing 1Password token.");
        } else {
          await prompt_and_save_op_token(path_overrides);
          op.token_configured = true;
          op.status = "op CLI installed, service account token configured";
        }
      } else {
        p.note(
          "Create a service account at https://my.1password.com → Developer → Service Accounts\n\n" +
            "Grant it:\n" +
            "  • Create and manage vaults (each entity gets its own vault)\n" +
            "  • Read/write access to a master \"lobsterfarm\" vault for shared credentials",
          "1Password Setup",
        );
        await prompt_and_save_op_token(path_overrides);
        op.token_configured = true;
        op.status = "op CLI installed, service account token configured";
      }
    }

    // ── Step 7: Bun (required by Discord channel plugin) ──
    spin.start("Checking Bun...");
    const bun = await check_bun();
    spin.stop(`Bun: ${bun.status}`);

    if (!bun.installed && !non_interactive) {
      const install_bun = await p.confirm({
        message: "Bun is required for the Discord channel plugin. Install it?",
        initialValue: true,
      });
      if (p.isCancel(install_bun)) { p.cancel("Setup cancelled."); process.exit(0); }

      if (install_bun) {
        spin.start("Installing Bun...");
        const { exec_command } = await import("../lib/process.js");
        const result = await exec_command("curl -fsSL https://bun.sh/install | bash");
        if (result.exitCode === 0) {
          const home = process.env["HOME"] ?? "";
          process.env["PATH"] = `${home}/.bun/bin:${process.env["PATH"] ?? ""}`;
          bun.installed = true;
          bun.status = "Bun installed";
          spin.stop("Bun installed");
        } else {
          spin.stop("Bun installation failed");
          p.log.warning("Install manually: curl -fsSL https://bun.sh/install | bash");
        }
      }
    }

    // ── Step 8: tmux (required for Commander session) ──
    spin.start("Checking tmux...");
    const tmux = await check_tmux();
    spin.stop(`tmux: ${tmux.status}`);

    if (!tmux.installed && !non_interactive) {
      const install_tmux = await p.confirm({
        message: "tmux is required for the Commander (Pat) session. Install it?",
        initialValue: true,
      });
      if (p.isCancel(install_tmux)) { p.cancel("Setup cancelled."); process.exit(0); }

      if (install_tmux) {
        spin.start("Installing tmux...");
        const { exec_command } = await import("../lib/process.js");
        const result = await exec_command("brew install tmux");
        if (result.exitCode === 0) {
          tmux.installed = true;
          tmux.status = "tmux installed";
          spin.stop("tmux installed");
        } else {
          spin.stop("tmux installation failed");
          p.log.warning("Install manually: brew install tmux");
        }
      }
    }

    // ── Step 9: GitHub CLI ──
    spin.start("Checking GitHub CLI...");
    const gh = await check_github_cli();
    spin.stop(`GitHub CLI: ${gh.status}`);

    if (!gh.installed && !non_interactive) {
      const install_gh = await p.confirm({
        message: "GitHub CLI (gh) is recommended for PR workflows. Install it?",
        initialValue: true,
      });
      if (p.isCancel(install_gh)) { p.cancel("Setup cancelled."); process.exit(0); }

      if (install_gh) {
        spin.start("Installing GitHub CLI...");
        const { exec_command } = await import("../lib/process.js");
        const result = await exec_command("brew install gh");
        if (result.exitCode === 0) {
          gh.installed = true;
          spin.stop("GitHub CLI installed");
        } else {
          spin.stop("GitHub CLI installation failed");
          p.log.warning("Install manually: brew install gh");
        }
      }
    }

    if (gh.installed && !gh.authenticated && !non_interactive) {
      const do_gh_login = await p.confirm({
        message: "GitHub CLI is not authenticated. Log in now?",
        initialValue: true,
      });
      if (p.isCancel(do_gh_login)) { p.cancel("Setup cancelled."); process.exit(0); }

      if (do_gh_login) {
        p.log.info("Opening browser for GitHub login...");
        const { spawnSync } = await import("node:child_process");
        spawnSync("gh", ["auth", "login", "-w"], { stdio: "inherit" });
        // Set up git credential helper
        const { exec_command } = await import("../lib/process.js");
        await exec_command("gh auth setup-git");
        gh.authenticated = true;
        gh.status = "gh CLI installed and authenticated";
      }
    }

    // ── Step 10: macOS Full Disk Access ──
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

    // ── Step 11: Tool Integrations ──
    const tools_config = await setup_tool_integrations(spin, non_interactive, options);

    // ── Step 12: Peekaboo (computer use CLI) ──
    if (machine.platform === "darwin" && !non_interactive) {
      const { exec_command } = await import("../lib/process.js");
      const { spawnSync } = await import("node:child_process");

      spin.start("Checking Peekaboo...");
      const peekaboo_which = await exec_command("which peekaboo");
      const peekaboo_installed = peekaboo_which.exitCode === 0;
      spin.stop(peekaboo_installed ? `Peekaboo: installed (${peekaboo_which.stdout.trim()})` : "Peekaboo: not installed");

      if (!peekaboo_installed) {
        const install_peekaboo = await p.confirm({
          message: "Peekaboo enables GUI automation (screen capture, clicking, typing). Install it?",
          initialValue: true,
        });
        if (p.isCancel(install_peekaboo)) { p.cancel("Setup cancelled."); process.exit(0); }

        if (install_peekaboo) {
          // Check Swift toolchain is available
          const swift_check = await exec_command("which swift");
          if (swift_check.exitCode !== 0) {
            p.log.warning("Swift toolchain not found — Peekaboo requires Xcode or Command Line Tools to build from source.");
            p.log.info("Install Xcode from the App Store, then re-run this wizard.");
          } else {
            const home = process.env["HOME"] ?? "";
            const tools_dir = `${home}/.lobsterfarm/tools`;
            const peekaboo_dir = `${tools_dir}/Peekaboo`;

            // Clone the repo
            spin.start("Cloning Peekaboo v3.0.0-beta3...");
            const { mkdir: mkdirFs } = await import("node:fs/promises");
            await mkdirFs(tools_dir, { recursive: true });

            const clone_result = await exec_command(
              `git clone --depth 1 --branch v3.0.0-beta3 https://github.com/steipete/Peekaboo.git "${peekaboo_dir}"`,
            );
            if (clone_result.exitCode !== 0) {
              spin.stop("Peekaboo clone failed");
              p.log.warning(`Clone failed: ${clone_result.stderr.trim()}`);
            } else {
              spin.stop("Peekaboo cloned");

              // Build from source (this takes several minutes)
              spin.start("Building Peekaboo from source (this may take a few minutes)...");
              const build_result = await exec_command(
                `cd "${peekaboo_dir}/Apps/CLI" && swift build --arch arm64 -c release`,
              );
              if (build_result.exitCode !== 0) {
                spin.stop("Peekaboo build failed");
                p.log.warning(`Build failed: ${build_result.stderr.trim().split("\n").slice(-5).join("\n")}`);
              } else {
                spin.stop("Peekaboo built successfully");

                // Copy binary to /usr/local/bin
                spin.start("Installing peekaboo binary...");
                const cp_result = spawnSync("sudo", [
                  "cp",
                  `${peekaboo_dir}/Apps/CLI/.build/arm64-apple-macosx/release/peekaboo`,
                  "/usr/local/bin/peekaboo",
                ], { stdio: "inherit" });

                if (cp_result.status !== 0) {
                  spin.stop("Failed to copy binary to /usr/local/bin");
                  p.log.warning("Copy the binary manually: sudo cp Apps/CLI/.build/arm64-apple-macosx/release/peekaboo /usr/local/bin/peekaboo");
                } else {
                  // Verify
                  const version_check = await exec_command("peekaboo --version");
                  if (version_check.exitCode === 0) {
                    spin.stop(`Peekaboo installed: ${version_check.stdout.trim()}`);
                  } else {
                    spin.stop("Peekaboo binary installed to /usr/local/bin/peekaboo");
                  }
                }
              }
            }
          }
        }
      }

      // Grant Screen Recording + Accessibility permissions
      const peekaboo_recheck = await exec_command("which peekaboo");
      if (peekaboo_recheck.exitCode === 0) {
        const setup_perms = await p.confirm({
          message: "Grant Peekaboo permissions (Screen Recording + Accessibility)?",
          initialValue: true,
        });
        if (p.isCancel(setup_perms)) { p.cancel("Setup cancelled."); process.exit(0); }

        if (setup_perms) {
          const apps_to_grant = [
            { name: "Terminal", bundle: "com.apple.Terminal" },
            { name: "node", path: null as string | null },
            { name: "tmux", path: null as string | null },
          ];

          const node_which = await exec_command("which node");
          if (node_which.exitCode === 0) apps_to_grant[1]!.path = node_which.stdout.trim();
          const tmux_which = await exec_command("which tmux");
          if (tmux_which.exitCode === 0) apps_to_grant[2]!.path = tmux_which.stdout.trim();

          const tcc_db = "/Library/Application Support/com.apple.TCC/TCC.db";
          const tcc_services = ["kTCCServiceScreenCapture", "kTCCServiceAccessibility"];

          spin.start("Attempting to grant Screen Recording + Accessibility via TCC database...");
          let tcc_success = true;

          for (const service of tcc_services) {
            // Grant Terminal by bundle ID
            const terminal_result = spawnSync("sudo", [
              "sqlite3", tcc_db,
              `INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version) VALUES ('${service}', 'com.apple.Terminal', 0, 2, 4, 1);`,
            ], { stdio: "inherit" });
            if (terminal_result.status !== 0) tcc_success = false;

            // Grant node and tmux by path
            for (const app of apps_to_grant.slice(1)) {
              if (!app.path) continue;
              const result = spawnSync("sudo", [
                "sqlite3", tcc_db,
                `INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version) VALUES ('${service}', '${app.path}', 1, 2, 4, 1);`,
              ], { stdio: "inherit" });
              if (result.status !== 0) tcc_success = false;
            }
          }

          if (tcc_success) {
            spin.stop("Screen Recording + Accessibility granted via TCC database");
          } else {
            spin.stop("TCC database method failed — opening System Settings");
            p.log.info("Manually enable Screen Recording and Accessibility for Terminal, node, and tmux.");

            spawnSync("open", [
              "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
            ]);
            spawnSync("open", [
              "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
            ]);

            const node_path = apps_to_grant[1]?.path ?? "not found";
            const tmux_path = apps_to_grant[2]?.path ?? "not installed";
            p.note(
              "System Settings has been opened to Screen Recording and Accessibility.\n\n" +
                "In each pane, click the + button and add:\n" +
                `  • Terminal (should be listed)\n` +
                `  • node: ${node_path}\n` +
                `  • tmux: ${tmux_path}\n\n` +
                "Tip: In the file picker, press Cmd+Shift+G to type a path directly.",
              "Manual Setup Required",
            );

            const ack = await p.confirm({ message: "Done configuring Screen Recording + Accessibility?" });
            if (p.isCancel(ack)) { p.cancel("Setup cancelled."); process.exit(0); }
          }
        }

        // Create Peekaboo skill file
        const { writeFile: writeSkill, mkdir: mkdirSkill } = await import("node:fs/promises");
        const home = process.env["HOME"] ?? "";
        const skill_dir = `${home}/.claude/skills/peekaboo`;
        await mkdirSkill(skill_dir, { recursive: true });

        const skill_content = `---
name: peekaboo
description: >
  Computer use via Peekaboo CLI. Use when a task requires GUI interaction
  and no CLI/API alternative exists. Covers screen capture, UI element
  detection, clicking, typing, keyboard shortcuts, and window management.
---

# Peekaboo — Computer Use

_GUI automation for macOS via the Peekaboo CLI. Use \`peekaboo learn\` for the full interactive guide._

## When to Use

- **GUI-only tasks** — no CLI/API alternative exists
- **Visual verification** — confirming what's on screen
- **App automation** — clicking buttons, filling forms in native apps

Do NOT use when a CLI command, API call, or shell script can do the job.

## Core Commands

\`\`\`bash
# See — capture screen + detect UI elements (returns JSON with element IDs)
peekaboo see --json
peekaboo see --app "Safari" --json

# Capture screenshot to a file
peekaboo image --mode screen --format png --path /tmp/pb-capture.png

# Click — by element ID (from see output) or coordinates
peekaboo click --on elem_42 --snapshot <snapshot_id>
peekaboo click --coords 500,300

# Type — human-cadence text input
peekaboo type "Hello world"
peekaboo type "search query" --app "Safari"

# Press — individual keys (plain names)
peekaboo press return
peekaboo press tab tab return

# Hotkey — keyboard shortcuts (comma-separated modifiers)
peekaboo hotkey "cmd,c"
peekaboo hotkey "cmd,shift,g"

# App management
peekaboo list --apps
peekaboo app --action launch --name "Calculator"
peekaboo app --action switch --to "Safari"
peekaboo open "https://example.com"
\`\`\`

## Cleanup Rules

Always clean up after yourself:
- Delete screenshot files: \`rm /tmp/pb-*.png\`
- Delete annotated \`see\` screenshots: \`rm ~/Desktop/peekaboo_see_*.png\`
- Clear snapshot cache: \`peekaboo clean --all-snapshots\`
- Use \`/tmp/pb-\` prefix for all screenshot paths

## Gotchas

- Snapshot IDs expire when UI changes — always take fresh \`see\` before clicking
- \`see\` targets the frontmost app — use \`--app\` for background apps
- Never type passwords — stop and ask the user
- macOS may require monthly re-grant of Screen Recording permission
`;

        await writeSkill(`${skill_dir}/SKILL.md`, skill_content);
        p.log.success("Peekaboo skill file created: ~/.claude/skills/peekaboo/SKILL.md");

        // Append Peekaboo section to tools.md
        const { lobsterfarm_dir: lf_dir } = await import("@lobster-farm/shared");
        const tools_path = `${lf_dir(path_overrides)}/tools.md`;
        try {
          const { readFile: readTools, writeFile: writeTools } = await import("node:fs/promises");
          const tools_content = await readTools(tools_path, "utf-8");
          if (!tools_content.includes("Peekaboo")) {
            const peekaboo_section =
              "\n## Computer Use (Peekaboo)\n\n" +
              "- **Binary:** `/usr/local/bin/peekaboo` (v3.0.0-beta3, arm64)\n" +
              "- **Source:** `~/.lobsterfarm/tools/Peekaboo/` (pinned to v3.0.0-beta3)\n" +
              "- **Skill:** `~/.claude/skills/peekaboo/SKILL.md` — load when GUI interaction is needed\n" +
              "- **Permissions:** Screen Recording + Accessibility granted for Terminal, node, tmux\n" +
              "- **When to use:** GUI-only tasks where no CLI/API alternative exists. Not the default — always prefer CLI/API.\n" +
              "- **Cleanup:** Always delete screenshots after use (`/tmp/pb-*.png`, `~/Desktop/peekaboo_see_*.png`)\n";

            // Insert before the "Shared Services" section if it exists, otherwise append before the footer
            if (tools_content.includes("## Shared Services")) {
              const updated = tools_content.replace("## Shared Services", peekaboo_section + "\n## Shared Services");
              await writeTools(tools_path, updated);
            } else {
              // Append before the closing italics line, or at the end
              const footer_marker = "_This file grows";
              if (tools_content.includes(footer_marker)) {
                const updated = tools_content.replace(footer_marker, peekaboo_section + "\n" + footer_marker);
                await writeTools(tools_path, updated);
              } else {
                const { appendFile } = await import("node:fs/promises");
                await appendFile(tools_path, peekaboo_section);
              }
            }
            p.log.success("Peekaboo section added to tools.md");
          }
        } catch {
          // tools.md doesn't exist yet — that's fine, it'll be created by generate_config_files
          p.log.info("tools.md not found — Peekaboo entry will need to be added manually after setup.");
        }
      }
    }

    // ── Prompts (skipped in non-interactive mode) ──
    // Check if Discord tokens already exist
    let has_existing_discord_token = false;
    try {
      const { readFile: readF } = await import("node:fs/promises");
      const { lobsterfarm_dir: lf_dir } = await import("@lobster-farm/shared");
      const env_content = await readF(`${lf_dir(path_overrides)}/.env`, "utf-8");
      has_existing_discord_token = env_content.includes("DISCORD_BOT_TOKEN");
    } catch { /* no .env yet */ }
    if (!has_existing_discord_token) {
      try {
        const { readFile: readF } = await import("node:fs/promises");
        const { lobsterfarm_dir: lf_dir } = await import("@lobster-farm/shared");
        const pat_env = await readF(`${lf_dir(path_overrides)}/channels/pat/.env`, "utf-8");
        has_existing_discord_token = pat_env.includes("DISCORD_BOT_TOKEN");
      } catch { /* no pat .env yet */ }
    }

    const discord_setup = non_interactive ? undefined : await prompt_discord(has_existing_discord_token);
    const github = non_interactive ? { username: "" } : await prompt_github();

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
      COMMANDER_NAME: agent_names.commander,
      PLANNER_NAME_LOWER: agent_names.planner.toLowerCase(),
      DESIGNER_NAME_LOWER: agent_names.designer.toLowerCase(),
      BUILDER_NAME_LOWER: agent_names.builder.toLowerCase(),
      OPERATOR_NAME_LOWER: agent_names.operator.toLowerCase(),
      COMMANDER_NAME_LOWER: agent_names.commander.toLowerCase(),
      PROJECTS_DIR: "~/.lobsterfarm/entities",
      GITHUB_USERNAME: github.username,
      GITHUB_ORG: "",
    });

    // ── Build LobsterFarmConfig ──
    const config_paths: Record<string, string> = {};
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
        commander: { name: agent_names.commander },
      },
    };

    if (discord_setup) {
      config_input["discord"] = { server_id: discord_setup.server_id };
    }

    if (tools_config && Object.keys(tools_config).length > 0) {
      config_input["tools"] = tools_config;
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

    // Write .env with secrets (daemon bot token)
    if (discord_setup?.daemon_bot_token) {
      const { writeFile, mkdir: mkdirFs } = await import("node:fs/promises");
      const { lobsterfarm_dir: lf_dir } = await import("@lobster-farm/shared");
      const env_dir = lf_dir(path_overrides);
      await mkdirFs(env_dir, { recursive: true });
      const env_path = `${env_dir}/.env`;
      await writeFile(env_path, `DISCORD_BOT_TOKEN=${discord_setup.daemon_bot_token}\n`, { mode: 0o600 });
      files.push(env_path);
    }

    // Write Commander (Pat) bot token to channel state dir
    if (discord_setup?.commander_bot_token) {
      const { writeFile, mkdir: mkdirFs } = await import("node:fs/promises");
      const { lobsterfarm_dir: lf_dir } = await import("@lobster-farm/shared");
      const pat_dir = `${lf_dir(path_overrides)}/channels/pat`;
      await mkdirFs(pat_dir, { recursive: true, mode: 0o700 });
      const pat_env_path = `${pat_dir}/.env`;
      await writeFile(pat_env_path, `DISCORD_BOT_TOKEN=${discord_setup.commander_bot_token}\n`, { mode: 0o600 });
      files.push(pat_env_path);
    }

    // Install Discord channel plugin for Commander
    if (discord_setup && !non_interactive) {
      spin.start("Installing Discord channel plugin...");
      const { exec_command } = await import("../lib/process.js");
      const plugin_check = await exec_command("claude plugins list 2>/dev/null");
      if (!plugin_check.stdout.includes("discord@claude-plugins-official")) {
        const result = await exec_command("claude plugins install discord@claude-plugins-official 2>&1");
        if (result.exitCode === 0) {
          spin.stop("Discord channel plugin installed");
        } else {
          spin.stop("Discord plugin install failed — install manually: claude plugins install discord@claude-plugins-official");
        }
      } else {
        spin.stop("Discord channel plugin already installed");
      }
    }

    // Write Pat's access.json if commander token and Discord are configured
    if (discord_setup?.commander_bot_token && !non_interactive) {
      p.note(
        "Pat needs to know which Discord channel to listen in and who to accept messages from.\n\n" +
          "Enable Developer Mode in Discord: User Settings → Advanced → Developer Mode.\n" +
          "Right-click the #command-center channel → Copy Channel ID.\n" +
          "Right-click your own avatar → Copy User ID.",
        "Commander Access Control",
      );

      const command_center_id = await p.text({
        message: "#command-center channel ID:",
        validate: (value) => {
          if (!value.trim()) return "Channel ID is required for Pat.";
          return undefined;
        },
      });
      if (p.isCancel(command_center_id)) { p.cancel("Setup cancelled."); process.exit(0); }

      const user_discord_id = await p.text({
        message: "Your Discord user ID:",
        validate: (value) => {
          if (!value.trim()) return "User ID is required.";
          return undefined;
        },
      });
      if (p.isCancel(user_discord_id)) { p.cancel("Setup cancelled."); process.exit(0); }

      const { writeFile: writeF, mkdir: mkdirFs } = await import("node:fs/promises");
      const { lobsterfarm_dir: lf_dir } = await import("@lobster-farm/shared");
      const pat_dir = `${lf_dir(path_overrides)}/channels/pat`;
      await mkdirFs(pat_dir, { recursive: true, mode: 0o700 });

      const access_config = {
        dmPolicy: "allowlist",
        allowFrom: [user_discord_id.trim()],
        groups: {
          [command_center_id.trim()]: {
            requireMention: false,
            allowFrom: [],
          },
        },
        pending: {},
        ackReaction: "👀",
        replyToMode: "first",
        textChunkLimit: 2000,
        chunkMode: "newline",
      };

      const access_path = `${pat_dir}/access.json`;
      await writeF(access_path, JSON.stringify(access_config, null, 2) + "\n", { mode: 0o600 });
      files.push(access_path);
      p.log.success("Commander access control configured");
    }

    spin.stop(`Wrote ${String(files.length + 2)} configuration files`);

    // ── Summary ──
    const summary_lines = [
      `Config:     ${config_path}`,
      `Settings:   ${settings_path}`,
      `Agents:     ${agent_names.planner} (planner), ${agent_names.designer} (designer), ${agent_names.builder} (builder), ${agent_names.operator} (operator), ${agent_names.commander} (commander)`,
      `Entities:   ~/.lobsterfarm/entities/`,
      `Machine:    ${machine.name}`,
      `Sudo:       ${sudo.status}`,
      `1Password:  ${op.status}`,
    ];

    summary_lines.push(`Bun:        ${bun.status}`);
    summary_lines.push(`tmux:       ${tmux.status}`);
    summary_lines.push(`GitHub CLI: ${gh.status}`);

    if (discord_setup) {
      const tokens = [discord_setup.daemon_bot_token ? "daemon" : ""].filter(Boolean);
      if (discord_setup.commander_bot_token) tokens.push("commander");
      summary_lines.push(`Discord:    server ${discord_setup.server_id} (${tokens.join(" + ")} token${tokens.length > 1 ? "s" : ""} saved)`);
    }

    if (github.username) {
      summary_lines.push(`GitHub:     ${github.username}`);
    }

    // Tool integration statuses
    if (tools_config?.tailscale?.installed) {
      const ts = tools_config.tailscale;
      summary_lines.push(`Tailscale:  connected as ${ts.hostname ?? "unknown"} (${ts.ip ?? "unknown"})`);
    }
    if (tools_config?.docker?.installed) {
      summary_lines.push(`Docker:     ${tools_config.docker.runtime ?? "colima"} ready`);
    }
    if (tools_config?.vercel?.installed) {
      const v = tools_config.vercel;
      summary_lines.push(`Vercel:     authenticated as ${v.username ?? "unknown"}`);
    }
    if (tools_config?.supabase?.installed) {
      summary_lines.push(`Supabase:   authenticated`);
    }
    if (tools_config?.sentry?.installed) {
      const s = tools_config.sentry;
      summary_lines.push(`Sentry:     authenticated${s.org ? ` (org: ${s.org})` : ""}`);
    }

    p.note(summary_lines.join("\n"), "Setup Complete");

    p.outro(
      "Run `lf start` to launch the daemon. Happy building!",
    );
  });
