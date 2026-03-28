import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LobsterFarmConfig, EntityConfig, ArchetypeRole } from "@lobster-farm/shared";
import { expand_home } from "@lobster-farm/shared";
import type { EntityRegistry } from "./registry.js";
import type { ClaudeSessionManager } from "./session.js";
import type { DiscordBot } from "./discord.js";
import type { FeatureManager } from "./features.js";
import type { GitHubAppAuth } from "./github-app.js";
import { fetch_review_comments, build_review_fix_prompt } from "./features.js";
import { detect_review_outcome } from "./actions.js";
import { load_pr_reviews, save_pr_reviews } from "./persistence.js";
import type { PRReviewState } from "./persistence.js";

const exec = promisify(execFile);

// ── Types ──

interface OpenPR {
  number: number;
  title: string;
  headRefName: string;
  updatedAt: string;
  url: string;
  author: { login: string };
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

  constructor(
    private registry: EntityRegistry,
    private session_manager: ClaudeSessionManager,
    private config: LobsterFarmConfig,
    private discord: DiscordBot | null = null,
    private feature_manager: FeatureManager | null = null,
    private github_app: GitHubAppAuth | null = null,
  ) {}

  /** Start the polling cron. Loads persisted review state before first poll. */
  async start(interval_ms: number = DEFAULT_INTERVAL_MS): Promise<void> {
    if (this.timer) return;

    // Load persisted review state so we don't re-review after restart
    this.processed = await load_pr_reviews(this.config);
    const count = Object.keys(this.processed).length;
    if (count > 0) {
      console.log(`[pr-cron] Loaded ${String(count)} processed PR reviews from disk`);
    }

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
    try {
      const entities = this.registry.get_active();

      for (const entity_config of entities) {
        const entity_id = entity_config.entity.id;
        const repos = entity_config.entity.repos;

        for (const repo of repos) {
          const repo_path = expand_home(repo.path);
          await this.check_repo(entity_id, repo_path, entity_config);
        }
      }
    } catch (err) {
      console.error(`[pr-cron] Poll failed: ${String(err)}`);
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
    let prs: OpenPR[];
    try {
      const { stdout } = await exec("gh", [
        "pr", "list",
        "--state", "open",
        "--json", "number,title,headRefName,updatedAt,url,author",
      ], { cwd: repo_path, timeout: 30_000 });

      prs = JSON.parse(stdout) as OpenPR[];
    } catch (err) {
      // gh CLI not available or not in a git repo — skip
      console.log(`[pr-cron] Could not list PRs for ${entity_id}: ${String(err)}`);
      return;
    }

    if (prs.length === 0) return;

    // Clean stale entries: remove processed PRs that are no longer open
    const open_keys = new Set(prs.map(pr => `${entity_id}:${String(pr.number)}`));
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

    for (const pr of prs) {
      const key = `${entity_id}:${String(pr.number)}`;

      // Skip if already processed — unless PR was updated since our review
      const prior = this.processed[key];
      if (prior && new Date(pr.updatedAt) <= new Date(prior.reviewed_at)) {
        continue;
      }
      if (prior) {
        // PR updated after our review — allow re-review
        console.log(`[pr-cron] PR #${String(pr.number)} updated since last review, allowing re-review`);
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
    // Note: we don't filter by author here. In this codebase all reviews come from
    // the same GitHub account (ultim88888888). If CI bots start posting comments,
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
      const { stdout } = await exec("gh", [
        "pr", "view", String(pr_number),
        "--json", "reviews,comments,commits",
      ], { cwd: repo_path, timeout: 15_000 });

      return JSON.parse(stdout) as PRFeedbackData;
    } catch {
      return null;
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

    const prompt = [
      `Review PR #${String(pr.number)}: "${pr.title}" on branch ${pr.headRefName}.`,
      `Repository: ${repo_path}`,
      ``,
      `Run /review to do a comprehensive code review.`,
      `Post your review on the PR using gh cli.`,
      `If the code is clean — approve the PR with: gh pr review ${String(pr.number)} --approve --body "Looks good."`,
      `If changes are needed — request changes with: gh pr review ${String(pr.number)} --request-changes --body "<your findings>"`,
      ``,
      `After posting your review, if you approved, merge the PR:`,
      `gh pr merge ${String(pr.number)} --squash --delete-branch`,
    ].join("\n");

    console.log(`[pr-cron] Spawning reviewer for PR #${String(pr.number)} in ${entity_id}`);

    // Inject GitHub App token if available — gives reviewer its own identity
    let spawn_env: Record<string, string> | undefined;
    if (this.github_app) {
      try {
        const gh_token = await this.github_app.get_token();
        spawn_env = { GH_TOKEN: gh_token };
      } catch (err) {
        console.error(`[pr-cron] Failed to get GitHub App token: ${String(err)}`);
        // Continue without app token — reviewer will use default gh auth
      }
    }

    try {
      const session = await this.session_manager.spawn({
        entity_id,
        feature_id: `pr-review-${String(pr.number)}`,
        archetype: "reviewer",
        dna: ["review-guideline"],
        model: { model: "sonnet", think: "standard" },
        worktree_path: repo_path,
        prompt,
        interactive: false,
        env: spawn_env,
      });

      console.log(`[pr-cron] Reviewer session ${session.session_id.slice(0, 8)} started for PR #${String(pr.number)}`);

      // Listen for session completion
      const on_complete = (result: { session_id: string; exit_code: number }) => {
        if (result.session_id !== session.session_id) return;
        this.session_manager.removeListener("session:completed", on_complete);
        this.session_manager.removeListener("session:failed", on_fail);

        this.active_reviews.delete(key);
        console.log(`[pr-cron] Review completed for PR #${String(pr.number)} in ${entity_id}`);

        // Persist completion so we don't re-review after restart
        void this.persist_review_completion(entity_id, pr, repo_path)
          .catch(err => console.error(`[pr-cron] Failed to persist review for PR #${String(pr.number)}: ${String(err)}`));
      };

      const on_fail = (session_id: string, error: string) => {
        if (session_id !== session.session_id) return;
        this.session_manager.removeListener("session:completed", on_complete);
        this.session_manager.removeListener("session:failed", on_fail);

        this.active_reviews.delete(key);
        console.error(`[pr-cron] Review failed for PR #${String(pr.number)}: ${error}`);
      };

      this.session_manager.on("session:completed", on_complete);
      this.session_manager.on("session:failed", on_fail);
    } catch (err) {
      this.active_reviews.delete(key);
      console.error(`[pr-cron] Failed to spawn reviewer for PR #${String(pr.number)}: ${String(err)}`);
    }
  }

  /** Persist review completion to disk, then hand off to outcome routing. */
  private async persist_review_completion(
    entity_id: string,
    pr: OpenPR,
    repo_path: string,
  ): Promise<void> {
    const key = `${entity_id}:${String(pr.number)}`;
    const outcome = await detect_review_outcome(pr.number, repo_path);

    this.processed[key] = {
      entity_id,
      pr_number: pr.number,
      reviewed_at: new Date().toISOString(),
      outcome,
    };
    await save_pr_reviews(this.processed, this.config);
    console.log(`[pr-cron] Persisted review for PR #${String(pr.number)} (${outcome})`);

    // Route the outcome (alerts, fix spawning, etc.)
    await this.handle_review_completion(entity_id, repo_path, pr, outcome);
  }

  /** After a reviewer session completes, detect the outcome and route accordingly. */
  private async handle_review_completion(
    entity_id: string,
    repo_path: string,
    pr: OpenPR,
    review_outcome?: "approved" | "changes_requested" | "pending",
  ): Promise<void> {
    const review_state = review_outcome ?? await detect_review_outcome(pr.number, repo_path);
    const linked_feature = this.feature_manager?.find_by_pr(pr.number) ?? null;

    if (linked_feature) {
      // Internal PR caught by cron — feature manager handles its own transitions
      console.log(`[pr-cron] PR #${String(pr.number)} linked to feature ${linked_feature.id} — deferring to feature manager`);
      return;
    }

    // Non-feature PR — determine if internal (our agents) or truly external
    const entity_config = this.registry.get(entity_id);
    const github_user = entity_config?.entity.accounts?.github?.user;
    const is_internal = github_user != null && pr.author.login === github_user;

    if (review_state === "changes_requested") {
      await this.spawn_external_pr_fixer(entity_id, repo_path, pr);
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
      const is_merged = await this.check_pr_merged(repo_path, pr.number);
      if (is_internal) {
        await this.notify_alerts(
          entity_id,
          `PR #${String(pr.number)}: ${pr.title} — ${is_merged ? "approved and merged to main" : "approved, awaiting merge"}`,
        );
      } else if (is_merged) {
        await this.notify_alerts(
          entity_id,
          `External PR #${String(pr.number)} from @${pr.author.login}: ${pr.title} — approved and merged to main`,
        );
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

  /** Spawn a builder session to fix an external PR based on reviewer feedback. */
  private async spawn_external_pr_fixer(
    entity_id: string,
    repo_path: string,
    pr: OpenPR,
  ): Promise<void> {
    // Fetch the actual review comments to give the builder full context
    const review_comments = await fetch_review_comments(pr.number, repo_path);

    const prompt = [
      `An external PR needs fixes based on reviewer feedback.`,
      `PR #${String(pr.number)}: "${pr.title}" on branch ${pr.headRefName}`,
      `Repository: ${repo_path}`,
      ``,
      `First, check out the PR branch: git checkout ${pr.headRefName}`,
      ``,
      build_review_fix_prompt(pr.number, pr.title, review_comments),
      ``,
      `Do NOT merge the PR.`,
    ].join("\n");

    console.log(`[pr-cron] Spawning builder to fix external PR #${String(pr.number)} in ${entity_id}`);

    // Inject GitHub App token if available
    let fix_env: Record<string, string> | undefined;
    if (this.github_app) {
      try {
        const gh_token = await this.github_app.get_token();
        fix_env = { GH_TOKEN: gh_token };
      } catch (err) {
        console.error(`[pr-cron] Failed to get GitHub App token for fixer: ${String(err)}`);
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
      console.error(`[pr-cron] Failed to spawn builder for external PR #${String(pr.number)}: ${String(err)}`);
    }
  }

  /** Send a notification to the entity's alerts channel. */
  private async notify_alerts(entity_id: string, message: string): Promise<void> {
    console.log(`[pr-cron:alerts] ${message}`);
    if (this.discord) {
      await this.discord.send_to_entity(
        entity_id,
        "alerts",
        message,
        "reviewer" as ArchetypeRole,
      );
    }
  }

  /** Check if a PR has been merged. */
  private async check_pr_merged(repo_path: string, pr_number: number): Promise<boolean> {
    try {
      const { stdout } = await exec("gh", [
        "pr", "view", String(pr_number),
        "--json", "state",
        "--jq", ".state",
      ], { cwd: repo_path, timeout: 15_000 });
      return stdout.trim() === "MERGED";
    } catch {
      return false;
    }
  }
}
