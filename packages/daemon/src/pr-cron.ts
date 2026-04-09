import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import type { ArchetypeRole, EntityConfig, LobsterFarmConfig } from "@lobster-farm/shared";
import { expand_home } from "@lobster-farm/shared";
import { detect_review_outcome } from "./actions.js";
import type { DiscordBot } from "./discord.js";
import { resolve_binary } from "./env.js";
import type { GitHubAppAuth } from "./github-app.js";
import {
  close_linked_issues,
  extract_linked_issues,
  fetch_issue_context,
  nwo_from_url,
} from "./issue-utils.js";
import { load_pr_reviews, save_pr_reviews } from "./persistence.js";
import type { PRReviewState } from "./persistence.js";
import type { PRWatchStore } from "./pr-watches.js";
import type { EntityRegistry } from "./registry.js";
import {
  MAX_CI_FIX_ATTEMPTS,
  attempt_auto_merge,
  build_ci_fix_prompt,
  build_review_fix_prompt,
  check_ci_status,
  fetch_ci_failure_logs,
  fetch_review_comments,
} from "./review-utils.js";
import * as sentry from "./sentry.js";
import type { ClaudeSessionManager } from "./session.js";
import { cleanup_after_merge } from "./worktree-cleanup.js";

const exec = promisify(execFile);

// ── Helpers ──

async function try_cleanup_worktree(
  repo_path: string,
  branch: string,
  pr_number: number,
): Promise<void> {
  try {
    await cleanup_after_merge(repo_path, branch);
  } catch (err) {
    console.error(
      `[pr-cron] Worktree cleanup failed after merge for branch ${branch}: ${String(err)}`,
    );
    sentry.captureException(err, {
      tags: { module: "pr-cron", action: "worktree_cleanup" },
      contexts: { pr: { number: pr_number, branch } },
    });
  }
}

// ── Types ──

interface OpenPR {
  number: number;
  title: string;
  headRefName: string;
  updatedAt: string;
  url: string;
  body: string;
  author: { login: string };
  isDraft: boolean;
}

interface ActiveReview {
  pr_number: number;
  entity_id: string;
  repo_url: string;
  status: "reviewing" | "changes_requested" | "approved" | "merged";
  last_checked: Date;
}

// ── GitHub API response shapes (subset of what gh pr view --json returns) ──

interface GHReview {
  submittedAt: string;
  author: { login: string };
  state: string;
}

interface GHComment {
  createdAt: string;
  author: { login: string };
}

interface GHCommit {
  committedDate: string;
}

interface PRFeedbackData {
  reviews: GHReview[];
  comments: GHComment[];
  commits: GHCommit[];
}

// ── PR Cron ──

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/** Buffer in ms to avoid re-reviewing when commit and review timestamps are very close. */
const TIMESTAMP_BUFFER_MS = 60_000; // 60 seconds

export class PRReviewCron {
  private timer: ReturnType<typeof setInterval> | null = null;
  private active_reviews = new Map<string, ActiveReview>(); // key: "entity:pr#"
  private processed: PRReviewState = {}; // persisted to disk — tracks completed reviews
  private running = false;
  private interval_ms: number = DEFAULT_INTERVAL_MS;
  private gh_bin = "gh"; // resolved to absolute path in start()

  constructor(
    private registry: EntityRegistry,
    private session_manager: ClaudeSessionManager,
    private config: LobsterFarmConfig,
    private discord: DiscordBot | null = null,
    private github_app: GitHubAppAuth | null = null,
    private pr_watches: PRWatchStore | null = null,
  ) {}

  /** Start the polling cron. Loads persisted review state before first poll. */
  async start(interval_ms: number = DEFAULT_INTERVAL_MS): Promise<void> {
    if (this.timer) return;

    // Resolve gh to absolute path once — prevents ENOENT in launchd environments
    // where child processes may not inherit PATH correctly
    this.gh_bin = resolve_binary("gh");
    console.log(`[pr-cron] Resolved gh binary: ${this.gh_bin}`);

    // Load persisted review state so we don't re-review after restart
    this.processed = await load_pr_reviews(this.config);
    const count = Object.keys(this.processed).length;
    if (count > 0) {
      console.log(`[pr-cron] Loaded ${String(count)} processed PR reviews from disk`);
    }

    this.interval_ms = interval_ms;
    console.log(`[pr-cron] Starting PR review cron (every ${String(interval_ms / 1000)}s)`);

    // Run immediately on start, then on interval
    void this.poll();
    this.timer = setInterval(() => void this.poll(), interval_ms);
  }

  /** Stop the cron. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log("[pr-cron] Stopped");
    }
  }

  /** Get active review states. */
  get_active_reviews(): ActiveReview[] {
    return [...this.active_reviews.values()];
  }

  /** Single poll cycle: check all entity repos for open PRs. */
  private async poll(): Promise<void> {
    if (this.running) {
      console.log("[pr-cron] Previous poll still running, skipping");
      return;
    }

    this.running = true;

    // Sentry cron monitoring: derive schedule from actual interval
    const interval_minutes = Math.round(this.interval_ms / 60_000);
    const checkInId = sentry.cronCheckInStart("pr-review-cron", {
      schedule: { type: "interval", value: interval_minutes, unit: "minute" },
      checkinMargin: Math.max(1, Math.round(interval_minutes * 0.2)),
      maxRuntime: 15,
      failureIssueThreshold: 3,
      recoveryThreshold: 2,
    });

    try {
      // Expire stale PR watches (24h TTL)
      if (this.pr_watches) {
        await this.pr_watches.cleanup_expired();
      }

      const entities = this.registry.get_active();

      for (const entity_config of entities) {
        const entity_id = entity_config.entity.id;
        const repos = entity_config.entity.repos;

        for (const repo of repos) {
          const repo_path = expand_home(repo.path);
          await this.check_repo(entity_id, repo_path, entity_config);
        }
      }

      sentry.cronCheckInFinish(checkInId, "pr-review-cron", "ok");
    } catch (err) {
      console.error(`[pr-cron] Poll failed: ${String(err)}`);
      sentry.cronCheckInFinish(checkInId, "pr-review-cron", "error");
      sentry.captureException(err, {
        tags: { module: "pr-cron" },
      });
    } finally {
      this.running = false;
    }
  }

  /** Check a single repo for open PRs. */
  private async check_repo(
    entity_id: string,
    repo_path: string,
    entity_config: EntityConfig,
  ): Promise<void> {
    // Verify repo path exists before shelling out — avoids confusing ENOENT
    // errors for entities with stale or placeholder paths (e.g. alpha → /tmp/test-repo)
    try {
      await stat(repo_path);
    } catch {
      console.log(`[pr-cron] Repo path does not exist for ${entity_id}: ${repo_path} — skipping`);
      return;
    }

    let prs: OpenPR[];
    try {
      const { stdout } = await exec(
        this.gh_bin,
        [
          "pr",
          "list",
          "--state",
          "open",
          "--json",
          "number,title,headRefName,updatedAt,url,body,author,isDraft",
        ],
        { cwd: repo_path, env: process.env, timeout: 30_000 },
      );

      prs = JSON.parse(stdout) as OpenPR[];
    } catch (err) {
      // gh CLI not available or not in a git repo — skip
      console.log(`[pr-cron] Could not list PRs for ${entity_id}: ${String(err)}`);
      return;
    }

    // Clean stale entries: remove processed PRs that are no longer open
    const open_keys = new Set(prs.map((pr) => `${entity_id}:${String(pr.number)}`));
    let stale_cleaned = false;
    for (const key of Object.keys(this.processed)) {
      if (key.startsWith(`${entity_id}:`) && !open_keys.has(key)) {
        delete this.processed[key];
        stale_cleaned = true;
      }
    }
    if (stale_cleaned) {
      await save_pr_reviews(this.processed, this.config);
    }

    if (prs.length === 0) return;

    for (const pr of prs) {
      // Skip draft PRs — builder is still iterating
      if (pr.isDraft) {
        console.log(`[pr-cron] Skipping draft PR #${String(pr.number)} in ${entity_id}`);
        continue;
      }

      const key = `${entity_id}:${String(pr.number)}`;

      // Skip if already processed — unless PR was updated since our review
      const prior = this.processed[key];
      if (prior && new Date(pr.updatedAt) <= new Date(prior.reviewed_at)) {
        continue;
      }
      if (prior) {
        // PR updated after our review — allow re-review
        console.log(
          `[pr-cron] PR #${String(pr.number)} updated since last review, allowing re-review`,
        );
        delete this.processed[key];
      }

      // Skip if already being reviewed
      if (this.active_reviews.has(key)) {
        continue;
      }

      console.log(`[pr-cron] Found open PR #${String(pr.number)} in ${entity_id}: "${pr.title}"`);

      // Check if PR needs (re-)review by comparing commit vs feedback timestamps
      const skip = await this.should_skip_pr(repo_path, pr.number);
      if (skip) {
        continue;
      }

      // Spawn reviewer
      await this.review_pr(entity_id, repo_path, pr, entity_config);
    }

    // Retry merge for approved-but-unmerged PRs whose CI was pending (#189)
    await this.retry_approved_unmerged(entity_id, repo_path, prs, entity_config);
  }

  /**
   * Decide whether to skip a PR based on commit vs review/comment timestamps.
   *
   * - No feedback at all: don't skip (never reviewed)
   * - Latest commit is newer than latest feedback + buffer: don't skip (needs re-review)
   * - Latest feedback is at or after latest commit: skip (already reviewed)
   */
  private async should_skip_pr(repo_path: string, pr_number: number): Promise<boolean> {
    const data = await this.fetch_pr_feedback(repo_path, pr_number);
    if (!data) {
      // Can't fetch PR data — don't skip, let the reviewer attempt proceed
      return false;
    }

    // Extract feedback timestamps from reviews and comments.
    // Note: we don't filter by author here. If CI bots start posting comments,
    // add author filtering (e.g., skip authors with [bot] suffix or known CI logins).
    const feedback_timestamps: number[] = [];

    for (const review of data.reviews) {
      if (review.submittedAt) {
        feedback_timestamps.push(new Date(review.submittedAt).getTime());
      }
    }
    for (const comment of data.comments) {
      if (comment.createdAt) {
        feedback_timestamps.push(new Date(comment.createdAt).getTime());
      }
    }

    // No feedback at all — never reviewed
    if (feedback_timestamps.length === 0) {
      return false;
    }

    const latest_feedback = Math.max(...feedback_timestamps);

    // Get latest commit timestamp — commits are returned in chronological order
    const commits = data.commits;
    if (commits.length === 0) {
      // No commits somehow — don't skip, something is off
      return false;
    }

    const last_commit = commits[commits.length - 1]!;
    const latest_commit_ts = new Date(last_commit.committedDate).getTime();

    // Re-review if commits are newer than feedback (with buffer for timestamp rounding)
    if (latest_commit_ts > latest_feedback + TIMESTAMP_BUFFER_MS) {
      console.log(
        `[pr-cron] PR #${String(pr_number)} has commits newer than latest feedback — needs re-review`,
      );
      return false;
    }

    console.log(`[pr-cron] PR #${String(pr_number)} already reviewed, skipping`);
    return true;
  }

  /** Fetch reviews, comments, and commits for a PR via gh CLI. Returns null on error. */
  protected async fetch_pr_feedback(
    repo_path: string,
    pr_number: number,
  ): Promise<PRFeedbackData | null> {
    try {
      const { stdout } = await exec(
        this.gh_bin,
        ["pr", "view", String(pr_number), "--json", "reviews,comments,commits"],
        { cwd: repo_path, env: process.env, timeout: 15_000 },
      );

      return JSON.parse(stdout) as PRFeedbackData;
    } catch {
      return null;
    }
  }

  /**
   * Resolve a GitHub App token for the given entity.
   * Uses the entity's `github_app_installation_id` if configured,
   * otherwise falls back to the default installation from env.
   */
  private async resolve_entity_token(entity_config: EntityConfig): Promise<string | undefined> {
    if (!this.github_app) return undefined;

    const override_id = entity_config.entity.accounts?.github?.github_app_installation_id;
    try {
      return override_id
        ? await this.github_app.get_token_for_installation(override_id)
        : await this.github_app.get_token();
    } catch (err) {
      console.error(`[pr-cron] Failed to get GitHub App token: ${String(err)}`);
      sentry.captureException(err, {
        tags: { module: "pr-cron", entity: entity_config.entity.id },
      });
      return undefined;
    }
  }

  /** Spawn a reviewer session for a PR. */
  private async review_pr(
    entity_id: string,
    repo_path: string,
    pr: OpenPR,
    entity_config: EntityConfig,
  ): Promise<void> {
    const key = `${entity_id}:${String(pr.number)}`;

    this.active_reviews.set(key, {
      pr_number: pr.number,
      entity_id,
      repo_url: pr.url,
      status: "reviewing",
      last_checked: new Date(),
    });

    // Fetch linked issue context from PR body (Closes/Fixes/Resolves #N) and title (#N)
    let issue_context = "";
    const linked_issues = extract_linked_issues(pr.body, pr.title);
    if (linked_issues.length > 0) {
      const contexts = await Promise.all(
        linked_issues.map((n) => fetch_issue_context(repo_path, n)),
      );
      issue_context = contexts.filter(Boolean).join("\n\n---\n\n");
    }

    const prompt_lines = [
      `Review PR #${String(pr.number)}: "${pr.title}" on branch ${pr.headRefName}.`,
      `Repository: ${repo_path}`,
      "",
      "Run /review to do a comprehensive code review.",
      "Post your review on the PR using gh cli.",
      "",
      "Review standards:",
      "- Every piece of actionable feedback should be included.",
      "- If there is ANY actionable feedback, request changes:",
      `  gh pr review ${String(pr.number)} --request-changes --body "<your review>"`,
      "- If the code is genuinely clean with no improvements needed, approve:",
      `  gh pr review ${String(pr.number)} --approve --body "Looks good."`,
      "",
      "Before merging, check CI status:",
      `  gh pr checks ${String(pr.number)} --required`,
      "If any required checks are failing or pending, do NOT merge.",
      "Instead, note the failing checks in your review and request changes.",
      "If no CI workflows are configured for this repo, proceed with merge normally.",
      "",
      "After posting your review:",
      "- If you approved, merge the PR:",
      `  gh pr merge ${String(pr.number)} --squash --delete-branch`,
      "- If the merge command fails (branch behind main):",
      `  1. Try: git fetch origin && git checkout ${pr.headRefName} && git rebase origin/main`,
      `  2. If rebase is clean (no conflicts): git push --force-with-lease origin ${pr.headRefName}`,
      `  3. Then retry: gh pr merge ${String(pr.number)} --squash --delete-branch`,
      "  4. If rebase has conflicts: git rebase --abort — do NOT force push conflict markers",
      "- If you requested changes, do NOT merge.",
    ];

    if (issue_context) {
      prompt_lines.push("", "## Linked Issue Context", "", issue_context);
    }

    const prompt = prompt_lines.join("\n");

    console.log(`[pr-cron] Spawning reviewer for PR #${String(pr.number)} in ${entity_id}`);

    // Inject GitHub App token if available — gives reviewer its own identity.
    // Uses per-entity installation ID when configured.
    let spawn_env: Record<string, string> | undefined;
    const gh_token = await this.resolve_entity_token(entity_config);
    if (gh_token) {
      spawn_env = { GH_TOKEN: gh_token };
    }

    try {
      const session = await this.session_manager.spawn({
        entity_id,
        feature_id: `pr-review-${String(pr.number)}`,
        archetype: "reviewer",
        dna: ["review-dna"],
        model: { model: "sonnet", think: "standard" },
        worktree_path: repo_path,
        prompt,
        interactive: false,
        env: spawn_env,
      });

      console.log(
        `[pr-cron] Reviewer session ${session.session_id.slice(0, 8)} started for PR #${String(pr.number)}`,
      );

      // Listen for session completion
      const on_complete = (result: { session_id: string; exit_code: number }) => {
        if (result.session_id !== session.session_id) return;
        this.session_manager.removeListener("session:completed", on_complete);
        this.session_manager.removeListener("session:failed", on_fail);

        this.active_reviews.delete(key);
        console.log(`[pr-cron] Review completed for PR #${String(pr.number)} in ${entity_id}`);

        // Persist completion so we don't re-review after restart
        void this.persist_review_completion(entity_id, pr, repo_path, entity_config).catch(
          (err) => {
            console.error(
              `[pr-cron] Failed to persist review for PR #${String(pr.number)}: ${String(err)}`,
            );
            sentry.captureException(err, {
              tags: { module: "pr-cron", entity: entity_id },
              contexts: { pr: { number: pr.number, title: pr.title } },
            });
          },
        );
      };

      const on_fail = (session_id: string, error: string) => {
        if (session_id !== session.session_id) return;
        this.session_manager.removeListener("session:completed", on_complete);
        this.session_manager.removeListener("session:failed", on_fail);

        this.active_reviews.delete(key);
        console.error(`[pr-cron] Review failed for PR #${String(pr.number)}: ${error}`);
        sentry.captureException(new Error(error), {
          tags: { module: "pr-cron", entity: entity_id },
          contexts: { pr: { number: pr.number, title: pr.title } },
        });
      };

      this.session_manager.on("session:completed", on_complete);
      this.session_manager.on("session:failed", on_fail);
    } catch (err) {
      this.active_reviews.delete(key);
      console.error(
        `[pr-cron] Failed to spawn reviewer for PR #${String(pr.number)}: ${String(err)}`,
      );
      sentry.captureException(err, {
        tags: { module: "pr-cron", entity: entity_id, action: "spawn_reviewer" },
        contexts: { pr: { number: pr.number, title: pr.title } },
      });
    }
  }

  /** Persist review completion to disk, then hand off to outcome routing. */
  private async persist_review_completion(
    entity_id: string,
    pr: OpenPR,
    repo_path: string,
    entity_config: EntityConfig,
  ): Promise<void> {
    const key = `${entity_id}:${String(pr.number)}`;

    // Resolve a token so detect_review_outcome and check_pr_merged can
    // authenticate against the correct GitHub account (cross-account repos).
    const gh_token = await this.resolve_entity_token(entity_config);

    const outcome = await detect_review_outcome(pr.number, repo_path, gh_token);

    this.processed[key] = {
      entity_id,
      pr_number: pr.number,
      reviewed_at: new Date().toISOString(),
      outcome,
    };
    await save_pr_reviews(this.processed, this.config);
    console.log(`[pr-cron] Persisted review for PR #${String(pr.number)} (${outcome})`);

    // Route the outcome (alerts, fix spawning, etc.)
    await this.handle_review_completion(entity_id, repo_path, pr, outcome, gh_token);
  }

  /** After a reviewer session completes, detect the outcome and route accordingly. */
  private async handle_review_completion(
    entity_id: string,
    repo_path: string,
    pr: OpenPR,
    review_outcome?: "approved" | "changes_requested" | "pending",
    gh_token?: string,
  ): Promise<void> {
    const review_state =
      review_outcome ?? (await detect_review_outcome(pr.number, repo_path, gh_token));

    // Determine if internal (our agents) or truly external
    const entity_config = this.registry.get(entity_id);
    const github_user = entity_config?.entity.accounts?.github?.user;
    const is_internal = github_user != null && pr.author.login === github_user;

    if (review_state === "changes_requested") {
      await this.spawn_external_pr_fixer(entity_id, repo_path, pr, entity_config);
      if (is_internal) {
        await this.notify_alerts(
          entity_id,
          `PR #${String(pr.number)}: ${pr.title} — needs changes, spawning builder to fix`,
        );
      } else {
        await this.notify_alerts(
          entity_id,
          `External PR #${String(pr.number)} from @${pr.author.login}: ${pr.title} — needs changes, spawning builder to fix`,
        );
      }
    } else if (review_state === "approved") {
      // Check if the reviewer already merged (they're instructed to merge on approval)
      const is_merged = await this.check_pr_merged(repo_path, pr.number, gh_token);

      if (is_merged) {
        // Reviewer merged — close linked issues and notify
        await this.close_issues_for_merged_pr(entity_id, repo_path, pr, entity_config);

        if (is_internal) {
          await this.notify_alerts(
            entity_id,
            `PR #${String(pr.number)}: ${pr.title} — approved and merged to main`,
          );
        } else {
          await this.notify_alerts(
            entity_id,
            `External PR #${String(pr.number)} from @${pr.author.login}: ${pr.title} — approved and merged to main`,
          );
        }

        // Clean up local worktrees for the merged branch
        await try_cleanup_worktree(repo_path, pr.headRefName, pr.number);
      } else if (is_internal) {
        // Check CI status before attempting merge (#189)
        const ci = await check_ci_status(pr.number, repo_path, gh_token, this.gh_bin);

        if (ci.pending) {
          console.log(
            `[pr-cron] CI checks pending for PR #${String(pr.number)} — skipping merge, retry pass will handle`,
          );
          // Don't merge yet — retry_approved_unmerged will check again next cycle
        } else if (ci.failures.length > 0) {
          // Spawn builder to fix CI failures (#196)
          await this.spawn_ci_fixer(entity_id, repo_path, pr, ci.failures, entity_config);
        } else {
          // All checks passed (or none configured) — attempt auto-merge with rebase (#166)
          const result = await attempt_auto_merge(
            pr.number,
            pr.headRefName,
            repo_path,
            this.gh_bin,
            gh_token,
          );

          if (result.merged) {
            await this.close_issues_for_merged_pr(entity_id, repo_path, pr, entity_config);
            await this.notify_alerts(
              entity_id,
              `PR #${String(pr.number)}: ${pr.title} — approved, auto-rebased (${result.method}), and merged to main`,
            );

            // Clean up local worktrees for the merged branch
            await try_cleanup_worktree(repo_path, pr.headRefName, pr.number);
          } else {
            await this.notify_alerts(
              entity_id,
              `PR #${String(pr.number)}: ${pr.title} — approved but merge failed after rebase attempt. ${result.error ?? "Manual intervention needed."}`,
            );
          }
        }
      } else {
        // External, not yet merged — escalate to human
        await this.notify_alerts(
          entity_id,
          `External PR #${String(pr.number)} from @${pr.author.login}: ${pr.title} — approved, awaiting human merge`,
        );
      }
    } else {
      // Notify completion without specific action
      await this.notify_alerts(
        entity_id,
        `PR #${String(pr.number)} review completed: "${pr.title}"`,
      );
    }
  }

  /**
   * Retry merge for approved-but-unmerged PRs.
   *
   * Handles the gap where CI was pending at review completion time:
   * - PR-cron path: `persist_review_completion` stored the outcome as "approved"
   *   but the merge was skipped because CI was still running.
   * - Webhook handler path: the webhook handler skipped merge due to pending CI
   *   but doesn't write to `processed`, so `should_skip_pr()` blocks re-review.
   *
   * This pass runs after the main review loop each cycle. For each open PR:
   * 1. Check if it has an approved review (from `processed` or GitHub API)
   * 2. If approved and still open, check CI and attempt merge
   *
   * No reviewer sessions are spawned — this is purely a merge-retry mechanism.
   */
  private async retry_approved_unmerged(
    entity_id: string,
    repo_path: string,
    prs: OpenPR[],
    entity_config: EntityConfig,
  ): Promise<void> {
    const gh_token = await this.resolve_entity_token(entity_config);
    const github_user = entity_config.entity.accounts?.github?.user;

    for (const pr of prs) {
      const key = `${entity_id}:${String(pr.number)}`;

      // Only retry internal PRs — external ones need human merge
      const is_internal = github_user != null && pr.author.login === github_user;
      if (!is_internal) continue;

      // Skip PRs with an active review session
      if (this.active_reviews.has(key)) continue;

      // Determine if this PR is approved but unmerged
      const processed_entry = this.processed[key];
      let is_approved = false;

      if (processed_entry?.outcome === "approved") {
        // PR-cron path: we already know the outcome from the previous review
        is_approved = true;
      } else if (!processed_entry) {
        // Webhook handler path: no processed entry, check GitHub directly
        const outcome = await detect_review_outcome(pr.number, repo_path, gh_token);
        if (outcome === "approved") {
          is_approved = true;
        }
      }
      // If outcome is "changes_requested" or "pending", a review loop or
      // new review will handle it — don't retry merge here.

      if (!is_approved) continue;

      // Verify the PR hasn't been merged since we last checked
      const is_merged = await this.check_pr_merged(repo_path, pr.number, gh_token);
      if (is_merged) {
        // Clean up: close issues, update processed state
        await this.close_issues_for_merged_pr(entity_id, repo_path, pr, entity_config);
        if (processed_entry) {
          delete this.processed[key];
          await save_pr_reviews(this.processed, this.config);
        }
        continue;
      }

      // Check CI status
      const ci = await check_ci_status(pr.number, repo_path, gh_token, this.gh_bin);

      if (ci.pending) {
        console.log(
          `[pr-cron] CI still pending for approved PR #${String(pr.number)} — will retry next cycle`,
        );
        continue;
      }

      if (ci.failures.length > 0) {
        // Deduplicate: only spawn a fix if the failure set changed since last attempt.
        // Keyed on sorted failure names so a fresh fix fires when different checks fail.
        const failure_key = JSON.stringify([...ci.failures].sort());
        if (this.processed[key]?.ci_failure_alerted === failure_key) {
          continue;
        }

        // Spawn builder to fix CI failures (#196).
        // spawn_ci_fixer returns true if the failure was handled (spawned, cap
        // reached, or dedup hit) — mark ci_failure_alerted so we don't re-process
        // the same failure set next cycle. Returns false on transient errors
        // (token resolution) so the next cycle retries.
        const handled = await this.spawn_ci_fixer(
          entity_id,
          repo_path,
          pr,
          ci.failures,
          entity_config,
        );
        if (handled) {
          this.processed[key] = {
            ...(this.processed[key] ?? {
              entity_id,
              pr_number: pr.number,
              reviewed_at: new Date().toISOString(),
              outcome: "approved" as const,
            }),
            ci_failure_alerted: failure_key,
          };
          await save_pr_reviews(this.processed, this.config);
        }
        continue;
      }

      // CI passed — attempt merge
      console.log(`[pr-cron] CI passed for approved PR #${String(pr.number)} — retrying merge`);

      const result = await attempt_auto_merge(
        pr.number,
        pr.headRefName,
        repo_path,
        this.gh_bin,
        gh_token,
      );

      if (result.merged) {
        // Update processed state to reflect the merge
        this.processed[key] = {
          entity_id,
          pr_number: pr.number,
          reviewed_at: new Date().toISOString(),
          outcome: "approved",
        };
        await save_pr_reviews(this.processed, this.config);

        await this.close_issues_for_merged_pr(entity_id, repo_path, pr, entity_config);
        await this.notify_alerts(
          entity_id,
          `PR #${String(pr.number)}: ${pr.title} — CI passed, auto-merged (${result.method})`,
        );

        // Clean up local worktrees for the merged branch
        await try_cleanup_worktree(repo_path, pr.headRefName, pr.number);
      } else {
        await this.notify_alerts(
          entity_id,
          `PR #${String(pr.number)}: ${pr.title} — approved, CI passed, but merge failed. ${result.error ?? "Manual intervention needed."}`,
        );
      }
    }
  }

  /** Spawn a builder session to fix an external PR based on reviewer feedback. */
  private async spawn_external_pr_fixer(
    entity_id: string,
    repo_path: string,
    pr: OpenPR,
    entity_config?: EntityConfig,
  ): Promise<void> {
    // Fetch the actual review comments to give the builder full context
    const review_comments = await fetch_review_comments(pr.number, repo_path);

    const prompt = [
      "An external PR needs fixes based on reviewer feedback.",
      `PR #${String(pr.number)}: "${pr.title}" on branch ${pr.headRefName}`,
      `Repository: ${repo_path}`,
      "",
      `First, check out the PR branch: git checkout ${pr.headRefName}`,
      "",
      build_review_fix_prompt(pr.number, pr.title, review_comments),
      "",
      "Do NOT merge the PR.",
    ].join("\n");

    console.log(
      `[pr-cron] Spawning builder to fix external PR #${String(pr.number)} in ${entity_id}`,
    );

    // Inject GitHub App token if available — uses per-entity installation ID when configured
    let fix_env: Record<string, string> | undefined;
    const config = entity_config ?? this.registry.get(entity_id);
    if (config) {
      const gh_token = await this.resolve_entity_token(config);
      if (gh_token) {
        fix_env = { GH_TOKEN: gh_token };
      }
    }

    try {
      await this.session_manager.spawn({
        entity_id,
        feature_id: `external-pr-fix-${String(pr.number)}`,
        archetype: "builder",
        dna: ["coding-dna"],
        model: { model: "opus", think: "high" },
        worktree_path: repo_path,
        prompt,
        interactive: false,
        env: fix_env,
      });
    } catch (err) {
      console.error(
        `[pr-cron] Failed to spawn builder for external PR #${String(pr.number)}: ${String(err)}`,
      );
      sentry.captureException(err, {
        tags: { module: "pr-cron", entity: entity_id, action: "spawn_fixer" },
        contexts: { pr: { number: pr.number, title: pr.title } },
      });
    }
  }

  /**
   * Spawn a builder session to fix CI failures on an approved PR (#196).
   *
   * Checks the retry cap (max 3 attempts) before spawning. If the cap is
   * reached, alerts #alerts and stops. Uses the active_reviews map for
   * dedup — key is `entity_id:pr_number`.
   *
   * Returns `true` if the failure was handled (spawn attempted, cap reached,
   * or dedup hit) — caller should mark `ci_failure_alerted`. Returns `false`
   * on transient errors (token resolution) so the next cycle retries.
   */
  private async spawn_ci_fixer(
    entity_id: string,
    repo_path: string,
    pr: OpenPR,
    failed_checks: string[],
    entity_config?: EntityConfig,
  ): Promise<boolean> {
    const key = `${entity_id}:${String(pr.number)}`;

    // Check retry cap
    const attempts = this.processed[key]?.ci_fix_attempts ?? 0;

    if (attempts >= MAX_CI_FIX_ATTEMPTS) {
      await this.notify_alerts(
        entity_id,
        `PR #${String(pr.number)}: ${pr.title} — CI fix failed after ${String(MAX_CI_FIX_ATTEMPTS)} attempts. Needs human intervention. Failed checks: ${failed_checks.join(", ")}`,
      );
      return true; // handled — cap reached, don't retry this failure set
    }

    // Dedup: if a review/fix is already in-flight for this PR, skip
    if (this.active_reviews.has(key)) {
      console.log(
        `[pr-cron] CI fix skipped for PR #${String(pr.number)} — review/fix already in-flight`,
      );
      return true; // handled — fix in-flight, don't retry this failure set
    }

    // Resolve token BEFORE incrementing attempt counter — transient token
    // errors (cert issues, rate limits) shouldn't consume retry slots.
    const config = entity_config ?? this.registry.get(entity_id);
    let gh_token: string | undefined;
    if (config) {
      try {
        gh_token = await this.resolve_entity_token(config);
      } catch (err) {
        console.error(
          `[pr-cron] Failed to get token for CI fix PR #${String(pr.number)}: ${String(err)}`,
        );
        sentry.captureException(err, {
          tags: { module: "pr-cron", entity: entity_id, action: "ci_fix_token" },
          contexts: { pr: { number: pr.number, title: pr.title } },
        });
        return false; // transient error — don't mark ci_failure_alerted, retry next cycle
      }
    }

    // Now increment attempt counter and set ci_failure_alerted so
    // retry_approved_unmerged doesn't double-spawn for the same failure set.
    const failure_key = JSON.stringify([...failed_checks].sort());
    this.processed[key] = {
      ...(this.processed[key] ?? {
        entity_id,
        pr_number: pr.number,
        reviewed_at: new Date().toISOString(),
        outcome: "approved" as const,
      }),
      ci_fix_attempts: attempts + 1,
      ci_failure_alerted: failure_key,
    };
    await save_pr_reviews(this.processed, this.config);

    // Fetch CI failure logs for context
    const failure_logs = await fetch_ci_failure_logs(
      pr.headRefName,
      repo_path,
      gh_token,
      this.gh_bin,
    );

    const prompt = [
      `Repository: ${repo_path}`,
      "",
      build_ci_fix_prompt(pr.number, pr.title, pr.headRefName, failure_logs, failed_checks),
    ].join("\n");

    console.log(
      `[pr-cron] Spawning CI fix builder for PR #${String(pr.number)} in ${entity_id} (attempt ${String(attempts + 1)}/${String(MAX_CI_FIX_ATTEMPTS)})`,
    );

    await this.notify_alerts(
      entity_id,
      `PR #${String(pr.number)}: ${pr.title} — approved but CI failed (${failed_checks.join(", ")}), spawning builder to fix (attempt ${String(attempts + 1)}/${String(MAX_CI_FIX_ATTEMPTS)})`,
    );

    let fix_env: Record<string, string> | undefined;
    if (gh_token) {
      fix_env = { GH_TOKEN: gh_token };
    }

    try {
      await this.session_manager.spawn({
        entity_id,
        feature_id: `ci-fix-${String(pr.number)}`,
        archetype: "builder",
        dna: ["coding-dna"],
        model: { model: "opus", think: "high" },
        worktree_path: repo_path,
        prompt,
        interactive: false,
        env: fix_env,
      });
    } catch (err) {
      console.error(
        `[pr-cron] Failed to spawn CI fix builder for PR #${String(pr.number)}: ${String(err)}`,
      );
      sentry.captureException(err, {
        tags: { module: "pr-cron", entity: entity_id, action: "spawn_ci_fixer" },
        contexts: { pr: { number: pr.number, title: pr.title } },
      });
    }

    return true;
  }

  /** Send a notification to the entity's alerts channel. */
  private async notify_alerts(entity_id: string, message: string): Promise<void> {
    console.log(`[pr-cron:alerts] ${message}`);
    if (this.discord) {
      await this.discord.send_to_entity(entity_id, "alerts", message, "reviewer" as ArchetypeRole);
    }
  }

  /** Check if a PR has been merged. */
  private async check_pr_merged(
    repo_path: string,
    pr_number: number,
    gh_token?: string,
  ): Promise<boolean> {
    try {
      const env = gh_token ? { ...process.env, GH_TOKEN: gh_token } : process.env;
      const { stdout } = await exec(
        this.gh_bin,
        ["pr", "view", String(pr_number), "--json", "state", "--jq", ".state"],
        { cwd: repo_path, env, timeout: 15_000 },
      );
      return stdout.trim() === "MERGED";
    } catch {
      return false;
    }
  }

  /**
   * Close linked issues after a PR merge via the GitHub REST API.
   * Derives the repo full name (owner/repo) from the entity's config.
   * Failures are logged but never thrown.
   */
  private async close_issues_for_merged_pr(
    entity_id: string,
    repo_path: string,
    pr: OpenPR,
    entity_config?: EntityConfig,
  ): Promise<void> {
    const issue_numbers = extract_linked_issues(pr.body, pr.title);
    if (issue_numbers.length === 0) return;

    // Derive repo full name (owner/repo) from entity config
    const config = entity_config ?? this.registry.get(entity_id);
    const repo = config?.entity.repos.find(
      (r: { path: string; url: string }) => expand_home(r.path) === repo_path,
    );
    const repo_full_name = repo ? nwo_from_url(repo.url) : undefined;
    if (!repo_full_name) {
      console.warn(
        `[pr-cron] Cannot derive repo full name for ${repo_path} — skipping issue close`,
      );
      return;
    }

    // Get GitHub App token for the API call — uses per-entity installation ID when configured
    if (!this.github_app) {
      console.warn("[pr-cron] No GitHub App configured — cannot close linked issues");
      return;
    }

    const gh_token = config ? await this.resolve_entity_token(config) : undefined;
    if (!gh_token) {
      console.error(`[pr-cron] Failed to get token for issue closing in ${entity_id}`);
      return;
    }

    console.log(
      `[pr-cron] Closing linked issues ${issue_numbers.map((n) => `#${String(n)}`).join(", ")} ` +
        `for merged PR #${String(pr.number)}`,
    );

    const results = await close_linked_issues(repo_full_name, pr.number, issue_numbers, gh_token);

    for (const result of results) {
      if (!result.success) {
        sentry.captureException(new Error(result.error ?? "unknown"), {
          tags: { module: "pr-cron", entity: entity_id, action: "close_issue" },
          contexts: {
            pr: { number: pr.number, title: pr.title },
            issue: { number: result.issue_number },
          },
        });
      }
    }
  }
}
