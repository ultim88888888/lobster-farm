/**
 * Real `tmux capture-pane -p` output from a live pool bot, captured while
 * driving Claude Code's `/mcp` TUI by hand against a genuinely broken MCP
 * connection (the plugin's bun server was SIGKILLed first, so the panel shows
 * the real `✘ failed` state the recovery driver actually meets).
 *
 * These are byte-exact captures, not hand-written approximations, and that is
 * the whole point. Issue #373 went undetected because every fixture in this
 * suite was a two-line sketch — `"Manage MCP servers\n❯ plugin:discord"` —
 * that contained none of the pane a real capture contains. A real pane also
 * holds the transcript above the panel, and every command the transcript
 * echoes renders as `❯ …` at column 0. That is what the old
 * `selection_line` matched instead of the cursor.
 *
 * Note the nine `❯ /mcp` lines in the transcript below: each one is a
 * previous failed recovery attempt. The bug was self-reinforcing — every
 * failure echoed one more decoy above the panel.
 *
 * Do not "tidy" these. Re-capture them instead:
 *   tmux capture-pane -t pool-N -p
 */

/** The `/mcp` server list, cursor still on the first row (`computer-use`) —
 * the state the Down-hunt starts from. */
export const REAL_PANE_SERVER_LIST = `
✻ Conversation compacted (ctrl+o for history)


❯ /compact
  ⎿  Compacted (ctrl+o to see full summary)
  ⎿  Read ../../CLAUDE.md (120 lines)
  ⎿  Referenced file scratch/qs-build-status.html
  ⎿  Read ../../../.claude/rules/escalation.md (12 lines)
  ⎿  Read ../../../.claude/rules/collaboration.md (8 lines)

❯ /mcp
  ⎿  Reconnected to plugin:discord:discord.

❯ /mcp
  ⎿  MCP dialog dismissed

❯ /mcp
  ⎿  MCP dialog dismissed

❯ /mcp
  ⎿  MCP dialog dismissed

❯ /mcp
  ⎿  MCP dialog dismissed

❯ /mcp
  ⎿  MCP dialog dismissed

❯ /mcp
  ⎿  MCP dialog dismissed

❯ /mcp
  ⎿  Reconnected to plugin:discord:discord.

❯ /mcp
───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── gary ─

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Manage MCP servers
  2 servers

    Built-in MCPs (always available)
  ❯ computer-use · ◯ disabled
    plugin:discord:discord · ✘ failed

  ※ Run claude --debug to see error logs
  https://code.claude.com/docs/en/mcp for help
 ↑/↓ to navigate · Enter to confirm · Esc to cancel`;

/** The same list after one Down: cursor on the failed discord server. This is
 * the row the Down-hunt is looking for. */
export const REAL_PANE_DISCORD_SELECTED = `
✻ Conversation compacted (ctrl+o for history)


❯ /compact
  ⎿  Compacted (ctrl+o to see full summary)
  ⎿  Read ../../CLAUDE.md (120 lines)
  ⎿  Referenced file scratch/qs-build-status.html
  ⎿  Read ../../../.claude/rules/escalation.md (12 lines)
  ⎿  Read ../../../.claude/rules/collaboration.md (8 lines)

❯ /mcp
  ⎿  Reconnected to plugin:discord:discord.

❯ /mcp
  ⎿  MCP dialog dismissed

❯ /mcp
  ⎿  MCP dialog dismissed

❯ /mcp
  ⎿  MCP dialog dismissed

❯ /mcp
  ⎿  MCP dialog dismissed

❯ /mcp
  ⎿  MCP dialog dismissed

❯ /mcp
  ⎿  MCP dialog dismissed

❯ /mcp
  ⎿  Reconnected to plugin:discord:discord.

❯ /mcp
───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── gary ─

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Manage MCP servers
  2 servers

    Built-in MCPs (always available)
    computer-use · ◯ disabled
  ❯ plugin:discord:discord · ✘ failed

  ※ Run claude --debug to see error logs
  https://code.claude.com/docs/en/mcp for help
 ↑/↓ to navigate · Enter to confirm · Esc to cancel`;

/** The discord server's detail menu, reached by pressing Enter on the row
 * above. A failed server offers `1. Reconnect` / `2. Disable` with Reconnect
 * preselected. (A *connected* server offers `1. View tools` / `2. Reconnect` /
 * `3. Disable` instead — but recovery only ever runs against a failed one.)
 *
 * Note what this panel does NOT contain: the string "Manage MCP servers". Its
 * header is "Plugin:discord:discord MCP Server". Any attempt to scope the
 * cursor search by slicing at the server-list header would return null here
 * and break the detail-menu guard. */
export const REAL_PANE_DETAIL_MENU = `✻ Conversation compacted (ctrl+o for history)


❯ /compact
  ⎿  Compacted (ctrl+o to see full summary)
  ⎿  Read ../../CLAUDE.md (120 lines)
  ⎿  Referenced file scratch/qs-build-status.html
  ⎿  Read ../../../.claude/rules/escalation.md (12 lines)
  ⎿  Read ../../../.claude/rules/collaboration.md (8 lines)

❯ /mcp
  ⎿  Reconnected to plugin:discord:discord.

❯ /mcp
  ⎿  MCP dialog dismissed

❯ /mcp
  ⎿  MCP dialog dismissed

❯ /mcp
  ⎿  MCP dialog dismissed

❯ /mcp
  ⎿  MCP dialog dismissed

❯ /mcp
  ⎿  MCP dialog dismissed

❯ /mcp
  ⎿  MCP dialog dismissed

❯ /mcp
  ⎿  Reconnected to plugin:discord:discord.

❯ /mcp
───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── gary ─

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Plugin:discord:discord MCP Server

  Status:           ✘ failed
  Command:          bun
  Args:             run --cwd /Users/farm/.lobsterfarm/shared/claude-config-rengen/plugins/cache/claude-plugins-official/discord/0.0.4 --shell=bun --silent start
  Config location:  Dynamically configured

  ❯ 1. Reconnect
    2. Disable

  ↑/↓ to navigate · Enter to select · Esc to back`;

/**
 * Everything in a real pane above the panel: the transcript (nine `❯ /mcp`
 * decoys included) plus the composer box, sliced verbatim out of the capture
 * above so the chrome can never drift from reality.
 */
const REAL_PANE_ABOVE_PANEL = (() => {
  const lines = REAL_PANE_SERVER_LIST.split("\n");
  let i = lines.length - 1;
  while (i >= 0 && !/^─{10,}/.test(lines[i] ?? "")) i--;
  return lines.slice(0, i + 1).join("\n");
})();

/**
 * Build a pane showing `panel_lines` below the composer, on top of the real
 * transcript-and-composer chrome above.
 *
 * Scripted driver tests need panel states no live session happened to produce
 * (a stray keystroke moving the cursor mid-sequence, say). Those states are
 * synthetic, but the pane they are rendered into is not — which is the part
 * that mattered for #373. Called with no arguments it yields an idle pane
 * with no panel open at all.
 */
export function real_pane_showing(...panel_lines: string[]): string {
  return [REAL_PANE_ABOVE_PANEL, ...panel_lines].join("\n");
}
