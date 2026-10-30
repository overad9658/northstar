import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { freePort, startServer, stopServer } from './support/server-fixture.mjs';

test('activity feed lists recent project and card events, newest first, respecting visibility', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-activity-'));
  const port = await freePort();
  const child = await startServer(dataDir, port, { AUTH_DISABLED: 'false', API_TOKEN: '' });
  t.after(async () => { await stopServer(child); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const send = (path, method = 'GET', body, headers = {}) => fetch(`${base}${path}`, {
    method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const read = (path, headers) => send(path, 'GET', undefined, headers).then((response) => response.json());

  const setup = await send('/api/auth/setup', 'POST', { username: 'owner', password: 'correct horse battery staple' });
  const cookie = { cookie: setup.headers.get('set-cookie').split(';', 1)[0] };
  const visible = await send('/api/projects', 'POST', { projectId: 'ACT-1', name: 'Visible', impact: 4, urgency: 4, confidence: 5, effort: 5 }, cookie).then((response) => response.json());
  const hidden = await send('/api/projects', 'POST', { name: 'Hidden', hiddenFromReadOnly: true, impact: 3, urgency: 3, confidence: 5, effort: 5 }, cookie).then((response) => response.json());
  await send(`/api/projects/${visible.id}`, 'PUT', { impact: 5, moveComment: 'Raised' }, cookie);
  const todo = await send('/api/kanban/columns', 'POST', { name: 'To do' }, cookie).then((response) => response.json());
  const done = await send('/api/kanban/columns', 'POST', { name: 'Done' }, cookie).then((response) => response.json());
  const card = await send('/api/kanban/cards', 'POST', { columnId: todo.id, projectId: visible.id, title: 'Ship it' }, cookie).then((response) => response.json());
  await send(`/api/kanban/cards/${card.id}`, 'PUT', { columnId: done.id }, cookie);
  await send(`/api/kanban/cards/${card.id}/notes`, 'POST', { body: 'Shipped' }, cookie);
  await send('/api/kanban/cards', 'POST', { columnId: todo.id, projectId: hidden.id, title: 'Secret card' }, cookie);

  assert.equal((await send('/api/activity')).status, 401);
  const response = await send('/api/activity', 'GET', undefined, cookie);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const { items } = await response.json();
  assert.deepEqual([...new Set(items.map((item) => item.type))].sort(), ['card.created', 'card.moved', 'card.note', 'project.created', 'project.moved']);
  assert.equal(new Set(items.map((item) => item.id)).size, items.length);
  assert.deepEqual(items.map((item) => item.at), items.map((item) => item.at).sort().reverse());
  assert.ok(items.every((item) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item.at)));
  const move = items.find((item) => item.type === 'project.moved');
  assert.deepEqual([move.projectId, move.projectCode, move.from, move.to, move.comment], [visible.id, 'ACT-1', { impact: 4, urgency: 4 }, { impact: 5, urgency: 4 }, 'Raised']);
  assert.deepEqual(items.filter((item) => item.cardId === card.id).map((item) => item.type).sort(), ['card.created', 'card.moved', 'card.note']);
  assert.equal(items.find((item) => item.type === 'card.moved').columnName, 'Done');
  assert.ok(items.some((item) => item.projectId === hidden.id));

  const reader = await send('/api/api-tokens', 'POST', { name: 'Feed reader', scope: 'read' }, cookie).then((response) => response.json());
  const bearer = { authorization: `Bearer ${reader.token}` };
  const readerItems = (await read('/api/activity', bearer)).items;
  assert.ok(readerItems.length > 0);
  assert.ok(readerItems.every((item) => item.projectId !== hidden.id));
  assert.equal((await send('/api/activity', 'POST', {}, bearer)).status, 403);

  assert.equal((await read('/api/activity?limit=2', cookie)).items.length, 2);
  const since = items[0].at;
  const recent = (await read(`/api/activity?since=${encodeURIComponent(since)}`, cookie)).items;
  assert.ok(recent.some((item) => item.id === items[0].id));
  assert.ok(recent.every((item) => item.at >= `${since.slice(0, 19)}.000Z`));
  assert.deepEqual((await read('/api/activity?since=2999-01-01T00:00:00Z', cookie)).items, []);
  assert.equal((await send('/api/activity?since=yesterday', 'GET', undefined, cookie)).status, 400);
  assert.equal((await send('/api/activity?limit=0', 'GET', undefined, cookie)).status, 400);
  assert.equal((await send('/api/activity?limit=501', 'GET', undefined, cookie)).status, 400);
});

test('activity feed includes planning decisions', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-activity-planning-'));
  const port = await freePort();
  const child = await startServer(dataDir, port);
  t.after(async () => { await stopServer(child); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const project = await post('/api/projects', { projectId: 'PLAN-1', name: 'Planned', impact: 4, urgency: 4, confidence: 5, effort: 5 }).then((response) => response.json());
  const room = await post('/api/planning-sessions', { projectIds: [project.id] }).then((response) => response.json());
  assert.equal((await post(`/api/sessions/${room.token}/reveal`, { leaderKey: room.leaderKey, projectId: project.id })).status, 200);
  const decided = await post(`/api/sessions/${room.token}/decide`, { leaderKey: room.leaderKey, projectId: project.id, impact: 7, urgency: 6, confidence: 5, effort: 4, moveComment: 'Agreed in planning' });
  assert.equal(decided.status, 200);

  const { items } = await fetch(`${base}/api/activity`).then((response) => response.json());
  const decision = items.find((item) => item.type === 'planning.decided');
  assert.ok(decision, 'planning decision is listed');
  assert.match(decision.id, new RegExp(`^planning\\.decided:\\d+:${project.id}$`));
  assert.deepEqual([decision.projectId, decision.projectCode, decision.scores, decision.comment],
    [project.id, 'PLAN-1', { impact: 7, urgency: 6, confidence: 5, effort: 4 }, 'Agreed in planning']);
  assert.match(decision.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
});
