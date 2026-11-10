import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { freePort, startServer, stopServer } from './support/server-fixture.mjs';

test('GET /api/projects takes the table sort and filter parameters; linked cards name their column', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-table-api-'));
  const port = await freePort();
  const child = await startServer(dataDir, port, { AUTH_DISABLED: 'false', API_TOKEN: 'table-token' });
  t.after(async () => { await stopServer(child); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const send = (path, method = 'GET', body) => fetch(`${base}${path}`, {
    method,
    headers: { authorization: 'Bearer table-token', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((response) => response.json());
  await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'correct horse battery staple' }) });

  const make = (name, impact, status = 'Active') => send('/api/projects', 'POST', { name, impact, urgency: 5, confidence: 5, effort: 5, status, description: `${name} notes` });
  const alpha = await make('Alpha', 9);
  const bravo = await make('bravo', 4, 'Blocked');
  const charlie = await make('Charlie', 6);
  const names = (list) => list.map((project) => project.name);

  assert.deepEqual(names(await send('/api/projects?sort=name:asc')), ['Alpha', 'bravo', 'Charlie']);
  assert.deepEqual(names(await send('/api/projects?sort=impact:asc')), ['bravo', 'Charlie', 'Alpha']);
  assert.deepEqual(names(await send('/api/projects?f.impact=5..&sort=name:desc')), ['Charlie', 'Alpha']);
  assert.deepEqual(names(await send('/api/projects?f.status=Blocked&f.status=Complete')), ['bravo']);
  assert.deepEqual(names(await send('/api/projects?f.name=AR&sort=name:asc')), ['Charlie']);
  assert.deepEqual(names(await send('/api/projects?q=bravo%20notes')), ['bravo']);
  assert.equal((await send('/api/projects')).length, 3);
  assert.deepEqual(names(await send(`/api/projects?projectId=${encodeURIComponent('nope')}&sort=name:asc`)), []);

  const column = await send('/api/kanban/columns', 'POST', { name: 'Doing' });
  await send('/api/kanban/cards', 'POST', { columnId: column.id, projectId: alpha.id, title: 'Linked', assignee: 'sam' });
  const linked = await send(`/api/kanban/cards?projectId=${alpha.id}`);
  assert.deepEqual(linked.map((card) => [card.title, card.columnName, card.assignee]), [['Linked', 'Doing', 'sam']]);
  assert.deepEqual(await send(`/api/kanban/cards?projectId=${bravo.id}`), []);
  assert.ok(charlie.id);
});
