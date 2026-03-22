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
