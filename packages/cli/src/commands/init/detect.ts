import { hostname, arch, cpus, platform } from "node:os";
import { exec_command } from "../../lib/process.js";

export interface MachineInfo {
  name: string;
  hardware: string;
  platform: string;
}

/** Auto-detect machine information from the OS. */
export function detect_machine(): MachineInfo {
  const cpu_list = cpus();
  const cpu_model = cpu_list[0]?.model ?? "unknown";
  const cpu_count = cpu_list.length;
  const hw = `${platform()} ${arch()} — ${cpu_model} (${cpu_count} cores)`;
  return {
    name: hostname(),
    hardware: hw,
    platform: platform(),
  };
}

export interface SudoCheckResult {
  has_passwordless_sudo: boolean;
  status: string;
}

/** Check whether passwordless sudo is available. */
export async function check_sudo(): Promise<SudoCheckResult> {
  const { exitCode } = await exec_command("sudo -n true 2>/dev/null");
  if (exitCode === 0) {
    return { has_passwordless_sudo: true, status: "passwordless sudo available" };
  }
  return { has_passwordless_sudo: false, status: "passwordless sudo not configured" };
}

export interface OnePasswordCheckResult {
  cli_installed: boolean;
  token_configured: boolean;
  status: string;
}

/** Check if 1Password CLI is installed and the service account token is set. */
export interface ClaudeCodeCheckResult {
  installed: boolean;
  version: string | null;
  status: string;
}

/** Check if Claude Code CLI is installed. */
export async function check_claude_code(): Promise<ClaudeCodeCheckResult> {
  // Check PATH first, then common install locations
  const check_cmd = 'claude --version 2>/dev/null || ~/.local/bin/claude --version 2>/dev/null || /usr/local/bin/claude --version 2>/dev/null';
  const { exitCode, stdout } = await exec_command(check_cmd);
  if (exitCode === 0 && stdout.trim()) {
    // If found in ~/.local/bin but not in PATH, fix PATH
    const { exitCode: path_check } = await exec_command("which claude 2>/dev/null");
    if (path_check !== 0) {
      // Add to PATH for this session and suggest permanent fix
      const home = process.env["HOME"] ?? "";
      process.env["PATH"] = `${home}/.local/bin:${process.env["PATH"] ?? ""}`;
    }
    return {
      installed: true,
      version: stdout.trim(),
      status: `Claude Code ${stdout.trim()}`,
    };
  }
  return {
    installed: false,
    version: null,
    status: "Claude Code not found — install from https://docs.anthropic.com/en/docs/claude-code",
  };
}

export interface BunCheckResult {
  installed: boolean;
  status: string;
}

/** Check if Bun is installed (required by Discord channel plugin). */
export async function check_bun(): Promise<BunCheckResult> {
  const check_cmd = 'bun --version 2>/dev/null || ~/.bun/bin/bun --version 2>/dev/null';
  const { exitCode, stdout } = await exec_command(check_cmd);
  if (exitCode === 0 && stdout.trim()) {
    const { exitCode: path_check } = await exec_command("which bun 2>/dev/null");
    if (path_check !== 0) {
      const home = process.env["HOME"] ?? "";
      process.env["PATH"] = `${home}/.bun/bin:${process.env["PATH"] ?? ""}`;
    }
    return { installed: true, status: `Bun ${stdout.trim()}` };
  }
  return { installed: false, status: "Bun not found" };
}

export interface TmuxCheckResult {
  installed: boolean;
  status: string;
}

/** Check if tmux is installed (required for Commander session). */
export async function check_tmux(): Promise<TmuxCheckResult> {
  const { exitCode, stdout } = await exec_command("tmux -V 2>/dev/null");
  if (exitCode === 0 && stdout.trim()) {
    return { installed: true, status: stdout.trim() };
  }
  return { installed: false, status: "tmux not found" };
}

export interface GhCheckResult {
  installed: boolean;
  authenticated: boolean;
  status: string;
}

/** Check if GitHub CLI is installed and authenticated. */
export async function check_github_cli(): Promise<GhCheckResult> {
  const { exitCode: which_exit } = await exec_command("which gh 2>/dev/null");
  if (which_exit !== 0) {
    return { installed: false, authenticated: false, status: "gh CLI not found" };
  }
  const { exitCode: auth_exit } = await exec_command("gh auth status 2>/dev/null");
  if (auth_exit === 0) {
    return { installed: true, authenticated: true, status: "gh CLI installed and authenticated" };
  }
  return { installed: true, authenticated: false, status: "gh CLI installed, not authenticated" };
}

export async function check_onepassword(): Promise<OnePasswordCheckResult> {
  const { exitCode: which_exit } = await exec_command("which op");
  const cli_installed = which_exit === 0;
  const token_configured = Boolean(process.env["OP_SERVICE_ACCOUNT_TOKEN"]);

  let status: string;
  if (cli_installed && token_configured) {
    status = "op CLI installed, service account token configured";
  } else if (cli_installed) {
    status = "op CLI installed, service account token NOT set (set OP_SERVICE_ACCOUNT_TOKEN)";
  } else {
    status = "op CLI not found (install with: brew install 1password-cli)";
  }

  return { cli_installed, token_configured, status };
}

// ── Optional Tool Detection ──

export interface TailscaleCheckResult {
  installed: boolean;
  running: boolean;
  authenticated: boolean;
  hostname: string | null;
  ip: string | null;
  gui_app_detected: boolean;
  gui_extension_running: boolean;
  status: string;
}

/** Check Tailscale installation, daemon status, and GUI conflicts. */
export async function check_tailscale(): Promise<TailscaleCheckResult> {
  const result: TailscaleCheckResult = {
    installed: false,
    running: false,
    authenticated: false,
    hostname: null,
    ip: null,
    gui_app_detected: false,
    gui_extension_running: false,
    status: "not installed",
  };

  const { exitCode: which_exit } = await exec_command("which tailscale 2>/dev/null");
  if (which_exit !== 0) return result;
  result.installed = true;

  // Check for GUI app conflict
  const { exitCode: app_exit } = await exec_command("ls /Applications/Tailscale.app 2>/dev/null");
  result.gui_app_detected = app_exit === 0;

  // Check for system extension running
  const { exitCode: ext_exit, stdout: ext_out } = await exec_command(
    "ps aux 2>/dev/null | grep io.tailscale.ipn.macsys.network-extension | grep -v grep",
  );
  result.gui_extension_running = ext_exit === 0 && ext_out.trim().length > 0;

  // Check daemon status and auth
  const { exitCode: status_exit, stdout: status_out } = await exec_command("tailscale status --json 2>/dev/null");
  if (status_exit !== 0) {
    result.status = "installed, daemon not running";
    return result;
  }

  result.running = true;

  try {
    const status_json = JSON.parse(status_out);
    const self = status_json.Self;
    if (self) {
      result.authenticated = true;
      result.hostname = self.HostName ?? self.DNSName?.split(".")[0] ?? null;
      const addrs: string[] = self.TailscaleIPs ?? [];
      // Prefer IPv4
      result.ip = addrs.find((a: string) => !a.includes(":")) ?? addrs[0] ?? null;
      result.status = `connected as ${result.hostname} (${result.ip})`;
    } else {
      result.status = "installed, not authenticated";
    }
  } catch {
    result.status = "installed, running (status parse failed)";
  }

  return result;
}

export interface DockerCheckResult {
  docker_installed: boolean;
  colima_installed: boolean;
  colima_running: boolean;
  docker_desktop_detected: boolean;
  docker_version: string | null;
  colima_version: string | null;
  status: string;
}

/** Check Docker/Colima installation and running state. */
export async function check_docker(): Promise<DockerCheckResult> {
  const result: DockerCheckResult = {
    docker_installed: false,
    colima_installed: false,
    colima_running: false,
    docker_desktop_detected: false,
    docker_version: null,
    colima_version: null,
    status: "not installed",
  };

  const { exitCode: docker_exit, stdout: docker_ver } = await exec_command("docker --version 2>/dev/null");
  result.docker_installed = docker_exit === 0;
  if (docker_exit === 0) {
    const match = docker_ver.match(/Docker version ([\d.]+)/);
    result.docker_version = match?.[1] ?? null;
  }

  const { exitCode: colima_exit, stdout: colima_ver } = await exec_command("colima version 2>/dev/null");
  result.colima_installed = colima_exit === 0;
  if (colima_exit === 0) {
    const match = colima_ver.match(/colima version ([\d.]+)/);
    result.colima_version = match?.[1] ?? null;
  }

  // Check for Docker Desktop conflict
  const { exitCode: desktop_exit } = await exec_command("ls /Applications/Docker.app 2>/dev/null");
  result.docker_desktop_detected = desktop_exit === 0;

  // Check if Colima is running
  if (result.colima_installed) {
    const { exitCode: running_exit } = await exec_command("colima status 2>/dev/null");
    result.colima_running = running_exit === 0;
  }

  // Build status string
  const parts: string[] = [];
  if (result.colima_installed) parts.push(`Colima v${result.colima_version ?? "?"}`);
  if (result.docker_installed) parts.push(`Docker v${result.docker_version ?? "?"}`);
  if (parts.length === 0) {
    result.status = "not installed";
  } else if (result.colima_running) {
    result.status = `${parts.join(", ")} (running)`;
  } else {
    result.status = `${parts.join(", ")} (stopped)`;
  }

  return result;
}

export interface VercelCheckResult {
  installed: boolean;
  authenticated: boolean;
  username: string | null;
  status: string;
}

/** Check Vercel CLI installation and auth state. */
export async function check_vercel(): Promise<VercelCheckResult> {
  const { exitCode: which_exit } = await exec_command("which vercel 2>/dev/null");
  if (which_exit !== 0) {
    return { installed: false, authenticated: false, username: null, status: "not installed" };
  }

  const { exitCode: whoami_exit, stdout: whoami_out } = await exec_command("vercel whoami 2>/dev/null");
  if (whoami_exit === 0 && whoami_out.trim()) {
    const username = whoami_out.trim();
    return { installed: true, authenticated: true, username, status: `authenticated as ${username}` };
  }

  return { installed: true, authenticated: false, username: null, status: "installed, not authenticated" };
}

export interface SupabaseCheckResult {
  installed: boolean;
  authenticated: boolean;
  version: string | null;
  status: string;
}

/** Check Supabase CLI installation and auth state. */
export async function check_supabase(): Promise<SupabaseCheckResult> {
  const { exitCode: which_exit, stdout: ver_out } = await exec_command("supabase --version 2>/dev/null");
  if (which_exit !== 0) {
    return { installed: false, authenticated: false, version: null, status: "not installed" };
  }

  const version = ver_out.trim() || null;

  // `supabase projects list` requires auth — exit code reveals auth state
  const { exitCode: auth_exit } = await exec_command("supabase projects list 2>/dev/null");
  if (auth_exit === 0) {
    return {
      installed: true,
      authenticated: true,
      version,
      status: `v${version}, authenticated`,
    };
  }

  return {
    installed: true,
    authenticated: false,
    version,
    status: `v${version}, not authenticated`,
  };
}

export interface SentryCheckResult {
  installed: boolean;
  authenticated: boolean;
  org: string | null;
  status: string;
}

/** Check Sentry CLI installation and auth state. */
export async function check_sentry(): Promise<SentryCheckResult> {
  const { exitCode: which_exit } = await exec_command("which sentry-cli 2>/dev/null");
  if (which_exit !== 0) {
    return { installed: false, authenticated: false, org: null, status: "not installed" };
  }

  const { exitCode: info_exit, stdout: info_out } = await exec_command("sentry-cli info 2>/dev/null");
  if (info_exit === 0) {
    // Parse org from sentry-cli info output (line like "Default Organization: ultim8")
    const org_match = info_out.match(/Default Organization:\s*(.+)/i);
    const org = org_match?.[1]?.trim() ?? null;
    return {
      installed: true,
      authenticated: true,
      org,
      status: org ? `authenticated (org: ${org})` : "authenticated",
    };
  }

  return { installed: true, authenticated: false, org: null, status: "installed, not authenticated" };
}
