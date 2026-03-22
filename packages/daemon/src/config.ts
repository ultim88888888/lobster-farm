import { access } from "node:fs/promises";
import {
  LobsterFarmConfigSchema,
  type LobsterFarmConfig,
  global_config_path,
  load_yaml,
} from "@lobster-farm/shared";

/**
 * Load the global LobsterFarm config from ~/.lobsterfarm/config.yaml.
 * If the file does not exist, prints a helpful error message and exits.
 */
export async function load_config(): Promise<LobsterFarmConfig> {
  const config_path = global_config_path();

  try {
    await access(config_path);
  } catch {
    console.error(
      `Error: LobsterFarm config not found at ${config_path}\n\n` +
      `Run \`lobsterfarm init\` to create the initial configuration.`,
    );
    process.exit(1);
  }

  try {
    // load_yaml validates via safeParse and returns data with all Zod defaults applied.
    // The cast is needed because z.ZodSchema<T> infers T as the input type, but
    // safeParse().data always produces the output type with defaults resolved.
    return await load_yaml(config_path, LobsterFarmConfigSchema) as LobsterFarmConfig;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: Failed to load config from ${config_path}\n\n${message}`);
    process.exit(1);
  }
}
