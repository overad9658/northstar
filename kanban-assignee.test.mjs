import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { freePort, startServer, stopServer } from './support/server-fixture.mjs';

test('kanban cards carry an optional assignee through updates and backups', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-kanban-assignee-'));
  const port = await freePort();
  const child = await startServer(dataDir, port);
  t.after(async () => { await stopServer(child); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const request = (path, method = 'GET', body) => fetch(`${base}${path}`, {
    method, headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  assert.equal((await request('/kanban.html').then((response) => response.text())).includes('id="assignee-filter"'), true);
  const column = await (await request('/api/kanban/columns', 'POST', { name: 'To do' })).json();
  const unassigned = await (await request('/api/kanban/cards', 'POST', { columnId: column.id, title: 'Triage inbox' })).json();
  assert.equal(unassigned.assignee, '');
  const assigned = await (await request('/api/kanban/cards', 'POST', { columnId: column.id, title: 'Write release notes', assignee: '  Alex  ' })).json();
  assert.equal(assigned.assignee, 'Alex');
  assert.equal((await request('/api/kanban/cards', 'POST', { columnId: column.id, title: 'Too long', assignee: 'x'.repeat(81) })).status, 400);

  let board = await (await request('/api/kanban')).json();
  assert.deepEqual(board.cards.map((card) => [card.title, card.assignee]), [['Triage inbox', ''], ['Write release notes', 'Alex']]);
  assert.equal((await (await request(`/api/kanban/cards/${unassigned.id}`, 'PUT', { assignee: 'Sam' })).json()).assignee, 'Sam');
  assert.equal((await (await request(`/api/kanban/cards/${unassigned.id}`, 'PUT', { title: 'Triage the inbox' })).json()).assignee, 'Sam');
  assert.equal((await (await request(`/api/kanban/cards/${assigned.id}`, 'PUT', { assignee: '' })).json()).assignee, '');

  const backup = await (await request('/api/backup')).json();
  assert.deepEqual(backup.kanbanCards.map((card) => card.assignee), ['Sam', '']);
  assert.equal((await request(`/api/kanban/cards/${unassigned.id}`, 'PUT', { assignee: 'Changed' })).status, 200);
  assert.equal((await request('/api/backup', 'POST', backup)).status, 200);
  board = await (await request('/api/kanban')).json();
  assert.equal(board.cards.find((card) => card.id === unassigned.id).assignee, 'Sam');

  const olderBackup = { ...backup, kanbanCards: backup.kanbanCards.map(({ assignee, ...card }) => card) };
  assert.equal((await request('/api/backup', 'POST', olderBackup)).status, 200);
  board = await (await request('/api/kanban')).json();
  assert.deepEqual(board.cards.map((card) => card.assignee), ['', '']);
});
