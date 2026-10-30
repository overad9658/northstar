import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { freePort, startServer, stopServer } from './support/server-fixture.mjs';

test('cards have an optional unique key for lookup and upsert, kept by backups', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-card-key-'));
  const port = await freePort();
  const child = await startServer(dataDir, port);
  t.after(async () => { await stopServer(child); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const send = (path, method = 'GET', body) => fetch(`${base}${path}`, {
    method, headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const read = (path) => send(path).then((response) => response.json());
  const statuses = (responses) => responses.map((response) => response.status).sort();

  const column = await send('/api/kanban/columns', 'POST', { name: 'To do' }).then((response) => response.json());
  const input = { key: 'sync-42', columnId: column.id, title: 'Keyed card' };

  const created = await send('/api/kanban/cards/upsert?key=key', 'PUT', input);
  assert.equal(created.status, 201);
  const first = await created.json();
  assert.deepEqual([first.created, first.card.key], [true, 'sync-42']);
  const repeated = await send('/api/kanban/cards/upsert?key=key', 'PUT', input);
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).card.id, first.card.id);
  const retitled = await send('/api/kanban/cards/upsert?key=key', 'PUT', { key: 'sync-42', title: 'Renamed' }).then((response) => response.json());
  assert.deepEqual([retitled.created, retitled.card.id, retitled.card.title], [false, first.card.id, 'Renamed']);
  assert.deepEqual((await read('/api/kanban/cards?key=sync-42')).map((card) => card.id), [first.card.id]);
  assert.deepEqual(await read('/api/kanban/cards?key=missing'), []);

  const byUrl = { columnId: column.id, title: 'Linked', externalUrl: 'https://code.example/pull/1' };
  assert.equal((await send('/api/kanban/cards/upsert', 'PUT', byUrl)).status, 201);
  assert.equal((await send('/api/kanban/cards/upsert', 'PUT', byUrl)).status, 200);
  assert.equal((await read(`/api/kanban/cards?externalUrl=${encodeURIComponent(byUrl.externalUrl)}`))[0].key, null);

  const other = await send('/api/kanban/cards', 'POST', { columnId: column.id, title: 'Other' }).then((response) => response.json());
  await send('/api/kanban/cards', 'POST', { columnId: column.id, title: 'Also unkeyed', key: '' });
  assert.equal((await send('/api/kanban/cards', 'POST', { columnId: column.id, title: 'Duplicate', key: 'sync-42' })).status, 409);
  assert.equal((await send(`/api/kanban/cards/${other.id}`, 'PUT', { key: 'sync-42' })).status, 409);
  assert.equal((await send(`/api/kanban/cards/${first.card.id}`, 'PUT', { key: '' }).then((response) => response.json())).key, null);
  assert.equal((await send(`/api/kanban/cards/${other.id}`, 'PUT', { key: 'sync-42' })).status, 200);

  assert.equal((await send('/api/kanban/cards', 'POST', { columnId: column.id, title: 'Too long', key: 'k'.repeat(121) })).status, 400);
  assert.equal((await send('/api/kanban/cards/upsert?key=title', 'PUT', input)).status, 400);
  assert.equal((await send('/api/kanban/cards/upsert?key=key', 'PUT', { ...input, key: ' ' })).status, 400);

  const race = { key: 'race-1', columnId: column.id, title: 'Race' };
  assert.deepEqual(statuses(await Promise.all([1, 2].map(() => send('/api/kanban/cards/upsert?key=key', 'PUT', race)))), [200, 201]);
  assert.equal((await read('/api/kanban/cards?key=race-1')).length, 1);

  const backup = await read('/api/backup');
  assert.equal((await send('/api/backup', 'POST', backup)).status, 200);
  assert.deepEqual((await read('/api/kanban/cards?key=sync-42')).map((card) => [card.id, card.title]), [[other.id, 'Other']]);
  assert.equal((await read('/api/kanban/cards?key=race-1')).length, 1);
});
