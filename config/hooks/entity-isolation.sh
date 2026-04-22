#!/usr/bin/env bash
# entity-isolation.sh — PreToolUse hook to prevent cross-entity filesystem access.
#
# When a pool bot session is running for entity X, this hook blocks attempts to
# read/write/exec paths under ~/.lobsterfarm/entities/<other>/. Fails open if
# the session is not in an entity directory (e.g., Pat at the platform level).
#
# Install: register in ~/.claude/settings.json under hooks.PreToolUse
#   matchers: "Bash", "Read|Edit|Write"
#
# Hook input: JSON on stdin with {tool_name, tool_input, cwd, ...}

set -euo pipefail

# --- Dependency check ---
if ! command -v jq &>/dev/null; then
  # Fail open — a broken hook must never block all tool calls
  exit 0
fi

# --- Read input ---
INPUT="$(cat)" || exit 0
[ -z "$INPUT" ] && exit 0

# --- Identify self-entity ---
# Prefer CLAUDE_PROJECT_DIR (set by Claude Code to the session's initial cwd,
# unchanged by internal cd). Fall back to the cwd field in the hook input.
ENTITIES_DIR="$HOME/.lobsterfarm/entities"
SELF_DIR="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$SELF_DIR" ]; then
  SELF_DIR="$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)" || exit 0
fi

# Not a pool bot session if not under entities/ — skip check
case "$SELF_DIR" in
  "$ENTITIES_DIR"/*) ;;
  *) exit 0 ;;
esac

# Extract entity id: first path component after entities/
SELF_ENTITY="${SELF_DIR#"$ENTITIES_DIR"/}"
SELF_ENTITY="${SELF_ENTITY%%/*}"
[ -z "$SELF_ENTITY" ] && exit 0

# --- Collect other entity ids ---
# Build a pipe-separated regex alternation of sibling entity ids.
OTHER_ENTITIES=""
for dir in "$ENTITIES_DIR"/*/; do
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"
  [ "$name" = "$SELF_ENTITY" ] && continue
  if [ -z "$OTHER_ENTITIES" ]; then
    OTHER_ENTITIES="$name"
  else
    OTHER_ENTITIES="$OTHER_ENTITIES|$name"
  fi
done
[ -z "$OTHER_ENTITIES" ] && exit 0

# --- Extract tool input ---
TOOL="$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)" || exit 0

block() {
  local other="$1"
  local hint="$2"
  cat >&2 <<MSG
BLOCK: Cross-entity access — "$SELF_ENTITY" session attempted to access "$other" entity.
→ Pool bots are scoped to a single entity. Reading another entity's files leaks context and breaks isolation.
→ $hint
MSG
  exit 2
}

case "$TOOL" in
  Bash)
    CMD="$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)" || exit 0
    [ -z "$CMD" ] && exit 0
    # Match references to other entity directories. Patterns:
    #   /.lobsterfarm/entities/<other>/
    #   entities/<other>/
    #   entities/<other>$
    #   entities/<other> (end of word)
    # Using extended regex with the alternation of other entity names.
    if echo "$CMD" | grep -qE "(\\.lobsterfarm/entities|entities)/($OTHER_ENTITIES)(/|\$|[[:space:]]|\"|'|\\))"; then
      matched="$(echo "$CMD" | grep -oE "entities/($OTHER_ENTITIES)" | head -1 | sed -E "s|entities/||")"
      block "$matched" "If you need cross-entity data, request it through the daemon API or escalate to Pat."
    fi
    ;;
  Read|Edit|Write|NotebookEdit)
    FILE="$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)" || exit 0
    [ -z "$FILE" ] && exit 0
    # Normalize: expand ~ to $HOME if present
    case "$FILE" in
      "~/"*) FILE="$HOME/${FILE#~/}" ;;
    esac
    # Check if path is under another entity's directory
    if [[ "$FILE" == "$ENTITIES_DIR"/* ]]; then
      target_entity="${FILE#"$ENTITIES_DIR"/}"
      target_entity="${target_entity%%/*}"
      if [ "$target_entity" != "$SELF_ENTITY" ] && [ -n "$target_entity" ]; then
        block "$target_entity" "Edit your own entity's files only."
      fi
    fi
    ;;
esac

exit 0
