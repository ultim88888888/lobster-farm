/**
 * PR watch store.
 *
 * Bots register interest in PRs they created via POST /pr/watch. When a PR
 * reaches a terminal state (merged, closed, review feedback), the webhook
 * handler checks the store and injects a notification into the watching bot's
 * tmux session.
 *
 * Watches are persisted to disk (pr-watches.json) so they survive daemon
 * restarts. A 24-hour TTL auto-expires stale watches via the pr-cron cycle.
 */

import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { load_pr_watches, save_pr_watches } from "./persistence.js";
import type { PersistedPRWatch, PRWatchState } from "./persistence.js";

export const PR_WATCH_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Build the watch key from repo and PR number. */
export function watch_key(repo: string, pr_number: number): string {
  return `${repo}#${String(pr_number)}`;
}

export class PRWatchStore {
  private watches: Map<string, PersistedPRWatch> = new Map();
  private config: LobsterFarmConfig;

  constructor(config: LobsterFarmConfig) {
    this.config = config;
  }

  /** Load persisted watches from disk. Call once on daemon startup. */
  async initialize(): Promise<void> {
    const state = await load_pr_watches(this.config);
    const count = Object.keys(state).length;
    for (const [key, entry] of Object.entries(state)) {
      this.watches.set(key, entry);
    }
    if (count > 0) {
      console.log(`[pr-watches] Loaded ${String(count)} watch(es) from disk`);
    }
  }

  /** Register a watch for a PR. Persists immediately. */
  async add(repo: string, pr_number: number, channel_id: string): Promise<void> {
    const key = watch_key(repo, pr_number);
    this.watches.set(key, {
      repo,
      pr_number,
      channel_id,
      created_at: new Date().toISOString(),
    });
    console.log(`[pr-watches] Registered watch: ${key} → channel ${channel_id}`);
    await this.persist();
  }

  /** Look up a watch by repo and PR number. Returns undefined if none. */
  get(repo: string, pr_number: number): PersistedPRWatch | undefined {
    return this.watches.get(watch_key(repo, pr_number));
  }

  /** Remove a watch (after the event fires). Persists immediately. */
  async remove(repo: string, pr_number: number): Promise<void> {
    const key = watch_key(repo, pr_number);
    if (this.watches.delete(key)) {
      console.log(`[pr-watches] Removed watch: ${key}`);
      await this.persist();
    }
  }

  /** Remove all watches for a given channel (e.g., when a bot is evicted). */
  async remove_for_channel(channel_id: string): Promise<void> {
    let removed = 0;
    for (const [key, watch] of this.watches) {
      if (watch.channel_id === channel_id) {
        this.watches.delete(key);
        removed++;
      }
    }
    if (removed > 0) {
      console.log(`[pr-watches] Removed ${String(removed)} watch(es) for channel ${channel_id}`);
      await this.persist();
    }
  }

  /**
   * Expire watches older than the TTL. Returns the number of expired entries.
   * Called from the pr-cron poll cycle.
   */
  async cleanup_expired(ttl_ms: number = PR_WATCH_TTL_MS): Promise<number> {
    const now = Date.now();
    let expired = 0;
    for (const [key, watch] of this.watches) {
      const age = now - new Date(watch.created_at).getTime();
      if (age > ttl_ms) {
        this.watches.delete(key);
        expired++;
        console.log(`[pr-watches] Expired stale watch: ${key} (age: ${String(Math.round(age / 3600000))}h)`);
      }
    }
    if (expired > 0) {
      await this.persist();
    }
    return expired;
  }

  /** Get all watches (for debugging/status). */
  get_all(): PersistedPRWatch[] {
    return [...this.watches.values()];
  }

  /** Number of active watches. */
  get size(): number {
    return this.watches.size;
  }

  /** Persist current state to disk. */
  private async persist(): Promise<void> {
    const state: PRWatchState = {};
    for (const [key, watch] of this.watches) {
      state[key] = watch;
    }
    await save_pr_watches(state, this.config);
  }
}
