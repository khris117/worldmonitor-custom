#!/usr/bin/env bash
# Bring up the full World Monitor Docker stack for local testing of the
# website / Web service-outages work on this branch.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -f docker-compose.yml || ! -f docker-compose.test.yml ]]; then
  echo "error: run this from the worldmonitor-custom repo root (missing compose files)." >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  echo "Creating .env with required secrets (openssl rand -hex 32)..."
  {
    echo "RELAY_SHARED_SECRET=$(openssl rand -hex 32)"
    echo "REDIS_PASSWORD=$(openssl rand -hex 32)"
    echo "REDIS_TOKEN=$(openssl rand -hex 32)"
    echo "WM_SESSION_SECRET=$(openssl rand -hex 32)"
  } > .env
  echo "Wrote .env (gitignored). Do not commit it."
else
  echo "Using existing .env (not overwritten)."
fi

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.test.yml)
if docker compose -f docker-compose.test.yml config >/dev/null 2>&1; then
  # Prefer single-file include when the Compose engine supports it.
  COMPOSE=(docker compose -f docker-compose.test.yml)
fi

echo "Starting stack: ${COMPOSE[*]} up -d --build"
"${COMPOSE[@]}" up -d --build

cat <<'MSG'

Stack is starting.

  Open: http://localhost:3000

Verify Web service outages:
  1. Open the Service Status panel
  2. Select the Web category filter
  3. Expect status rows for: Google, Apple, Reddit, LinkedIn, Spotify,
     Shopify, Dropbox, and Akamai
  (No API keys required for those public status feeds.)

Optional (other panels / Redis seed data — not required for Web status):
  ./scripts/run-seeders.sh

Tear down:
  docker compose -f docker-compose.test.yml down
  # or: docker compose -f docker-compose.yml -f docker-compose.test.yml down

See DOCKER_TEST.md for full steps.
MSG
