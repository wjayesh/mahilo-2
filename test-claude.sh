#!/bin/bash
# Test with unique session ID

cd /Users/wjayesh/apps/mahilo-2

SESSION_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
echo "Using session ID: $SESSION_ID"
echo ""

claude --dangerously-skip-permissions --session-id "$SESSION_ID" -p "Read the file CLAUDE.md and tell me the first task ID mentioned" 2>&1
