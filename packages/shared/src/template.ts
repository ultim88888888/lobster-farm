import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { TemplateVariables } from "./schemas/template.js";

/**
 * Replace all {{KEY}} placeholders in a template string.
 * Unresolved placeholders are left as-is.
 * Also handles {{#BLOCK}}...{{/BLOCK}} regions:
 * - If the variable has content, the region is replaced with that content
 * - If the variable is empty/missing, the entire region (including markers) is removed
 */
export function resolve_template(
  template: string,
  variables: Partial<TemplateVariables>,
): string {
  let result = template;

  // Handle block regions first: {{#KEY}}...{{/KEY}}
  result = result.replace(
    /\{\{#(\w+)\}\}[\s\S]*?\{\{\/\1\}\}/g,
    (_match, key: string) => {
      const value = variables[key as keyof TemplateVariables];
      if (value && String(value).trim().length > 0) {
        return String(value);
      }
      return "";
    },
  );

  // Handle simple placeholders: {{KEY}}
  result = result.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = variables[key as keyof TemplateVariables];
    if (value !== undefined && value !== null) {
      return String(value);
    }
    return `{{${key}}}`;
  });

  return result;
}

/** Load a template file from disk and resolve placeholders. */
export async function load_and_resolve(
  template_path: string,
  variables: Partial<TemplateVariables>,
): Promise<string> {
  const content = await readFile(template_path, "utf-8");
  return resolve_template(content, variables);
}

/** Load a template, resolve placeholders, and write to an output path. */
export async function write_resolved(
  template_path: string,
  output_path: string,
  variables: Partial<TemplateVariables>,
): Promise<void> {
  const resolved = await load_and_resolve(template_path, variables);
  await mkdir(dirname(output_path), { recursive: true });
  await writeFile(output_path, resolved, "utf-8");
}

/** Find all unresolved {{KEY}} placeholders remaining in text. */
export function find_unresolved(text: string): string[] {
  const matches = text.matchAll(/\{\{(\w+)\}\}/g);
  const keys = new Set<string>();
  for (const match of matches) {
    keys.add(match[1]!);
  }
  return [...keys];
}
