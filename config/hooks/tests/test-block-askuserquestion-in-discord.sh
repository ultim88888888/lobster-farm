#!/usr/bin/env bash
# test-block-askuserquestion-in-discord.sh — Tests for the AskUserQuestion
# PreToolUse hook.
#
# Usage: bash config/hooks/tests/test-block-askuserquestion-in-discord.sh
#
# Each test feeds a JSON hook event to the hook via stdin (with or without
# DISCORD_STATE_DIR set in the env) and asserts:
#   - exit code is always 0 (hook is fail-open / advisory-block via JSON)
#   - stdout contains a `decision: block` JSON object iff the hook should block

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/../block-askuserquestion-in-discord.py"

PASS=0
FAIL=0
TOTAL=0

# Helpers -------------------------------------------------------------------

# Run the hook with the given stdin and env, and check the outcome.
# $1 = test name
# $2 = expected behavior — "block" or "allow"
# $3 = "discord" if DISCORD_STATE_DIR should be set, "no-discord" otherwise
# $4 = JSON payload (passed as a string arg so counters live in the parent shell)
run_test() {
  local name="$1"
  local expected="$2"
  local discord_mode="$3"
  local payload="$4"
  TOTAL=$((TOTAL + 1))

  local stdout exit_code
  if [ "$discord_mode" = "discord" ]; then
    stdout="$(printf '%s' "$payload" | DISCORD_STATE_DIR=/tmp/test-discord-state python3 "$HOOK" 2>/dev/null)"
    exit_code=$?
  else
    # Explicitly unset so the parent shell's env can't leak in.
    stdout="$(printf '%s' "$payload" | env -u DISCORD_STATE_DIR python3 "$HOOK" 2>/dev/null)"
    exit_code=$?
  fi

  # The hook must always exit 0 — blocking is signaled via stdout JSON.
  if [ "$exit_code" -ne 0 ]; then
    echo "  FAIL: $name (hook exited $exit_code, must always exit 0)"
    FAIL=$((FAIL + 1))
    return
  fi

  local is_block="no"
  if echo "$stdout" | grep -q '"decision"[[:space:]]*:[[:space:]]*"block"'; then
    is_block="yes"
  fi

  case "$expected" in
    block)
      if [ "$is_block" = "yes" ]; then
        # Confirm the redirect message names the right MCP tool.
        if echo "$stdout" | grep -q 'mcp__plugin_discord_discord__reply'; then
          echo "  PASS: $name"
          PASS=$((PASS + 1))
        else
          echo "  FAIL: $name (blocked but reason missing mcp__plugin_discord_discord__reply redirect)"
          echo "        stdout: $stdout"
          FAIL=$((FAIL + 1))
        fi
      else
        echo "  FAIL: $name (expected block, got allow)"
        echo "        stdout: $stdout"
        FAIL=$((FAIL + 1))
      fi
      ;;
    allow)
      if [ "$is_block" = "no" ]; then
        echo "  PASS: $name"
        PASS=$((PASS + 1))
      else
        echo "  FAIL: $name (expected allow, got block)"
        echo "        stdout: $stdout"
        FAIL=$((FAIL + 1))
      fi
      ;;
  esac
}

# --- MUST BLOCK — Discord-bridged + AskUserQuestion ------------------------

echo ""
echo "=== MUST BLOCK — Discord-bridged AskUserQuestion ==="
echo ""

ASK_PAYLOAD='{"tool_name":"AskUserQuestion","tool_input":{"question":"Pick one","options":["a","b"]},"session_id":"s","cwd":"/tmp","hook_event_name":"PreToolUse"}'
READ_PAYLOAD='{"tool_name":"Read","tool_input":{"file_path":"/tmp/x"},"session_id":"s","cwd":"/tmp","hook_event_name":"PreToolUse"}'
BASH_PAYLOAD='{"tool_name":"Bash","tool_input":{"command":"ls"},"session_id":"s","cwd":"/tmp","hook_event_name":"PreToolUse"}'
REPLY_PAYLOAD='{"tool_name":"mcp__plugin_discord_discord__reply","tool_input":{"chat_id":"1","content":"hi"},"session_id":"s","cwd":"/tmp","hook_event_name":"PreToolUse"}'

run_test "AskUserQuestion + DISCORD_STATE_DIR set" "block" "discord" "$ASK_PAYLOAD"

# --- MUST ALLOW — non-Discord sessions or other tools ---------------------

echo ""
echo "=== MUST ALLOW — not Discord-bridged or not AskUserQuestion ==="
echo ""

run_test "AskUserQuestion + no DISCORD_STATE_DIR (regular CLI session)" "allow" "no-discord" "$ASK_PAYLOAD"
run_test "Read tool + DISCORD_STATE_DIR set (other tools must pass through)" "allow" "discord" "$READ_PAYLOAD"
run_test "Bash tool + DISCORD_STATE_DIR set" "allow" "discord" "$BASH_PAYLOAD"
run_test "Discord reply tool + DISCORD_STATE_DIR set (must not block itself)" "allow" "discord" "$REPLY_PAYLOAD"

# --- FAIL-OPEN — malformed / unexpected input (P0) -------------------------
# A crashing hook would freeze every Claude session on this machine. Every
# pathological input must allow.

echo ""
echo "=== FAIL-OPEN — malformed input (P0) ==="
echo ""

run_test "Empty stdin + DISCORD_STATE_DIR set" "allow" "discord" ""
run_test "Whitespace-only stdin + DISCORD_STATE_DIR set" "allow" "discord" "   "
run_test "Malformed JSON + DISCORD_STATE_DIR set" "allow" "discord" "not json at all"
run_test "JSON array (not object) + DISCORD_STATE_DIR set" "allow" "discord" "[1,2,3]"
run_test "JSON string (not object) + DISCORD_STATE_DIR set" "allow" "discord" '"a string"'
run_test "Empty object + DISCORD_STATE_DIR set" "allow" "discord" "{}"
run_test "Missing tool_name + DISCORD_STATE_DIR set" "allow" "discord" '{"tool_input":{"question":"x"}}'
run_test "Null tool_name + DISCORD_STATE_DIR set" "allow" "discord" '{"tool_name":null}'
run_test "Numeric tool_name + DISCORD_STATE_DIR set" "allow" "discord" '{"tool_name":42}'

# Empty DISCORD_STATE_DIR string should be treated as unset.
TOTAL=$((TOTAL + 1))
stdout="$(DISCORD_STATE_DIR="" python3 "$HOOK" 2>/dev/null <<'JSON'
{"tool_name":"AskUserQuestion","tool_input":{"question":"x"}}
JSON
)"
exit_code=$?
if [ "$exit_code" -eq 0 ] && ! echo "$stdout" | grep -q '"decision"[[:space:]]*:[[:space:]]*"block"'; then
  echo "  PASS: Empty DISCORD_STATE_DIR string treated as unset"
  PASS=$((PASS + 1))
else
  echo "  FAIL: Empty DISCORD_STATE_DIR string should not trigger block (exit=$exit_code, stdout=$stdout)"
  FAIL=$((FAIL + 1))
fi

# --- Summary ---------------------------------------------------------------

echo ""
echo "=============================="
echo "Results: $PASS passed, $FAIL failed, $TOTAL total"
echo "=============================="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
