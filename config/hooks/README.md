# PreToolUse Hooks

Claude Code hook scripts that run before tool invocations. Registered in `~/.claude/settings.json` under `hooks.PreToolUse` with a tool name matcher. Most hooks here are bash and use exit code 2 to block; `block-askuserquestion-in-discord.py` uses the structured JSON contract (`{"decision": "block", "reason": "..."}` on stdout, always exit 0) so the model receives the redirect message verbatim.

## Files

- `scan-bash-secrets.sh` -- Scans Bash tool commands for leaked secrets before execution. Pattern-matches for Discord bot tokens, known API key prefixes (sk-, ghp_, AKIA, xox, etc.), hardcoded Authorization headers, `op read` in command substitutions, and private key material. Allowlists `op run` and `op item/vault` commands. Fails open if jq is missing or input is malformed.

- `scan-edit-write-secrets.sh` -- Scans Edit/Write tool content for leaked secrets before file writes. Extracts `tool_input.new_string` (Edit) or `tool_input.content` (Write) from stdin JSON and pattern-matches for Discord bot tokens, known API key prefixes, and private key material. Does not scan `old_string` (existing content being replaced). Fails open if jq is missing or input is malformed.

- `protect-branch.sh` -- Prevents Edit/Write operations on main/master branches. Extracts `tool_input.file_path` from stdin JSON, checks if the file is inside the current git repo, and blocks if the current branch is main or master. Fails open if not in a git repo, jq is missing, or input is malformed.

- `entity-isolation.sh` -- Prevents cross-entity filesystem access for pool bot sessions. Identifies the session's self-entity from `CLAUDE_PROJECT_DIR` (or the hook input `cwd` as a fallback), enumerates sibling entities under `~/.lobsterfarm/entities/`, and blocks Bash commands or Read/Edit/Write/NotebookEdit file paths that reference another entity. Fails open for platform-level sessions (e.g., Pat) that aren't scoped to an entity, when no sibling entities exist, and when jq is missing or input is malformed. Deployed to `~/.claude/hooks/` by `lf init` and registered in `~/.claude/settings.json` with matcher `Bash|Read|Edit|Write|NotebookEdit`.

- `block-askuserquestion-in-discord.py` -- Blocks the `AskUserQuestion` tool in Discord-bridged sessions. Detection signal is the `DISCORD_STATE_DIR` env var, which the daemon exports for pool bots, Pat, and channel-bound Gary tmux sessions. When both conditions match (tool name is `AskUserQuestion` AND `DISCORD_STATE_DIR` is set), the hook prints a structured block decision whose `reason` redirects the model to `mcp__plugin_discord_discord__reply` — Claude Code shows this message to the model as the tool result. Registered with matcher `AskUserQuestion`. Fails open (allows the call) on empty/malformed stdin, missing/non-string tool_name, and any unexpected exception — a crashing global hook would freeze every Claude session on this machine, so silent allow is the only safe failure mode.

### tests/

- `test-scan-bash-secrets.sh` -- Test suite for the Bash secret scanner. Exercises each pattern category with both positive (should block) and negative (should allow) cases.

- `test-scan-edit-write-secrets.sh` -- Test suite for the Edit/Write secret scanner. Tests all 3 pattern categories for both Edit and Write tools, plus edge cases (empty stdin, malformed JSON, missing jq, secret in old_string only).

- `test-protect-branch.sh` -- Test suite for the branch protector. Tests blocking on main/master, allowing on feature branches, files outside repo, and fail-open edge cases.

- `test-entity-isolation.sh` -- Test suite for the entity isolation hook. Uses a fake `HOME` with multiple entity directories to cover same-entity allowed, cross-entity blocked (Bash + Read/Edit/Write/NotebookEdit), platform-level sessions allowed, `CLAUDE_PROJECT_DIR` vs `cwd` fallback, and fail-open edge cases (empty/malformed stdin, missing fields, missing jq).

- `test-block-askuserquestion-in-discord.sh` -- Test suite for the AskUserQuestion blocker. Covers the block path (Discord-bridged + AskUserQuestion), allow paths (other tools, no DISCORD_STATE_DIR, the discord reply tool itself), and the P0 fail-open contract on every form of malformed input (empty/whitespace stdin, non-JSON, JSON non-objects, empty objects, missing/null/non-string `tool_name`, empty `DISCORD_STATE_DIR` string).
