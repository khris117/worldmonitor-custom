# Docker test deploy (website / Web service outages)

Local Docker packaging for branch `feature/website-service-outages`. Uses the
existing full stack (`worldmonitor` + Redis + redis-rest + ais-relay) under a
dedicated Compose project name so it does not clash with a normal
`docker compose up`.

## Prerequisites

- Docker Engine and Docker Compose v2 (Compose `include` preferred; merge via
  `-f` / `-f` also works)
- `openssl` (to generate secrets)
- This repo checked out on `feature/website-service-outages`

No vendor API keys are required to exercise the **Service Status → Web** panel.

## Quick start

```bash
git checkout feature/website-service-outages
bash scripts/docker-test-up.sh
```

The script:

1. Ensures it is run from the repo root
2. Creates `.env` **only if missing**, with:
   - `RELAY_SHARED_SECRET`
   - `REDIS_PASSWORD`
   - `REDIS_TOKEN`
   - `WM_SESSION_SECRET`  
   each set to `openssl rand -hex 32` (existing `.env` is never overwritten)
3. Runs `docker compose … up -d --build` against the test packaging
4. Prints verify steps

App URL: **http://localhost:3000**

## Manual commands

Generate secrets once (skip if `.env` already exists):

```bash
echo "RELAY_SHARED_SECRET=$(openssl rand -hex 32)" >> .env
echo "REDIS_PASSWORD=$(openssl rand -hex 32)"      >> .env
echo "REDIS_TOKEN=$(openssl rand -hex 32)"         >> .env
echo "WM_SESSION_SECRET=$(openssl rand -hex 32)"   >> .env
```

Bring the stack up (either form):

```bash
# Preferred when Compose supports include:
docker compose -f docker-compose.test.yml up -d --build

# Equivalent merge (always works with Compose v2):
docker compose -f docker-compose.yml -f docker-compose.test.yml up -d --build
```

`docker-compose.test.yml` only sets `name: worldmonitor-web-outages-test` and
includes the root `docker-compose.yml` — it does not redefine services.

## Verify Web service outages

1. Open http://localhost:3000
2. Open the **Service Status** panel
3. Select the **Web** category filter
4. Confirm rows for: **Google**, **Apple**, **Reddit**, **LinkedIn**,
   **Spotify**, **Shopify**, **Dropbox**, and **Akamai**

Those feeds use public status JSON; a flaky upstream can look empty briefly.

## Optional seeders

Other dashboard panels that rely on Redis seed data:

```bash
./scripts/run-seeders.sh
```

Not required for Service Status → Web.

## Tear down

```bash
docker compose -f docker-compose.test.yml down
# or:
docker compose -f docker-compose.yml -f docker-compose.test.yml down
```

Add `-v` to also remove the Redis volume.

## Notes

- `.env` is gitignored — never commit secrets.
- Port defaults to **3000** (`WM_PORT`). Override in `.env` if needed.
- Full self-host details: [SELF_HOSTING.md](./SELF_HOSTING.md).
