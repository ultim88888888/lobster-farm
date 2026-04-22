#!/usr/bin/env bash
# test-entity-isolation.sh — Tests for the entity isolation PreToolUse hook.
#
# Usage: bash config/hooks/tests/test-entity-isolation.sh
#
# Creates a fake ~/.lobsterfarm/entities/ layout under a tmpdir and points
# HOME at it, then feeds JSON hook events to the hook via stdin.
# Exit 0 = allowed, exit 2 = blocked.

set -uo pipefail

# Resolve script location so tests work from any cwd
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/../entity-isolation.sh"

PASS=0
FAIL=0
TOTAL=0

# --- Fake HOME setup ---
# Use pwd -P to resolve symlinks (macOS /var -> /private/var) so path
# comparisons inside the hook agree with the paths we pass in.
FAKE_HOME="$(cd "$(mktemp -d)" && pwd -P)"
FAKE_ENTITIES="$FAKE_HOME/.lobsterfarm/entities"
mkdir -p "$FAKE_ENTITIES/alpha/repos/app"
mkdir -p "$FAKE_ENTITIES/beta/repos/app"
mkdir -p "$FAKE_ENTITIES/gamma/repos/app"

cleanup() { rm -rf "$FAKE_HOME"; }
trap cleanup EXIT

# --- Helpers ---

# Build a JSON Bash hook event.
make_bash_event() {
  local cmd="$1"
  local cwd="$2"
  jq -n --arg cmd "$cmd" --arg cwd "$cwd" '{
    tool_name: "Bash",
    tool_input: { command: $cmd, description: "test", timeout: 120000 },
    session_id: "test-session",
    cwd: $cwd,
    hook_event_name: "PreToolUse"
  }'
}

# Build a JSON file-tool hook event (Read/Edit/Write/NotebookEdit).
# $1 = tool name, $2 = file path, $3 = cwd
make_file_event() {
  local tool="$1"
  local file_path="$2"
  local cwd="$3"
  jq -n --arg tool "$tool" --arg path "$file_path" --arg cwd "$cwd" '{
    tool_name: $tool,
    tool_input: { file_path: $path },
    session_id: "test-session",
    cwd: $cwd,
    hook_event_name: "PreToolUse"
  }'
}

# Run the hook with a fake HOME + CLAUDE_PROJECT_DIR.
# $1 = test name
# $2 = event JSON (on stdin)
# $3 = CLAUDE_PROJECT_DIR value (self-entity cwd)
# $4 = expected exit code
# $5 = optional stderr substring that must be present
run_test() {
  local name="$1"
  local event="$2"
  local self_dir="$3"
  local expected="$4"
  local expected_stderr="${5:-}"
  TOTAL=$((TOTAL + 1))

  local stderr_output actual
  stderr_output="$(
    HOME="$FAKE_HOME" CLAUDE_PROJECT_DIR="$self_dir" \
      bash "$HOOK" <<<"$event" 2>&1 >/dev/null
  )"
  actual=$?

  if [ "$actual" -ne "$expected" ]; then
    echo "  FAIL: $name (expected exit $expected, got exit $actual)"
    [ -n "$stderr_output" ] && echo "        stderr: $(echo "$stderr_output" | head -1)"
    FAIL=$((FAIL + 1))
    return
  fi

  if [ -n "$expected_stderr" ] && ! echo "$stderr_output" | grep -qF "$expected_stderr"; then
    echo "  FAIL: $name (stderr missing expected substring: '$expected_stderr')"
    echo "        stderr: $stderr_output"
    FAIL=$((FAIL + 1))
    return
  fi

  echo "  PASS: $name"
  PASS=$((PASS + 1))
}

ALPHA_CWD="$FAKE_ENTITIES/alpha/repos/app"
BETA_CWD="$FAKE_ENTITIES/beta/repos/app"

# --- MUST ALLOW (exit 0) — self-entity access ---

echo ""
echo "=== MUST ALLOW — same-entity (exit 0) ==="
echo ""

run_test "Bash: same-entity path reference" \
  "$(make_bash_event "ls $FAKE_ENTITIES/alpha/repos/app" "$ALPHA_CWD")" \
  "$ALPHA_CWD" 0

run_test "Bash: unrelated command (no entity reference)" \
  "$(make_bash_event "git status" "$ALPHA_CWD")" \
  "$ALPHA_CWD" 0

run_test "Read: same-entity file_path" \
  "$(make_file_event "Read" "$FAKE_ENTITIES/alpha/repos/app/README.md" "$ALPHA_CWD")" \
  "$ALPHA_CWD" 0

run_test "Edit: same-entity file_path" \
  "$(make_file_event "Edit" "$FAKE_ENTITIES/alpha/repos/app/src/index.ts" "$ALPHA_CWD")" \
  "$ALPHA_CWD" 0

run_test "Write: same-entity file_path" \
  "$(make_file_event "Write" "$FAKE_ENTITIES/alpha/repos/app/new.ts" "$ALPHA_CWD")" \
  "$ALPHA_CWD" 0

run_test "NotebookEdit: same-entity file_path" \
  "$(make_file_event "NotebookEdit" "$FAKE_ENTITIES/alpha/repos/app/nb.ipynb" "$ALPHA_CWD")" \
  "$ALPHA_CWD" 0

run_test "Read: file outside entities/ tree" \
  "$(make_file_event "Read" "/tmp/not-an-entity.txt" "$ALPHA_CWD")" \
  "$ALPHA_CWD" 0

# --- MUST BLOCK (exit 2) — cross-entity access ---

echo ""
echo "=== MUST BLOCK — cross-entity (exit 2) ==="
echo ""

run_test "Bash: ls sibling entity dir (absolute)" \
  "$(make_bash_event "ls $FAKE_ENTITIES/beta/" "$ALPHA_CWD")" \
  "$ALPHA_CWD" 2 "BLOCK: Cross-entity access"

run_test "Bash: cat file in sibling entity" \
  "$(make_bash_event "cat $FAKE_ENTITIES/beta/repos/app/secret.txt" "$ALPHA_CWD")" \
  "$ALPHA_CWD" 2 "BLOCK: Cross-entity access"

run_test "Bash: grep across sibling entity (ends at space)" \
  "$(make_bash_event "grep -r foo $FAKE_ENTITIES/gamma" "$ALPHA_CWD")" \
  "$ALPHA_CWD" 2 "BLOCK: Cross-entity access"

run_test "Read: sibling entity file_path" \
  "$(make_file_event "Read" "$FAKE_ENTITIES/beta/repos/app/README.md" "$ALPHA_CWD")" \
  "$ALPHA_CWD" 2 "BLOCK: Cross-entity access"

run_test "Edit: sibling entity file_path" \
  "$(make_file_event "Edit" "$FAKE_ENTITIES/beta/repos/app/src/index.ts" "$ALPHA_CWD")" \
  "$ALPHA_CWD" 2 "BLOCK: Cross-entity access"

run_test "Write: sibling entity file_path" \
  "$(make_file_event "Write" "$FAKE_ENTITIES/gamma/repos/app/new.ts" "$ALPHA_CWD")" \
  "$ALPHA_CWD" 2 "BLOCK: Cross-entity access"

# --- MUST ALLOW (exit 0) — platform-level sessions ---

echo ""
echo "=== MUST ALLOW — platform-level (exit 0) ==="
echo ""

# Pat at ~/.lobsterfarm/ (no entity) — should skip and allow everything
run_test "Platform cwd: touching entity dir is allowed (no self-entity)" \
  "$(make_bash_event "ls $FAKE_ENTITIES/beta/" "$FAKE_HOME/.lobsterfarm")" \
  "$FAKE_HOME/.lobsterfarm" 0

run_test "Platform cwd: Read on entity file is allowed" \
  "$(make_file_event "Read" "$FAKE_ENTITIES/beta/repos/app/README.md" "$FAKE_HOME/.lobsterfarm")" \
  "$FAKE_HOME/.lobsterfarm" 0

run_test "Platform cwd: unrelated bash command" \
  "$(make_bash_event "echo hi" "$FAKE_HOME/.lobsterfarm")" \
  "$FAKE_HOME/.lobsterfarm" 0

# Completely unrelated cwd (e.g., user shell outside lobsterfarm)
run_test "Non-lobsterfarm cwd: allowed" \
  "$(make_bash_event "ls $FAKE_ENTITIES/beta/" "/tmp")" \
  "/tmp" 0

# --- EDGE CASES ---

echo ""
echo "=== EDGE CASES ==="
echo ""

# Empty stdin — fail open
TOTAL=$((TOTAL + 1))
HOME="$FAKE_HOME" CLAUDE_PROJECT_DIR="$ALPHA_CWD" \
  bash "$HOOK" </dev/null 2>/dev/null
if [ $? -eq 0 ]; then
  echo "  PASS: Empty stdin (fail open)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: Empty stdin (expected exit 0, should fail open)"
  FAIL=$((FAIL + 1))
fi

# Malformed JSON — fail open
TOTAL=$((TOTAL + 1))
HOME="$FAKE_HOME" CLAUDE_PROJECT_DIR="$ALPHA_CWD" \
  bash "$HOOK" <<<"not json at all" 2>/dev/null
if [ $? -eq 0 ]; then
  echo "  PASS: Malformed JSON (fail open)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: Malformed JSON (expected exit 0, should fail open)"
  FAIL=$((FAIL + 1))
fi

# Missing command in Bash event
run_test "Bash: missing command field (fail open)" \
  '{"tool_name":"Bash","tool_input":{}}' \
  "$ALPHA_CWD" 0

# Missing file_path in Read event
run_test "Read: missing file_path field (fail open)" \
  '{"tool_name":"Read","tool_input":{}}' \
  "$ALPHA_CWD" 0

# Only one entity exists — no others to block against
TOTAL=$((TOTAL + 1))
SOLO_HOME="$(cd "$(mktemp -d)" && pwd -P)"
mkdir -p "$SOLO_HOME/.lobsterfarm/entities/alpha/repos/app"
SOLO_EVENT="$(jq -n --arg cmd "ls /anywhere" --arg cwd "$SOLO_HOME/.lobsterfarm/entities/alpha/repos/app" '{
  tool_name: "Bash",
  tool_input: { command: $cmd },
  cwd: $cwd,
  hook_event_name: "PreToolUse"
}')"
HOME="$SOLO_HOME" CLAUDE_PROJECT_DIR="$SOLO_HOME/.lobsterfarm/entities/alpha/repos/app" \
  bash "$HOOK" <<<"$SOLO_EVENT" >/dev/null 2>&1
if [ $? -eq 0 ]; then
  echo "  PASS: Only self-entity exists (nothing to block)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: Only self-entity exists (expected exit 0)"
  FAIL=$((FAIL + 1))
fi
rm -rf "$SOLO_HOME"

# Fall back to input.cwd when CLAUDE_PROJECT_DIR is unset
TOTAL=$((TOTAL + 1))
EVENT="$(make_bash_event "ls $FAKE_ENTITIES/beta/" "$ALPHA_CWD")"
HOME="$FAKE_HOME" bash "$HOOK" <<<"$EVENT" >/dev/null 2>&1
actual=$?
if [ "$actual" -eq 2 ]; then
  echo "  PASS: Falls back to input.cwd when CLAUDE_PROJECT_DIR unset"
  PASS=$((PASS + 1))
else
  echo "  FAIL: CLAUDE_PROJECT_DIR fallback (expected exit 2, got $actual)"
  FAIL=$((FAIL + 1))
fi

# Missing jq — fail open
# Write event to file to avoid SIGPIPE: the hook exits before reading stdin
# when jq is absent, which kills the pipe writer under pipefail.
TOTAL=$((TOTAL + 1))
FAKE_PATH="$(mktemp -d)"
JQ_TEST_EVENT="$(mktemp)"
for cmd in bash cat grep echo head sed basename; do
  real="$(command -v "$cmd" 2>/dev/null)" && [ -n "$real" ] && ln -sf "$real" "$FAKE_PATH/$cmd"
done
make_bash_event "ls $FAKE_ENTITIES/beta/" "$ALPHA_CWD" > "$JQ_TEST_EVENT"
HOME="$FAKE_HOME" CLAUDE_PROJECT_DIR="$ALPHA_CWD" PATH="$FAKE_PATH" \
  bash "$HOOK" < "$JQ_TEST_EVENT" >/dev/null 2>&1
if [ $? -eq 0 ]; then
  echo "  PASS: Missing jq (fail open)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: Missing jq (expected exit 0, should fail open)"
  FAIL=$((FAIL + 1))
fi
rm -rf "$FAKE_PATH" "$JQ_TEST_EVENT"

# --- Summary ---

echo ""
echo "=============================="
echo "Results: $PASS passed, $FAIL failed, $TOTAL total"
echo "=============================="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
