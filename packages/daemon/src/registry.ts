import { readdir } from "node:fs/promises";
import {
  EntityConfigSchema,
  type EntityConfig,
  type LobsterFarmConfig,
  entities_dir,
  entity_config_path,
  load_yaml,
} from "@lobster-farm/shared";

export class EntityRegistry {
  private entities: Map<string, EntityConfig> = new Map();
  private config: LobsterFarmConfig;

  constructor(config: LobsterFarmConfig) {
    this.config = config;
  }

  /**
   * Scan entity directories under ~/.lobsterfarm/entities/, validate each config.yaml
   * with EntityConfigSchema, and store valid configs. Logs warnings for invalid configs
   * but does not crash.
   */
  async load_all(): Promise<void> {
    this.entities.clear();
    const base_dir = entities_dir(this.config.paths);

    let entries: string[];
    try {
      const dir_entries = await readdir(base_dir, { withFileTypes: true });
      entries = dir_entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        console.log("No entities directory found; starting with empty registry.");
        return;
      }
      throw err;
    }

    for (const entity_id of entries) {
      const config_file = entity_config_path(this.config.paths, entity_id);
      try {
        const entity_config = await load_yaml(config_file, EntityConfigSchema) as EntityConfig;
        this.entities.set(entity_config.entity.id, entity_config);
        console.log(`Loaded entity: ${entity_config.entity.id} (${entity_config.entity.name})`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`Warning: Skipping entity "${entity_id}": ${message}`);
      }
    }
  }

  /** Get a single entity config by ID. */
  get(id: string): EntityConfig | undefined {
    return this.entities.get(id);
  }

  /** Get all entity configs. */
  get_all(): EntityConfig[] {
    return [...this.entities.values()];
  }

  /** Get all entity configs with status === "active". */
  get_active(): EntityConfig[] {
    return this.get_all().filter((e) => e.entity.status === "active");
  }

  /** Get the total number of loaded entities. */
  count(): number {
    return this.entities.size;
  }
}
