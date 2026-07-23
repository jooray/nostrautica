#!/usr/bin/env bash
# Run the Nostrautica coordinator for cypherpunk.today.
# Secrets come from .env (NOSTRAUTICA_COORDINATOR_NSEC, NOSTRAUTICA_COORDINATOR_DB)
# and the environment (VENICE_API_KEY). Config: coordinator.toml.
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] && { set -a; . ./.env; set +a; }
: "${VENICE_API_KEY:?set VENICE_API_KEY in the environment}"

# Release identity: the deploy hook writes the pushed revision into RELEASE_ID at
# the repo root (the rsynced tree has no .git to derive it from). An explicit
# NOSTRAUTICA_RELEASE_ID in the environment/.env always wins.
if [ -z "${NOSTRAUTICA_RELEASE_ID:-}" ] && [ -f ../../RELEASE_ID ]; then
  NOSTRAUTICA_RELEASE_ID="$(cat ../../RELEASE_ID)"
  export NOSTRAUTICA_RELEASE_ID
fi

node dist/main.js coordinator.toml
