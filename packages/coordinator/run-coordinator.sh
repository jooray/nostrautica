#!/usr/bin/env bash
# Run the Nostrautica coordinator for cypherpunk.today.
# Secrets come from .env (NOSTRAUTICA_COORDINATOR_NSEC, NOSTRAUTICA_COORDINATOR_DB)
# and the environment (VENICE_API_KEY). Config: coordinator.toml.
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] && { set -a; . ./.env; set +a; }
: "${VENICE_API_KEY:?set VENICE_API_KEY in the environment}"

node dist/main.js coordinator.toml
