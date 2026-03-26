#!/usr/bin/env bash
# test-scan-edit-write-secrets.sh — Tests for the Edit/Write secret scanning PreToolUse hook.
#
# Usage: bash config/hooks/tests/test-scan-edit-write-secrets.sh
#
# Each test feeds a JSON hook event to the scanner via stdin and checks
# the exit code. Exit 0 = allowed, exit 2 = blocked.

set -uo pipefail

# Resolve script location so tests work from any cwd
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/../scan-edit-write-secrets.sh"

PASS=0
FAIL=0
TOTAL=0

# --- Helpers ---

# Build a JSON hook event for an Edit or Write tool call.
# Uses jq to properly escape the content for JSON.
# $1 = tool name ("Edit" or "Write")
# $2 = content string (goes into new_string for Edit, content for Write)
make_event() {
  local tool="$1"
  local content="$2"
  if [ "$tool" = "Edit" ]; then
    jq -n --arg content "$content" '{
      tool_name: "Edit",
      tool_input: { file_path: "/tmp/test.ts", old_string: "placeholder", new_string: $content },
      session_id: "test-session",
      cwd: "/tmp",
      hook_event_name: "PreToolUse"
    }'
  else
    jq -n --arg content "$content" '{
      tool_name: "Write",
      tool_input: { file_path: "/tmp/test.ts", content: $content },
      session_id: "test-session",
      cwd: "/tmp",
      hook_event_name: "PreToolUse"
    }'
  fi
}

# Run the hook with given content and check the exit code.
# $1 = test name
# $2 = tool name ("Edit" or "Write")
# $3 = content string
# $4 = expected exit code (0 or 2)
run_test() {
  local name="$1"
  local tool="$2"
  local content="$3"
  local expected="$4"
  TOTAL=$((TOTAL + 1))

  local stderr_output
  stderr_output="$(make_event "$tool" "$content" | bash "$HOOK" 2>&1 >/dev/null)"
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

# --- Must block (exit 2) — Edit tool ---

echo ""
echo "=== MUST BLOCK — Edit tool (exit 2) ==="
echo ""

run_test "Edit: Discord bot token" \
  "Edit" \
  'const TOKEN = "MTk4NjIyNDgzNDcxOTI1MjQ4.Cl2FMQ.ZnCjm1XVW7vRze4b7Cq4se7kKWs";' \
  2

run_test "Edit: OpenAI API key" \
  "Edit" \
  'const OPENAI_KEY = "sk-abcdefghijklmnopqrstuvwxyz123456";' \
  2

run_test "Edit: GitHub PAT" \
  "Edit" \
  'const GH_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";' \
  2

run_test "Edit: GitHub OAuth token" \
  "Edit" \
  'const GH_OAUTH = "gho_abcdefghijklmnopqrstuvwxyz1234567890";' \
  2

run_test "Edit: GitHub fine-grained PAT" \
  "Edit" \
  'const GH_PAT = "github_pat_abcdefghijklmnopqrstuvwxyz12345";' \
  2

run_test "Edit: AWS access key" \
  "Edit" \
  'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE' \
  2

run_test "Edit: Slack bot token" \
  "Edit" \
  'const SLACK_TOKEN = "xoxb-fake-test-token-not-real";' \
  2

run_test "Edit: Webhook secret" \
  "Edit" \
  'const WEBHOOK_SECRET = "whsec_abcdefghijklmnopqrstuvwxyz";' \
  2

run_test "Edit: Private RSA key" \
  "Edit" \
  '-----BEGIN RSA PRIVATE KEY-----' \
  2

run_test "Edit: Private EC key" \
  "Edit" \
  '-----BEGIN EC PRIVATE KEY-----' \
  2

run_test "Edit: Private key (generic)" \
  "Edit" \
  '-----BEGIN PRIVATE KEY-----' \
  2

run_test "Edit: Private OPENSSH key" \
  "Edit" \
  '-----BEGIN OPENSSH PRIVATE KEY-----' \
  2

# --- Must block (exit 2) — Write tool ---

echo ""
echo "=== MUST BLOCK — Write tool (exit 2) ==="
echo ""

run_test "Write: Discord bot token" \
  "Write" \
  'const TOKEN = "MTk4NjIyNDgzNDcxOTI1MjQ4.Cl2FMQ.ZnCjm1XVW7vRze4b7Cq4se7kKWs";' \
  2

run_test "Write: OpenAI API key" \
  "Write" \
  'const OPENAI_KEY = "sk-abcdefghijklmnopqrstuvwxyz123456";' \
  2

run_test "Write: GitHub PAT" \
  "Write" \
  'const GH_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";' \
  2

run_test "Write: GitHub OAuth token" \
  "Write" \
  'const GH_OAUTH = "gho_abcdefghijklmnopqrstuvwxyz1234567890";' \
  2

run_test "Write: GitHub fine-grained PAT" \
  "Write" \
  'const GH_PAT = "github_pat_abcdefghijklmnopqrstuvwxyz12345";' \
  2

run_test "Write: AWS access key" \
  "Write" \
  'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE' \
  2

run_test "Write: Slack bot token" \
  "Write" \
  'const SLACK_TOKEN = "xoxb-fake-test-token-not-real";' \
  2

run_test "Write: Webhook secret" \
  "Write" \
  'const WEBHOOK_SECRET = "whsec_abcdefghijklmnopqrstuvwxyz";' \
  2

run_test "Write: Private RSA key" \
  "Write" \
  '-----BEGIN RSA PRIVATE KEY-----' \
  2

run_test "Write: Private DSA key" \
  "Write" \
  '-----BEGIN DSA PRIVATE KEY-----' \
  2

# --- Must allow (exit 0) ---

echo ""
echo "=== MUST ALLOW (exit 0) ==="
echo ""

run_test "Clean TypeScript code" \
  "Edit" \
  'const greeting = "hello world";' \
  0

run_test "Env var reference (not a secret)" \
  "Edit" \
  'const key = process.env.SECRET_KEY;' \
  0

run_test "Short sk- string (not a key)" \
  "Edit" \
  'const prefix = "sk-short";' \
  0

run_test "Short ghp_ string (not a key)" \
  "Write" \
  'grep -r "ghp_" src/' \
  0

run_test "Empty content (Write)" \
  "Write" \
  '' \
  0

run_test "Comment about keys (no actual key)" \
  "Edit" \
  '// API keys should be stored in 1Password, never hardcoded' \
  0

run_test "Public key (not private)" \
  "Write" \
  '-----BEGIN PUBLIC KEY-----' \
  0

run_test "Certificate (not private key)" \
  "Write" \
  '-----BEGIN CERTIFICATE-----' \
  0

run_test "sk- in variable name (no real key)" \
  "Edit" \
  'const sk_prefix_check = /^sk-/;' \
  0

run_test "Slack mention without real token" \
  "Edit" \
  '// Configure xoxb token via environment variable' \
  0

# --- Edge cases ---

echo ""
echo "=== EDGE CASES ==="
echo ""

# Empty stdin
TOTAL=$((TOTAL + 1))
echo "" | bash "$HOOK" 2>/dev/null
if [ $? -eq 0 ]; then
  echo "  PASS: Empty stdin (fail open)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: Empty stdin (expected exit 0, should fail open)"
  FAIL=$((FAIL + 1))
fi

# Malformed JSON
TOTAL=$((TOTAL + 1))
echo "not json at all" | bash "$HOOK" 2>/dev/null
if [ $? -eq 0 ]; then
  echo "  PASS: Malformed JSON (fail open)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: Malformed JSON (expected exit 0, should fail open)"
  FAIL=$((FAIL + 1))
fi

# Missing tool_input fields
TOTAL=$((TOTAL + 1))
echo '{"tool_name":"Edit","tool_input":{}}' | bash "$HOOK" 2>/dev/null
if [ $? -eq 0 ]; then
  echo "  PASS: Missing tool_input fields (fail open)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: Missing tool_input fields (expected exit 0)"
  FAIL=$((FAIL + 1))
fi

# Missing jq (create a minimal PATH without jq)
# Write event to file first to avoid SIGPIPE — the hook exits before reading
# stdin when jq is missing, which kills the pipe writer under pipefail.
TOTAL=$((TOTAL + 1))
FAKE_PATH="$(mktemp -d)"
JQ_TEST_EVENT="$(mktemp)"
for cmd in bash cat grep echo head; do
  real="$(command -v "$cmd" 2>/dev/null)" && [ -n "$real" ] && ln -sf "$real" "$FAKE_PATH/$cmd"
done
make_event "Edit" "sk-abcdefghijklmnopqrstuvwxyz123456" > "$JQ_TEST_EVENT"
stderr_output="$(PATH="$FAKE_PATH" bash "$HOOK" < "$JQ_TEST_EVENT" 2>&1 >/dev/null)"
if [ $? -eq 0 ]; then
  echo "  PASS: Missing jq (fail open)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: Missing jq (expected exit 0, should fail open)"
  FAIL=$((FAIL + 1))
fi
rm -rf "$FAKE_PATH" "$JQ_TEST_EVENT"

# Multi-line content with secret on later line
run_test "Multi-line content with secret" \
  "Write" \
  "$(printf 'const a = 1;\nconst key = \"sk-abcdefghijklmnopqrstuvwxyz123456\";\nconst b = 2;')" \
  2

# Multi-line content without secret
run_test "Multi-line content without secret" \
  "Write" \
  "$(printf 'const a = 1;\nconst b = 2;\nconst c = 3;')" \
  0

# Edit with secret in old_string but clean new_string (should allow)
TOTAL=$((TOTAL + 1))
EVENT="$(jq -n '{
  tool_name: "Edit",
  tool_input: {
    file_path: "/tmp/test.ts",
    old_string: "sk-abcdefghijklmnopqrstuvwxyz123456",
    new_string: "process.env.OPENAI_API_KEY"
  },
  session_id: "test-session",
  cwd: "/tmp",
  hook_event_name: "PreToolUse"
}')"
echo "$EVENT" | bash "$HOOK" 2>/dev/null
if [ $? -eq 0 ]; then
  echo "  PASS: Secret in old_string only (correctly allows — replacing a secret)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: Secret in old_string only (should allow — we're removing the secret)"
  FAIL=$((FAIL + 1))
fi

# --- Summary ---

echo ""
echo "=============================="
echo "Results: $PASS passed, $FAIL failed, $TOTAL total"
echo "=============================="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
