import * as p from "@clack/prompts";
import { spawnSync } from "node:child_process";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { exec_command } from "../../lib/process.js";
import {
  check_tailscale, check_docker, check_vercel, check_supabase, check_sentry,
  type TailscaleCheckResult, type DockerCheckResult, type VercelCheckResult,
  type SupabaseCheckResult, type SentryCheckResult,
} from "./detect.js";

// Tool names used as keys throughout the module.
const TOOL_NAMES = ["tailscale", "docker", "vercel", "supabase", "sentry"] as const;
type ToolName = (typeof TOOL_NAMES)[number];

/** Config shape written to config.yaml — mirrors the schema in config.ts. */
export interface ToolsConfig {
  tailscale?: { installed: boolean; hostname?: string; ip?: string };
  docker?: { installed: boolean; runtime?: "colima" | "docker-desktop" | "other" };
  vercel?: { installed: boolean; username?: string };
  supabase?: { installed: boolean };
  sentry?: { installed: boolean; org?: string };
}

interface ToolDetectionResults {
  tailscale: TailscaleCheckResult;
  docker: DockerCheckResult;
  vercel: VercelCheckResult;
  supabase: SupabaseCheckResult;
  sentry: SentryCheckResult;
}

interface ToolOption {
  value: ToolName;
  label: string;
  hint: string;
}

interface ToolSetupOptions {
  tools?: string;
  tailscaleAuthkey?: string;
  sentryToken?: string;
  supabaseToken?: string;
}

// ── Detection ──

/** Run all 5 tool detections in parallel. */
async function detect_all_tools(): Promise<ToolDetectionResults> {
  const [tailscale, docker, vercel, supabase, sentry] = await Promise.all([
    check_tailscale(),
    check_docker(),
    check_vercel(),
    check_supabase(),
    check_sentry(),
  ]);
  return { tailscale, docker, vercel, supabase, sentry };
}

/** Build the multiselect option list from detection results. */
function build_tool_options(detection: ToolDetectionResults): ToolOption[] {
  return [
    {
      value: "tailscale",
      label: "Tailscale",
      hint: `mesh VPN for remote SSH + dev server access [${detection.tailscale.status}]`,
    },
    {
      value: "docker",
      label: "Docker",
      hint: `container runtime via Colima [${detection.docker.status}]`,
    },
    {
      value: "vercel",
      label: "Vercel",
      hint: `frontend deployment platform [${detection.vercel.status}]`,
    },
    {
      value: "supabase",
      label: "Supabase",
      hint: `database & auth backend [${detection.supabase.status}]`,
    },
    {
      value: "sentry",
      label: "Sentry",
      hint: `error monitoring [${detection.sentry.status}]`,
    },
  ];
}

/** Determine which tools should be pre-selected (checked) by default. */
function default_selections(detection: ToolDetectionResults): ToolName[] {
  const selected: ToolName[] = [];

  // Not-installed or not-authenticated tools are checked by default.
  // Already fully configured tools are unchecked (user can still re-enable).
  if (!detection.tailscale.installed || !detection.tailscale.authenticated) selected.push("tailscale");
  if (!detection.docker.docker_installed || !detection.docker.colima_installed) selected.push("docker");
  if (!detection.vercel.installed || !detection.vercel.authenticated) selected.push("vercel");
  if (!detection.supabase.installed || !detection.supabase.authenticated) selected.push("supabase");
  if (!detection.sentry.installed || !detection.sentry.authenticated) selected.push("sentry");

  return selected;
}

// ── Individual tool setup flows ──

async function setup_tailscale(
  spin: ReturnType<typeof p.spinner>,
  detection: TailscaleCheckResult,
  non_interactive: boolean,
  authkey?: string,
): Promise<ToolsConfig["tailscale"]> {
  p.log.step("Setting up Tailscale");

  // GUI conflict check
  if (detection.gui_app_detected && !non_interactive) {
    p.log.warning(
      "Tailscale.app (GUI) detected. The App Store version conflicts with the CLI daemon\n" +
      "and doesn't support Tailscale SSH.\n" +
      "Please quit and uninstall Tailscale.app via Finder, then press Enter to continue.",
    );
    const proceed = await p.confirm({ message: "Tailscale.app removed?" });
    if (p.isCancel(proceed)) { p.cancel("Setup cancelled."); process.exit(0); }

    // Re-check
    const recheck = await check_tailscale();
    if (recheck.gui_app_detected) {
      p.log.warning("Tailscale.app still detected. Skipping Tailscale setup.");
      return undefined;
    }
  }

  // Install via brew if needed
  if (!detection.installed) {
    spin.start("Installing Tailscale...");
    const install = await exec_command("brew install tailscale");
    if (install.exitCode !== 0) {
      spin.stop("Tailscale installation failed");
      p.log.warning("Install manually: brew install tailscale");
      return undefined;
    }
    spin.stop("Tailscale installed");
  }

  // Create LaunchDaemon (requires sudo)
  const plist_path = "/Library/LaunchDaemons/com.tailscale.tailscaled.plist";
  const plist_content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.tailscale.tailscaled</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/opt/tailscale/bin/tailscaled</string>
    <string>--state=/var/lib/tailscale/tailscaled.state</string>
    <string>--socket=/var/run/tailscaled.socket</string>
    <string>--port=0</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/sbin:/usr/bin:/sbin:/bin:/opt/homebrew/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/var/log/tailscaled.log</string>
  <key>StandardErrorPath</key>
  <string>/var/log/tailscaled.log</string>
</dict>
</plist>`;

  spin.start("Configuring Tailscale daemon...");

  // Create state directory and write plist
  const mkdir_result = spawnSync("sudo", ["mkdir", "-p", "/var/lib/tailscale"], { stdio: "inherit" });
  if (mkdir_result.status !== 0) {
    spin.stop("Failed to create /var/lib/tailscale");
    p.log.warning("Tailscale daemon setup requires sudo access.");
    return undefined;
  }

  // Write the plist via sudo tee
  const write_plist = spawnSync("sudo", ["tee", plist_path], {
    input: plist_content,
    stdio: ["pipe", "pipe", "inherit"],
  });
  if (write_plist.status !== 0) {
    spin.stop("Failed to write LaunchDaemon plist");
    return undefined;
  }

  // Load the daemon
  const load_result = spawnSync("sudo", ["launchctl", "load", plist_path], { stdio: "inherit" });
  if (load_result.status !== 0) {
    // May already be loaded — try unload + load
    spawnSync("sudo", ["launchctl", "unload", plist_path], { stdio: "inherit" });
    const retry = spawnSync("sudo", ["launchctl", "load", plist_path], { stdio: "inherit" });
    if (retry.status !== 0) {
      spin.stop("Failed to load Tailscale daemon");
      return undefined;
    }
  }
  spin.stop("Tailscale daemon configured");

  // Authenticate
  if (authkey) {
    // Non-interactive: use auth key
    spin.start("Authenticating Tailscale...");
    const auth = await exec_command(`tailscale up --ssh --authkey=${authkey}`);
    if (auth.exitCode !== 0) {
      spin.stop("Tailscale auth failed");
      p.log.warning("Check your auth key and try again.");
      return undefined;
    }
    spin.stop("Tailscale authenticated");
  } else if (!detection.authenticated) {
    // Interactive: browser auth — spawnSync with inherited stdio so the URL is visible
    p.log.info("Tailscale will open a browser for authentication...");
    const auth = spawnSync("tailscale", ["up", "--ssh"], { stdio: "inherit" });
    if (auth.status !== 0) {
      p.log.warning("Tailscale authentication failed or was cancelled.");
      return undefined;
    }
  }

  // Verify
  const verify = await check_tailscale();
  if (verify.authenticated) {
    p.log.success(`Tailscale connected as ${verify.hostname} (${verify.ip})`);
    return { installed: true, hostname: verify.hostname ?? undefined, ip: verify.ip ?? undefined };
  }

  p.log.warning("Tailscale setup completed but verification failed.");
  return { installed: true };
}

async function setup_docker(
  spin: ReturnType<typeof p.spinner>,
  detection: DockerCheckResult,
  non_interactive: boolean,
): Promise<ToolsConfig["docker"]> {
  p.log.step("Setting up Docker");

  // Docker Desktop conflict
  if (detection.docker_desktop_detected && !non_interactive) {
    p.log.warning(
      "Docker Desktop detected. For headless operation, we'll use Colima instead.\n" +
      "Please uninstall Docker Desktop via Finder, then press Enter to continue.",
    );
    const proceed = await p.confirm({ message: "Docker Desktop removed?" });
    if (p.isCancel(proceed)) { p.cancel("Setup cancelled."); process.exit(0); }
  }

  // Install missing components
  const to_install: string[] = [];
  if (!detection.colima_installed) to_install.push("colima");
  if (!detection.docker_installed) to_install.push("docker");

  // Always check docker-compose
  const { exitCode: compose_exit } = await exec_command("which docker-compose 2>/dev/null");
  if (compose_exit !== 0) to_install.push("docker-compose");

  if (to_install.length > 0) {
    spin.start(`Installing ${to_install.join(", ")}...`);
    const install = await exec_command(`brew install ${to_install.join(" ")}`);
    if (install.exitCode !== 0) {
      spin.stop("Docker installation failed");
      p.log.warning(`Install manually: brew install ${to_install.join(" ")}`);
      return undefined;
    }
    spin.stop(`Installed ${to_install.join(", ")}`);
  }

  // Configure docker-compose CLI plugin path
  const home = process.env["HOME"] ?? "";
  const docker_config_path = `${home}/.docker/config.json`;
  try {
    await mkdir(`${home}/.docker`, { recursive: true });
    let docker_config: Record<string, unknown> = {};
    try {
      const existing = await readFile(docker_config_path, "utf-8");
      docker_config = JSON.parse(existing);
    } catch { /* file doesn't exist yet */ }

    docker_config["cliPluginsExtraDirs"] = ["/opt/homebrew/lib/docker/cli-plugins"];
    await writeFile(docker_config_path, JSON.stringify(docker_config, null, 2) + "\n");
  } catch (err) {
    p.log.warning(`Failed to configure docker-compose plugin: ${String(err)}`);
  }

  // Start Colima if not running
  if (!detection.colima_running) {
    spin.start("Starting Colima (--cpu 2 --memory 4 --disk 30)...");
    const start = await exec_command("colima start --cpu 2 --memory 4 --disk 30");
    if (start.exitCode !== 0) {
      spin.stop("Colima start failed");
      p.log.warning("Start manually: colima start --cpu 2 --memory 4 --disk 30");
      // Continue anyway — colima might already be running via different config
    } else {
      spin.stop("Colima started");
    }
  }

  // Auto-start on login
  spin.start("Enabling Colima auto-start...");
  await exec_command("brew services start colima");
  spin.stop("Colima auto-start enabled");

  // Verify with hello-world
  spin.start("Verifying Docker...");
  const verify = await exec_command("docker run --rm hello-world 2>&1");
  if (verify.exitCode === 0) {
    spin.stop("Docker verified");
  } else {
    spin.stop("Docker verification failed — container runtime may need a moment");
    p.log.warning("Try: docker run --rm hello-world");
  }

  // Get version info for summary
  const recheck = await check_docker();
  p.log.success(`Docker ready (Colima v${recheck.colima_version ?? "?"}, Docker v${recheck.docker_version ?? "?"})`);

  return { installed: true, runtime: "colima" };
}

async function setup_vercel(
  spin: ReturnType<typeof p.spinner>,
  detection: VercelCheckResult,
  _non_interactive: boolean,
): Promise<ToolsConfig["vercel"]> {
  p.log.step("Setting up Vercel");

  if (!detection.installed) {
    spin.start("Installing Vercel CLI...");
    const install = await exec_command("brew install vercel-cli");
    if (install.exitCode !== 0) {
      // Fallback: try npm
      const npm_install = await exec_command("npm install -g vercel");
      if (npm_install.exitCode !== 0) {
        spin.stop("Vercel installation failed");
        p.log.warning("Install manually: brew install vercel-cli");
        return undefined;
      }
    }
    spin.stop("Vercel CLI installed");
  }

  if (!detection.authenticated) {
    // Device auth flow — needs inherited stdio for URL display
    p.log.info("Vercel will open a browser for authentication...");
    const auth = spawnSync("vercel", ["login"], { stdio: "inherit" });
    if (auth.status !== 0) {
      p.log.warning("Vercel authentication failed or was cancelled.");
      return { installed: true };
    }
  }

  // Verify
  const verify = await check_vercel();
  if (verify.authenticated) {
    p.log.success(`Vercel authenticated as ${verify.username}`);
    return { installed: true, username: verify.username ?? undefined };
  }

  p.log.warning("Vercel setup completed but verification failed.");
  return { installed: true };
}

async function setup_supabase(
  spin: ReturnType<typeof p.spinner>,
  detection: SupabaseCheckResult,
  non_interactive: boolean,
  token?: string,
): Promise<ToolsConfig["supabase"]> {
  p.log.step("Setting up Supabase");

  if (!detection.installed) {
    spin.start("Installing Supabase CLI...");
    const install = await exec_command("brew install supabase/tap/supabase");
    if (install.exitCode !== 0) {
      spin.stop("Supabase installation failed");
      p.log.warning("Install manually: brew install supabase/tap/supabase");
      return undefined;
    }
    spin.stop("Supabase CLI installed");
  }

  if (!detection.authenticated) {
    if (token) {
      // Non-interactive: use provided token
      spin.start("Authenticating Supabase...");
      const auth = await exec_command(`supabase login --token ${token}`);
      if (auth.exitCode !== 0) {
        spin.stop("Supabase auth failed");
        return undefined;
      }
      spin.stop("Supabase authenticated");
    } else if (!non_interactive) {
      // Try interactive login first
      p.log.info("Attempting Supabase login...");
      const interactive_result = spawnSync("supabase", ["login"], { stdio: "inherit" });

      if (interactive_result.status !== 0) {
        // Fallback: prompt for token
        p.note(
          "Supabase requires a token for non-interactive auth.\n" +
          "Generate one at: https://supabase.com/dashboard/account/tokens",
          "Supabase Token",
        );
        const manual_token = await p.password({ message: "Paste your Supabase access token:" });
        if (p.isCancel(manual_token)) { p.cancel("Setup cancelled."); process.exit(0); }

        if (manual_token?.trim()) {
          spin.start("Authenticating Supabase...");
          const auth = await exec_command(`supabase login --token ${manual_token.trim()}`);
          if (auth.exitCode !== 0) {
            spin.stop("Supabase auth failed");
            return { installed: true };
          }
          spin.stop("Supabase authenticated");
        }
      }
    } else {
      // Non-interactive without token — skip auth
      p.log.warning("Supabase token required for non-interactive auth. Skipping.");
      return { installed: true };
    }
  }

  // Verify
  const verify = await check_supabase();
  if (verify.authenticated) {
    p.log.success("Supabase authenticated");
    return { installed: true };
  }

  return { installed: true };
}

async function setup_sentry(
  spin: ReturnType<typeof p.spinner>,
  detection: SentryCheckResult,
  non_interactive: boolean,
  token?: string,
): Promise<ToolsConfig["sentry"]> {
  p.log.step("Setting up Sentry");

  if (!detection.installed) {
    spin.start("Installing Sentry CLI...");
    const install = await exec_command("brew install getsentry/tools/sentry-cli");
    if (install.exitCode !== 0) {
      spin.stop("Sentry CLI installation failed");
      p.log.warning("Install manually: brew install getsentry/tools/sentry-cli");
      return undefined;
    }
    spin.stop("Sentry CLI installed");
  }

  let auth_token = token;

  if (!detection.authenticated && !auth_token) {
    if (non_interactive) {
      p.log.warning("Sentry token required for non-interactive auth. Skipping.");
      return { installed: true };
    }

    p.note(
      "Generate a Sentry auth token at:\n" +
      "https://sentry.io/settings/account/api/auth-tokens/\n\n" +
      "Required scopes: project:write, org:read",
      "Sentry Token",
    );
    const prompted_token = await p.password({ message: "Paste your Sentry auth token:" });
    if (p.isCancel(prompted_token)) { p.cancel("Setup cancelled."); process.exit(0); }
    auth_token = prompted_token?.trim() || undefined;
  }

  if (auth_token) {
    // Write token to ~/.sentryclirc
    const home = process.env["HOME"] ?? "";
    const sentryclirc_path = `${home}/.sentryclirc`;

    let org: string | undefined;

    // Write token first so sentry-cli can authenticate
    const initial_content = `[auth]\ntoken = ${auth_token}\n`;
    await writeFile(sentryclirc_path, initial_content, { mode: 0o600 });

    // Try to get org
    if (!non_interactive) {
      spin.start("Fetching Sentry organizations...");
      const orgs_result = await exec_command("sentry-cli organizations list 2>/dev/null");
      spin.stop("Organizations fetched");

      if (orgs_result.exitCode === 0 && orgs_result.stdout.trim()) {
        // Parse org list — each line has org slug
        const lines = orgs_result.stdout.trim().split("\n").filter((l) => l.trim() && !l.startsWith("-"));
        // Filter header lines — org lines typically don't start with "Name" or have dashes
        const org_slugs = lines
          .map((l) => l.trim().split(/\s+/)[0])
          .filter((s): s is string => Boolean(s) && s !== "Name" && s !== "Slug" && !s?.startsWith("|"));

        if (org_slugs.length === 1) {
          org = org_slugs[0];
        } else if (org_slugs.length > 1) {
          const selected = await p.select({
            message: "Select default Sentry organization:",
            options: org_slugs.map((s) => ({ value: s, label: s })),
          });
          if (p.isCancel(selected)) { p.cancel("Setup cancelled."); process.exit(0); }
          org = selected;
        }
      }
    }

    // Write final config with org
    let rc_content = "";
    if (org) {
      rc_content += `[defaults]\norg = ${org}\n\n`;
    }
    rc_content += `[auth]\ntoken = ${auth_token}\n`;
    await writeFile(sentryclirc_path, rc_content, { mode: 0o600 });
  }

  // Verify
  const verify = await check_sentry();
  if (verify.authenticated) {
    p.log.success(`Sentry authenticated${verify.org ? ` (org: ${verify.org})` : ""}`);
    return { installed: true, org: verify.org ?? undefined };
  }

  return { installed: true };
}

// ── Main entry point ──

/**
 * Run the tool integrations step of the init wizard.
 *
 * In interactive mode: detect all tools, show multiselect, run setup flows.
 * In non-interactive mode with --tools: install only listed tools.
 * In non-interactive mode without --tools: skip entirely.
 */
export async function setup_tool_integrations(
  spin: ReturnType<typeof p.spinner>,
  non_interactive: boolean,
  options: ToolSetupOptions,
): Promise<ToolsConfig | undefined> {
  // Non-interactive without --tools: skip
  if (non_interactive && !options.tools) {
    return undefined;
  }

  // Detect all tools
  spin.start("Detecting installed tools...");
  const detection = await detect_all_tools();
  spin.stop("Tool detection complete");

  let selected_tools: ToolName[];

  if (options.tools) {
    // Parse --tools flag
    selected_tools = options.tools.split(",").map((t) => t.trim()).filter(
      (t): t is ToolName => TOOL_NAMES.includes(t as ToolName),
    );
    if (selected_tools.length === 0) {
      p.log.warning(`No valid tools in --tools flag. Valid options: ${TOOL_NAMES.join(", ")}`);
      return undefined;
    }
  } else {
    // Interactive multiselect
    const tool_options = build_tool_options(detection);
    const initial_values = default_selections(detection);

    const choices = await p.multiselect({
      message: "Which optional tools would you like to set up?",
      options: tool_options.map((opt) => ({
        value: opt.value,
        label: opt.label,
        hint: opt.hint,
      })),
      initialValues: initial_values,
      required: false,
    });

    if (p.isCancel(choices)) { p.cancel("Setup cancelled."); process.exit(0); }
    selected_tools = (choices as ToolName[]) ?? [];
  }

  if (selected_tools.length === 0) {
    p.log.info("No tools selected. Skipping tool setup.");
    return undefined;
  }

  // Walk through each selected tool sequentially.
  // Failures in one tool don't block others.
  const tools_config: ToolsConfig = {};

  for (const tool of selected_tools) {
    try {
      switch (tool) {
        case "tailscale": {
          const result = await setup_tailscale(spin, detection.tailscale, non_interactive, options.tailscaleAuthkey);
          if (result) tools_config.tailscale = result;
          break;
        }
        case "docker": {
          const result = await setup_docker(spin, detection.docker, non_interactive);
          if (result) tools_config.docker = result;
          break;
        }
        case "vercel": {
          const result = await setup_vercel(spin, detection.vercel, non_interactive);
          if (result) tools_config.vercel = result;
          break;
        }
        case "supabase": {
          const result = await setup_supabase(spin, detection.supabase, non_interactive, options.supabaseToken);
          if (result) tools_config.supabase = result;
          break;
        }
        case "sentry": {
          const result = await setup_sentry(spin, detection.sentry, non_interactive, options.sentryToken);
          if (result) tools_config.sentry = result;
          break;
        }
      }
    } catch (err) {
      p.log.warning(`${tool} setup failed: ${String(err)}`);
    }
  }

  return Object.keys(tools_config).length > 0 ? tools_config : undefined;
}
