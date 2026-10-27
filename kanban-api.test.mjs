import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startServer, stopServer } from './support/server-fixture.mjs';

test('remote Kanban API uses revocable bearer tokens without broadening admin access', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-kanban-api-'));
  const port = 37000 + (process.pid % 1000);
  const child = await startServer(dataDir, port, { AUTH_DISABLED: 'false', API_TOKEN: '' });
  t.after(async () => { await stopServer(child); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const send = (path, method = 'GET', body, headers = {}) => fetch(`${base}${path}`, {
    method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const setup = await send('/api/auth/setup', 'POST', { username: 'owner', password: 'correct horse battery staple' });
  assert.equal(setup.status, 201);
  const adminCookie = setup.headers.get('set-cookie').split(';', 1)[0];
  const project = await (await send('/api/projects', 'POST', { name: 'Release', impact: 4, urgency: 4, confidence: 5, effort: 5 }, { cookie: adminCookie })).json();
  const issued = await send('/api/api-token', 'POST', undefined, { cookie: adminCookie });
  assert.equal(issued.status, 201);
  const token = (await issued.json()).token;
  const bearer = { authorization: `Bearer ${token}` };

  const unauthenticated = await send('/api/kanban');
  assert.equal(unauthenticated.status, 401);
  assert.match(unauthenticated.headers.get('www-authenticate'), /^Bearer/);
  assert.equal((await send('/api/kanban', 'GET', undefined, { authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await send('/api/kanban', 'GET', undefined, bearer)).status, 200);
  assert.equal((await send('/api/kanban/projects', 'GET', undefined, bearer).then((response) => response.json()))[0].id, project.id);
  assert.equal((await send('/api/projects', 'GET', undefined, bearer)).status, 401);
  assert.equal((await send('/api/backup', 'GET', undefined, bearer)).status, 401);
  assert.equal((await send('/api/api-token', 'GET', undefined, bearer)).status, 401);

  const columnResponse = await send('/api/kanban/columns', 'POST', { name: 'To do' }, bearer);
  assert.equal(columnResponse.status, 201);
  const column = await columnResponse.json();
  const nextColumn = await (await send('/api/kanban/columns', 'POST', { name: 'Done' }, bearer)).json();
  const cardResponse = await send('/api/kanban/cards', 'POST', { columnId: column.id, title: 'Prepare release', projectId: project.id, tags: ['release'] }, bearer);
  assert.equal(cardResponse.status, 201);
  const card = await cardResponse.json();
  assert.deepEqual((await send(`/api/kanban/cards/${card.id}`, 'GET', undefined, bearer).then((response) => response.json())).tags, ['release']);
  const note = await (await send(`/api/kanban/cards/${card.id}/notes`, 'POST', { body: 'Check approval' }, bearer)).json();
  assert.equal((await send(`/api/kanban/cards/${card.id}/notes`, 'GET', undefined, bearer).then((response) => response.json())).length, 1);
  assert.equal((await send(`/api/kanban/cards/${card.id}`, 'PUT', { columnId: nextColumn.id }, bearer)).status, 200);
  assert.equal((await send(`/api/kanban/cards/${card.id}/history`, 'GET', undefined, bearer).then((response) => response.json())).entries.length, 2);
  assert.equal((await send('/api/kanban/report', 'GET', undefined, bearer).then((response) => response.json())).rows.length, 2);

  const viewer = await send('/api/users', 'POST', { username: 'viewer', password: 'read only password', role: 'read_only' }, { cookie: adminCookie });
  assert.equal(viewer.status, 201);
  const login = await send('/api/auth/login', 'POST', { username: 'viewer', password: 'read only password' });
  const viewerCookie = login.headers.get('set-cookie').split(';', 1)[0];
  assert.equal((await send('/api/kanban', 'GET', undefined, { cookie: viewerCookie })).status, 200);
  assert.equal((await send('/api/kanban/columns', 'POST', { name: 'Denied' }, { cookie: viewerCookie })).status, 403);

  const replacement = (await send('/api/api-token', 'POST', undefined, { cookie: adminCookie }).then((response) => response.json())).token;
  assert.equal((await send('/api/kanban', 'GET', undefined, bearer)).status, 401);
  const newBearer = { authorization: `Bearer ${replacement}` };
  assert.equal((await send(`/api/kanban/cards/${card.id}/notes/${note.id}`, 'DELETE', undefined, newBearer)).status, 204);
  assert.equal((await send(`/api/kanban/cards/${card.id}`, 'DELETE', undefined, newBearer)).status, 204);
  assert.equal((await send(`/api/kanban/columns/${column.id}`, 'DELETE', undefined, newBearer)).status, 204);
});
