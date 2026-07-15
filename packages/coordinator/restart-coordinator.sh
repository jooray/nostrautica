#!/usr/bin/env bash
# Rebuild and restart the Nostrautica coordinator from this dev checkout (which is
# at the pushed commit — pushes originate here). Called by the deploy post-receive
# hook and safe to run by hand. Local/deploy file, not in git (like run-coordinator.sh).
#
# Build happens BEFORE the old instance is stopped, so a failing build leaves the
# running coordinator untouched.
set -uo pipefail
export PATH="/home/linuxbrew/.linuxbrew/bin:$PATH"

ROOT="$HOME/nostrautica"
COORD="$ROOT/packages/coordinator"
LOG="$HOME/log/nostrautica-coordinator.log"
mkdir -p "$HOME/log"

cd "$ROOT"
echo "=== coordinator rebuild $(date -Is) ==="
pnpm install --frozen-lockfile   || { echo "install failed — coordinator left running"; exit 1; }
pnpm --filter @nostrautica/protocol build    || { echo "protocol build failed — coordinator left running"; exit 1; }
pnpm --filter @nostrautica/coordinator build || { echo "coordinator build failed — coordinator left running"; exit 1; }

# Build OK — swap instances. Kill the node process by its exact argv (does not
# match this script or the chat mock); its run-coordinator.sh wrapper exits with it.
pkill -f "node dist/main.js coordinator.toml" 2>/dev/null || true
sleep 1

cd "$COORD"
# Detach so the coordinator survives this script and the git hook exiting.
setsid bash run-coordinator.sh >> "$LOG" 2>&1 < /dev/null &
disown 2>/dev/null || true
echo "=== coordinator restarted $(date -Is) (log: $LOG) ==="
