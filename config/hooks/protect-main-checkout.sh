#!/usr/bin/env bash
# protect-main-checkout.sh — PreToolUse hook that prevents git checkout/switch
# to non-main branches in the main repo directory. Feature work should happen
# in worktrees, not by switching branches in the main repo.
#
# Only blocks when:
# 1. The command is git checkout/switch to a branch (not main)
# 2. The cwd is NOT inside a worktree (.claude/worktrees/)

set -euo pipefail

if ! command -v jq &>/dev/null; then
  exit 0
fi

INPUT="$(cat)" || exit 0
if [ -z "$INPUT" ]; then
  exit 0
fi

COMMAND="$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)" || exit 0
if [ -z "$COMMAND" ]; then
  exit 0
fi

CWD="$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)" || exit 0

# If we're inside a worktree, allow everything
if echo "$CWD" | grep -q "\.claude/worktrees/\|/worktrees/"; then
  exit 0
fi

# Check for git checkout -b / git switch -c (creating a new branch)
if echo "$COMMAND" | grep -qE '^\s*git\s+(checkout\s+-b|switch\s+-c)\s+'; then
  cat >&2 <<'MSG'
BLOCK: Creating a new branch in the main repo directory is not allowed.
→ Feature work should happen in worktrees, not by switching branches here.
→ Use Claude Code's Agent tool (which auto-creates worktrees) or create one manually:
  git worktree add .claude/worktrees/<name> -b <branch>
MSG
  exit 2
fi

# Check for git checkout <branch> where branch is not main/master
# Match: git checkout <word> (not a flag, not main/master)
if echo "$COMMAND" | grep -qE '^\s*git\s+checkout\s+[a-zA-Z]'; then
  # Allow git checkout main / git checkout master
  if echo "$COMMAND" | grep -qE '^\s*git\s+checkout\s+(main|master)(\s|$)'; then
    exit 0
  fi

  TARGET=$(echo "$COMMAND" | grep -oE '^\s*git\s+checkout\s+\S+' | awk '{print $3}')

  cat >&2 <<MSG
BLOCK: Switching to branch '$TARGET' in the main repo directory is not allowed.
→ The main repo should always stay on main. Use worktrees for feature branches.
MSG
  exit 2
fi

exit 0
