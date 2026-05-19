#!/usr/bin/env python3
"""block-askuserquestion-in-discord.py — PreToolUse hook.

Blocks `AskUserQuestion` tool calls in Discord-bridged Claude Code sessions.
Discord-bridged sessions are detected by the presence of the `DISCORD_STATE_DIR`
environment variable, which the LobsterFarm daemon exports when spawning pool
bot, Pat, and channel-bound Gary tmux sessions.

The `AskUserQuestion` tool renders a terminal-only option picker that never
reaches the Discord user — so calling it wedges the conversation. This hook
blocks the call and instructs the model to ask via
`mcp__plugin_discord_discord__reply` instead.

Contract (https://docs.claude.com/en/docs/claude-code/hooks):
  - PreToolUse JSON arrives on stdin.
  - Block by printing `{"decision": "block", "reason": "..."}` to stdout.
  - Allow by exiting 0 with empty stdout.

Safety: this hook is registered globally and runs before every tool call on the
machine. A crashing or hanging hook would freeze every Claude session, so the
contract here is fail-open: any malformed input, missing field, or unexpected
exception exits 0 silently. Blocking only ever happens on the exact path where
both DISCORD_STATE_DIR is set AND the tool is AskUserQuestion.
"""

from __future__ import annotations

import json
import os
import sys

DENIAL_REASON = (
    "AskUserQuestion is not supported in Discord-bridged sessions — the option "
    "picker renders only in the local TTY and is invisible to the user. Ask the "
    "user via the `mcp__plugin_discord_discord__reply` tool with a numbered/"
    "lettered list instead, and read their answer from the next incoming "
    "`<channel>` block."
)


def main() -> int:
    try:
        raw = sys.stdin.read()
    except Exception:
        return 0

    if not raw or not raw.strip():
        return 0

    try:
        payload = json.loads(raw)
    except Exception:
        return 0

    if not isinstance(payload, dict):
        return 0

    tool_name = payload.get("tool_name")
    if tool_name != "AskUserQuestion":
        return 0

    if not os.environ.get("DISCORD_STATE_DIR"):
        return 0

    try:
        json.dump({"decision": "block", "reason": DENIAL_REASON}, sys.stdout)
        sys.stdout.write("\n")
    except Exception:
        return 0

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # Last-ditch fail-open: never crash a global hook.
        sys.exit(0)
