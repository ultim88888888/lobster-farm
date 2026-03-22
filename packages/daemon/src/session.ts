import type { ArchetypeRole, ModelTier } from "@lobster-farm/shared";

export interface SessionSpawnOptions {
  entity_id: string;
  feature_id: string;
  archetype: ArchetypeRole;
  dna: string[];
  model: ModelTier;
  worktree_path: string;
  prompt: string;
  interactive: boolean;
}

export interface ActiveSession {
  session_id: string;
  entity_id: string;
  feature_id: string;
  archetype: ArchetypeRole;
  started_at: Date;
  pid: number | null;
  tmux_pane: string | null;
}

export interface SessionManager {
  spawn(options: SessionSpawnOptions): Promise<ActiveSession>;
  resume(session_id: string): Promise<ActiveSession>;
  kill(session_id: string): Promise<void>;
  get_active(): ActiveSession[];
  get_by_entity(entity_id: string): ActiveSession[];
  get_by_feature(feature_id: string): ActiveSession | null;
}

/**
 * Stub implementation of SessionManager.
 * All methods throw "Not yet implemented". Used by the daemon skeleton
 * until the real session manager is built.
 */
export class SessionManagerStub implements SessionManager {
  spawn(_options: SessionSpawnOptions): Promise<ActiveSession> {
    throw new Error("Not yet implemented");
  }

  resume(_session_id: string): Promise<ActiveSession> {
    throw new Error("Not yet implemented");
  }

  kill(_session_id: string): Promise<void> {
    throw new Error("Not yet implemented");
  }

  get_active(): ActiveSession[] {
    throw new Error("Not yet implemented");
  }

  get_by_entity(_entity_id: string): ActiveSession[] {
    throw new Error("Not yet implemented");
  }

  get_by_feature(_feature_id: string): ActiveSession | null {
    throw new Error("Not yet implemented");
  }
}
