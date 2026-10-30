import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { freePort, startServer, stopServer } from './support/server-fixture.mjs';

test('cards can be archived and restored, are hidden by default, and filter by tag and source', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-card-archive-'));
  const port = await freePort();
  const child = await startServer(dataDir, port);
  t.after(async () => { await stopServer(child); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const send = (path, method = 'GET', body) => fetch(`${base}${path}`, {
    method, headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const read = (path) => send(path).then((response) => response.json());
  const ids = (cards) => cards.map((card) => card.id).sort((a, b) => a - b);

  const column = await send('/api/kanban/columns', 'POST', { name: 'To do' }).then((response) => response.json());
  const synced = await send('/api/kanban/cards', 'POST', { columnId: column.id, title: 'Synced', tags: ['Release'], source: 'ipm-sync' }).then((response) => response.json());
  const manual = await send('/api/kanban/cards', 'POST', { columnId: column.id, title: 'Manual', tags: ['other'], source: 'manual' }).then((response) => response.json());
  assert.deepEqual([synced.source, synced.archived, synced.archivedAt], ['ipm-sync', false, null]);

  const archivedResponse = await send(`/api/kanban/cards/${synced.id}`, 'PUT', { archived: true });
  assert.equal(archivedResponse.status, 200);
  const archived = await archivedResponse.json();
  assert.equal(archived.archived, true);
  assert.match(archived.archivedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal((await send(`/api/kanban/cards/${synced.id}`, 'PUT', { title: 'Synced again' }).then((response) => response.json())).archivedAt, archived.archivedAt);
  const archiveEvents = async () => (await read('/api/activity?limit=500')).items
    .filter((item) => item.cardId === synced.id && ['card.archived', 'card.restored'].includes(item.type)).map((item) => item.type);
  assert.deepEqual(await archiveEvents(), ['card.archived']);

  assert.deepEqual(ids((await read('/api/kanban')).cards), [manual.id]);
  assert.deepEqual(ids((await read('/api/kanban?archived=include')).cards), [synced.id, manual.id]);
  assert.deepEqual((await read('/api/kanban?archived=only')).cards.map((card) => [card.id, card.archived, card.source]), [[synced.id, true, 'ipm-sync']]);
  assert.deepEqual(ids(await read('/api/kanban/cards')), [manual.id]);
  assert.deepEqual(ids(await read('/api/kanban/cards?archived=include')), [synced.id, manual.id]);
  assert.deepEqual(ids(await read('/api/kanban/cards?tag=release')), []);
  assert.deepEqual(ids(await read('/api/kanban/cards?tag=%20Release%20&archived=include')), [synced.id]);
  assert.deepEqual(ids(await read('/api/kanban/cards?source=ipm-sync&archived=only')), [synced.id]);
  assert.deepEqual(ids(await read('/api/kanban/cards?source=manual')), [manual.id]);
  assert.equal((await send('/api/kanban/cards?archived=yes')).status, 400);
  assert.equal((await send('/api/kanban?archived=all')).status, 400);
  assert.equal((await send(`/api/kanban/cards/${manual.id}`, 'PUT', { archived: 'yes' })).status, 400);
  assert.equal((await send(`/api/kanban/cards/${synced.id}`)).status, 200);

  const born = await send('/api/kanban/cards', 'POST', { columnId: column.id, title: 'Born archived', archived: true }).then((response) => response.json());
  assert.equal(born.archived, true);
  assert.match(born.archivedAt, /^\d{4}-/);

  const backup = await read('/api/backup');
  assert.equal((await send('/api/backup', 'POST', backup)).status, 200);
  const restoredBackup = (await read('/api/kanban?archived=include')).cards.find((card) => card.id === synced.id);
  assert.deepEqual([restoredBackup.archived, restoredBackup.archivedAt, restoredBackup.source], [true, archived.archivedAt, 'ipm-sync']);

  const unarchived = await send(`/api/kanban/cards/${synced.id}`, 'PUT', { archived: false }).then((response) => response.json());
  assert.deepEqual([unarchived.archived, unarchived.archivedAt], [false, null]);
  assert.deepEqual(ids((await read('/api/kanban')).cards), [synced.id, manual.id]);
  assert.deepEqual((await archiveEvents()).sort(), ['card.archived', 'card.restored']);
});
