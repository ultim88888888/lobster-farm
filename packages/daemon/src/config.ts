import { access } from "node:fs/promises";
import {
  LobsterFarmConfigSchema,
  type LobsterFarmConfig,
  global_config_path,
  load_yaml,
} from "@lobster-farm/shared";

/**
 * Load the global LobsterFarm config.
 *
 * Resolution order:
 * 1. LF_CONFIG_PATH env var (explicit override)
 * 2. ~/.lobsterfarm/config.yaml (default)
 *
 * If the file does not exist, prints a helpful error message and exits.
 */
export async function load_config(): Promise<LobsterFarmConfig> {
  const config_path = process.env["LF_CONFIG_PATH"] ?? global_config_path();

  try {
    await access(config_path);
  } catch {
    console.error(
      `Error: LobsterFarm config not found at ${config_path}\n\n` +
      `Run \`lobsterfarm init\` to create the initial configuration.\n` +
      `Or set LF_CONFIG_PATH to point to an existing config.yaml.`,
    );
    process.exit(1);
  }

  try {
    return await load_yaml(config_path, LobsterFarmConfigSchema) as LobsterFarmConfig;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: Failed to load config from ${config_path}\n\n${message}`);
    process.exit(1);
  }
}
