import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LobsterFarmConfig, EntityConfig } from "@lobster-farm/shared";
import { expand_home } from "@lobster-farm/shared";
import type { EntityRegistry } from "./registry.js";
import type { ClaudeSessionManager } from "./session.js";
import type { DiscordBot } from "./discord.js";

const exec = promisify(execFile);

// ── Types ──

interface OpenPR {
  number: number;
  title: string;
  headRefName: string;
  updatedAt: string;
  url: string;
}

interface PRReviewState {
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
  private active_reviews = new Map<string, PRReviewState>(); // key: "entity:pr#"
  private running = false;

  constructor(
    private registry: EntityRegistry,
    private session_manager: ClaudeSessionManager,
    private config: LobsterFarmConfig,
    private discord: DiscordBot | null = null,
  ) {}

  /** Start the polling cron. */
  start(interval_ms: number = DEFAULT_INTERVAL_MS): void {
    if (this.timer) return;

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
  get_active_reviews(): PRReviewState[] {
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

    for (const pr of prs) {
      const key = `${entity_id}:${String(pr.number)}`;

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

  /** Check if a PR already has a review. */
  private async pr_has_review(repo_path: string, pr_number: number): Promise<boolean> {
    try {
      const { stdout } = await exec("gh", [
        "pr", "view", String(pr_number),
        "--json", "reviews",
        "--jq", ".reviews | length",
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

        // Notify in alerts
        if (this.discord) {
          void this.discord.send_to_entity(
            entity_id,
            "alerts",
            `PR #${String(pr.number)} review completed: "${pr.title}"`,
            "reviewer" as import("@lobster-farm/shared").ArchetypeRole,
          );
        }
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
}
