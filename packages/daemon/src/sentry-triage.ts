/**
 * Sentry triage orchestration.
 *
 * When a new error or regression appears in Sentry, the daemon calls
 * `handle_sentry_triage_event()`. This module:
 *   1. Classifies the event (triage-worthy vs alert-only vs ignore)
 *   2. Deduplicates against active and recently-completed triages
 *   3. Rate-limits concurrent triage sessions (max 2)
 *   4. Fetches full Sentry issue details via the API
 *   5. Spawns a Ray (operator) session with a structured prompt
 *   6. Tracks triage state in memory and on disk
 *
 * Pattern mirrors webhook-handler.ts (GitHub PR review handler):
 * receive event → enrich with API → spawn session → track → handle completion.
 */

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { lobsterfarm_dir, expand_home } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import type { ClaudeSessionManager, SessionResult } from "./session.js";
import type { EntityRegistry } from "./registry.js";
import type { DiscordBot } from "./discord.js";
import { fetch_sentry_issue_details, type SentryIssueDetails } from "./sentry-api.js";
import * as sentry from "./sentry.js";

// ── Constants ──

const MAX_CONCURRENT_TRIAGES = 2;
const MAX_QUEUE_DEPTH = 5;
const TRIAGE_TIMEOUT_MS = 30 * 60 * 1000;   // 30 minutes
const TRIAGE_COOLDOWN_MS = 24 * 60 * 60 * 1000;  // 24 hours

// ── Public context type ──

export interface SentryTriageContext {
  session_manager: ClaudeSessionManager;
  registry: EntityRegistry;
  discord: DiscordBot | null;
  config: LobsterFarmConfig;
}

// ── Sentry webhook payload shapes ──

export interface SentryProject {
  id: string;
  slug: string;
  name: string;
}

export interface SentryIssueWebhook {
  id: string;
  title: string;
  culprit?: string;
  level?: string;
  status?: string;
  permalink?: string;
  web_url?: string;
  shortId?: string;
  project?: SentryProject;
}

export interface SentryWebhookPayload {
  action?: string;
  data?: {
    issue?: SentryIssueWebhook;
    project?: SentryProject;
    project_name?: string;
  };
}

// ── Entity config sentry project type ──

export interface SentryProjectConfig {
  slug: string;
  type?: string;  // e.g. "frontend" | "backend"
  repo?: string;  // which entity repo this maps to
}

// ── Active triage tracking ──

interface ActiveTriage {
  entity_id: string;
  session_id: string;
  started_at: Date;
  sentry_issue_url: string;
  project_slug: string;
  error_title: string;
}

const active_triages = new Map<string, ActiveTriage>();

// Pending queue: events that arrived when at capacity
const triage_queue: Array<{
  sentry_issue_id: string;
  entity_id: string;
  project_info: SentryProjectConfig;
  issue_details: SentryIssueDetails;
  action: string;
  repo_path: string;
}> = [];

function cleanup_stale_triages(): void {
  const now = Date.now();
  for (const [id, triage] of active_triages) {
    if (now - triage.started_at.getTime() > TRIAGE_TIMEOUT_MS) {
      console.log(`[sentry-triage] Cleaning up stale triage entry for ${id}`);
      active_triages.delete(id);
    }
  }
}

function is_at_capacity(): boolean {
  return active_triages.size >= MAX_CONCURRENT_TRIAGES;
}

// ── State persistence ──

export interface SentryTriageRecord {
  entity_id: string;
  project_slug: string;
  error_title: string;
  level?: string;
  github_issue?: number;
  triaged_at: string;       // ISO timestamp
  status: "investigating" | "tracked" | "dismissed" | "auto-resolved";
  sentry_url: string;
}

export interface SentryTriageState {
  triages: Record<string, SentryTriageRecord>;
  stats: {
    total_triaged: number;
    issues_created: number;
    dismissed: number;
    last_triage_at: string;
  };
}

function state_file_path(config: LobsterFarmConfig): string {
  return join(lobsterfarm_dir(config.paths), "state", "sentry-triages.json");
}

export async function load_triage_state(config: LobsterFarmConfig): Promise<SentryTriageState> {
  const path = state_file_path(config);
  try {
    const content = await readFile(path, "utf-8");
    return JSON.parse(content) as SentryTriageState;
  } catch {
    return {
      triages: {},
      stats: {
        total_triaged: 0,
        issues_created: 0,
        dismissed: 0,
        last_triage_at: "",
      },
    };
  }
}

export async function save_triage_state(
  state: SentryTriageState,
  config: LobsterFarmConfig,
): Promise<void> {
  const path = state_file_path(config);
  const tmp_path = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp_path, JSON.stringify(state, null, 2), "utf-8");
  await rename(tmp_path, path);
}

// Serialize state writes to prevent read-modify-write races when
// multiple concurrent triage sessions complete near-simultaneously.
let state_write_lock = Promise.resolve();

async function update_triage_state(
  sentry_issue_id: string,
  update: Partial<SentryTriageRecord>,
  config: LobsterFarmConfig,
): Promise<void> {
  // .catch(() => {}) absorbs any prior rejection so a single transient disk error
  // (full disk, interrupted write) does not permanently poison the chain.
  // Same pattern as webhook-handler.ts.
  state_write_lock = state_write_lock.catch(() => {}).then(async () => {
    const state = await load_triage_state(config);
    state.triages[sentry_issue_id] = { ...state.triages[sentry_issue_id], ...update } as SentryTriageRecord;
    state.stats.last_triage_at = new Date().toISOString();
    await save_triage_state(state, config);
  });
  await state_write_lock;
}

// ── Cooldown check ──

/**
 * Returns true if this issue should be triaged.
 *
 * Skips if:
 *   - Already being actively triaged (in-memory dedup)
 *   - Triaged within the last 24h (persistent cooldown)
 *
 * Exception: regression events always triage even if within cooldown,
 * because the error context has changed since the last investigation.
 */
async function should_triage(
  sentry_issue_id: string,
  action: string,
  config: LobsterFarmConfig,
): Promise<{ proceed: boolean; reason: string }> {
  cleanup_stale_triages();

  // In-memory dedup: active triage already running
  if (active_triages.has(sentry_issue_id)) {
    return { proceed: false, reason: "already actively triaging" };
  }

  // Persistent cooldown check (skip for regressions — context has changed)
  if (action !== "regression") {
    const state = await load_triage_state(config);
    const record = state.triages[sentry_issue_id];
    if (record?.triaged_at && record.status !== "dismissed") {
      const age_ms = Date.now() - new Date(record.triaged_at).getTime();
      if (age_ms < TRIAGE_COOLDOWN_MS) {
        const hours = Math.floor(age_ms / (60 * 60 * 1000));
        return {
          proceed: false,
          reason: `triaged ${String(hours)}h ago (cooldown: 24h)`,
        };
      }
    }
  }

  return { proceed: true, reason: "" };
}

// ── Entity resolution ──

/**
 * Find the entity that owns a given Sentry project slug.
 * Checks `entity.accounts.sentry.projects[].slug` in each entity config.
 *
 * Returns null if no entity is configured for this project.
 */
function find_entity_for_sentry_project(
  project_slug: string,
  registry: EntityRegistry,
): { entity_id: string; project_info: SentryProjectConfig; repo_path: string } | null {
  for (const entry of registry.get_active()) {
    const accounts = entry.entity.accounts as Record<string, unknown> | undefined;
    const sentry_config = accounts?.["sentry"] as Record<string, unknown> | undefined;
    const projects = sentry_config?.["projects"] as SentryProjectConfig[] | undefined;

    if (!projects?.length) continue;

    const project_info = projects.find((p) => p.slug === project_slug);
    if (!project_info) continue;

    // Resolve repo path: use the named repo if specified, else first repo
    const target_repo_name = project_info.repo;
    const repos = entry.entity.repos;
    const repo = target_repo_name
      ? repos.find((r) => r.name === target_repo_name) ?? repos[0]
      : repos[0];

    if (!repo) return null;

    const repo_path = expand_home(repo.path);

    return { entity_id: entry.entity.id, project_info, repo_path };
  }

  return null;
}

// ── Triage prompt ──

function build_triage_prompt(
  entity_name: string,
  project_info: SentryProjectConfig,
  issue_details: SentryIssueDetails,
  action: string,
): string {
  const contexts_text = Object.keys(issue_details.contexts).length > 0
    ? JSON.stringify(issue_details.contexts, null, 2)
    : "(none)";

  const request_text = issue_details.request
    ? [
        issue_details.request.method && `Method: ${issue_details.request.method}`,
        issue_details.request.url && `URL: ${issue_details.request.url}`,
      ].filter(Boolean).join("\n") || "(request info available but empty)"
    : "(no request context)";

  const tags_text = issue_details.tags.length > 0
    ? issue_details.tags.map((t) => `${t.key}: ${t.value}`).join("\n")
    : "(no tags)";

  return `You are triaging a Sentry error for the ${entity_name} project.

## Error Details

**Title:** ${issue_details.title}
**Severity:** ${issue_details.level}
**Project:** ${project_info.slug}${project_info.type ? ` (${project_info.type})` : ""}
**First seen:** ${issue_details.first_seen}
**Last seen:** ${issue_details.last_seen}
**Occurrences:** ${issue_details.count}
**Action:** ${action}
**Culprit:** ${issue_details.culprit}
**Platform:** ${issue_details.platform}
**Sentry URL:** ${issue_details.web_url}

## Tags

${tags_text}

## Stack Trace

\`\`\`
${issue_details.stack_trace}
\`\`\`

## Request Context

${request_text}

## Event Contexts

\`\`\`json
${contexts_text}
\`\`\`

## Your Task

1. **Investigate the source code** — read the files referenced in the stack trace. Understand what went wrong.

2. **Check recent changes** — run \`git log --oneline -20\` and \`gh pr list --state merged --limit 10\` to see if a recent change introduced this. If so, identify the PR.

3. **Classify severity:**
   - **P0 (Critical):** Auth failures, data loss/corruption, payment errors, security issues, complete feature breakage. Requires immediate attention.
   - **P1 (High):** New error types affecting core flows, regressions from recent deploys. Same-day fix.
   - **P2 (Low):** Edge cases, non-critical UI errors, errors in non-core flows. Track and fix when convenient.

4. **Post your diagnosis to #alerts.** Include:
   - What went wrong (1-2 sentences)
   - Root cause (code path, recent change, or external trigger)
   - Severity classification with rationale
   - Whether a GitHub issue is warranted

5. **If P0 or P1:** Create a GitHub issue with:
   - Title: \`fix: {concise description}\`
   - Body: diagnosis, affected code paths, stack trace summary, suggested fix approach, link to Sentry issue
   - The issue body should include \`Sentry: ${issue_details.web_url}\` for traceability

6. **If P2 or noise:** Post to #alerts only. If it's a known non-issue (expected error, operational noise), recommend adding it to Sentry's \`ignoreErrors\` or \`beforeSend\` filter.

7. **If P0 (Critical):** After creating the issue, post an urgent message to #alerts flagging it for immediate human attention.

Do NOT attempt to fix the code yourself. Diagnose only.`;
}

// ── Queue processing ──

async function process_queue(ctx: SentryTriageContext): Promise<void> {
  while (triage_queue.length > 0 && !is_at_capacity()) {
    const item = triage_queue.shift();
    if (!item) break;

    console.log(
      `[sentry-triage] Processing queued triage for issue ${item.sentry_issue_id} ` +
      `(${String(triage_queue.length)} remaining in queue)`,
    );

    await spawn_triage_session(
      item.sentry_issue_id,
      item.entity_id,
      item.project_info,
      item.issue_details,
      item.action,
      item.repo_path,
      ctx,
    );
  }
}

// ── Session spawning ──

async function spawn_triage_session(
  sentry_issue_id: string,
  entity_id: string,
  project_info: SentryProjectConfig,
  issue_details: SentryIssueDetails,
  action: string,
  repo_path: string,
  ctx: SentryTriageContext,
): Promise<void> {
  // Record as investigating in persistent state
  await update_triage_state(
    sentry_issue_id,
    {
      entity_id,
      project_slug: project_info.slug,
      error_title: issue_details.title,
      level: issue_details.level,
      triaged_at: new Date().toISOString(),
      status: "investigating",
      sentry_url: issue_details.web_url,
    },
    ctx.config,
  );

  // Look up the entity name for the prompt
  const entity_entry = ctx.registry.get(entity_id);
  const entity_name = entity_entry?.entity.name ?? entity_id;

  const prompt = build_triage_prompt(entity_name, project_info, issue_details, action);

  let session;
  try {
    session = await ctx.session_manager.spawn({
      entity_id,
      feature_id: `sentry-triage-${sentry_issue_id}`,
      archetype: "operator",
      dna: [],
      model: { model: "sonnet", think: "standard" },
      worktree_path: repo_path,
      prompt,
      interactive: false,
    });
  } catch (err) {
    console.error(
      `[sentry-triage] Failed to spawn triage session for ${sentry_issue_id}: ${String(err)}`,
    );
    sentry.captureException(err, {
      tags: { module: "sentry-triage", entity: entity_id },
      contexts: { issue: { id: sentry_issue_id, title: issue_details.title } },
    });
    // Remove the investigating record so a future event can retry
    await update_triage_state(sentry_issue_id, { status: "dismissed" }, ctx.config);
    return;
  }

  console.log(
    `[sentry-triage] Spawned Ray session ${session.session_id.slice(0, 8)} ` +
    `for Sentry issue ${sentry_issue_id}`,
  );

  // Track in-memory
  active_triages.set(sentry_issue_id, {
    entity_id,
    session_id: session.session_id,
    started_at: new Date(),
    sentry_issue_url: issue_details.web_url,
    project_slug: project_info.slug,
    error_title: issue_details.title,
  });

  // ── Post-session listeners ──

  const on_complete = (result: SessionResult): void => {
    if (result.session_id !== session.session_id) return;
    ctx.session_manager.removeListener("session:completed", on_complete);
    ctx.session_manager.removeListener("session:failed", on_fail);

    console.log(
      `[sentry-triage] Triage session completed for ${sentry_issue_id}`,
    );

    active_triages.delete(sentry_issue_id);

    // Update state: mark completed (Ray will have posted its own diagnosis/issue)
    void update_triage_state(
      sentry_issue_id,
      { status: "tracked" },
      ctx.config,
    ).catch((err) => {
      console.error(`[sentry-triage] Failed to update state after completion: ${String(err)}`);
    });

    // Drain the queue now that a slot opened
    void process_queue(ctx).catch((err) => {
      console.error(`[sentry-triage] Queue drain error: ${String(err)}`);
    });
  };

  const on_fail = (session_id: string, error: string): void => {
    if (session_id !== session.session_id) return;
    ctx.session_manager.removeListener("session:completed", on_complete);
    ctx.session_manager.removeListener("session:failed", on_fail);

    console.error(
      `[sentry-triage] Ray session failed for ${sentry_issue_id}: ${error}`,
    );
    sentry.captureException(new Error(error), {
      tags: { module: "sentry-triage", entity: entity_id },
      contexts: { issue: { id: sentry_issue_id } },
    });

    active_triages.delete(sentry_issue_id);

    void update_triage_state(
      sentry_issue_id,
      { status: "dismissed" },
      ctx.config,
    ).catch((e) => {
      console.error(`[sentry-triage] Failed to update state after failure: ${String(e)}`);
    });

    void process_queue(ctx).catch((e) => {
      console.error(`[sentry-triage] Queue drain error after failure: ${String(e)}`);
    });
  };

  ctx.session_manager.on("session:completed", on_complete);
  ctx.session_manager.on("session:failed", on_fail);
}

// ── Main entry point ──

/**
 * Handle a triage-worthy Sentry event (action: created | regression).
 *
 * Called by `process_sentry_webhook()` in server.ts after basic classification.
 * Does its own dedup/rate-limit checks so server.ts stays clean.
 */
export async function handle_sentry_triage_event(
  sentry_issue_id: string,
  project_slug: string,
  action: string,
  ctx: SentryTriageContext,
): Promise<void> {
  // Resolve entity and project config
  const match = find_entity_for_sentry_project(project_slug, ctx.registry);
  if (!match) {
    console.log(
      `[sentry-triage] No entity configured for Sentry project "${project_slug}" — skipping triage`,
    );
    return;
  }

  const { entity_id, project_info, repo_path } = match;

  // Dedup + cooldown check
  const { proceed, reason } = await should_triage(sentry_issue_id, action, ctx.config);
  if (!proceed) {
    console.log(
      `[sentry-triage] Skipping triage for ${sentry_issue_id}: ${reason}`,
    );
    return;
  }

  // Fetch full issue details before spawning (keeps Sentry creds out of agent)
  const auth_token = process.env["SENTRY_AUTH_TOKEN"];
  const org_slug = process.env["SENTRY_ORG"];

  if (!auth_token || !org_slug) {
    console.warn(
      "[sentry-triage] SENTRY_AUTH_TOKEN or SENTRY_ORG not configured — " +
      "cannot fetch issue details, skipping triage",
    );
    return;
  }

  let issue_details: SentryIssueDetails;
  try {
    issue_details = await fetch_sentry_issue_details(sentry_issue_id, auth_token, org_slug);
  } catch (err) {
    console.error(
      `[sentry-triage] Failed to fetch Sentry issue ${sentry_issue_id}: ${String(err)}`,
    );
    sentry.captureException(err, {
      tags: { module: "sentry-triage", entity: entity_id },
      contexts: { issue: { id: sentry_issue_id } },
    });
    return;
  }

  console.log(
    `[sentry-triage] Triage event: ${action} for issue ${sentry_issue_id} ` +
    `(${project_slug} → entity "${entity_id}")`,
  );

  // Rate limit: check concurrent capacity
  cleanup_stale_triages();
  if (is_at_capacity()) {
    if (triage_queue.length >= MAX_QUEUE_DEPTH) {
      // Queue is full — something is very wrong. Alert but don't burn sessions.
      console.warn(
        `[sentry-triage] Queue full (${String(MAX_QUEUE_DEPTH)} items) — ` +
        `dropping triage for ${sentry_issue_id}. Too many errors arriving simultaneously.`,
      );
      if (ctx.discord) {
        await ctx.discord
          .send_to_entity(
            entity_id,
            "alerts",
            `Sentry triage queue full (${String(MAX_QUEUE_DEPTH)} items). ` +
            `Dropping triage for: ${issue_details.title}\n${issue_details.web_url}`,
            "system",
          )
          .catch((e) => console.error(`[sentry-triage] Discord alert error: ${String(e)}`));
      }
      return;
    }

    console.log(
      `[sentry-triage] At capacity (${String(MAX_CONCURRENT_TRIAGES)} concurrent) — ` +
      `queuing issue ${sentry_issue_id}`,
    );
    triage_queue.push({
      sentry_issue_id,
      entity_id,
      project_info,
      issue_details,
      action,
      repo_path,
    });
    return;
  }

  await spawn_triage_session(
    sentry_issue_id,
    entity_id,
    project_info,
    issue_details,
    action,
    repo_path,
    ctx,
  );
}

// ── Test helpers ──

/**
 * Reset module-level state between tests. Not for production use.
 */
export function _reset_for_test(): void {
  active_triages.clear();
  triage_queue.length = 0;
  state_write_lock = Promise.resolve();
}

/**
 * Handle a `resolved` event for a Sentry issue.
 * Updates persistent state if we were tracking this issue.
 */
export async function handle_sentry_resolved(
  sentry_issue_id: string,
  config: LobsterFarmConfig,
): Promise<void> {
  const state = await load_triage_state(config);
  const record = state.triages[sentry_issue_id];
  if (record && record.status !== "auto-resolved") {
    console.log(`[sentry-triage] Issue ${sentry_issue_id} resolved — updating state`);
    await update_triage_state(sentry_issue_id, { status: "auto-resolved" }, config);
  }
}
