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
type Dose = { id: string; pill_id: number; taken_at: string };

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

export function toCsv(db: DatabaseSync): string {
  const rows = db
    .prepare('SELECT d.taken_at, p.name FROM doses d JOIN pills p ON p.id = d.pill_id ORDER BY d.taken_at')
    .all() as { taken_at: string; name: string }[];
  const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' });
  const esc = (s: string): string => `"${s.replaceAll('"', '""')}"`;
  return ['date,time,pill', ...rows.map((r) => {
    const [date, time] = fmt.format(new Date(r.taken_at)).split(' ');
    return `${date},${time},${esc(r.name)}`;
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
        const { id, pill_id, taken_at } = await readJson(req);
        if (typeof id !== 'string' || typeof pill_id !== 'number' || !isIso(taken_at)) return send(res, 400, { error: 'id, pill_id, taken_at required' });
        // ponytail: INSERT OR IGNORE = idempotent retry from the offline queue
        db.prepare('INSERT OR IGNORE INTO doses (id, pill_id, taken_at) VALUES (?, ?, ?)').run(id, pill_id, taken_at);
        return send(res, 201, {});
      }
      const dose = p.match(/^\/api\/doses\/([\w-]+)$/);
      if (m === 'PATCH' && dose) {
        const { taken_at } = await readJson(req);
        if (!isIso(taken_at)) return send(res, 400, { error: 'taken_at required' });
        db.prepare('UPDATE doses SET taken_at = ? WHERE id = ?').run(taken_at, dose[1]);
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
