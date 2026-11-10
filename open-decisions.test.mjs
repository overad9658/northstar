import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { freePort, startServer, stopServer } from './support/server-fixture.mjs';

test('projects list how many linked cards still have an open decision', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-open-decisions-'));
  const port = await freePort();
  const child = await startServer(dataDir, port, { AUTH_DISABLED: 'false', API_TOKEN: 'decisions-token' });
  t.after(async () => { await stopServer(child); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const send = (path, method = 'GET', body) => fetch(`${base}${path}`, {
    method,
    headers: { authorization: 'Bearer decisions-token', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((response) => response.json());
  await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'correct horse battery staple' }) });

  const project = await send('/api/projects', 'POST', { name: 'Decisions', impact: 5, urgency: 5, confidence: 5, effort: 5 });
  const other = await send('/api/projects', 'POST', { name: 'Quiet', impact: 4, urgency: 4, confidence: 5, effort: 5 });
  const column = await send('/api/kanban/columns', 'POST', { name: 'Doing' });
  const decision = { options: ['Ship', 'Wait'] };
  await send('/api/kanban/cards', 'POST', { columnId: column.id, projectId: project.id, title: 'Open one', decision });
  await send('/api/kanban/cards', 'POST', { columnId: column.id, projectId: project.id, title: 'Open two', decision });
  await send('/api/kanban/cards', 'POST', { columnId: column.id, projectId: project.id, title: 'No decision' });
  const decided = await send('/api/kanban/cards', 'POST', { columnId: column.id, projectId: project.id, title: 'Decided', decision });
  await send(`/api/kanban/cards/${decided.id}`, 'PUT', { decision: { ...decision, decidedOption: 'Ship' } });
  const archived = await send('/api/kanban/cards', 'POST', { columnId: column.id, projectId: project.id, title: 'Archived', decision });
  await send(`/api/kanban/cards/${archived.id}`, 'PUT', { archived: true });

  const listed = new Map((await send('/api/projects')).map((item) => [item.id, item]));
  assert.equal(listed.get(project.id).openDecisionCount, 2);
  assert.equal(listed.get(project.id).cardCount, 5);
  assert.equal(listed.get(other.id).openDecisionCount, 0);
});
