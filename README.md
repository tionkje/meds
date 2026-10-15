# meds

Single-user, tap-to-log painkiller tracker. One big button per pill shows how many you took
today and at what times; below it a 7-day history. Past days show a 24h timeline per pill;
tap a day to edit or delete its doses. Works offline (service worker + localStorage queue), syncs when back online.
Runs on a home lab behind Tailscale, so no auth.

## Stack

Node 24 (native TS, `node:sqlite`), vanilla HTML/JS. Zero runtime dependencies. No build step.

## Develop

```sh
pnpm install     # dev deps only: typescript + @types/node
pnpm start       # http://localhost:3000, db at ./data/meds.db
pnpm test        # node --test
pnpm check       # tsc --noEmit
PROD_SSH=<host> pnpm pull-prod   # overwrite local db with a production snapshot
```

## Environment

| var             | default            |
| --------------- | ------------------ |
| `DATABASE_PATH` | `./data/meds.db`   |
| `PORT`          | `3000`             |
| `TZ`            | `Europe/Brussels`  |

## Deploy

CI pushes `ghcr.io/tionkje/meds:latest` on every push to `main`. On the server:

```sh
cd ~/meds
docker compose pull && docker compose up -d
```

Export: `/export.csv` (date, time, pill).
