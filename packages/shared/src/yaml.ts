import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { parse, stringify } from "yaml";
import type { z } from "zod";

/** Load a YAML file, parse it, and validate against a Zod schema. */
export async function load_yaml<T>(
  file_path: string,
  schema: z.ZodSchema<T>,
): Promise<T> {
  const content = await readFile(file_path, "utf-8");
  return parse_yaml(content, schema);
}

/** Parse a YAML string and validate against a Zod schema. */
export function parse_yaml<T>(
  content: string,
  schema: z.ZodSchema<T>,
): T {
  const raw: unknown = parse(content);
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`YAML validation failed:\n${issues}`);
  }
  return result.data;
}

/** Serialize data to YAML and write to a file. Creates parent directories. */
export async function write_yaml(
  file_path: string,
  data: unknown,
): Promise<void> {
  const content = stringify(data, { lineWidth: 120 });
  await mkdir(dirname(file_path), { recursive: true });
  await writeFile(file_path, content, "utf-8");
}
