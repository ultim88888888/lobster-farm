import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LobsterFarmConfig, EntityConfig, ArchetypeRole } from "@lobster-farm/shared";
import { expand_home } from "@lobster-farm/shared";
import type { EntityRegistry } from "./registry.js";
import type { ClaudeSessionManager } from "./session.js";
import type { DiscordBot } from "./discord.js";
import type { FeatureManager } from "./features.js";
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
}

interface ActiveReview {
  pr_number: number;
  entity_id: string;
  repo_url: string;
  status: "reviewing" | "changes_requested" | "approved" | "merged";
  last_checked: Date;
}

// ── PR Cron ──

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

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
        "--json", "number,title,headRefName,updatedAt,url",
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

      // Check if PR already has a review
      const has_review = await this.pr_has_review(repo_path, pr.number);
      if (has_review) {
        console.log(`[pr-cron] PR #${String(pr.number)} already reviewed, skipping`);
        continue;
      }

      // Spawn reviewer
      await this.review_pr(entity_id, repo_path, pr, entity_config);
    }
  }

  /** Check if a PR already has a review (formal reviews OR comments). */
  private async pr_has_review(repo_path: string, pr_number: number): Promise<boolean> {
    try {
      const { stdout } = await exec("gh", [
        "pr", "view", String(pr_number),
        "--json", "reviews,comments",
        "--jq", "(.reviews | length) + (.comments | length)",
      ], { cwd: repo_path, timeout: 15_000 });

      return parseInt(stdout.trim(), 10) > 0;
    } catch {
      return false;
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
        void this.persist_review_completion(entity_id, pr, repo_path);
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

    // External PR — no tracked feature
    if (review_state === "changes_requested") {
      await this.spawn_external_pr_fixer(entity_id, repo_path, pr);
      await this.notify_alerts(
        entity_id,
        `External PR #${String(pr.number)} needs changes — spawning builder to fix`,
      );
    } else if (review_state === "approved") {
      // Never auto-merge external code — escalate to human
      await this.notify_alerts(
        entity_id,
        `External PR #${String(pr.number)} approved — awaiting human merge approval`,
      );
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
    const prompt = [
      `An external PR needs fixes based on reviewer feedback.`,
      `PR #${String(pr.number)}: "${pr.title}" on branch ${pr.headRefName}`,
      `Repository: ${repo_path}`,
      ``,
      `Steps:`,
      `1. Check out the PR branch: git checkout ${pr.headRefName}`,
      `2. Read the reviewer's comments: gh pr view ${String(pr.number)} --json reviews --jq '.reviews[].body'`,
      `3. Make targeted fixes to address ONLY what the reviewer flagged — do not refactor beyond that`,
      `4. Commit and push your changes to the PR branch`,
      `5. Do NOT merge the PR`,
    ].join("\n");

    console.log(`[pr-cron] Spawning builder to fix external PR #${String(pr.number)} in ${entity_id}`);

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
}
