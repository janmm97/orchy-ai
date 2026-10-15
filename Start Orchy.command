#!/bin/bash
# Double-click to start Orchy on macOS. The dashboard opens at http://localhost:8008 (PORT in .env).
# If double-clicking says "permission denied" (a git clone can lose the executable bit), run once:
#   chmod +x "Start Orchy.command"
# Finder launches have a minimal PATH, so the Homebrew (/opt/homebrew/bin, /usr/local/bin) and
# npm-global folders are added below before looking for node.
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.claude/local:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Orchy needs Node.js 20 or newer, and it isn't installed yet."
  echo "  Get it from https://nodejs.org (or: brew install node), then open this file again."
  echo
  read -r -p "  Press Enter to close. " _
  exit 1
fi
# Setup is safe to repeat: installs packages once, creates .env, checks the CLIs.
if ! node scripts/setup.mjs --no-start; then
  echo
  echo "  Fix the item above, then open this file again."
  read -r -p "  Press Enter to close. " _
  exit 1
fi
node orchestrator/server.mjs
status=$?
# Only keep the window open when there's an error to read.
if [ $status -ne 0 ]; then read -r -p "  Orchy stopped with an error. Press Enter to close. " _; fi
