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
 *
 * A note-to-self is only temporary if something reads it back. #370 adds the
 * second half of the vocabulary: an owner token the daemon can resolve to a
 * living session or process, so `worktree-lock-reaper.ts` can release a lock
 * whose owner died instead of leaving it to outlive everyone. Locks written
 * before that token existed still parse as ours — the token sits *before* the
 * trailing marker precisely so they do.
 */

/**
 * The trailing phrase that marks a lock as ours, matching the reason format
 * already visible in the daemon logs (e.g. "issue-570 active build").
 */
const AGENT_LOCK_SUFFIX = " active build";

/**
 * A lock owner the daemon can actually go and look for (#370).
 *
 * "issue-570" names the *work*, which is what a human reading `git worktree
 * list` wants. It is useless to a reaper: there is nothing to ask whether
 * issue-570 is still running. These two kinds are the identities this machine
 * can resolve to a yes/no.
 *
 * - `tmux` — a tmux session name, resolvable with `tmux has-session`. The
 *   right choice whenever the work runs in a pool bot or commander session.
 * - `pid`  — an OS process id, resolvable with `kill(pid, 0)`. The fallback
 *   for work owned by a process rather than a session.
 */
export interface LockOwner {
  kind: "tmux" | "pid";
  id: string;
}

/** The kinds `parse_lock_owner` will hand back. Anything else is unresolvable. */
const OWNER_KINDS = new Set<LockOwner["kind"]>(["tmux", "pid"]);

/**
 * The bracketed segment carrying the owner token.
 *
 * Deliberately *not* at the end of the reason: `is_agent_lock` matches on the
 * trailing phrase, and every lock placed before #370 ends in it. Inserting the
 * token before the suffix keeps those old locks reading as ours — which
 * matters enormously, because they are precisely the ones the reaper exists to
 * clear.
 */
const OWNER_TOKEN_RE = /\[lf-owner:([a-z]+):([^\]]*)\]/;

/** Strip the characters that would break the token back out of the reason. */
function sanitize_token_part(value: string): string {
  return value.replace(/[[\]\r\n]/g, "").trim();
}

/**
 * Build the lock reason for a worktree owned by `owner`.
 *
 * The label half is what makes the reason readable: "locked" alone says a tree
 * is protected, "issue-570 active build" says which build to go and look at.
 * The optional `owner` adds the half a machine can act on, so a lock outlives
 * its session only until the next reaper pass rather than forever.
 *
 * @param label - Human-readable owner, e.g. "issue-570" or a branch name.
 * @param owner - Machine-resolvable owner token. Omitted only where the caller
 *   genuinely has no resolvable identity to name; the resulting lock reads as
 *   ours but names nobody, and the reaper treats it as orphaned on sight.
 */
export function agent_lock_reason(label: string, owner?: LockOwner): string {
  if (owner === undefined) return `${label}${AGENT_LOCK_SUFFIX}`;
  const id = sanitize_token_part(owner.id);
  return `${label} [lf-owner:${owner.kind}:${id}]${AGENT_LOCK_SUFFIX}`;
}

/**
 * Recover the owner token from a lock reason, or null when there is nothing
 * resolvable to recover.
 *
 * Null is returned for anything the daemon cannot turn into a liveness
 * question — a reason with no token (every lock placed before #370), an owner
 * kind we do not know how to probe, or a pid that is not a positive integer.
 * Callers must read null as "ownership unknown", never as "owner alive".
 */
export function parse_lock_owner(reason: string | null | undefined): LockOwner | null {
  if (typeof reason !== "string") return null;

  const match = OWNER_TOKEN_RE.exec(reason);
  if (match === null) return null;

  const [, raw_kind = "", raw_id = ""] = match;
  const id = raw_id.trim();
  if (id === "") return null;
  if (!OWNER_KINDS.has(raw_kind as LockOwner["kind"])) return null;
  const kind = raw_kind as LockOwner["kind"];

  // A pid we cannot turn into a number is not a pid. Guard it here rather than
  // at the probe, so "unparseable" and "not running" stay distinguishable.
  if (kind === "pid" && !/^[1-9][0-9]*$/.test(id)) return null;

  return { kind, id };
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
