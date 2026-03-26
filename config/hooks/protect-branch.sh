#!/usr/bin/env bash
# protect-branch.sh — PreToolUse hook that prevents Edit/Write on main/master.
#
# Reads hook event JSON from stdin, extracts the file path, checks if the file
# is inside the current git repo, and blocks the operation if the current branch
# is main or master. Fails open (exit 0) if jq is missing, not in a git repo,
# or input is malformed — a broken hook must never block all Edit/Write operations.
#
# Install: cp config/hooks/protect-branch.sh ~/.claude/hooks/
# Register in ~/.claude/settings.json under hooks.PreToolUse with matcher "Edit|Write"

set -euo pipefail

# --- Dependency check ---
if ! command -v jq &>/dev/null; then
  echo "WARNING: jq not found — branch protection disabled" >&2
  exit 0
fi

# --- Read and parse stdin ---
INPUT="$(cat)" || exit 0
if [ -z "$INPUT" ]; then
  exit 0
fi

FILE_PATH="$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)" || exit 0
if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# --- Check if file is inside a git repo ---
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0

case "$FILE_PATH" in
  "$REPO_ROOT"/*) ;;
  *) exit 0 ;;
esac

# --- Check current branch ---
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" || exit 0

if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then
  cat >&2 <<MSG
BLOCK: Direct edits to '$BRANCH' are not allowed.
→ Create a feature branch first: git checkout -b feature/<issue#>-<slug>
MSG
  exit 2
fi

# --- Not on a protected branch ---
exit 0
