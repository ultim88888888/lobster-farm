# PreToolUse Hooks

Claude Code hook scripts that run before tool invocations. Registered in `~/.claude/settings.json` under `hooks.PreToolUse` with a tool name matcher. Exit code 0 allows the tool call, exit code 2 blocks it with an error message on stderr.

## Files

- `scan-bash-secrets.sh` -- Scans Bash tool commands for leaked secrets before execution. Pattern-matches for Discord bot tokens, known API key prefixes (sk-, ghp_, AKIA, xox, etc.), hardcoded Authorization headers, `op read` in command substitutions, and private key material. Allowlists `op run` and `op item/vault` commands. Fails open if jq is missing or input is malformed.

- `scan-edit-write-secrets.sh` -- Scans Edit/Write tool content for leaked secrets before file writes. Extracts `tool_input.new_string` (Edit) or `tool_input.content` (Write) from stdin JSON and pattern-matches for Discord bot tokens, known API key prefixes, and private key material. Does not scan `old_string` (existing content being replaced). Fails open if jq is missing or input is malformed.

- `protect-branch.sh` -- Prevents Edit/Write operations on main/master branches. Extracts `tool_input.file_path` from stdin JSON, checks if the file is inside the current git repo, and blocks if the current branch is main or master. Fails open if not in a git repo, jq is missing, or input is malformed.

### tests/

- `test-scan-bash-secrets.sh` -- Test suite for the Bash secret scanner. Exercises each pattern category with both positive (should block) and negative (should allow) cases.

- `test-scan-edit-write-secrets.sh` -- Test suite for the Edit/Write secret scanner. Tests all 3 pattern categories for both Edit and Write tools, plus edge cases (empty stdin, malformed JSON, missing jq, secret in old_string only).

- `test-protect-branch.sh` -- Test suite for the branch protector. Tests blocking on main/master, allowing on feature branches, files outside repo, and fail-open edge cases.
