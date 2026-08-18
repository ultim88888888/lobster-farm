/**
 * The vocabulary of an agent build lock.
 *
 * `create_worktree` locks every worktree it creates, because `git worktree
 * remove` refuses a locked tree even with `--force`. That refusal is the only
 * thing that resisted the destructive stale sweep in #357 — every worktree it
 * destroyed was an unlocked one.
 *
 * A universal lock only works if the *intended* cleanup paths can tell our own
 * lock from someone else's. A lock we placed at creation is a note-to-self
 * that expires the moment the work lands; a lock a human or another tool
 * placed is a "do not touch" that outranks any evidence we have, including a
 * confirmed merge (#358). Both halves of that distinction live here so they
 * cannot drift apart.
 */

/**
 * The trailing phrase that marks a lock as ours, matching the reason format
 * already visible in the daemon logs (e.g. "issue-570 active build").
 */
const AGENT_LOCK_SUFFIX = " active build";

/**
 * Build the lock reason for a worktree owned by `owner`.
 *
 * The owner half is what makes the reason useful: "locked" alone says a tree
 * is protected, "issue-570 active build" says which build to go and look at.
 */
export function agent_lock_reason(owner: string): string {
  return `${owner}${AGENT_LOCK_SUFFIX}`;
}

/**
 * True when a lock reason is one we placed at worktree creation.
 *
 * Deliberately strict about the owner half: a reason of exactly "active build"
 * identifies nothing, so it is treated as foreign and left alone.
 */
export function is_agent_lock(reason: string | null | undefined): boolean {
  if (typeof reason !== "string") return false;
  const trimmed = reason.trim();
  return trimmed.length > AGENT_LOCK_SUFFIX.length && trimmed.endsWith(AGENT_LOCK_SUFFIX);
}
