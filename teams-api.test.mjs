import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { freePort, startServer, stopServer } from './support/server-fixture.mjs';

test('API tokens manage teams and capacity; read tokens only read them', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-teams-api-'));
  const port = await freePort();
  const child = await startServer(dataDir, port, { AUTH_DISABLED: 'false', API_TOKEN: 'teams-token' });
  t.after(async () => { await stopServer(child); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const send = (path, method = 'GET', body, headers = {}) => fetch(`${base}${path}`, {
    method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const writer = { authorization: 'Bearer teams-token' };

  const setup = await send('/api/auth/setup', 'POST', { username: 'owner', password: 'correct horse battery staple' });
  const cookie = { cookie: setup.headers.get('set-cookie').split(';', 1)[0] };
  const reader = { authorization: `Bearer ${(await send('/api/api-tokens', 'POST', { name: 'Reader', scope: 'read' }, cookie).then((response) => response.json())).token}` };

  const unauthenticated = await send('/api/teams');
  assert.equal(unauthenticated.status, 401);
  assert.match(unauthenticated.headers.get('www-authenticate'), /^Bearer/);
  assert.equal((await send('/api/teams', 'GET', undefined, { authorization: 'Bearer wrong' })).status, 401);

  const created = await send('/api/teams', 'POST', { name: 'Sync team', capacity: 4 }, writer);
  assert.equal(created.status, 201);
  const team = await created.json();
  const updated = await send(`/api/teams/${team.id}`, 'PUT', { name: 'Sync team', capacity: 6 }, writer);
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).capacity, 6);
  assert.ok((await send('/api/teams', 'GET', undefined, reader).then((response) => response.json())).some((item) => item.name === 'Sync team'));

  const capacity = await send('/api/capacity', 'GET', undefined, reader);
  assert.equal(capacity.status, 200);
  const before = await capacity.json();
  const set = await send('/api/capacity', 'PUT', { total: before.occupied + 10 }, writer);
  assert.equal(set.status, 200);
  assert.equal((await send('/api/capacity', 'GET', undefined, writer).then((response) => response.json())).total, before.occupied + 10);

  assert.equal((await send('/api/teams', 'POST', { name: 'Denied', capacity: 1 }, reader)).status, 403);
  assert.equal((await send(`/api/teams/${team.id}`, 'PUT', { capacity: 1 }, reader)).status, 403);
  assert.equal((await send(`/api/teams/${team.id}`, 'DELETE', undefined, reader)).status, 403);
  assert.equal((await send('/api/capacity', 'PUT', { total: 0 }, reader)).status, 403);

  const spare = await send('/api/teams', 'POST', { name: 'Spare', capacity: 0 }, writer).then((response) => response.json());
  assert.equal((await send(`/api/teams/${spare.id}`, 'DELETE', undefined, writer)).status, 204);
  assert.equal((await send('/api/users', 'GET', undefined, writer)).status, 401);
  assert.equal((await send('/api/planning-sessions', 'POST', { projectIds: [] }, writer)).status, 401);
});
