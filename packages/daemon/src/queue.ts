import { randomUUID } from "node:crypto";
import type {
  LobsterFarmConfig,
  ArchetypeRole,
  ModelTier,
  Priority,
} from "@lobster-farm/shared";
import type { ClaudeSessionManager, SessionResult } from "./session.js";

// ── Types ──

export interface TaskSubmission {
  entity_id: string;
  feature_id: string;
  archetype: ArchetypeRole;
  dna: string[];
  model: ModelTier;
  prompt: string;
  interactive: boolean;
  priority?: Priority;
  worktree_path: string;
}

export interface QueuedTask extends TaskSubmission {
  id: string;
  priority: Priority;
  submitted_at: Date;
  status: "queued" | "active" | "completed" | "failed" | "cancelled";
  session_id: string | null;
  completed_at: Date | null;
  exit_code: number | null;
  error: string | null;
}

export interface QueueStats {
  pending: number;
  active: number;
  completed_total: number;
  failed_total: number;
}

// ── Priority ordering ──

const PRIORITY_ORDER: Record<Priority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

// ── Task Queue ──

export class TaskQueue {
  private pending: QueuedTask[] = [];
  private active = new Map<string, QueuedTask>();
  private completed_count = 0;
  private failed_count = 0;

  constructor(
    private session_manager: ClaudeSessionManager,
    private config: LobsterFarmConfig,
  ) {
    // When a session completes, mark the task and process the next one
    session_manager.on("session:completed", (result: SessionResult) => {
      this.on_session_completed(result.session_id, result.exit_code);
    });

    session_manager.on("session:failed", (session_id: string, error: string) => {
      this.on_session_failed(session_id, error);
    });
  }

  /** Submit a new task. Returns the task ID. */
  submit(submission: TaskSubmission): string {
    const task: QueuedTask = {
      ...submission,
      id: randomUUID(),
      priority: submission.priority ?? "medium",
      submitted_at: new Date(),
      status: "queued",
      session_id: null,
      completed_at: null,
      exit_code: null,
      error: null,
    };

    this.pending.push(task);
    this.sort_pending();

    console.log(
      `[queue] Task ${task.id.slice(0, 8)} submitted: ` +
        `${task.archetype} for ${task.entity_id}/${task.feature_id} ` +
        `(priority: ${task.priority})`,
    );

    // Try to process immediately
    void this.process_next();

    return task.id;
  }

  /** Try to start the next pending task if there's capacity. */
  async process_next(): Promise<void> {
    const max = this.config.concurrency.max_active_sessions;

    while (this.active.size < max && this.pending.length > 0) {
      const task = this.pending.shift();
      if (!task) break;

      task.status = "active";
      this.active.set(task.id, task);

      console.log(
        `[queue] Starting task ${task.id.slice(0, 8)} ` +
          `(${String(this.active.size)}/${String(max)} slots used, ${String(this.pending.length)} pending)`,
      );

      try {
        const session = await this.session_manager.spawn({
          entity_id: task.entity_id,
          feature_id: task.feature_id,
          archetype: task.archetype,
          dna: task.dna,
          model: task.model,
          prompt: task.prompt,
          interactive: task.interactive,
          worktree_path: task.worktree_path,
        });

        task.session_id = session.session_id;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        task.status = "failed";
        task.error = error;
        task.completed_at = new Date();
        this.active.delete(task.id);
        this.failed_count++;

        console.error(`[queue] Task ${task.id.slice(0, 8)} failed to start: ${error}`);
      }
    }
  }

  /** Cancel a queued task. Cannot cancel active tasks (use kill instead). */
  cancel(task_id: string): boolean {
    const idx = this.pending.findIndex((t) => t.id === task_id);
    if (idx === -1) {
      return false;
    }

    const task = this.pending[idx]!;
    task.status = "cancelled";
    task.completed_at = new Date();
    this.pending.splice(idx, 1);

    console.log(`[queue] Task ${task_id.slice(0, 8)} cancelled`);
    return true;
  }

  /** Get all pending tasks. */
  get_pending(): QueuedTask[] {
    return [...this.pending];
  }

  /** Get all active tasks. */
  get_active(): QueuedTask[] {
    return [...this.active.values()];
  }

  /** Get queue statistics for the /status endpoint. */
  get_stats(): QueueStats {
    return {
      pending: this.pending.length,
      active: this.active.size,
      completed_total: this.completed_count,
      failed_total: this.failed_count,
    };
  }

  // ── Internal handlers ──

  private on_session_completed(session_id: string, exit_code: number): void {
    for (const [task_id, task] of this.active) {
      if (task.session_id === session_id) {
        task.status = "completed";
        task.exit_code = exit_code;
        task.completed_at = new Date();
        this.active.delete(task_id);
        this.completed_count++;

        console.log(`[queue] Task ${task_id.slice(0, 8)} completed (exit: ${String(exit_code)})`);
        break;
      }
    }

    // Process next pending task
    void this.process_next();
  }

  private on_session_failed(session_id: string, error: string): void {
    for (const [task_id, task] of this.active) {
      if (task.session_id === session_id) {
        task.status = "failed";
        task.error = error;
        task.completed_at = new Date();
        this.active.delete(task_id);
        this.failed_count++;

        console.error(`[queue] Task ${task_id.slice(0, 8)} failed: ${error}`);
        break;
      }
    }

    // Process next pending task
    void this.process_next();
  }

  private sort_pending(): void {
    this.pending.sort((a, b) => {
      const pa = PRIORITY_ORDER[a.priority];
      const pb = PRIORITY_ORDER[b.priority];
      if (pa !== pb) return pa - pb;
      return a.submitted_at.getTime() - b.submitted_at.getTime();
    });
  }
}
