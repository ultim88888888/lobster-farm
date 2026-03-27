import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { entity_daily_dir, lobsterfarm_dir } from "@lobster-farm/shared";

const exec = promisify(execFile);

// ── Daily log management ──

function today_str(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Append a session summary to today's daily log. */
export async function append_to_daily_log(
  entity_id: string,
  content: string,
  config: LobsterFarmConfig,
): Promise<string> {
  const daily_dir = entity_daily_dir(config.paths, entity_id);
  await mkdir(daily_dir, { recursive: true });

  const log_path = join(daily_dir, `${today_str()}.md`);

  // Create file with header if it doesn't exist
  try {
    await readFile(log_path, "utf-8");
  } catch {
    await writeFile(
      log_path,
      `# Daily Log — ${today_str()}\n\n`,
      "utf-8",
    );
  }

  const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
  await appendFile(log_path, `\n## ${timestamp}\n\n${content}\n`, "utf-8");

  return log_path;
}

// ── Stop hook: session memory extraction ──

/**
 * Extract learnings from a completed session using Haiku.
 * Writes a summary to the daily log.
 *
 * This runs after a session completes. It asks Haiku to summarize
 * what was accomplished and what's worth remembering.
 */
export async function extract_session_learnings(
  entity_id: string,
  feature_id: string,
  archetype: string,
  session_id: string,
  config: LobsterFarmConfig,
): Promise<void> {
  const prompt = [
    "You are a memory extraction assistant. A Claude Code session just completed.",
    "",
    `Entity: ${entity_id}`,
    `Feature: ${feature_id}`,
    `Archetype: ${archetype}`,
    `Session: ${session_id}`,
    "",
    "Based on the session that just completed, write a brief summary for the daily log.",
    "Include:",
    "- What was worked on",
    "- Key decisions made",
    "- Any gotchas or issues encountered",
    "- Items that might be worth promoting to MEMORY.md",
    "",
    "Keep it concise — 3-8 bullet points. Write in markdown.",
  ].join("\n");

  try {
    const claude_bin = process.env["CLAUDE_BIN"] ?? "claude";
    const { stdout } = await exec(claude_bin, [
      "-p",
      "--model", "haiku",
      "--no-session-persistence",
      "--print",
      prompt,
    ], { timeout: 30_000 });

    const summary = stdout.trim();
    if (summary) {
      const entry = [
        `**Session: ${archetype} on ${feature_id}** (${session_id.slice(0, 8)})`,
        "",
        summary,
      ].join("\n");

      await append_to_daily_log(entity_id, entry, config);
      console.log(`[hooks] Extracted session learnings for ${feature_id}`);
    }
  } catch (err) {
    // Haiku extraction is best-effort — don't fail the flow
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[hooks] Memory extraction skipped: ${msg}`);

    // Still write a basic marker to the daily log
    const entry = `**Session ended: ${archetype} on ${feature_id}** (${session_id.slice(0, 8)}) — extraction skipped`;
    await append_to_daily_log(entity_id, entry, config);
  }
}

// ── Global learnings ──

const GLOBAL_LEARNINGS_FILE = "global-learnings.md";

/** Get the path to the global learnings file. */
export function global_learnings_path(config: LobsterFarmConfig): string {
  return join(lobsterfarm_dir(config.paths), GLOBAL_LEARNINGS_FILE);
}

/** Append a learning to the global learnings file. */
export async function append_global_learning(
  content: string,
  source_entity: string,
  config: LobsterFarmConfig,
): Promise<void> {
  const path = global_learnings_path(config);
  await mkdir(dirname(path), { recursive: true });

  // Create file with header if it doesn't exist
  try {
    await readFile(path, "utf-8");
  } catch {
    await writeFile(
      path,
      [
        "# Global Learnings",
        "",
        "_Cross-entity knowledge staging area. Reviewed by Commander and routed to DNA evolution or specific entities._",
        "",
      ].join("\n"),
      "utf-8",
    );
  }

  const timestamp = new Date().toISOString().split("T")[0];
  await appendFile(
    path,
    `\n### ${timestamp} (from ${source_entity})\n\n${content}\n`,
    "utf-8",
  );

  console.log(`[hooks] Global learning recorded from ${source_entity}`);
}
