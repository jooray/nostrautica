#!/usr/bin/env bash
# Rebuild and restart the Nostrautica coordinator. The deploy post-receive hook
# rsyncs the repo source to the coordinator host (nostrautica@jl.bednar.io) and
# runs this over SSH; also safe to run by hand there.
#
# PATH must find pnpm, which on that host is user-local (~/.npm-global/bin — the
# distro node RPM ships no corepack), while /usr/bin (ffmpeg) comes from the
# inherited login PATH. The linuxbrew entry is harmless where it doesn't exist.
#
# Build happens BEFORE the old instance is stopped, so a failing build leaves the
# running coordinator untouched.
set -uo pipefail
export PATH="$HOME/.npm-global/bin:/home/linuxbrew/.linuxbrew/bin:$PATH"

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
