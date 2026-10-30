import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { freePort, startServer, stopServer } from './support/server-fixture.mjs';

test('API token manages projects and reads moves without opening other admin endpoints', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-projects-api-'));
  const port = await freePort();
  const child = await startServer(dataDir, port, { AUTH_DISABLED: 'false', API_TOKEN: '' });
  t.after(async () => { await stopServer(child); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const send = (path, method = 'GET', body, headers = {}) => fetch(`${base}${path}`, {
    method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const setup = await send('/api/auth/setup', 'POST', { username: 'owner', password: 'correct horse battery staple' });
  const adminCookie = setup.headers.get('set-cookie').split(';', 1)[0];
  const token = (await send('/api/api-token', 'POST', undefined, { cookie: adminCookie }).then((response) => response.json())).token;
  const bearer = { authorization: `Bearer ${token}` };

  const unauthenticated = await send('/api/projects');
  assert.equal(unauthenticated.status, 401);
  assert.match(unauthenticated.headers.get('www-authenticate'), /^Bearer/);
  assert.equal((await send('/api/projects', 'GET', undefined, { authorization: 'Bearer wrong' })).status, 401);

  const created = await send('/api/projects', 'POST', { name: 'Token project', impact: 4, urgency: 4, confidence: 5, effort: 5 }, bearer);
  assert.equal(created.status, 201);
  const project = await created.json();
  assert.deepEqual((await send('/api/projects', 'GET', undefined, bearer).then((response) => response.json())).map((item) => item.name), ['Token project']);
  const updated = await send(`/api/projects/${project.id}`, 'PUT', { impact: 7, moveComment: 'Updated by API' }, bearer);
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).impact, 7);
  const moves = await send(`/api/projects/${project.id}/moves`, 'GET', undefined, bearer);
  assert.equal(moves.status, 200);
  assert.deepEqual((await moves.json()).map((move) => [move.fromImpact, move.toImpact, move.comment]), [[4, 7, 'Updated by API']]);

  assert.equal((await send(`/api/projects/${project.id}/sessions`, 'POST', {}, bearer)).status, 401);
  assert.equal((await send('/api/planning-sessions', 'POST', { projectIds: [project.id] }, bearer)).status, 401);
  assert.equal((await send('/api/users', 'GET', undefined, bearer)).status, 401);

  await send('/api/users', 'POST', { username: 'viewer', password: 'read only password', role: 'read_only' }, { cookie: adminCookie });
  const login = await send('/api/auth/login', 'POST', { username: 'viewer', password: 'read only password' });
  const viewerCookie = login.headers.get('set-cookie').split(';', 1)[0];
  assert.equal((await send('/api/projects', 'GET', undefined, { cookie: viewerCookie })).status, 200);
  assert.equal((await send('/api/projects', 'POST', { name: 'Denied', impact: 1, urgency: 1, confidence: 5, effort: 5 }, { cookie: viewerCookie })).status, 403);

  await send('/api/api-token', 'POST', undefined, { cookie: adminCookie });
  assert.equal((await send('/api/projects', 'GET', undefined, bearer)).status, 401);
  assert.equal((await send(`/api/projects/${project.id}`, 'DELETE', undefined, bearer)).status, 401);
});
