import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const TZ = process.env.TZ ?? 'Europe/Brussels';
const STATIC: Record<string, string> = {
  '/': 'index.html',
  '/sw.js': 'sw.js',
  '/manifest.json': 'manifest.json',
  '/icon.svg': 'icon.svg',
};
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml' };

type Pill = { id: number; name: string; hidden: number };
type Dose = { id: string; pill_id: number; taken_at: string; quantity: number };

export function openDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS pills (id INTEGER PRIMARY KEY, name TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS doses (
      id TEXT PRIMARY KEY,
      pill_id INTEGER NOT NULL REFERENCES pills(id),
      taken_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS doses_taken_at ON doses(taken_at);
  `);
  // ponytail: single hand-rolled migration; switch to a versioned list when there's a second one
  const cols = db.prepare('PRAGMA table_info(doses)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'quantity')) db.exec('ALTER TABLE doses ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1');
  return db;
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? (JSON.parse(body) as Record<string, unknown>) : {};
}

function send(res: http.ServerResponse, status: number, body: unknown, type = 'application/json'): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function isIso(v: unknown): v is string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

function isQty(v: unknown): v is number {
  return Number.isInteger(v) && (v as number) >= 1;
}

export function toCsv(db: DatabaseSync): string {
  const rows = db
    .prepare('SELECT d.taken_at, d.quantity, p.name FROM doses d JOIN pills p ON p.id = d.pill_id ORDER BY d.taken_at')
    .all() as { taken_at: string; quantity: number; name: string }[];
  const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' });
  const esc = (s: string): string => `"${s.replaceAll('"', '""')}"`;
  return ['date,time,pill,quantity', ...rows.map((r) => {
    const [date, time] = fmt.format(new Date(r.taken_at)).split(' ');
    return `${date},${time},${esc(r.name)},${r.quantity}`;
  })].join('\n') + '\n';
}

export function createApp(db: DatabaseSync): http.Server {
  const dir = import.meta.dirname;
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const p = url.pathname;
      const m = req.method;

      if (m === 'GET' && p in STATIC) {
        const file = STATIC[p];
        return send(res, 200, await fs.readFile(path.join(dir, file)), MIME[path.extname(file)]);
      }
      if (m === 'GET' && p === '/export.csv') {
        res.setHeader('content-disposition', 'attachment; filename="meds.csv"');
        return send(res, 200, toCsv(db), 'text/csv');
      }
      if (m === 'GET' && p === '/api/state') {
        return send(res, 200, {
          pills: db.prepare('SELECT * FROM pills ORDER BY id').all() as Pill[],
          doses: db.prepare('SELECT * FROM doses ORDER BY taken_at DESC').all() as Dose[],
        });
      }
      if (m === 'POST' && p === '/api/pills') {
        const { name } = await readJson(req);
        if (typeof name !== 'string' || !name.trim()) return send(res, 400, { error: 'name required' });
        const r = db.prepare('INSERT INTO pills (name) VALUES (?)').run(name.trim());
        return send(res, 201, { id: Number(r.lastInsertRowid) });
      }
      const pill = p.match(/^\/api\/pills\/(\d+)$/);
      if (m === 'PATCH' && pill) {
        const { name, hidden } = await readJson(req);
        if (typeof name === 'string' && name.trim()) db.prepare('UPDATE pills SET name = ? WHERE id = ?').run(name.trim(), pill[1]);
        if (typeof hidden === 'boolean') db.prepare('UPDATE pills SET hidden = ? WHERE id = ?').run(hidden ? 1 : 0, pill[1]);
        return send(res, 200, {});
      }
      if (m === 'POST' && p === '/api/doses') {
        const { id, pill_id, taken_at, quantity = 1 } = await readJson(req);
        if (typeof id !== 'string' || typeof pill_id !== 'number' || !isIso(taken_at) || !isQty(quantity)) return send(res, 400, { error: 'id, pill_id, taken_at, quantity required' });
        // ponytail: upsert on id = idempotent retry from the offline queue; the queue always carries the full dose, so a repeat tap or an offline edit just resends it
        db.prepare('INSERT INTO doses (id, pill_id, taken_at, quantity) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET taken_at = excluded.taken_at, quantity = excluded.quantity').run(id, pill_id, taken_at, quantity);
        return send(res, 201, {});
      }
      const dose = p.match(/^\/api\/doses\/([\w-]+)$/);
      if (m === 'PATCH' && dose) {
        const { taken_at, quantity } = await readJson(req);
        if (taken_at === undefined && quantity === undefined) return send(res, 400, { error: 'taken_at or quantity required' });
        if (taken_at !== undefined && !isIso(taken_at)) return send(res, 400, { error: 'bad taken_at' });
        if (quantity !== undefined && !isQty(quantity)) return send(res, 400, { error: 'bad quantity' });
        if (isIso(taken_at)) db.prepare('UPDATE doses SET taken_at = ? WHERE id = ?').run(taken_at, dose[1]);
        if (isQty(quantity)) db.prepare('UPDATE doses SET quantity = ? WHERE id = ?').run(quantity, dose[1]);
        return send(res, 200, {});
      }
      if (m === 'DELETE' && dose) {
        db.prepare('DELETE FROM doses WHERE id = ?').run(dose[1]);
        return send(res, 200, {});
      }
      send(res, 404, { error: 'not found' });
    } catch (err) {
      console.error(err);
      send(res, 500, { error: String(err) });
    }
  });
}

if (import.meta.main) {
  const dbPath = process.env.DATABASE_PATH ?? './data/meds.db';
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const port = Number(process.env.PORT ?? 3000);
  createApp(openDb(dbPath)).listen(port, () => console.log(`meds listening on :${port}, db ${dbPath}, tz ${TZ}`));
}
