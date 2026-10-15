# meds

Single-user, tap-to-log painkiller tracker (PWA). Offline-first, no auth (runs behind Tailscale). See `README.md` for the user-facing overview.

If `AGENTS.local.md` exists, read it: it holds machine-local notes (e.g. production host details) that are not committed.

## Commands

- `pnpm start`: http://localhost:3000, db at `./data/meds.db`
- `pnpm test`: `node --test server.test.ts` with `TZ=Europe/Brussels` (CSV assertion depends on it)
- `pnpm check`: `tsc --noEmit`
- `PROD_SSH=<host> pnpm pull-prod`: overwrite local db with a production snapshot (`scripts/pull-prod-db.sh`, runs `VACUUM INTO` inside the `meds` container)
- CI (`.github/workflows/ci.yml`) runs `check` + `test`, then pushes `ghcr.io/tionkje/meds:latest` on push to `main`

## Stack constraints

- Node 24 runs `server.ts` directly (type stripping). No build step, zero runtime deps. Keep it that way.
- `erasableSyntaxOnly`: no enums, namespaces, parameter properties. Relative imports use the `.ts` extension.
- DB is `node:sqlite` (`DatabaseSync`), not a package.
- Frontend is vanilla JS inline in `index.html`, not type-checked.

## Layout

- `server.ts`: everything server-side. `openDb` (schema + migrations), `toCsv`, `createApp` (hand-rolled router on `node:http`). Runs `listen` only when `import.meta.main`.
- `server.test.ts`: one integration test against an in-memory db (`openDb(':memory:')`).
- `index.html`: UI + client logic (state cache, offline queue, render).
- `sw.js`: service worker. Shell is stale-while-revalidate; `/api/*` and `/export.csv` go to the network.

## API

- `GET /api/state` → `{ pills, doses }` (all rows, doses newest first)
- `POST /api/pills {name}`, `PATCH /api/pills/:id {name?, hidden?}`
- `POST /api/doses {id, pill_id, taken_at, quantity=1}`: **upsert on `id`** (`taken_at` + `quantity` update on conflict)
- `PATCH /api/doses/:id {taken_at?, quantity?}`, `DELETE /api/doses/:id`
- `GET /export.csv` → `date,time,pill,quantity`, times formatted in `TZ`

## Gotchas

- Offline sync: the client makes the dose `id` (`crypto.randomUUID()`) and queues full dose objects in `localStorage` (`queue`). Retries depend on the idempotent upsert, so don't break that. An unsynced dose is edited in place (state + its queue entry, `editPending`), so time/quantity/delete work offline; a delete replaces the entry with `{id, deleted: true}`, sent as `DELETE`.
- A repeat tap on the same pill within `MERGE_MS` (10 min) bumps `quantity` on the existing dose instead of adding a new one.
- Pill button order is frozen for each visit (`order`, reset on `visibilitychange`) so the buttons don't move while you tap.
- `taken_at` is stored as an ISO UTC string. Day grouping and display happen in the browser's local time.
- Migrations: a single hand-rolled column check in `openDb`. Switch to a versioned list when a second one is needed.
- To add a static file, update all three: the `STATIC` map in `server.ts`, the `COPY` line in `Dockerfile`, and `SHELL` in `sw.js` if it should work offline.
- When shell assets change in ways cached clients must pick up, bump `VERSION` in `sw.js`.
- Comments explaining a non-obvious design choice start with `ponytail:`. Follow that convention.
