import { EventEmitter } from "node:events";
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
import type { TaskQueue } from "./queue.js";
import type { SessionResult } from "./session.js";
import * as actions from "./actions.js";
import { save_features, load_features } from "./persistence.js";
import { extract_session_learnings } from "./hooks.js";

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
      "Implement feature #{issue}: {title}. " +
      "Follow the spec in the GitHub issue. Write tests. " +
      "Commit and push when complete.",
  },
  review: {
    archetype: "reviewer",
    dna: ["review-dna"],
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

export interface CreateFeatureOptions {
  entity_id: string;
  title: string;
  github_issue: number;
  priority?: Priority;
  labels?: string[];
}

export class FeatureManager extends EventEmitter {
  private features = new Map<string, FeatureState>();
  private session_to_feature = new Map<string, string>();
  private task_to_feature = new Map<string, string>();

  constructor(
    private registry: EntityRegistry,
    private queue: TaskQueue,
    private config: LobsterFarmConfig,
  ) {
    super();
  }

  /** Load persisted features from disk. Call on daemon startup. */
  async load_persisted(): Promise<void> {
    const saved = await load_features(this.config);
    for (const feature of saved) {
      this.features.set(feature.id, feature);
    }
    if (saved.length > 0) {
      console.log(`[features] Restored ${String(saved.length)} features from disk`);
    }
  }

  /** Persist all features to disk. Called after every mutation. */
  private async persist(): Promise<void> {
    await save_features([...this.features.values()], this.config);
  }

  /** Create a new feature. Starts in the "plan" phase. */
  create_feature(opts: CreateFeatureOptions): FeatureState {
    const entity = this.registry.get(opts.entity_id);
    if (!entity) {
      throw new Error(`Entity "${opts.entity_id}" not found`);
    }

    const id = `${opts.entity_id}-${String(opts.github_issue)}`;
    const branch = `feature/${String(opts.github_issue)}-${slugify(opts.title)}`;

    const feature: FeatureState = {
      id,
      entity: opts.entity_id,
      githubIssue: opts.github_issue,
      title: opts.title,
      phase: "plan",
      priority: opts.priority ?? "medium",
      branch,
      worktreePath: null,
      discordWorkRoom: null,
      activeArchetype: null,
      activeDna: [],
      sessionId: null,
      lastSessionId: null,
      blocked: false,
      blockedReason: null,
      approved: false,
      labels: opts.labels ?? [],
      prNumber: null,
      agentDone: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.features.set(id, feature);
    void this.persist();

    console.log(
      `[features] Created feature ${id}: "${opts.title}" (phase: plan)`,
    );

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
    void this.persist();

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

    void this.persist();
    this.emit("feature:advanced", feature, old_phase);
    return feature;
  }

  /** Register a session→feature mapping when a session starts. */
  on_session_started(session: { session_id: string; feature_id: string }): void {
    const feature = this.features.get(session.feature_id);
    if (feature) {
      feature.sessionId = session.session_id;
      feature.lastSessionId = session.session_id;
      this.session_to_feature.set(session.session_id, feature.id);
    }
  }

  /** Handle a completed session — check if the feature can auto-advance. */
  async on_session_completed(result: SessionResult): Promise<void> {
    const feature_id = this.session_to_feature.get(result.session_id);
    if (!feature_id) return;

    const feature = this.get_feature(feature_id);
    if (!feature) return;

    this.session_to_feature.delete(result.session_id);
    feature.agentDone = true;
    feature.sessionId = null;
    feature.updatedAt = new Date().toISOString();
    void this.persist();

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

    // Auto-advance if no approval gate
    const phase_config = PHASE_CONFIG[feature.phase];
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
      await actions.notify(
        "alerts",
        `Feature ${feature_id}: ${feature.phase} phase complete. Awaiting approval.`,
        entity,
        feature.activeArchetype ?? undefined,
      );
    }
  }

  /** Handle a failed session — mark the feature as blocked. */
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
    void this.persist();

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
    void this.persist();
    return feature;
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

    const entity = this.registry.get(feature.entity);
    if (!entity) return;

    const prompt = resolve_prompt(phase_config.prompt_template, feature);
    const worktree_path = feature.worktreePath ?? expand_home_safe(entity.entity.repo.path);

    // Resume prior session if same archetype is being re-spawned for this feature
    // (e.g., builder picks up where it left off after being unblocked)
    const resume_id = feature.lastSessionId ?? undefined;

    const task_id = this.queue.submit({
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

    feature.activeArchetype = phase_config.archetype;
    feature.activeDna = phase_config.dna;
    this.task_to_feature.set(task_id, feature.id);

    console.log(
      `[features] Spawned ${phase_config.archetype} for ${feature.id} (task: ${task_id.slice(0, 8)})`,
    );
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
        break;
      }
      case "review": {
        // Create PR
        try {
          const pr_number = await actions.create_pr(feature, entity);
          feature.prNumber = pr_number;
        } catch (err) {
          console.error(`[features] Failed to create PR: ${String(err)}`);
        }
        break;
      }
      default:
        break;
    }

    await actions.notify(
      "work_log",
      `${feature.id}: entered ${phase} phase`,
      entity,
      "system",
    );
  }

  private async run_ship_actions(feature: FeatureState): Promise<void> {
    const entity = this.registry.get(feature.entity);
    if (!entity) return;

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

    // Release work room
    await actions.release_work_room(feature, entity);
    feature.discordWorkRoom = null;

    await actions.notify(
      "general",
      `Feature #${String(feature.githubIssue)} shipped and merged to main: ${feature.title}`,
      entity,
      "system",
    );
  }
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
