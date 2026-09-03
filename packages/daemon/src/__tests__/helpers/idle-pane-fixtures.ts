/**
 * Real `tmux capture-pane -p` output from live pool sessions, captured
 * 2026-08-27 against Claude Code v2.1.239 / v2.1.250.
 *
 * These are byte-exact captures, not hand-written approximations. Issue #377
 * (and #375 before it) shipped green because the pane fixtures in this suite
 * were authored from what we assumed the TUI emits. A real pane holds the
 * transcript above the composer, a status bar below it, and a variable number
 * of footer rows below that — none of which a sketch contains.
 *
 * Trailing whitespace and the U+00A0 after each `❯` are load-bearing: the
 * parser slices on the composer border and the status bar's right-aligned
 * `/rc` hint sits at column ~195. Do not "tidy" these. Re-capture instead:
 *   tmux capture-pane -t pool-N -p
 *
 * Captures were chosen from sessions whose transcripts carry no credentials or
 * infrastructure identifiers — this repo is public. Panes holding live tokens
 * were discarded rather than redacted, so every fixture here is whole.
 */

/** The regression case. A long-idle pane: the `/rc` hint has wrapped onto its
 * own row *below* the status bar, so it is the last line after `.trim()`:
 *
 *   '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents    ✔ Update…'
 *   '                                                              /rc'
 *
 * Reading only that last line finds neither `❯` nor `bypass permissions`, so
 * the pre-#377 implementation reported this bot as "working" — forever.
 *
 * Also carries a decoy `❯ /compact` in the transcript above the composer. */
export const PANE_IDLE_HINT_OWN_ROW = `Permission allow rule (../../../.claude/settings.json): Write(~/.claude/skills/**) is not matched by file permission checks — only Edit(path) rules are. Use Edit(~/.claude/skills/**) instead (Edit rul
es cover all file-editing tools).
Permission allow rule (../../../.claude/settings.json): Write(~/.claude/agents/**) is not matched by file permission checks — only Edit(path) rules are. Use Edit(~/.claude/agents/**) instead (Edit rul
es cover all file-editing tools).
Permission allow rule (../../../.claude/settings.json): Write(~/.claude/rules/**) is not matched by file permission checks — only Edit(path) rules are. Use Edit(~/.claude/rules/**) instead (Edit rules
 cover all file-editing tools).
 ▐▛███▛█   Claude Code v2.1.239
▝▜██████▀  Opus 5 with high effort · Claude Max
  ▝▝ ▝▝    @gary · ~/.lobsterfarm/entities/pirs

 ▎ Channels (experimental) messages from plugin:discord@claude-plugins-official inject directly in this session · restart without --channels to stop
   +1 more · /status

✻ Conversation compacted (ctrl+o for history)


❯ /compact
  ⎿  Compacted (ctrl+o to see full summary)
  ⎿  Read ../../../.claude/rules/collaboration.md (8 lines)
  ⎿  Read ../../../.claude/rules/git.md (8 lines)
  ⎿  Read ../../../.claude/rules/secrets.md (9 lines)
  ⎿  Read ../../../.claude/rules/escalation.md (12 lines)
  ⎿  Read ../../CLAUDE.md (120 lines)

───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── gary ─
❯ 
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents                                                                                                  ✔ Update installed · Restart to update
                                                                                                                                                                                                   /rc`;

/** The same bot, minutes after being interacted with: the `/rc` hint shares the
 * status bar row instead of taking its own. This rendering always read
 * correctly, which is why #377 presented as flaky rather than broken — the
 * hint only wraps on panes nobody has touched, so the bug selectively blinded
 * the daemon to exactly the bots eviction exists to reap.
 *
 * Three decoy `❯ /mcp` lines sit in the transcript above the composer. */
export const PANE_IDLE_HINT_SAME_ROW = `Permission allow rule (../../shared/claude-config-rengen/settings.json): Write(~/.claude/skills/**) is not matched by file permission checks — only Edit(path) rules are. Use Edit(~/.claude/skills/**)
instead (Edit rules cover all file-editing tools).
Permission allow rule (../../shared/claude-config-rengen/settings.json): Write(~/.claude/agents/**) is not matched by file permission checks — only Edit(path) rules are. Use Edit(~/.claude/agents/**)
instead (Edit rules cover all file-editing tools).
Permission allow rule (../../shared/claude-config-rengen/settings.json): Write(~/.claude/rules/**) is not matched by file permission checks — only Edit(path) rules are. Use Edit(~/.claude/rules/**) in
stead (Edit rules cover all file-editing tools).
 ▐▛███▛█   Claude Code v2.1.250
▝▜██████▀  Opus 5 with high effort · Claude Max
  ▝▝ ▝▝    @gary · ~/.lobsterfarm/entities/canal-street

  Updated to latest. Got 7 features, 68 bugfixes, and 19 other changes.
  code.claude.com/docs/en/changelog for details

▎ Channels (experimental) messages from plugin:discord@claude-plugins-official inject directly in this session · restart without --channels to stop

❯ /mcp
  ⎿  MCP dialog dismissed

❯ /mcp
  ⎿  Reconnected to plugin:discord:discord.

❯ /mcp
  ⎿  MCP dialog dismissed

───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── gary ─
❯ 
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents                                                                                                                                     /rc`;

/** Idle, with a tab indicator row (`⧉  qs-status`) rendered *below* the `/rc`
 * hint. The footer is not a fixed height: this pane's status bar sits four
 * rows from the end rather than two. */
export const PANE_IDLE_WITH_TAB_ROW = `     … +38 lines (ctrl+o to expand)

⏺ Bash(cd ~/.lobsterfarm/entities/canal-street/repos/canalstreet-admin && for n in 653 717 714 812 791 831; do gh issue view $n --json number,title,createdAt,updatedAt…)
  ⎿  #653 created 2026-08-18 updated 2026-08-18 comments=0  prod database is 19 migrations behind and the migration role cannot AL
     #717 created 2026-08-18 updated 2026-08-18 comments=0  deal_entry_sync fails every tick: AdminBlotterRow.amends_blotter_id do
     #714 created 2026-08-18 updated 2026-08-18 comments=0  Staging/prod backend DB role lacks CREATE on schema public — blocks mi
     … +3 lines (ctrl+o to expand)

⏺ That's worth flagging: three production-impacting issues filed on 18 August, never touched since. Let me build you a proper status page rather than a wall of chat.

⏺ Skill(artifact-design)
  ⎿  Successfully loaded skill

⏺ Design plan: deep teal accent (semantic green/amber/red stay reserved for status), warm-neutral grounds biased toward it, Newsreader for headings against IBM Plex Sans and Mono — a report that reads
  like a venue's own documentation rather than a dashboard template.

⏺ Bash(mkdir -p /private/tmp/claude-502/-Users-farm--lobsterfarm-entities-canal-street/075d5fdd-8c28-455a-b0ff-4a99cdab4cf7/scratchpad && echo ok)
  ⎿  ok

  Made 2 scratchpad edits +430 -2 (ctrl+o to expand)

⏺ Artifact(/private/tmp/claude-502/-Users-farm--lobsterfarm-entities-canal-street/075d5fdd-8c28-455a-b0ff-4a99cdab4cf7/scratchpad/qs-status.html)
  ⎿  Published ⧉ https://claude.ai/code/artifact/6d137c31-a286-41c8-a334-77ab1237b16e

  Called plugin:discord:discord (ctrl+o to expand)

⏺ Full status published, with the headlines in the message. The three untouched August issues are the thing I'd most want to resolve — one of them claims production can't take releases at all, and
  nobody has looked at it in nine days.

⏺ Ran 2 stop hooks (ctrl+o to expand)
  ⎿  Stop hook error: You ended a turn with a text response in a Discord-bridged session but did not call mcp__plugin_discord_discord__reply. Your text output is invisible to the user — they
  only see messages sent via the reply tool. Send your response NOW via mcp__plugin_discord_discord__reply. Use the chat_id from the most recent inbound <channel
  source="plugin:discord:discord"> block in your context. Text you wrote (preview): "Full status published, with the headlines in the message. The three untouched August issues are the thing
  I'd most want to resolve — one of them claims production can't take releases at all, and nobody has looked at it in nine days."

  Called plugin:discord:discord (ctrl+o to expand)

⏺ Status page published and the recommendation is with Grant. Waiting on his call.

✻ Worked for 3m 23s

───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── gary ─
❯ go ahead and verify those three
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents                                                                                                  ✔ Update installed · Restart to update
                                                                                                                                                                new task? /clear to save 251.8k tokens
                                                                                                                                                                                                   /rc
  ⧉  qs-status`;

/** The deepest footer observed: a `/rc` row, a blank, a git branch row
 * (`⏺ main`) and a background agent row (`◯ bob …`) all sit below the status
 * bar, putting it five rows from the end and the `❯` composer line eight.
 *
 * This is why the fix anchors on the composer border instead of scanning a
 * fixed number of trailing lines — any window shallow enough to be safe from
 * the transcript above is too shallow to reach the status bar here.
 *
 * Note the background agent row. Claude Code no longer prints "N local agents"
 * in the status bar (that string appears in none of ~200 captures taken across
 * 15 sessions and two CLI versions); a running subagent is now reported by
 * this `◯` footer row instead. */
export const PANE_IDLE_WITH_AGENT_FOOTER = `      cat > /tmp/377-comment.md <<'EOF'…)
  ⎿  posted corrected comment

  Read 1 file (ctrl+o to expand)

⏺ Both channels are live and I've recorded the findings. Bob is working #377 in the background; I'll report when he lands the PR.

✻ Waiting for 1 background agent to finish

← discord · ultim81227: but there definitely aren't 15 bots actively wrokig right n…

⏺ Exactly right — that's #377. Let me show you the proof rather than assert it.

⏺ Bash(echo "Reproducing the daemon's own is_tmux_session_idle() check on all 15 bots:"; echo
      for n in $(seq 0 14); do…)
  ⎿  Reproducing the daemon's own is_tmux_session_idle() check on all 15 bots:

       pool-0  working (WRONG)      last_line='                         /rc'
     … +14 lines (ctrl+o to expand)

⏺ Bash(tmux capture-pane -t pool-7 -p | python3 -c "
      import sys…)
  ⎿  LAST full: '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents
                      /rc'
     has_prompt: False | has_bypass: True

  Called plugin:discord:discord (ctrl+o to expand)

⏺ Bash(cd ~/.lobsterfarm/entities/lobster-farm/repos/lobster-farm && export GH_CONFIG_DIR=~/.config/gh
      cat > /tmp/377-c2.md <<'EOF'…)
  ⎿  posted
  ⎿  Message queued for delivery to a34f593b43e926652 at its next tool round.

⏺ Passed the refinement to Bob and documented it on #377.

  The short version of what you spotted: the reaper logic is fine. Its input is lying to it. And it lies specifically about long-idle bots — the exact set eviction targets — because the /rc hint drops
  to its own row on panes nobody has touched. Recently-active bots read correctly, which is why this presented as flaky rather than broken.

✻ Waiting for 1 background agent to finish

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── pat ─
❯ yes run the sweep
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on · 1 shell · ← for agents · ↓ to manage                                                                                               ✔ Update installed · Restart to update
                                                                                                                                                                                                   /rc

  ⏺ main
  ◯ bob   Screening working-pool-5-1.txt for secrets                                                                                                                          7m 39s · ↓ 126.4k tokens`;

/** Actively generating: the status bar carries `esc to interrupt` alongside
 * `bypass permissions` on the same row, with the `/rc` hint on its own row
 * below. Active-work indicators must win over the idle indicators sharing
 * that line. */
export const PANE_WORKING = `     {
         "startedAt": "2026-08-21T10:11:04.391000-04:00",
     … +5 lines (ctrl+o to expand)

⏺ I got that wrong. Correcting.

⏺ Bash(START=$(python3 -c "import datetime;print(int(datetime.datetime(2026,8,22,10,0,tzinfo=datetime.timezone.utc).timestamp()*1000))")
      END=$(python3 -c "import datet…)
  ⎿  (eval):3: command not found: timeout

⏺ Bash(START=$(python3 -c "import datetime;print(int(datetime.datetime(2026,8,22,0,0,tzinfo=datetime.timezone.utc).timestamp()*1000))")
      END=$(python3 -c "import dateti…)
  ⎿  (No output)

⏺ The logs can settle this exactly — radar_auth_success is logged on every login.

⏺ Bash(START=$(python3 -c "import datetime;print(int(datetime.datetime(2026,8,21,0,0,tzinfo=datetime.timezone.utc).timestamp()*1000))")
      op run --env-file /tmp/sonar-aw…)
  ⎿  (No output)
  ⎿  (timeout 8m 20s)

⏺ Before I trust that negative — validating the filter works at all on a window I know has matches.

⏺ Bash(START=$(python3 -c "import time;print(int((time.time()-7200)*1000))")
      echo "=== control: does the filter match KNOWN recent errors? ==="…)
  ⎿  === control: does the filter match KNOWN recent errors? ===
     1787880646770
     1787880646828
     1787880647612
  ⎿  (timeout 5m)

⏺ Filter is valid — so those negatives are real. But that contradicts the model. Re-running the auth query cleanly.

⏺ Bash(START=$(python3 -c "import datetime;print(int(datetime.datetime(2026,8,21,0,0,tzinfo=datetime.timezone.utc).timestamp()*1000))")
      echo "=== radar_auth_success si…)
  ⎿  === radar_auth_success since Aug 21 ===
     === any 'radar_' structlog event since Aug 21 ===
  ⎿  (timeout 8m 20s)

⏺ That negative holds — and it breaks my model. A login should have been logged. My earlier traceback read came from a grepped view that dropped frames. Pulling it raw.

· Enchanting… (9m 53s · ↓ 28.6k tokens · thought for 16s)
  ⎿  Tip: Use /btw to ask a quick side question without interrupting Claude's current work

───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── gary ─
❯ 
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← for agents                                                                               ✔ Update installed · Restart to update
                                                                                                                                                                                                   /rc`;
