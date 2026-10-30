import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { freePort, startServer, stopServer } from './support/server-fixture.mjs';

test('project and card change history survives a backup round-trip', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-backup-history-'));
  const port = await freePort();
  const child = await startServer(dataDir, port);
  t.after(async () => { await stopServer(child); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const send = (path, method = 'GET', body) => fetch(`${base}${path}`, {
    method, headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const read = (path) => send(path).then((response) => response.json());
  const changeEvents = async () => (await read('/api/activity?limit=500')).items
    .filter((item) => ['project.status', 'card.assigned'].includes(item.type))
    .map(({ id, type, at, from, to, note }) => ({ id, type, at, from, to, note }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const project = await send('/api/projects', 'POST', { name: 'Kept', status: 'Active', impact: 4, urgency: 4, confidence: 5, effort: 5 }).then((response) => response.json());
  assert.equal((await send(`/api/projects/${project.id}`, 'PUT', { status: 'Blocked', blockedNote: 'Waiting on access' })).status, 200);
  const column = await send('/api/kanban/columns', 'POST', { name: 'To do' }).then((response) => response.json());
  const card = await send('/api/kanban/cards', 'POST', { columnId: column.id, title: 'Kept card' }).then((response) => response.json());
  assert.equal((await send(`/api/kanban/cards/${card.id}`, 'PUT', { assignee: 'Sam' })).status, 200);

  const before = await changeEvents();
  assert.deepEqual(before.map((item) => item.type).sort(), ['card.assigned', 'project.status']);

  const backup = await read('/api/backup');
  assert.equal(backup.projectChanges.length, 1);
  assert.equal(backup.cardChanges.length, 1);
  assert.equal((await send('/api/backup', 'POST', backup)).status, 200);
  assert.deepEqual(await changeEvents(), before);

  const { projectChanges, cardChanges, ...olderBackup } = backup;
  assert.equal((await send('/api/backup', 'POST', olderBackup)).status, 200);
  assert.deepEqual(await changeEvents(), []);
  assert.equal((await send('/api/backup', 'POST', { ...backup, cardChanges: 'nope' })).status, 400);
});
