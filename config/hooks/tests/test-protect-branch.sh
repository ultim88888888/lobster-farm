#!/usr/bin/env bash
# test-protect-branch.sh — Tests for the branch protection PreToolUse hook.
#
# Usage: bash config/hooks/tests/test-protect-branch.sh
#
# Creates temporary git repos to simulate different branch states.
# Each test feeds a JSON hook event to the hook via stdin and checks
# the exit code. Exit 0 = allowed, exit 2 = blocked.

set -uo pipefail

# Resolve script location so tests work from any cwd
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/../protect-branch.sh"

PASS=0
FAIL=0
TOTAL=0

# --- Test repo setup ---
# Create a temporary git repo so we can control the branch name
# Resolve real path to handle macOS /var -> /private/var symlink.
# git rev-parse --show-toplevel returns the real path, so file paths
# must also use the real path for the case comparison to match.
TEST_DIR="$(cd "$(mktemp -d)" && pwd -P)"
cleanup() { rm -rf "$TEST_DIR"; }
trap cleanup EXIT

git -C "$TEST_DIR" init -b main --quiet
git -C "$TEST_DIR" commit --allow-empty -m "init" --quiet

# --- Helpers ---

# Build a JSON hook event with a file path.
# $1 = tool name ("Edit" or "Write")
# $2 = file path
make_event() {
  local tool="$1"
  local file_path="$2"
  if [ "$tool" = "Edit" ]; then
    jq -n --arg path "$file_path" '{
      tool_name: "Edit",
      tool_input: { file_path: $path, old_string: "old", new_string: "new" },
      session_id: "test-session",
      cwd: "/tmp",
      hook_event_name: "PreToolUse"
    }'
  else
    jq -n --arg path "$file_path" '{
      tool_name: "Write",
      tool_input: { file_path: $path, content: "file content" },
      session_id: "test-session",
      cwd: "/tmp",
      hook_event_name: "PreToolUse"
    }'
  fi
}

# Run the hook from within a specific directory and check exit code.
# $1 = test name
# $2 = tool name ("Edit" or "Write")
# $3 = file path
# $4 = working directory for the hook
# $5 = expected exit code (0 or 2)
run_test() {
  local name="$1"
  local tool="$2"
  local file_path="$3"
  local work_dir="$4"
  local expected="$5"
  TOTAL=$((TOTAL + 1))

  local stderr_output
  stderr_output="$(make_event "$tool" "$file_path" | bash -c "cd '$work_dir' && bash '$HOOK'" 2>&1 >/dev/null)"
  local actual=$?

  if [ "$actual" -eq "$expected" ]; then
    echo "  PASS: $name"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $name (expected exit $expected, got exit $actual)"
    if [ -n "$stderr_output" ]; then
      echo "        stderr: $(echo "$stderr_output" | head -1)"
    fi
    FAIL=$((FAIL + 1))
  fi
}

# --- Must block (exit 2) — on main/master ---

echo ""
echo "=== MUST BLOCK — protected branches (exit 2) ==="
echo ""

# On main branch (default after init)
run_test "Edit on main branch" \
  "Edit" "$TEST_DIR/src/index.ts" "$TEST_DIR" 2

run_test "Write on main branch" \
  "Write" "$TEST_DIR/src/index.ts" "$TEST_DIR" 2

# Switch to master and test
git -C "$TEST_DIR" checkout -b master --quiet
run_test "Edit on master branch" \
  "Edit" "$TEST_DIR/src/index.ts" "$TEST_DIR" 2

run_test "Write on master branch" \
  "Write" "$TEST_DIR/src/index.ts" "$TEST_DIR" 2

# --- Must allow (exit 0) — feature branch ---

echo ""
echo "=== MUST ALLOW — feature branches (exit 0) ==="
echo ""

git -C "$TEST_DIR" checkout -b feature/test-branch --quiet

run_test "Edit on feature branch" \
  "Edit" "$TEST_DIR/src/index.ts" "$TEST_DIR" 0

run_test "Write on feature branch" \
  "Write" "$TEST_DIR/src/index.ts" "$TEST_DIR" 0

# --- Must allow (exit 0) — file outside repo ---

echo ""
echo "=== MUST ALLOW — file outside repo (exit 0) ==="
echo ""

# Switch back to main so we can verify it would block repo files
git -C "$TEST_DIR" checkout main --quiet

run_test "Edit file outside repo (on main)" \
  "Edit" "/tmp/outside-file.ts" "$TEST_DIR" 0

run_test "Write file outside repo (on main)" \
  "Write" "/tmp/outside-file.ts" "$TEST_DIR" 0

# --- Edge cases ---

echo ""
echo "=== EDGE CASES ==="
echo ""

# Empty stdin
TOTAL=$((TOTAL + 1))
echo "" | bash -c "cd '$TEST_DIR' && bash '$HOOK'" 2>/dev/null
if [ $? -eq 0 ]; then
  echo "  PASS: Empty stdin (fail open)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: Empty stdin (expected exit 0, should fail open)"
  FAIL=$((FAIL + 1))
fi

# Malformed JSON
TOTAL=$((TOTAL + 1))
echo "not json" | bash -c "cd '$TEST_DIR' && bash '$HOOK'" 2>/dev/null
if [ $? -eq 0 ]; then
  echo "  PASS: Malformed JSON (fail open)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: Malformed JSON (expected exit 0, should fail open)"
  FAIL=$((FAIL + 1))
fi

# Missing file_path in tool_input
TOTAL=$((TOTAL + 1))
echo '{"tool_name":"Edit","tool_input":{}}' | bash -c "cd '$TEST_DIR' && bash '$HOOK'" 2>/dev/null
if [ $? -eq 0 ]; then
  echo "  PASS: Missing file_path (fail open)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: Missing file_path (expected exit 0)"
  FAIL=$((FAIL + 1))
fi

# Not in a git repo
TOTAL=$((TOTAL + 1))
NON_GIT_DIR="$(mktemp -d)"
make_event "Edit" "$NON_GIT_DIR/file.ts" | bash -c "cd '$NON_GIT_DIR' && bash '$HOOK'" 2>/dev/null
if [ $? -eq 0 ]; then
  echo "  PASS: Not in git repo (fail open)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: Not in git repo (expected exit 0, should fail open)"
  FAIL=$((FAIL + 1))
fi
rm -rf "$NON_GIT_DIR"

# Missing jq (create a minimal PATH without jq)
# Write event to file first to avoid SIGPIPE — the hook exits before reading
# stdin when jq is missing, which kills the pipe writer under pipefail.
TOTAL=$((TOTAL + 1))
FAKE_PATH="$(mktemp -d)"
JQ_TEST_EVENT="$(mktemp)"
for cmd in bash cat grep echo head git; do
  real="$(command -v "$cmd" 2>/dev/null)" && [ -n "$real" ] && ln -sf "$real" "$FAKE_PATH/$cmd"
done
make_event "Edit" "$TEST_DIR/file.ts" > "$JQ_TEST_EVENT"
PATH="$FAKE_PATH" bash -c "cd '$TEST_DIR' && bash '$HOOK'" < "$JQ_TEST_EVENT" 2>/dev/null
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
