import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type http from 'node:http';
import { createApp, openDb } from './server.ts';

let server: http.Server;
let base: string;

before(async () => {
  server = createApp(openDb(':memory:'));
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  base = `http://localhost:${addr.port}`;
});
after(() => server.close());

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
}
type State = { pills: { id: number; name: string; hidden: number }[]; doses: { id: string; pill_id: number; taken_at: string; quantity: number }[] };
const state = async (): Promise<State> => (await call('GET', '/api/state')).json() as Promise<State>;

test('pill + dose flow, idempotent dose, rename follows history, csv', async () => {
  const { id } = (await (await call('POST', '/api/pills', { name: 'Paracetamol' })).json()) as { id: number };
  assert.equal((await call('POST', '/api/pills', { name: '  ' })).status, 400);

  const dose = { id: 'uuid-1', pill_id: id, taken_at: '2026-09-16T10:00:00.000Z' };
  assert.equal((await call('POST', '/api/doses', dose)).status, 201);
  assert.equal((await call('POST', '/api/doses', dose)).status, 201); // offline-queue retry
  assert.equal((await state()).doses.length, 1);
  assert.equal((await state()).doses[0].quantity, 1);
  await call('POST', '/api/doses', { ...dose, quantity: 2 }); // repeat tap within merge window = same id, higher quantity
  assert.equal((await state()).doses[0].quantity, 2);
  await call('POST', '/api/doses', { ...dose, taken_at: '2026-09-16T10:15:00.000Z', quantity: 2 }); // offline time edit of a queued dose
  assert.equal((await state()).doses[0].taken_at, '2026-09-16T10:15:00.000Z');
  assert.equal((await call('POST', '/api/doses', { id: 'x', pill_id: id, taken_at: 'nope' })).status, 400);
  assert.equal((await call('POST', '/api/doses', { ...dose, quantity: 0 })).status, 400);
  assert.equal((await call('PATCH', '/api/doses/uuid-1', {})).status, 400);

  await call('PATCH', `/api/pills/${id}`, { name: 'Dafalgan', hidden: true });
  const s = await state();
  assert.deepEqual(s.pills, [{ id, name: 'Dafalgan', hidden: 1 }]);
  assert.equal(s.doses[0].pill_id, id);

  await call('PATCH', '/api/doses/uuid-1', { taken_at: '2026-09-16T11:30:00.000Z' });
  assert.equal((await state()).doses[0].taken_at, '2026-09-16T11:30:00.000Z');

  const csv = await (await call('GET', '/export.csv')).text();
  assert.equal(csv, 'date,time,pill,quantity\n2026-09-16,13:30,"Dafalgan",2\n'); // TZ=Europe/Brussels (CEST)

  await call('DELETE', '/api/doses/uuid-1');
  assert.equal((await state()).doses.length, 0);
  assert.equal((await call('DELETE', '/api/doses/never-synced')).status, 200); // queued delete of a dose the server never got
  assert.equal((await call('GET', '/nope')).status, 404);
});
