import { BotPool } from "../../pool.js";
import type { PoolBot } from "../../pool.js";

/**
 * Shared TestBotPool base for tests that don't need JSONL control.
 *
 * Treats all sessions as present on disk and disables the background watcher.
 * Test files that need custom JSONL behavior (e.g. pool-session-confirmation)
 * should extend BotPool directly and provide their own overrides.
 */
export class BotPoolTestBase extends BotPool {
  /** Default to "JSONL present" so existing pre-#256 expectations hold. */
  protected override check_session_jsonl_exists_anywhere(): Promise<boolean> {
    return Promise.resolve(true);
  }
  protected override check_session_jsonl_exists(): Promise<boolean> {
    return Promise.resolve(true);
  }
  /** Disable the background JSONL confirmation watcher — its deferred
   * persist() can race with afterEach teardown and cause ENOTEMPTY on rmdir. */
  protected override watch_session_confirmation(bot: PoolBot): void {
    bot.session_confirmed = true;
  }
  /** Default to "MCP healthy" (issue #345) — these tests don't exercise
   * MCP verification and would otherwise incur real tmux/pgrep calls and
   * multi-second wait loops against fake tmux session names. Test files
   * that need to exercise MCP detection/recovery should extend BotPool
   * directly (see pool-mcp-health.test.ts). */
  protected override async check_mcp_health(): Promise<void> {
    /* no-op */
  }
  protected override async verify_mcp_post_spawn(): Promise<boolean> {
    return true;
  }
}
