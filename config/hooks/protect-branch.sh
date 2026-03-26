#!/usr/bin/env bash
# protect-branch.sh — PreToolUse hook that prevents Edit/Write on main/master.
#
# Reads hook event JSON from stdin, extracts the file path, checks if the file
# is inside a git repo, and blocks the operation if that repo's current branch
# is main or master. Uses the file's directory for git checks (not cwd) so
# worktrees are handled correctly.

set -euo pipefail

if ! command -v jq &>/dev/null; then
  exit 0
fi

INPUT="$(cat)" || exit 0
if [ -z "$INPUT" ]; then
  exit 0
fi

FILE_PATH="$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.content // empty' 2>/dev/null)" || exit 0
if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Use the file's directory for git checks (handles worktrees correctly)
FILE_DIR="$(dirname "$FILE_PATH")"
if [ ! -d "$FILE_DIR" ]; then
  exit 0
fi

REPO_ROOT="$(git -C "$FILE_DIR" rev-parse --show-toplevel 2>/dev/null)" || exit 0

case "$FILE_PATH" in
  "$REPO_ROOT"/*) ;;
  *) exit 0 ;;
esac

BRANCH="$(git -C "$FILE_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null)" || exit 0

if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then
  cat >&2 <<MSG
BLOCK: Direct edits to '$BRANCH' are not allowed.
→ Create a feature branch first: git checkout -b feature/<issue#>-<slug>
MSG
  exit 2
fi

exit 0
