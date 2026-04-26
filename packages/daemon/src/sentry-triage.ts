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
import type { AlertRouter } from "./alert-router.js";
import type { DiscordBot } from "./discord.js";
import type { EntityRegistry } from "./registry.js";
import { MAX_SENTRY_FIX_ATTEMPTS, build_sentry_fix_prompt } from "./review-utils.js";
import {
  format_fix_exhausted_body,
  format_fix_merged_body,
  format_fix_spawned_body,
  format_incident_open_body,
  format_no_verdict_body,
  format_session_failed_body,
  format_triaging_body,
  format_verdict_body,
  get_cached_issue_details,
  truncate_title,
} from "./sentry-alert-format.js";
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
  alert_router: AlertRouter | null;
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
  // Incident thread tracking (#310)
  thread_id?: string;
  alert_message_id?: string;
  last_fix_pr_url?: string;
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
 * Validate and shape a parsed verdict payload. Returns null if any required
 * field is missing or the wrong type. Same rules as the original parser.
 */
function validate_verdict(parsed: unknown): TriageVerdict | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  const severity = obj.severity;
  if (severity !== "P0" && severity !== "P1" && severity !== "P2") return null;

  if (typeof obj.auto_fixable !== "boolean") return null;

  // github_issue must be null/undefined or a number — reject other types
  if (
    obj.github_issue !== null &&
    obj.github_issue !== undefined &&
    typeof obj.github_issue !== "number"
  ) {
    return null;
  }
  const github_issue = typeof obj.github_issue === "number" ? obj.github_issue : null;

  const fix_approach = typeof obj.fix_approach === "string" ? obj.fix_approach : null;

  return {
    severity,
    auto_fixable: obj.auto_fixable,
    github_issue,
    fix_approach,
  };
}

/**
 * Extract the verdict from a string that contains the marker. Slices from the
 * marker, trims, and JSON.parses the trailing object literal. Returns null on
 * any parse or validation failure.
 */
function extract_verdict_from_text(text: string): TriageVerdict | null {
  // Use lastIndexOf so a verdict appearing after other (possibly verdict-shaped)
  // text in the same string still wins — last marker is the authoritative one.
  const marker_idx = text.lastIndexOf(VERDICT_MARKER);
  if (marker_idx === -1) return null;

  const json_str = text.slice(marker_idx + VERDICT_MARKER.length).trim();
  try {
    return validate_verdict(JSON.parse(json_str));
  } catch {
    return null;
  }
}

/**
 * Stream-JSON event shape we care about. The Claude CLI emits one JSON event
 * per line on stdout (see session.ts: `--output-format stream-json`); assistant
 * messages carry the verdict inside `.message.content[].text`.
 */
interface StreamJsonAssistantEvent {
  type: "assistant";
  message?: {
    content?: Array<{ type?: string; text?: string }>;
  };
}

/**
 * Parse a structured verdict from Ray's triage output.
 *
 * Output capture path: session.ts spawns the Claude CLI with
 * `--output-format stream-json`, so each line in `output_lines` is a JSON
 * envelope like:
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"…SENTRY_TRIAGE_VERDICT:{…}"}]}}
 *
 * Strategy (per #316):
 *   1. For each line (scanned in reverse — verdicts arrive last), try to parse
 *      it as a stream-json event. If it's an assistant message, walk the
 *      content blocks, pull `.text` from each text block, and look for the
 *      verdict marker in those (already-unescaped) strings.
 *   2. If the line is NOT valid JSON, fall back to the legacy plain-line
 *      `indexOf` path. This preserves behavior for non-stream-json captures
 *      (test fixtures, future capture-format changes).
 *
 * Null = no auto-fix = safe fallback (same contract as before).
 */
export function parse_triage_verdict(output_lines: string[] | undefined): TriageVerdict | null {
  if (!output_lines || output_lines.length === 0) return null;

  for (let i = output_lines.length - 1; i >= 0; i--) {
    const line = output_lines[i]!;

    // Path 1: try stream-json envelope first.
    let parsed_envelope: unknown;
    try {
      parsed_envelope = JSON.parse(line);
    } catch {
      parsed_envelope = undefined;
    }

    if (parsed_envelope && typeof parsed_envelope === "object") {
      const event = parsed_envelope as StreamJsonAssistantEvent;
      if (event.type === "assistant") {
        const blocks = event.message?.content ?? [];
        // Walk text blocks in reverse — within a single message, the last
        // text block holding the marker is authoritative (last-wins).
        for (let b = blocks.length - 1; b >= 0; b--) {
          const block = blocks[b];
          if (!block || block.type !== "text" || typeof block.text !== "string") continue;
          const verdict = extract_verdict_from_text(block.text);
          if (verdict) return verdict;
        }
      }
      // Stream-json line that wasn't an assistant text-bearing event (system,
      // tool_use, tool_result, result, etc.) — skip without falling through to
      // the plain-line path. The marker shouldn't appear in those.
      continue;
    }

    // Path 2: legacy plain-line fallback (preserves pre-stream-json fixtures).
    const verdict = extract_verdict_from_text(line);
    if (verdict) return verdict;
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

4. **Create a GitHub issue** if there is an actionable code fix — regardless of severity. Use:
   - Title: \`fix: {concise description}\`
   - Body: diagnosis, affected code paths, stack trace summary, suggested fix approach, link to Sentry issue
   - The issue body should include \`Sentry: ${issue_details.web_url}\` for traceability

   Skip issue creation ONLY if: the error is truly transient (one-off network blip, no code change would help), already tracked in an existing issue, or is expected operational noise that should be filtered via Sentry's \`ignoreErrors\`/\`beforeSend\`.

5. **If P0 (Critical):** Flag the issue as urgent — it needs immediate human attention.

6. **Output a structured verdict** as the very last line of your session. This MUST be a single line in exactly this format:

SENTRY_TRIAGE_VERDICT:{"severity":"P0|P1|P2","auto_fixable":boolean,"github_issue":number|null,"fix_approach":"string or null"}

Rules for auto_fixable:
- true ONLY if: clear code bug with identifiable fix path in this repo.
- false if: involves auth/permissions/encryption, touches user data, requires infra changes, involves third-party deps, root cause is ambiguous, or fix requires architectural decisions.
- When in doubt, false.

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

  // Post "triaging" update into the incident thread (#310).
  // Mirrors the format_fix_spawned_body pattern in spawn_sentry_fix — read the
  // thread_id set by open_incident_for_triage and post an incident_update.
  if (ctx.alert_router) {
    const { triages } = await load_triage_state(ctx.config);
    const thread_id = triages[sentry_issue_id]?.thread_id;
    if (thread_id) {
      void ctx.alert_router
        .post_alert({
          entity_id,
          tier: "incident_update",
          incident_id: thread_id,
          title: "",
          body: format_triaging_body(),
        })
        .catch((err) => {
          console.error(`[sentry-triage] Failed to post triaging update: ${String(err)}`);
        });
    }
  }

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
      // Route verdict into the incident thread if we have one (#310);
      // fall back to the legacy top-level action_required alert if not.
      if (ctx.alert_router) {
        void load_triage_state(ctx.config)
          .then((state) => {
            const thread_id = state.triages[sentry_issue_id]?.thread_id;
            if (thread_id) {
              return ctx.alert_router!.post_alert({
                entity_id,
                tier: "incident_update",
                incident_id: thread_id,
                title: "",
                body: format_verdict_body(verdict),
              });
            }
            // Back-compat: no thread_id (pre-#310 state) → top-level alert.
            const fix_note = verdict.auto_fixable
              ? `Auto-fix: yes → ${verdict.fix_approach ?? "approach TBD"}`
              : "Auto-fix: no";
            const issue_note = verdict.github_issue
              ? `GitHub: #${String(verdict.github_issue)}`
              : "No GitHub issue created";
            return ctx.alert_router!.post_alert({
              entity_id,
              tier:
                verdict.severity === "P0" || verdict.severity === "P1"
                  ? "action_required"
                  : "routine",
              title: `\u{1f50d} Sentry triage: ${verdict.severity} — ${issue_details.title}`,
              body: [issue_details.web_url, issue_note, fix_note].join("\n"),
            });
          })
          .catch((err) => {
            console.error(`[sentry-triage] Failed to post verdict alert: ${String(err)}`);
          });
      }

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
      // No verdict parsed \u2014 route to the incident thread if we have one
      // (#310), with Ray's output tail so the user can diagnose the parse
      // failure. Fall back to top-level alert for back-compat.
      if (ctx.alert_router) {
        void load_triage_state(ctx.config)
          .then((state) => {
            const thread_id = state.triages[sentry_issue_id]?.thread_id;
            if (thread_id) {
              return ctx.alert_router!.post_alert({
                entity_id,
                tier: "incident_update",
                incident_id: thread_id,
                title: "",
                body: format_no_verdict_body(result.output_lines),
              });
            }
            return ctx.alert_router!.post_alert({
              entity_id,
              tier: "action_required",
              title: "\u26a0\ufe0f Sentry triage completed \u2014 no verdict parsed",
              body: `Ray's session completed but didn't output a structured verdict.\n${issue_details.title}\n${issue_details.web_url}`,
            });
          })
          .catch((err) => {
            console.error(`[sentry-triage] Failed to post no-verdict alert: ${String(err)}`);
          });
      }

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

    // Alert on session failure — more urgent than no-verdict since Ray didn't run at all
    if (ctx.alert_router) {
      // Route into incident thread if we have one (#310); fall back to
      // top-level action_required for back-compat.
      void load_triage_state(ctx.config)
        .then((state) => {
          const thread_id = state.triages[sentry_issue_id]?.thread_id;
          if (thread_id) {
            return ctx.alert_router!.post_alert({
              entity_id,
              tier: "incident_update",
              incident_id: thread_id,
              title: "",
              body: format_session_failed_body(error),
            });
          }
          return ctx.alert_router!.post_alert({
            entity_id,
            tier: "action_required",
            title: "\u274c Sentry triage session failed",
            body: `Ray's triage session crashed.\n${issue_details.title}\n${issue_details.web_url}\nError: ${error}`,
          });
        })
        .catch((err) => {
          console.error(`[sentry-triage] Failed to post failure alert: ${String(err)}`);
        });
    }

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
    // Post exhaustion update into the incident thread (#310).
    if (ctx.alert_router && record?.thread_id) {
      await ctx.alert_router
        .post_alert({
          entity_id,
          tier: "incident_update",
          incident_id: record.thread_id,
          title: "",
          body: format_fix_exhausted_body(current_attempts, record.last_fix_pr_url ?? null),
        })
        .catch((err) => {
          console.error(`[sentry-triage] Failed to post fix-exhaustion update: ${String(err)}`);
        });
    }
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

  // Post "fix spawned" update into the incident thread (#310).
  if (ctx.alert_router && record?.thread_id) {
    void ctx.alert_router
      .post_alert({
        entity_id,
        tier: "incident_update",
        incident_id: record.thread_id,
        title: "",
        body: format_fix_spawned_body(),
      })
      .catch((err) => {
        console.error(`[sentry-triage] Failed to post fix-spawned update: ${String(err)}`);
      });
  }

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
      if (ctx.alert_router) {
        await ctx.alert_router
          .post_alert({
            entity_id,
            tier: "action_required",
            title: "\u26a0\ufe0f Sentry triage queue full",
            body: `${String(MAX_QUEUE_DEPTH)} items queued. Dropping triage for: ${issue_details.title}\n${issue_details.web_url}`,
          })
          .catch((e) => console.error(`[sentry-triage] Alert router error: ${String(e)}`));
      }
      return;
    }

    console.log(
      `[sentry-triage] At capacity (${String(MAX_CONCURRENT_TRIAGES)} concurrent) — ` +
        `queuing issue ${sentry_issue_id}`,
    );
    await open_incident_for_triage(sentry_issue_id, entity_id, issue_details, ctx);
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

  await open_incident_for_triage(sentry_issue_id, entity_id, issue_details, ctx);
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

/**
 * Open a Discord incident thread for a Sentry issue we're about to triage
 * (#310). The thread carries the full lifecycle (triage start, verdict,
 * fix spawn, fix merge). Persists `thread_id` + `alert_message_id` on the
 * triage state so every subsequent update posts into this thread.
 *
 * Called only after gates pass (not dedup, not cooldown, not queue-full).
 * If Discord is unavailable or no alerts channel is configured, returns
 * without persisting — subsequent alerts fall back to top-level action_required.
 */
async function open_incident_for_triage(
  sentry_issue_id: string,
  entity_id: string,
  issue_details: SentryIssueDetails,
  ctx: SentryTriageContext,
): Promise<void> {
  if (!ctx.alert_router) return;
  try {
    const result = await ctx.alert_router.post_alert({
      entity_id,
      tier: "incident_open",
      title: `\u{1f6a8} Sentry — ${truncate_title(issue_details.title, 80)}`,
      body: format_incident_open_body(issue_details.web_url),
    });
    if (result.thread_id) {
      await update_triage_state(
        sentry_issue_id,
        {
          thread_id: result.thread_id,
          alert_message_id: result.message_id ?? undefined,
        },
        ctx.config,
      );
    }
  } catch (err) {
    console.error(`[sentry-triage] Failed to open incident thread: ${String(err)}`);
  }
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
 * Handle a fix PR being merged (#310).
 *
 * Called by the GitHub webhook handler when a merged PR's linked issues
 * include one tracked by a Sentry triage. Finds every triage record whose
 * `github_issue` matches, marks it `fix_status: fixed`, and calls
 * `resolve_incident` to turn the top-level embed green and post a
 * resolution message into the thread.
 *
 * Safe to call when no matching triage exists — it's a best-effort hook.
 */
export async function handle_sentry_fix_pr_merged(
  pr_number: number,
  linked_issue_numbers: number[],
  ctx: SentryTriageContext,
): Promise<void> {
  if (linked_issue_numbers.length === 0) return;

  const state = await load_triage_state(ctx.config);
  const linked_set = new Set(linked_issue_numbers);

  for (const [sentry_issue_id, record] of Object.entries(state.triages)) {
    if (record.github_issue == null) continue;
    if (!linked_set.has(record.github_issue)) continue;
    if (record.fix_status === "fixed") continue;

    await update_triage_state(
      sentry_issue_id,
      { fix_status: "fixed", last_fix_pr_url: `PR #${String(pr_number)}` },
      ctx.config,
    );

    if (ctx.alert_router && record.thread_id) {
      try {
        await ctx.alert_router.resolve_incident(
          record.thread_id,
          format_fix_merged_body(pr_number),
        );
      } catch (err) {
        console.error(
          `[sentry-triage] Failed to resolve incident for ${sentry_issue_id}: ${String(err)}`,
        );
      }
    }
  }
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
