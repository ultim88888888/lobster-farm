/**
 * Reading Claude Code's TUI out of a `tmux capture-pane -p` dump.
 *
 * Two production incidents came from the same mistake: locating information in
 * the pane by a *fixed row offset*. #375 read the `❯` selection cursor by
 * scanning from the top, and matched transcript echoes instead. #377 read the
 * status bar as "the last line", and broke the moment Claude Code started
 * wrapping its right-aligned `/rc` hint onto a row of its own.
 *
 * The pane's row offsets are not stable. Below the status bar Claude Code may
 * render any of: the `/rc` hint, a blank, a git branch row (`⏺ main`), a tab
 * indicator row (`⧉  qs-status`), and one row per running background agent
 * (`◯ bob  …`). Across ~200 captures the status bar was observed anywhere from
 * one to five rows from the end, and the `❯` composer line from four to eight.
 *
 * What *is* stable is the composer box: Claude Code draws a full-width rule at
 * column 0 above and below the input line. So anchor on those rules and read
 * the region they open, rather than counting rows from either end.
 */

/**
 * A full-width horizontal rule at column 0 — one of the two lines Claude Code
 * draws around the composer. Anchored and unindented on purpose: the only
 * other `─` runs a pane ever shows are markdown table borders, which are
 * indented and start with `┌`/`├`/`└`.
 *
 * The 10-character floor is a safety margin, not a measurement — real borders
 * span the terminal width (193-200 chars in the captures this was verified
 * against) and would still be matched in a very narrow terminal.
 */
export const COMPOSER_BORDER = /^─{10,}/;

/**
 * A running background agent, rendered as its own footer row below the status
 * bar: `  ◯ bob   Screening foo.txt for secrets      7m 39s · ↓ 126.4k tokens`.
 *
 * Only meaningful inside the composer region — the glyph is generic enough
 * that transcript content could plausibly contain it, and the region slice is
 * what makes matching it safe.
 */
const BACKGROUND_AGENT_ROW = /^\s*◯\s/;

/**
 * How much of the tail to read when the pane has no composer box at all — a
 * session that crashed to a shell, or one still booting. Bounded rather than
 * whole-pane so that arbitrary scrollback can't supply a false prompt match.
 */
const NO_COMPOSER_TAIL_LINES = 8;

/** Index of the last line at or above `from` that is a composer border, or -1. */
function find_border(lines: string[], from: number): number {
  for (let i = from; i >= 0; i--) {
    if (COMPOSER_BORDER.test(lines[i] ?? "")) return i;
  }
  return -1;
}

/**
 * The lines from the top of Claude Code's composer box to the end of the pane:
 * the `❯` input line, the status bar beneath it, and whatever footer rows
 * follow. Excludes the transcript above the composer, which is where `❯`
 * echoes of previously-run slash commands live (the #375 decoys).
 *
 * Falls back to a bounded tail when no border is present.
 */
export function composer_region(pane_output: string): string[] {
  const lines = pane_output.trimEnd().split("\n");

  const bottom = find_border(lines, lines.length - 1);
  if (bottom < 0) return lines.slice(-NO_COMPOSER_TAIL_LINES);

  // Prefer the rule *above* the input line so the `❯` is inside the region.
  // A single border still yields a usable region (the status bar below it) —
  // that's the case when an overlay panel is covering the composer.
  const top = find_border(lines, bottom - 1);
  return lines.slice(top < 0 ? bottom : top);
}

/**
 * Whether a captured pane shows Claude Code sitting at the prompt with no work
 * in progress.
 *
 * Precedence matters: the status bar puts `esc to interrupt` on the *same row*
 * as `bypass permissions`, so active-work indicators must be checked first or
 * a generating session reads as idle.
 *
 * 1. `esc to interrupt` → actively generating → NOT idle
 * 2. a background agent row, or the legacy "N local agents" status bar wording
 *    → subagent still running → NOT idle
 * 3. `❯` or `bypass permissions` → at the prompt → idle
 */
export function is_pane_idle(pane_output: string): boolean {
  const region = composer_region(pane_output);

  if (region.some((line) => line.includes("esc to interrupt"))) return false;

  // Background subagents: the parent sits at the prompt but work is still
  // happening. Claude Code moved this out of the status bar ("N local agents",
  // which appears in none of the current captures) and into a dedicated footer
  // row; both spellings are accepted so older CLI builds keep working.
  if (region.some((line) => line.includes("local agent"))) return false;
  if (region.some((line) => BACKGROUND_AGENT_ROW.test(line))) return false;

  return region.some((line) => line.includes("❯") || line.includes("bypass permissions"));
}
