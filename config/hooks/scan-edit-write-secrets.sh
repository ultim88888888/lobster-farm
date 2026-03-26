#!/usr/bin/env bash
# scan-edit-write-secrets.sh — PreToolUse hook for Claude Code Edit/Write tool calls.
#
# Reads hook event JSON from stdin, extracts the content being written
# (new_string for Edit, content for Write), and pattern-matches for hardcoded
# secrets. Blocks execution (exit 2 + stderr) if a secret is found.
# Fails open (exit 0) if jq is missing or input is malformed — a broken hook
# must never block all Edit/Write operations.
#
# Install: cp config/hooks/scan-edit-write-secrets.sh ~/.claude/hooks/
# Register in ~/.claude/settings.json under hooks.PreToolUse with matcher "Edit|Write"

set -euo pipefail

# --- Dependency check ---
if ! command -v jq &>/dev/null; then
  echo "WARNING: jq not found — secret scanning disabled" >&2
  exit 0
fi

# --- Read and parse stdin ---
INPUT="$(cat)" || exit 0
if [ -z "$INPUT" ]; then
  exit 0
fi

CONTENT="$(echo "$INPUT" | jq -r '(.tool_input.new_string // .tool_input.content // empty)' 2>/dev/null)" || exit 0
if [ -z "$CONTENT" ]; then
  exit 0
fi

# --- Pattern checks ---
# Each pattern has a specific block message with actionable guidance.

# 1. Discord bot tokens: base64-encoded user ID . timestamp . HMAC
#    Format: <24+ chars>.<6+ chars>.<27+ chars> (all base64url alphabet)
if echo "$CONTENT" | grep -qE '[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{27,}'; then
  cat >&2 <<'MSG'
BLOCK: File content contains what appears to be a Discord bot token.
→ Store the token in 1Password and reference it via environment variable.
→ See the secrets-guideline skill for details.
MSG
  exit 2
fi

# 2. Known API key prefixes
#    Each prefix has a minimum length to avoid false positives on short strings.
if echo "$CONTENT" | grep -qE '(sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36,}|gho_[a-zA-Z0-9]{36,}|github_pat_[a-zA-Z0-9_]{30,}|AKIA[A-Z0-9]{16}|xox[bpras]-[a-zA-Z0-9-]{10,}|whsec_[a-zA-Z0-9]{20,})'; then
  cat >&2 <<'MSG'
BLOCK: File content contains a hardcoded API key.
→ Store the key in 1Password and reference it via environment variable or op run.
MSG
  exit 2
fi

# 3. Private key material
if echo "$CONTENT" | grep -qE '\-\-\-\-\-BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY\-\-\-\-\-'; then
  cat >&2 <<'MSG'
BLOCK: File content contains private key material.
→ Private keys should never appear in source files. Store in 1Password and reference via op run.
MSG
  exit 2
fi

# --- All checks passed ---
exit 0
