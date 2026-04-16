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
 *   7. Parses Ray's structured verdict and auto-spawns Bob to fix (#250)
 *
 * Self-healing flow (added in #250):
 *   Sentry webhook → Ray diagnoses → structured verdict → daemon parses
 *   → Bob fixes → PR → AutoReviewer merges
 *
 * Pattern mirrors webhook-handler.ts (GitHub PR review handler):
 * receive event → enrich with API → spawn session → track → handle completion.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expand_home, lobsterfarm_dir } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import type { DiscordBot } from "./discord.js";
import type { GitHubAppAuth } from "./github-app.js";
import type { EntityRegistry } from "./registry.js";
import { MAX_SENTRY_FIX_ATTEMPTS, build_sentry_fix_prompt } from "./review-utils.js";
import { get_cached_issue_details } from "./sentry-alert-format.js";
import { type SentryIssueDetails, fetch_sentry_issue_details } from "./sentry-api.js";
import * as sentry from "./sentry.js";
import type { ActiveSession, ClaudeSessionManager, SessionResult } from "./session.js";

// ── Constants ──

const MAX_CONCURRENT_TRIAGES = 2;
const MAX_QUEUE_DEPTH = 5;
const TRIAGE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const TRIAGE_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── Public context type ──

export interface SentryTriageContext {
  session_manager: ClaudeSessionManager;
  registry: EntityRegistry;
  discord: DiscordBot | null;
  config: LobsterFarmConfig;
  github_app: GitHubAppAuth | null;
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
  type?: string; // e.g. "frontend" | "backend"
  repo?: string; // which entity repo this maps to
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
  triaged_at: string; // ISO timestamp
  status: "investigating" | "tracked" | "dismissed" | "auto-resolved";
  sentry_url: string;
  // Auto-fix fields (#250)
  severity?: "P0" | "P1" | "P2";
  auto_fixable?: boolean;
  fix_approach?: string;
  fix_attempts?: number;
  fix_session_id?: string;
  fix_status?: "pending" | "fixing" | "fixed" | "failed";
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
  state_write_lock = state_write_lock
    .catch(() => {})
    .then(async () => {
      const state = await load_triage_state(config);
      state.triages[sentry_issue_id] = {
        ...state.triages[sentry_issue_id],
        ...update,
      } as SentryTriageRecord;
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

// ── Verdict parsing (#250) ──

export interface TriageVerdict {
  severity: "P0" | "P1" | "P2";
  auto_fixable: boolean;
  github_issue: number | null;
  fix_approach: string | null;
}

const VERDICT_MARKER = "SENTRY_TRIAGE_VERDICT:";

/**
 * Parse a structured verdict from Ray's triage output.
 *
 * Searches output_lines in reverse for the SENTRY_TRIAGE_VERDICT: marker,
 * then parses the JSON payload after it. Returns null on any failure
 * (missing marker, malformed JSON, missing required fields).
 *
 * Null = no auto-fix = safe fallback.
 */
export function parse_triage_verdict(output_lines: string[] | undefined): TriageVerdict | null {
  if (!output_lines || output_lines.length === 0) return null;

  // Search in reverse — the verdict should be the last thing Ray outputs
  for (let i = output_lines.length - 1; i >= 0; i--) {
    const line = output_lines[i]!;
    const marker_idx = line.indexOf(VERDICT_MARKER);
    if (marker_idx === -1) continue;

    const json_str = line.slice(marker_idx + VERDICT_MARKER.length).trim();
    try {
      const parsed = JSON.parse(json_str) as Record<string, unknown>;

      // Validate required fields
      const severity = parsed.severity;
      if (severity !== "P0" && severity !== "P1" && severity !== "P2") return null;

      if (typeof parsed.auto_fixable !== "boolean") return null;

      const github_issue =
        parsed.github_issue === null || parsed.github_issue === undefined
          ? null
          : typeof parsed.github_issue === "number"
            ? parsed.github_issue
            : null;

      // github_issue must be null or a number — reject other types
      if (
        parsed.github_issue !== null &&
        parsed.github_issue !== undefined &&
        typeof parsed.github_issue !== "number"
      ) {
        return null;
      }

      const fix_approach = typeof parsed.fix_approach === "string" ? parsed.fix_approach : null;

      return {
        severity,
        auto_fixable: parsed.auto_fixable,
        github_issue,
        fix_approach,
      };
    } catch {
      // Malformed JSON — safe fallback
      return null;
    }
  }

  return null;
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
    const sentry_config = accounts?.sentry as Record<string, unknown> | undefined;
    const projects = sentry_config?.projects as SentryProjectConfig[] | undefined;

    if (!projects?.length) continue;

    const project_info = projects.find((p) => p.slug === project_slug);
    if (!project_info) continue;

    // Resolve repo path: use the named repo if specified, else first repo
    const target_repo_name = project_info.repo;
    const repos = entry.entity.repos;
    const repo = target_repo_name
      ? (repos.find((r) => r.name === target_repo_name) ?? repos[0])
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
  const contexts_text =
    Object.keys(issue_details.contexts).length > 0
      ? JSON.stringify(issue_details.contexts, null, 2)
      : "(none)";

  const request_text = issue_details.request
    ? [
        issue_details.request.method && `Method: ${issue_details.request.method}`,
        issue_details.request.url && `URL: ${issue_details.request.url}`,
      ]
        .filter(Boolean)
        .join("\n") || "(request info available but empty)"
    : "(no request context)";

  const tags_text =
    issue_details.tags.length > 0
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

8. **Output a structured verdict** as the very last line of your session. This MUST be a single line in exactly this format:

SENTRY_TRIAGE_VERDICT:{"severity":"P0|P1|P2","auto_fixable":boolean,"github_issue":number|null,"fix_approach":"string or null"}

Rules for auto_fixable:
- true ONLY if: clear code bug with identifiable fix path in this repo.
- false if: involves auth/permissions/encryption, touches user data, requires infra changes, involves third-party deps, root cause is ambiguous, or fix requires architectural decisions.
- When in doubt, false.

Do NOT attempt to fix the code yourself. Diagnose only.`;
}

// ── GitHub token resolution ──

/**
 * Resolve a GitHub App installation token for the given entity.
 * Uses the entity's `github_app_installation_id` if configured,
 * otherwise falls back to the default installation from env.
 *
 * Same pattern as pr-cron's resolve_entity_token, extracted as a
 * standalone function since sentry-triage doesn't live in a class.
 */
async function resolve_gh_token(
  github_app: GitHubAppAuth,
  entity_id: string,
  registry: EntityRegistry,
): Promise<string | undefined> {
  const entry = registry.get(entity_id);
  const override_id = entry?.entity.accounts?.github?.github_app_installation_id;
  try {
    return override_id
      ? await github_app.get_token_for_installation(override_id)
      : await github_app.get_token();
  } catch (err) {
    console.warn(`[sentry-triage] Failed to resolve GH token for ${entity_id}: ${String(err)}`);
    return undefined;
  }
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

  // Resolve GitHub token so Ray can use `gh` CLI (issue creation, PR listing)
  let spawn_env: Record<string, string> | undefined;
  if (ctx.github_app) {
    const gh_token = await resolve_gh_token(ctx.github_app, entity_id, ctx.registry);
    if (gh_token) {
      spawn_env = { GH_TOKEN: gh_token };
    }
  }

  let session: ActiveSession;
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
      env: spawn_env,
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

    console.log(`[sentry-triage] Triage session completed for ${sentry_issue_id}`);

    active_triages.delete(sentry_issue_id);

    // Parse structured verdict from Ray's output (#250)
    const verdict = parse_triage_verdict(result.output_lines);

    if (verdict) {
      // Update state with verdict data
      void update_triage_state(
        sentry_issue_id,
        {
          status: "tracked",
          severity: verdict.severity,
          auto_fixable: verdict.auto_fixable,
          fix_approach: verdict.fix_approach ?? undefined,
          github_issue: verdict.github_issue ?? undefined,
        },
        ctx.config,
      )
        .then(() => {
          // Spawn auto-fix if eligible: auto_fixable, not P0, has a GitHub issue
          if (verdict.auto_fixable && verdict.severity !== "P0" && verdict.github_issue != null) {
            return spawn_sentry_fix(
              sentry_issue_id,
              entity_id,
              verdict,
              issue_details,
              repo_path,
              ctx,
            );
          }
        })
        .catch((err) => {
          console.error(
            `[sentry-triage] Failed to update state / spawn fix after completion: ${String(err)}`,
          );
        });
    } else {
      // No verdict parsed — legacy behavior: mark as tracked
      void update_triage_state(sentry_issue_id, { status: "tracked" }, ctx.config).catch((err) => {
        console.error(`[sentry-triage] Failed to update state after completion: ${String(err)}`);
      });
    }

    // Drain the queue now that a slot opened
    void process_queue(ctx).catch((err) => {
      console.error(`[sentry-triage] Queue drain error: ${String(err)}`);
    });
  };

  const on_fail = (session_id: string, error: string): void => {
    if (session_id !== session.session_id) return;
    ctx.session_manager.removeListener("session:completed", on_complete);
    ctx.session_manager.removeListener("session:failed", on_fail);

    console.error(`[sentry-triage] Ray session failed for ${sentry_issue_id}: ${error}`);
    sentry.captureException(new Error(error), {
      tags: { module: "sentry-triage", entity: entity_id },
      contexts: { issue: { id: sentry_issue_id } },
    });

    active_triages.delete(sentry_issue_id);

    void update_triage_state(sentry_issue_id, { status: "dismissed" }, ctx.config).catch((e) => {
      console.error(`[sentry-triage] Failed to update state after failure: ${String(e)}`);
    });

    void process_queue(ctx).catch((e) => {
      console.error(`[sentry-triage] Queue drain error after failure: ${String(e)}`);
    });
  };

  ctx.session_manager.on("session:completed", on_complete);
  ctx.session_manager.on("session:failed", on_fail);
}

// ── Auto-fix spawning (#250) ──

/**
 * Spawn a Bob (builder) session to auto-fix a Sentry error after triage.
 *
 * Only called when Ray's verdict indicates the error is auto_fixable,
 * not P0, and has an associated GitHub issue.
 *
 * Fix sessions do NOT count against the triage concurrency cap
 * (MAX_CONCURRENT_TRIAGES) — they are separate work.
 */
async function spawn_sentry_fix(
  sentry_issue_id: string,
  entity_id: string,
  verdict: TriageVerdict,
  issue_details: SentryIssueDetails,
  repo_path: string,
  ctx: SentryTriageContext,
): Promise<void> {
  // Load current state to check fix_attempts
  const state = await load_triage_state(ctx.config);
  const record = state.triages[sentry_issue_id];
  const current_attempts = record?.fix_attempts ?? 0;

  if (current_attempts >= MAX_SENTRY_FIX_ATTEMPTS) {
    console.log(
      `[sentry-triage] Fix attempt cap reached for ${sentry_issue_id} ` +
        `(${String(current_attempts)}/${String(MAX_SENTRY_FIX_ATTEMPTS)}) — skipping auto-fix`,
    );
    return;
  }

  const attempt = current_attempts + 1;

  // Update state: increment attempts, mark as fixing
  await update_triage_state(
    sentry_issue_id,
    { fix_attempts: attempt, fix_status: "fixing" },
    ctx.config,
  );

  const prompt = build_sentry_fix_prompt(verdict, {
    title: issue_details.title,
    web_url: issue_details.web_url,
    stack_trace: issue_details.stack_trace,
    culprit: issue_details.culprit,
  });

  // Resolve GitHub token so Bob can push branches and open PRs
  let spawn_env: Record<string, string> | undefined;
  if (ctx.github_app) {
    const gh_token = await resolve_gh_token(ctx.github_app, entity_id, ctx.registry);
    if (gh_token) {
      spawn_env = { GH_TOKEN: gh_token };
    }
  }

  console.log(
    `[sentry-triage] Spawning Bob for Sentry fix in ${entity_id} ` +
      `(issue ${sentry_issue_id}, attempt ${String(attempt)}/${String(MAX_SENTRY_FIX_ATTEMPTS)})`,
  );

  let fix_session: ActiveSession;
  try {
    fix_session = await ctx.session_manager.spawn({
      entity_id,
      feature_id: `sentry-fix-${sentry_issue_id}`,
      archetype: "builder",
      dna: ["coding-dna"],
      model: { model: "opus", think: "high" },
      worktree_path: repo_path,
      prompt,
      interactive: false,
      env: spawn_env,
    });
  } catch (err) {
    console.error(
      `[sentry-triage] Failed to spawn fix session for ${sentry_issue_id}: ${String(err)}`,
    );
    sentry.captureException(err, {
      tags: { module: "sentry-triage", entity: entity_id, action: "spawn_sentry_fix" },
      contexts: { issue: { id: sentry_issue_id, title: issue_details.title } },
    });
    await update_triage_state(sentry_issue_id, { fix_status: "failed" }, ctx.config);
    return;
  }

  // Update state with session ID
  await update_triage_state(
    sentry_issue_id,
    { fix_session_id: fix_session.session_id },
    ctx.config,
  );

  // ── Fix session lifecycle listeners ──

  const on_fix_complete = (result: SessionResult): void => {
    if (result.session_id !== fix_session.session_id) return;
    ctx.session_manager.removeListener("session:completed", on_fix_complete);
    ctx.session_manager.removeListener("session:failed", on_fix_fail);

    console.log(`[sentry-triage] Fix session completed for ${sentry_issue_id}`);

    void update_triage_state(sentry_issue_id, { fix_status: "fixed" }, ctx.config).catch((err) => {
      console.error(`[sentry-triage] Failed to update state after fix completion: ${String(err)}`);
    });
  };

  const on_fix_fail = (session_id: string, error: string): void => {
    if (session_id !== fix_session.session_id) return;
    ctx.session_manager.removeListener("session:completed", on_fix_complete);
    ctx.session_manager.removeListener("session:failed", on_fix_fail);

    console.error(`[sentry-triage] Fix session failed for ${sentry_issue_id}: ${error}`);
    sentry.captureException(new Error(error), {
      tags: { module: "sentry-triage", entity: entity_id, action: "sentry_fix_failed" },
      contexts: { issue: { id: sentry_issue_id } },
    });

    void update_triage_state(sentry_issue_id, { fix_status: "failed" }, ctx.config).catch((e) => {
      console.error(`[sentry-triage] Failed to update state after fix failure: ${String(e)}`);
    });
  };

  ctx.session_manager.on("session:completed", on_fix_complete);
  ctx.session_manager.on("session:failed", on_fix_fail);
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
    console.log(`[sentry-triage] Skipping triage for ${sentry_issue_id}: ${reason}`);
    return;
  }

  // Fetch full issue details before spawning (keeps Sentry creds out of agent)
  const auth_token = process.env.SENTRY_AUTH_TOKEN;
  const org_slug = process.env.SENTRY_ORG;

  if (!auth_token || !org_slug) {
    console.warn(
      "[sentry-triage] SENTRY_AUTH_TOKEN or SENTRY_ORG not configured — " +
        "cannot fetch issue details, skipping triage",
    );
    return;
  }

  let issue_details: SentryIssueDetails;
  try {
    // Shared cache with the webhook alert enrichment path (#259) — if the
    // webhook handler already fetched this issue in the last 30s, we reuse
    // the result instead of hitting the Sentry API twice for the same event.
    issue_details = await get_cached_issue_details(sentry_issue_id, () =>
      fetch_sentry_issue_details(sentry_issue_id, auth_token, org_slug),
    );
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
