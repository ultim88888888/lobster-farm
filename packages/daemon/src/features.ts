import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { writeFile as writeFileAsync, unlink } from "node:fs/promises";
import type {
  FeatureState,
  Phase,
  ArchetypeRole,
  ModelTier,
  Priority,
  LobsterFarmConfig,
} from "@lobster-farm/shared";
import { PHASE_TRANSITIONS } from "@lobster-farm/shared";
import type { EntityRegistry } from "./registry.js";
import { QueueFullError } from "./queue.js";
import type { TaskQueue } from "./queue.js";
import type { BotPool, PoolAssignment } from "./pool.js";
import type { SessionResult } from "./session.js";
import * as actions from "./actions.js";
import { save_features, load_features, append_session_log } from "./persistence.js";
import { extract_session_learnings } from "./hooks.js";
import { PersistQueue } from "./persist-queue.js";

// ── Phase configuration ──

interface PhaseConfig {
  archetype: ArchetypeRole | null;
  dna: string[];
  model: ModelTier | null;
  needs_approval: boolean;
  optional: boolean;
  skip_unless_labels?: string[];
  prompt_template: string | null;
}

const PHASE_CONFIG: Record<Phase, PhaseConfig> = {
  plan: {
    archetype: "planner",
    dna: ["planning-dna"],
    model: { model: "opus", think: "high" },
    needs_approval: true,
    optional: false,
    prompt_template:
      "Plan feature #{issue} for entity {entity}: {title}. " +
      "Write a detailed spec as a GitHub issue comment with acceptance criteria, " +
      "technical approach, and scope boundaries.",
  },
  design: {
    archetype: "designer",
    dna: ["design-dna", "coding-dna"],
    model: { model: "opus", think: "standard" },
    needs_approval: true,
    optional: true,
    skip_unless_labels: ["ui", "frontend", "brand", "design"],
    prompt_template:
      "Design the UI/UX for feature #{issue}: {title}. " +
      "Create coded prototypes using the entity's design system.",
  },
  build: {
    archetype: "builder",
    dna: ["coding-dna"],
    model: { model: "opus", think: "high" },
    needs_approval: false,
    optional: false,
    prompt_template:
      "Implement feature #{issue}: {title}.\n" +
      "Follow the spec in the GitHub issue. Write tests.\n" +
      "\n" +
      "You're working in a collaboration room. Use your judgment on when to involve the user:\n" +
      "- Straightforward, well-specced work: build it, push, and open a PR with `gh pr create`.\n" +
      "- Complex or ambiguous work: show progress, ask questions when you hit decisions that could go either way.\n" +
      "- Visual/UI work: show the user a preview or screenshots before opening a PR.\n" +
      "- When you hit something the spec didn't cover: ask rather than guess.\n" +
      "\n" +
      "When the work is ready, commit, push, and open a PR. Post the PR link in this channel.\n" +
      "If the user asks for changes after you show them: iterate, then open the PR when they approve.",
  },
  review: {
    archetype: "reviewer",
    dna: ["review-guideline"],
    model: { model: "sonnet", think: "standard" },
    needs_approval: false,
    optional: false,
    prompt_template:
      "Review the pull request for feature #{issue}: {title}. " +
      "Check correctness, security, robustness, performance, and maintainability. " +
      "Post your review on the PR.",
  },
  ship: {
    archetype: null,
    dna: [],
    model: null,
    needs_approval: false,
    optional: false,
    prompt_template: null,
  },
  done: {
    archetype: null,
    dna: [],
    model: null,
    needs_approval: false,
    optional: false,
    prompt_template: null,
  },
};

// ── Prompt template resolution ──

function resolve_prompt(
  template: string,
  feature: FeatureState,
): string {
  return template
    .replace("{issue}", String(feature.githubIssue))
    .replace("{entity}", feature.entity)
    .replace("{title}", feature.title);
}

// ── Feature Manager ──

/** Phases that are valid as a starting phase for feature creation. */
const VALID_START_PHASES: readonly Phase[] = ["plan", "design", "build"] as const;

export interface CreateFeatureOptions {
  entity_id: string;
  title: string;
  github_issue: number;
  priority?: Priority;
  labels?: string[];
  start_phase?: Phase;
  depends_on?: string[];
}

export class FeatureManager extends EventEmitter {
  private features = new Map<string, FeatureState>();
  private session_to_feature = new Map<string, string>();
  private task_to_feature = new Map<string, string>();

  /** Maps pool bot ID → feature ID for pool-based builder sessions. */
  private pool_bot_to_feature = new Map<number, string>();

  /** Maps pool bot ID → session start timestamp (ms) for duration tracking. */
  private pool_bot_start_times = new Map<number, number>();

  /** Optional pool reference — set via set_pool() after construction. */
  private pool: BotPool | null = null;

  private persist_queue: PersistQueue;

  constructor(
    private registry: EntityRegistry,
    private queue: TaskQueue,
    private config: LobsterFarmConfig,
  ) {
    super();

    this.persist_queue = new PersistQueue(() => this.persist());

    // When the queue drains (a task completes), retry features blocked due to queue-full
    this.queue.on("drain", () => this.retry_queue_blocked());
  }

  /** Drain the persist queue. Call during graceful shutdown. */
  drain_persist(): Promise<void> {
    return this.persist_queue.drain();
  }

  /**
   * Connect the pool to this feature manager and wire up event listeners.
   * Called from daemon index.ts after both pool and feature manager are initialized.
   */
  set_pool(pool: BotPool): void {
    this.pool = pool;

    // When a pool bot is released, retry features blocked waiting for pool capacity
    pool.on("bot:released", () => {
      this.retry_pool_blocked();
    });

    // When a pool bot's tmux session ends, check for PR and advance or alert
    pool.on("bot:session_ended", (event: { bot_id: number; channel_id: string | null; entity_id: string | null }) => {
      void this.on_bot_session_ended(event);
    });
  }

  /** Load persisted features from disk. Call on daemon startup. */
  async load_persisted(): Promise<void> {
    const saved = await load_features(this.config);
    for (const feature of saved) {
      this.features.set(feature.id, feature);

      // Rebuild pool_bot_to_feature map from persisted poolBotId
      if (feature.poolBotId !== null && feature.poolBotId !== undefined) {
        this.pool_bot_to_feature.set(feature.poolBotId, feature.id);
      }
    }
    if (saved.length > 0) {
      console.log(`[features] Restored ${String(saved.length)} features from disk`);
    }
  }

  /** Persist all features to disk. Called after every mutation. */
  private async persist(): Promise<void> {
    await save_features([...this.features.values()], this.config);
  }

  /**
   * Create a new feature.
   * Defaults to "plan" phase. Pass `start_phase` to skip earlier phases
   * (e.g., "build" when the spec is already written on the GitHub issue).
   */
  async create_feature(opts: CreateFeatureOptions): Promise<FeatureState> {
    const entity = this.registry.get(opts.entity_id);
    if (!entity) {
      throw new Error(`Entity "${opts.entity_id}" not found`);
    }

    const start_phase = opts.start_phase ?? "plan";

    if (!VALID_START_PHASES.includes(start_phase)) {
      throw new Error(
        `Invalid start_phase "${start_phase}". Must be one of: ${VALID_START_PHASES.join(", ")}`,
      );
    }

    const id = `${opts.entity_id}-${String(opts.github_issue)}`;

    // Guard against duplicate creation.
    // If the feature already exists and is active, reject the request to avoid
    // orphaning an in-progress session or pool bot assignment.
    // If the feature is in a terminal state ("done"), allow re-creation by
    // removing the old entry first.
    const existing = this.features.get(id);
    if (existing) {
      if (existing.phase === "done") {
        this.features.delete(id);
      } else {
        throw new Error(
          `Feature "${id}" already exists and is active (phase: ${existing.phase}). ` +
            `Finish or remove the existing feature before re-creating it.`,
        );
      }
    }

    const branch = `feature/${String(opts.github_issue)}-${slugify(opts.title)}`;
    const depends_on = opts.depends_on ?? [];

    // Validate dependency IDs reference existing features
    for (const dep_id of depends_on) {
      if (!this.features.has(dep_id)) {
        throw new Error(`Dependency "${dep_id}" not found`);
      }
    }

    // Check for circular dependencies before creating the feature.
    // We temporarily build what the graph would look like with this new feature,
    // then run DFS cycle detection.
    if (depends_on.length > 0) {
      const cycle = check_dependency_cycle(id, depends_on, this.features);
      if (cycle) {
        throw new Error(
          `Circular dependency detected: ${cycle.join(" → ")}`,
        );
      }
    }

    // Determine if any dependency is not yet done
    const pending_deps = depends_on.filter((dep_id) => {
      const dep = this.features.get(dep_id);
      return dep !== undefined && dep.phase !== "done";
    });

    const is_blocked_by_deps = pending_deps.length > 0;

    const feature: FeatureState = {
      id,
      entity: opts.entity_id,
      githubIssue: opts.github_issue,
      title: opts.title,
      phase: start_phase,
      priority: opts.priority ?? "medium",
      branch,
      worktreePath: null,
      discordWorkRoom: null,
      activeArchetype: null,
      activeDna: [],
      sessionId: null,
      lastSessionId: null,
      lastBuilderSessionId: null,
      dependsOn: depends_on,
      blocked: is_blocked_by_deps,
      blockedReason: is_blocked_by_deps
        ? `Waiting on: ${pending_deps.join(", ")}`
        : null,
      approved: false,
      labels: opts.labels ?? [],
      poolBotId: null,
      prNumber: null,
      agentDone: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.features.set(id, feature);

    // If blocked by dependencies, skip entry actions and agent spawn —
    // these will happen when the last dependency reaches done.
    if (!is_blocked_by_deps) {
      // Run entry actions for the start phase (e.g., build creates a worktree and assigns a work room).
      // Skipped for "plan" — plan has no entry actions in run_entry_actions.
      if (start_phase !== "plan") {
        await this.run_entry_actions(feature, start_phase);
      }

      // Spawn the agent for the start phase.
      // Awaited so pool-based assignments complete before the caller sees the feature.
      const phase_config = PHASE_CONFIG[start_phase];
      await this.spawn_phase_agent(feature, phase_config);
    }

    console.log(
      `[features] Created feature ${id}: "${opts.title}" (phase: ${start_phase})` +
        (is_blocked_by_deps ? ` [blocked: ${pending_deps.join(", ")}]` : ""),
    );

    // Persist after entry actions so worktreePath / discordWorkRoom are captured
    this.persist_queue.enqueue();

    this.emit("feature:created", feature);
    return feature;
  }

  /** Approve the current phase gate. Required before advancing from gated phases. */
  approve_phase(feature_id: string): FeatureState {
    const feature = this.get_feature(feature_id);
    if (!feature) throw new Error(`Feature "${feature_id}" not found`);

    const phase_config = PHASE_CONFIG[feature.phase];
    if (!phase_config.needs_approval) {
      throw new Error(
        `Phase "${feature.phase}" for feature "${feature_id}" does not require approval`,
      );
    }

    feature.approved = true;
    feature.updatedAt = new Date().toISOString();
    this.persist_queue.enqueue();

    console.log(`[features] Phase "${feature.phase}" approved for ${feature_id}`);
    this.emit("feature:approved", feature);

    return feature;
  }

  /**
   * Advance a feature to the next phase.
   * Validates the transition, runs exit/entry actions, and spawns agents.
   */
  async advance_feature(
    feature_id: string,
    target_phase?: Phase,
  ): Promise<FeatureState> {
    const feature = this.get_feature(feature_id);
    if (!feature) throw new Error(`Feature "${feature_id}" not found`);

    if (feature.blocked) {
      throw new Error(
        `Feature "${feature_id}" is blocked: ${feature.blockedReason ?? "unknown"}`,
      );
    }

    const current_config = PHASE_CONFIG[feature.phase];

    // Check approval gate
    if (current_config.needs_approval && !feature.approved) {
      throw new Error(
        `Phase "${feature.phase}" requires approval before advancing. ` +
          `Call approve_phase("${feature_id}") first.`,
      );
    }

    // Determine next phase
    const next_phase = target_phase ?? this.determine_next_phase(feature);
    if (!next_phase) {
      throw new Error(`No valid next phase for feature "${feature_id}" in phase "${feature.phase}"`);
    }

    // Validate transition
    const valid_transitions = PHASE_TRANSITIONS[feature.phase];
    if (!valid_transitions.includes(next_phase)) {
      throw new Error(
        `Invalid transition: ${feature.phase} → ${next_phase}. ` +
          `Valid: ${valid_transitions.join(", ")}`,
      );
    }

    const old_phase = feature.phase;

    // Update feature state
    feature.phase = next_phase;
    feature.approved = false;
    feature.agentDone = false;
    feature.sessionId = null;
    feature.activeArchetype = null;
    feature.activeDna = [];
    feature.updatedAt = new Date().toISOString();

    console.log(`[features] ${feature_id}: ${old_phase} → ${next_phase}`);

    // Run entry actions for the new phase
    await this.run_entry_actions(feature, next_phase);

    // Spawn agent if this phase has one
    const next_config = PHASE_CONFIG[next_phase];
    if (next_config.archetype && next_config.model && next_config.prompt_template) {
      await this.spawn_phase_agent(feature, next_config);
    }

    // If this phase has no agent and no approval gate, auto-advance
    if (!next_config.archetype && !next_config.needs_approval && next_phase !== "done") {
      // Ship phase: run ship actions then advance to done
      if (next_phase === "ship") {
        await this.run_ship_actions(feature);
        return this.advance_feature(feature_id, "done");
      }
    }

    this.persist_queue.enqueue();
    this.emit("feature:advanced", feature, old_phase);

    // When a feature reaches done, check if any blocked features can be unblocked
    if (next_phase === "done") {
      void this.resolve_dependencies(feature_id);
    }

    return feature;
  }

  /** Register a session->feature mapping when a session starts. */
  on_session_started(session: { session_id: string; feature_id: string }): void {
    const feature = this.features.get(session.feature_id);
    if (feature) {
      feature.sessionId = session.session_id;
      feature.lastSessionId = session.session_id;

      // Preserve builder session ID separately so it survives the reviewer overwriting lastSessionId
      if (feature.activeArchetype === "builder") {
        feature.lastBuilderSessionId = session.session_id;
      }

      this.session_to_feature.set(session.session_id, feature.id);
    }
  }

  /** Handle a completed session -- check if the feature can auto-advance. */
  async on_session_completed(result: SessionResult): Promise<void> {
    const feature_id = this.session_to_feature.get(result.session_id);
    if (!feature_id) return;

    const feature = this.get_feature(feature_id);
    if (!feature) return;

    this.session_to_feature.delete(result.session_id);
    feature.agentDone = true;
    feature.sessionId = null;
    feature.updatedAt = new Date().toISOString();
    this.persist_queue.enqueue();

    console.log(
      `[features] Agent completed for ${feature_id} (phase: ${feature.phase})`,
    );

    // Extract session learnings to daily log (best-effort, non-blocking)
    void extract_session_learnings(
      feature.entity,
      feature_id,
      feature.activeArchetype ?? feature.phase,
      result.session_id,
      this.config,
    );

    const phase_config = PHASE_CONFIG[feature.phase];

    // Review phase: detect outcome instead of blind auto-advance
    if (feature.phase === "review") {
      await this.handle_review_outcome(feature);
      return;
    }

    // Auto-advance if no approval gate
    if (!phase_config.needs_approval) {
      try {
        await this.advance_feature(feature_id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[features] Auto-advance failed for ${feature_id}: ${msg}`);
      }
    } else {
      // Notify that the phase is done and awaiting approval
      const entity = this.registry.get(feature.entity);
      await actions.notify_feature(
        feature,
        `Feature ${feature_id}: ${feature.phase} phase complete. Awaiting approval.`,
        entity,
        { also_alerts: true },
      );
    }
  }

  /** Detect review outcome and route: approved -> ship, changes_requested -> build bounce, pending -> blocked. */
  private async handle_review_outcome(feature: FeatureState): Promise<void> {
    const entity = this.registry.get(feature.entity);

    if (!feature.prNumber) {
      console.error(`[features] Review completed for ${feature.id} but no PR number -- blocking`);
      feature.blocked = true;
      feature.blockedReason = "Review completed but no PR number to check";
      this.persist_queue.enqueue();
      return;
    }

    const repo_path = entity
      ? expand_home_safe(entity.entity.repos[0]?.path ?? ".")
      : ".";

    const outcome = await actions.detect_review_outcome(feature.prNumber, repo_path);

    switch (outcome) {
      case "approved":
        console.log(`[features] PR #${String(feature.prNumber)} approved -- advancing ${feature.id} to ship`);
        try {
          await this.advance_feature(feature.id, "ship");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[features] Failed to advance ${feature.id} to ship: ${msg}`);
        }
        break;

      case "changes_requested":
        console.log(`[features] PR #${String(feature.prNumber)} changes requested -- bouncing ${feature.id} back to build`);
        try {
          await this.advance_feature(feature.id, "build");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[features] Failed to bounce ${feature.id} to build: ${msg}`);
        }
        // Notify alerts about the bounce
        await actions.notify_feature(
          feature,
          `Review bounced ${feature.id} back to build -- changes requested on PR #${String(feature.prNumber)}`,
          entity,
          { also_alerts: true },
        );
        break;

      case "pending":
        console.log(`[features] Reviewer completed for ${feature.id} without posting a decision -- blocking`);
        feature.blocked = true;
        feature.blockedReason = "Reviewer session completed without posting a review decision";
        this.persist_queue.enqueue();
        this.emit("feature:blocked", feature, feature.blockedReason);
        break;
    }
  }

  /** Handle a failed session -- mark the feature as blocked. */
  on_session_failed(session_id: string, error: string): void {
    const feature_id = this.session_to_feature.get(session_id);
    if (!feature_id) return;

    const feature = this.get_feature(feature_id);
    if (!feature) return;

    this.session_to_feature.delete(session_id);
    feature.blocked = true;
    feature.blockedReason = error;
    feature.sessionId = null;
    feature.updatedAt = new Date().toISOString();
    this.persist_queue.enqueue();

    console.error(`[features] Session failed for ${feature_id}: ${error}`);
    this.emit("feature:blocked", feature, error);
  }

  /** Unblock a feature (e.g., after manual intervention). */
  unblock_feature(feature_id: string): FeatureState {
    const feature = this.get_feature(feature_id);
    if (!feature) throw new Error(`Feature "${feature_id}" not found`);

    feature.blocked = false;
    feature.blockedReason = null;
    feature.updatedAt = new Date().toISOString();
    this.persist_queue.enqueue();
    return feature;
  }

  /**
   * When a feature reaches done, scan for features blocked by dependencies
   * and unblock any whose deps are now all done.
   */
  private async resolve_dependencies(completed_feature_id: string): Promise<void> {
    for (const feature of this.features.values()) {
      if (!feature.blocked || feature.dependsOn.length === 0) continue;

      // Only consider features that actually depend on the one that just completed
      if (!feature.dependsOn.includes(completed_feature_id)) continue;

      const all_deps_done = feature.dependsOn.every((dep_id) => {
        const dep = this.features.get(dep_id);
        return dep !== undefined && dep.phase === "done";
      });

      if (!all_deps_done) continue;

      // All dependencies satisfied -- unblock and spawn
      feature.blocked = false;
      feature.blockedReason = null;
      feature.updatedAt = new Date().toISOString();

      console.log(
        `[features] Dependencies satisfied for ${feature.id} -- unblocking`,
      );

      // Run entry actions if needed (same logic as create_feature)
      if (feature.phase !== "plan") {
        await this.run_entry_actions(feature, feature.phase);
      }

      const phase_config = PHASE_CONFIG[feature.phase];
      void this.spawn_phase_agent(feature, phase_config);

      this.emit("feature:unblocked", feature);
    }

    this.persist_queue.enqueue();
  }

  /**
   * Retry spawning agents for features that were blocked because the queue was full.
   * Called by the queue's drain callback when a task completes and capacity frees up.
   */
  private retry_queue_blocked(): void {
    const blocked = [...this.features.values()].filter(
      (f) => f.blocked && f.blockedReason?.includes("Queue full"),
    );

    for (const feature of blocked) {
      const phase_config = PHASE_CONFIG[feature.phase];
      if (!phase_config.archetype || !phase_config.model || !phase_config.prompt_template) {
        continue;
      }

      // Clear the block before retrying so the feature isn't stuck if spawn succeeds
      feature.blocked = false;
      feature.blockedReason = null;
      feature.updatedAt = new Date().toISOString();

      console.log(`[features] Retrying spawn for queue-blocked feature ${feature.id}`);

      // spawn_phase_agent will re-block if the queue is still full
      void this.spawn_phase_agent(feature, phase_config);
      this.persist_queue.enqueue();
    }
  }

  /**
   * Retry spawning builders for features blocked because no pool bots were available.
   * Called when a pool bot is released (bot:released event).
   */
  private retry_pool_blocked(): void {
    const blocked = [...this.features.values()].filter(
      (f) => f.blocked && f.blockedReason?.includes("No pool bots"),
    );

    for (const feature of blocked) {
      const phase_config = PHASE_CONFIG[feature.phase];
      if (!phase_config.archetype || !phase_config.model || !phase_config.prompt_template) {
        continue;
      }

      // Clear the block before retrying
      feature.blocked = false;
      feature.blockedReason = null;
      feature.updatedAt = new Date().toISOString();

      console.log(`[features] Retrying pool assignment for pool-blocked feature ${feature.id}`);

      // spawn_phase_agent will re-block if pool is still full
      void this.spawn_phase_agent(feature, phase_config);
      this.persist_queue.enqueue();
    }
  }

  /**
   * Handle a pool bot's tmux session ending.
   * Looks up the feature via pool_bot_to_feature, checks for PR, advances or alerts.
   */
  private async on_bot_session_ended(event: {
    bot_id: number;
    channel_id: string | null;
    entity_id: string | null;
  }): Promise<void> {
    const feature_id = this.pool_bot_to_feature.get(event.bot_id);
    if (!feature_id) return;

    const feature = this.get_feature(feature_id);
    if (!feature) {
      this.pool_bot_to_feature.delete(event.bot_id);
      return;
    }

    // Log pool session completion
    const start_ms = this.pool_bot_start_times.get(event.bot_id);
    this.pool_bot_start_times.delete(event.bot_id);
    const now = new Date();
    void append_session_log(feature.entity, {
      session_id: `pool-${String(event.bot_id)}-ended-${now.getTime()}`,
      entity_id: feature.entity,
      feature_id: feature.id,
      archetype: feature.activeArchetype ?? "builder",
      phase: feature.phase,
      source: "pool",
      started_at: start_ms ? new Date(start_ms).toISOString() : now.toISOString(),
      ended_at: now.toISOString(),
      exit_code: 0,  // tmux session ended -- treat as normal exit
      duration_ms: start_ms ? now.getTime() - start_ms : null,
      bot_id: event.bot_id,
      resume: false,
    }, this.config);

    // Clean up pool binding
    this.pool_bot_to_feature.delete(event.bot_id);
    feature.poolBotId = null;
    feature.updatedAt = new Date().toISOString();

    if (feature.phase !== "build") {
      // Not in build phase — just clean up, don't try to advance
      this.persist_queue.enqueue();
      return;
    }

    const entity = this.registry.get(feature.entity);

    // Check if builder created a PR on the feature branch
    try {
      const repo_path = entity
        ? expand_home_safe(entity.entity.repos[0]?.path ?? ".")
        : ".";
      const cwd = feature.worktreePath ?? repo_path;

      const pr_number = this.detect_pr_on_branch(feature.branch, cwd);

      if (pr_number > 0) {
        // PR exists — advance to review
        feature.prNumber = pr_number;
        console.log(`[features] Builder exited with PR #${String(pr_number)} for ${feature.id} -- advancing to review`);
        this.persist_queue.enqueue();

        try {
          await this.advance_feature(feature.id, "review");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[features] Failed to advance ${feature.id} to review: ${msg}`);
        }
        return;
      }
    } catch {
      // gh command failed — treat as no PR
    }

    // No PR — alert
    console.log(`[features] Builder exited without creating a PR for ${feature.id}`);
    await actions.notify_feature(
      feature,
      `Builder exited without creating a PR for ${feature.id}`,
      entity,
      { also_alerts: true },
    );
    this.persist_queue.enqueue();
  }

  /**
   * Check if a PR exists on the given branch. Returns the PR number (>0) or 0.
   * Protected so tests can override without ESM module-spy gymnastics.
   */
  protected detect_pr_on_branch(branch: string, cwd: string): number {
    const pr_output = execFileSync("gh", [
      "pr", "list",
      "--head", branch,
      "--json", "number",
      "--jq", ".[0].number",
    ], { encoding: "utf-8", cwd, timeout: 10_000 }).trim();

    return parseInt(pr_output, 10) || 0;
  }

  // ── Queries ──

  get_feature(id: string): FeatureState | undefined {
    return this.features.get(id);
  }

  get_features_by_entity(entity_id: string): FeatureState[] {
    return [...this.features.values()].filter((f) => f.entity === entity_id);
  }

  list_features(): FeatureState[] {
    return [...this.features.values()];
  }

  /** Find a feature by its linked PR number. Returns null if no feature is linked. */
  find_by_pr(pr_number: number): FeatureState | null {
    for (const feature of this.features.values()) {
      if (feature.prNumber === pr_number) {
        return feature;
      }
    }
    return null;
  }

  // ── Internal ──

  private determine_next_phase(feature: FeatureState): Phase | null {
    const valid = PHASE_TRANSITIONS[feature.phase];
    if (valid.length === 0) return null;

    // Check if design phase should be skipped
    if (valid.includes("design") && valid.includes("build")) {
      const should_design = PHASE_CONFIG.design.skip_unless_labels?.some(
        (label) => feature.labels.includes(label),
      );
      return should_design ? "design" : "build";
    }

    return valid[0] ?? null;
  }

  private async spawn_phase_agent(
    feature: FeatureState,
    phase_config: PhaseConfig,
  ): Promise<void> {
    if (!phase_config.archetype || !phase_config.model || !phase_config.prompt_template) {
      return;
    }

    // Route builders with work rooms through the pool for interactive sessions
    if (phase_config.archetype === "builder" && feature.discordWorkRoom && this.pool) {
      await this.spawn_builder_in_pool(feature, phase_config);
      return;
    }

    // All other archetypes (reviewers, planners, designers) go through the queue
    const entity = this.registry.get(feature.entity);
    if (!entity) return;

    const prompt = resolve_prompt(phase_config.prompt_template, feature);
    const worktree_path = feature.worktreePath ?? expand_home_safe(entity.entity.repos[0]?.path ?? ".");

    // Resume builder session on review->build bounce using the dedicated lastBuilderSessionId.
    // This is intentionally narrow — only builder bounce gets resume. All other transitions get fresh sessions.
    const is_builder_bounce = phase_config.archetype === "builder" && Boolean(feature.lastBuilderSessionId);
    const resume_id = is_builder_bounce ? (feature.lastBuilderSessionId ?? undefined) : undefined;

    let task_id: string;
    try {
      task_id = this.queue.submit({
        entity_id: feature.entity,
        feature_id: feature.id,
        archetype: phase_config.archetype,
        dna: phase_config.dna,
        model: phase_config.model,
        prompt,
        interactive: false,
        priority: feature.priority,
        worktree_path,
        resume_session_id: resume_id,
      });
    } catch (err) {
      if (err instanceof QueueFullError) {
        // Feature is created and persisted — only the agent spawn is deferred.
        // It will auto-retry when capacity frees up via retry_queue_blocked().
        feature.blocked = true;
        feature.blockedReason = "Queue full -- will retry when capacity frees up";
        feature.updatedAt = new Date().toISOString();
        this.persist_queue.enqueue();

        console.log(`[features] Queue full -- ${feature.id} blocked, will retry on drain`);
        this.emit("feature:blocked", feature, feature.blockedReason);
        return;
      }
      throw err;
    }

    feature.activeArchetype = phase_config.archetype;
    feature.activeDna = phase_config.dna;
    this.task_to_feature.set(task_id, feature.id);

    console.log(
      `[features] Spawned ${phase_config.archetype} for ${feature.id} (task: ${task_id.slice(0, 8)})`,
    );
  }

  /**
   * Spawn a builder as an interactive pool bot in the feature's work room.
   * Uses the pool for Discord MCP access so the builder can collaborate with the user.
   */
  private async spawn_builder_in_pool(
    feature: FeatureState,
    phase_config: PhaseConfig,
  ): Promise<void> {
    if (!this.pool || !feature.discordWorkRoom || !phase_config.prompt_template) return;

    // Pool-based builders don't go through the queue, so lastBuilderSessionId is never set for them.
    // Use poolBotId as the bounce signal: if a bot was previously assigned, this is a review->build bounce.
    const is_bounce = feature.phase === "build" && feature.poolBotId !== null;

    // On review->build bounce, check if the pool bot is still assigned to this work room
    if (is_bounce) {
      const existing = this.pool.get_assignment(feature.discordWorkRoom);
      if (existing && existing.id === feature.poolBotId) {
        // Bot still alive in the work room — bridge review feedback directly
        await this.bridge_review_feedback(feature, existing);
        feature.activeArchetype = phase_config.archetype;
        feature.activeDna = phase_config.dna;
        return;
      }
    }

    // Either fresh build or bot was evicted — do a pool assignment
    // Pool bots don't have queue-tracked session IDs, so no resume_id is available.
    const resume_id = undefined;
    const worktree_path = feature.worktreePath ?? undefined;

    let assignment: PoolAssignment | null;
    try {
      assignment = await this.pool.assign(
        feature.discordWorkRoom,
        feature.entity,
        "builder",
        resume_id,
        "work_room",
        worktree_path,
      );
    } catch {
      assignment = null;
    }

    if (!assignment) {
      // No pool bots available — block and wait for retry
      feature.blocked = true;
      feature.blockedReason = "No pool bots available -- will retry when one is freed";
      feature.updatedAt = new Date().toISOString();
      this.persist_queue.enqueue();

      console.log(`[features] No pool bots available -- ${feature.id} blocked, will retry on release`);
      this.emit("feature:blocked", feature, feature.blockedReason);
      return;
    }

    // Track pool-to-feature binding
    feature.poolBotId = assignment.bot_id;
    this.pool_bot_to_feature.set(assignment.bot_id, feature.id);
    this.pool_bot_start_times.set(assignment.bot_id, Date.now());
    feature.activeArchetype = phase_config.archetype;
    feature.activeDna = phase_config.dna;

    console.log(
      `[features] Spawned builder for ${feature.id} in pool (bot: pool-${String(assignment.bot_id)})`,
    );

    // Log pool session start
    void append_session_log(feature.entity, {
      session_id: assignment.session_id ?? `pool-${String(assignment.bot_id)}-${Date.now()}`,
      entity_id: feature.entity,
      feature_id: feature.id,
      archetype: "builder",
      phase: feature.phase,
      source: "pool",
      started_at: new Date().toISOString(),
      ended_at: null,
      exit_code: null,
      duration_ms: null,
      bot_id: assignment.bot_id,
      resume: Boolean(resume_id),
    }, this.config);

    // Bridge the build prompt to the pool bot
    if (is_bounce && feature.prNumber) {
      // Bounce: send review feedback
      await this.bridge_review_feedback_to_tmux(
        assignment.tmux_session,
        feature,
      );
    } else {
      // Fresh build: send the full build prompt
      await this.bridge_build_prompt(
        assignment.tmux_session,
        feature,
        phase_config.prompt_template,
      );
    }

    this.persist_queue.enqueue();
  }

  /**
   * Bridge a build prompt to a pool bot via temp file + tmux send-keys.
   * Same pattern as bridge_first_message() in discord.ts.
   */
  private async bridge_build_prompt(
    tmux_session: string,
    feature: FeatureState,
    prompt_template: string,
  ): Promise<void> {
    const prompt = resolve_prompt(prompt_template, feature);
    const pending_path = `/tmp/lf-build-${feature.id}.txt`;

    try {
      await writeFileAsync(pending_path, prompt, "utf-8");

      // Wait for the bot to be ready
      const start = Date.now();
      const timeout = 30_000;
      let ready = false;

      while (Date.now() - start < timeout) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        try {
          const output = execFileSync(
            "tmux", ["capture-pane", "-t", tmux_session, "-p"],
            { encoding: "utf-8", timeout: 2000 },
          );
          if (output.includes("Listening for channel messages") && output.includes("❯")) {
            ready = true;
            break;
          }
        } catch { /* ignore */ }
      }

      if (!ready) {
        console.log(`[features] Bot ${tmux_session} not ready after ${String(timeout)}ms -- prompt not bridged`);
        return;
      }

      // Small extra delay for the plugin to fully connect
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Send the prompt to the bot's tmux session
      const instruction = `Read ${pending_path} for your build instructions and begin working.`;
      execFileSync("tmux", ["send-keys", "-t", tmux_session, instruction, "Enter"], {
        stdio: "ignore",
        timeout: 5000,
      });

      console.log(`[features] Bridged build prompt to ${tmux_session} for ${feature.id}`);

      // Clean up after a delay
      setTimeout(() => { void unlink(pending_path).catch(() => {}); }, 60_000);
    } catch (err) {
      console.error(`[features] Failed to bridge build prompt: ${String(err)}`);
    }
  }

  /**
   * Bridge review feedback to an existing pool bot that is still assigned to the work room.
   * Used when a review->build bounce finds the bot still alive.
   */
  private async bridge_review_feedback(
    feature: FeatureState,
    bot: { tmux_session: string },
  ): Promise<void> {
    await this.bridge_review_feedback_to_tmux(bot.tmux_session, feature);
    console.log(`[features] Bridged review feedback to existing bot for ${feature.id}`);
  }

  /**
   * Bridge review feedback to a pool bot via tmux send-keys.
   * Used for review->build bounce — tells the builder what to fix.
   */
  private async bridge_review_feedback_to_tmux(
    tmux_session: string,
    feature: FeatureState,
  ): Promise<void> {
    const pr_number = feature.prNumber;
    if (!pr_number) return;

    const feedback_path = `/tmp/lf-review-feedback-${feature.id}.txt`;
    const feedback = (
      `The reviewer requested changes on PR #${String(pr_number)}.\n` +
      `Read the review comments with \`gh pr view ${String(pr_number)} --json reviews\` and make the fixes.\n` +
      `When done, commit, push, and post in this channel that the fixes are ready.`
    );

    try {
      await writeFileAsync(feedback_path, feedback, "utf-8");

      // Poll for the bot to be ready (same pattern as bridge_build_prompt)
      const start = Date.now();
      const timeout = 30_000;
      let ready = false;

      while (Date.now() - start < timeout) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        try {
          const output = execFileSync(
            "tmux", ["capture-pane", "-t", tmux_session, "-p"],
            { encoding: "utf-8", timeout: 2000 },
          );
          if (output.includes("Listening for channel messages") && output.includes("❯")) {
            ready = true;
            break;
          }
        } catch { /* ignore */ }
      }

      if (!ready) {
        console.log(`[features] Bot ${tmux_session} not ready after ${String(timeout)}ms -- review feedback not bridged`);
        return;
      }

      // Small extra delay for the plugin to fully connect
      await new Promise(resolve => setTimeout(resolve, 2000));

      const instruction = `Read ${feedback_path} for review feedback and begin fixing the issues.`;
      execFileSync("tmux", ["send-keys", "-t", tmux_session, instruction, "Enter"], {
        stdio: "ignore",
        timeout: 5000,
      });

      console.log(`[features] Bridged review feedback to ${tmux_session} for ${feature.id}`);

      setTimeout(() => { void unlink(feedback_path).catch(() => {}); }, 60_000);
    } catch (err) {
      console.error(`[features] Failed to bridge review feedback: ${String(err)}`);
    }
  }

  private async run_entry_actions(
    feature: FeatureState,
    phase: Phase,
  ): Promise<void> {
    const entity = this.registry.get(feature.entity);
    if (!entity) return;

    switch (phase) {
      case "build": {
        // Create worktree
        const worktree_path = await actions.create_worktree(feature, entity);
        feature.worktreePath = worktree_path;

        // Assign work room
        const room_id = await actions.assign_work_room(feature, entity);
        feature.discordWorkRoom = room_id;
        break;
      }
      case "review": {
        // Create PR (only if not already set by the pool bot health monitor)
        if (!feature.prNumber) {
          try {
            const pr_number = await actions.create_pr(feature, entity);
            feature.prNumber = pr_number;
          } catch (err) {
            console.error(`[features] Failed to create PR: ${String(err)}`);
          }
        }
        break;
      }
      default:
        break;
    }

    // Update work room topic on phase change
    if (feature.discordWorkRoom) {
      const short_title = feature.title.length > 60
        ? feature.title.slice(0, 57) + "..."
        : feature.title;

      const topic_map: Partial<Record<Phase, string>> = {
        build: `🔨 #${String(feature.githubIssue)}: ${short_title}`,
        review: `🔍 #${String(feature.githubIssue)}: ${short_title} — In Review`,
        ship: `✅ #${String(feature.githubIssue)}: ${short_title} — Shipping`,
      };
      const topic = topic_map[phase];
      if (topic) {
        await actions.update_work_room_topic(feature, topic);
      }
    }

    await actions.notify_feature(
      feature,
      `${feature.id}: entered ${phase} phase`,
      entity,
    );
  }

  private async run_ship_actions(feature: FeatureState): Promise<void> {
    const entity = this.registry.get(feature.entity);
    if (!entity) return;

    // Capture work room before any mutations so pool cleanup works regardless of outcome.
    const work_room = feature.discordWorkRoom;

    try {
      // Merge PR
      if (feature.prNumber) {
        try {
          await actions.merge_pr(feature, entity);
        } catch (err) {
          console.error(`[features] Failed to merge PR: ${String(err)}`);
          feature.blocked = true;
          feature.blockedReason = `Merge failed: ${String(err)}`;
          return;
        }
      }

      // Cleanup worktree
      await actions.cleanup_worktree(feature, entity);
      feature.worktreePath = null;

      // Send "shipped" notification BEFORE releasing work room
      // so the message arrives in the work room before it's cleaned up / reset.
      await actions.notify_feature(
        feature,
        `Feature #${String(feature.githubIssue)} shipped and merged to main: ${feature.title}`,
        entity,
        { also_general: true },
      );

      // Release work room (after notification so the room still exists)
      await actions.release_work_room(feature, entity);
      feature.discordWorkRoom = null;
    } finally {
      // Always release pool bot, even if merge fails — otherwise the slot is permanently occupied.
      // pool.release() kills the tmux session, so do this after any work room messaging is done.
      if (this.pool && work_room) {
        // Clear session history for the work room — feature is done, no context to preserve
        this.pool.clear_session_history(feature.entity, work_room);

        const assignment = this.pool.get_assignment(work_room);
        if (assignment) {
          await this.pool.release(work_room);
        }
      }
      if (feature.poolBotId !== null) {
        this.pool_bot_to_feature.delete(feature.poolBotId);
        feature.poolBotId = null;
      }
    }
  }
}

// ── Dependency cycle detection ──

/**
 * Check if adding a feature with the given dependencies would create a cycle.
 * Uses DFS: starting from each dep, walk its transitive dependsOn chain.
 * If we encounter `new_feature_id`, that's a cycle.
 *
 * Returns the cycle path (e.g. ["X", "Y", "Z", "X"]) if a cycle is found, or null if safe.
 */
export function check_dependency_cycle(
  new_feature_id: string,
  depends_on: string[],
  features: ReadonlyMap<string, FeatureState>,
): string[] | null {
  for (const dep_id of depends_on) {
    const visited = new Set<string>();
    const path = [new_feature_id, dep_id];

    const cycle = dfs_find_cycle(dep_id, new_feature_id, features, visited, path);
    if (cycle) return cycle;
  }
  return null;
}

function dfs_find_cycle(
  current: string,
  target: string,
  features: ReadonlyMap<string, FeatureState>,
  visited: Set<string>,
  path: string[],
): string[] | null {
  if (current === target) return [...path];
  if (visited.has(current)) return null;

  visited.add(current);

  const feature = features.get(current);
  if (!feature) return null;

  for (const dep_id of feature.dependsOn) {
    path.push(dep_id);
    const cycle = dfs_find_cycle(dep_id, target, features, visited, path);
    if (cycle) return cycle;
    path.pop();
  }

  return null;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

function expand_home_safe(p: string): string {
  if (p.startsWith("~/")) {
    return p.replace("~", process.env["HOME"] ?? "/root");
  }
  return p;
}
