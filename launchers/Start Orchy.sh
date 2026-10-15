#!/bin/sh
# Start Orchy on Linux: ./launchers/"Start Orchy.sh" in a terminal the first time, then ./"Start Orchy.sh" (setup puts a copy in the Orchy folder).
# The dashboard opens at http://localhost:8008 (PORT in .env). If it says "permission denied", run once:
#   chmod +x launchers/"Start Orchy.sh"
cd "$(dirname "$0")" || exit 1
# Run from the launchers folder (before the first setup) or from the Orchy folder (the copy setup puts there)
[ -f package.json ] || cd ..
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.claude/local:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Orchy needs Node.js 20 or newer, and it isn't installed yet."
  echo "  Get it from https://nodejs.org or your package manager, then run this again."
  echo
  exit 1
fi
# Setup is safe to repeat: installs packages once, creates .env, checks the CLIs, asks about Voice and Jev the first time.
if ! node scripts/setup.mjs --no-start; then
  echo
  echo "  Fix the item above, then run this again."
  exit 1
fi
exec node orchestrator/server.mjs
