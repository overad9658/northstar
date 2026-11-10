import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { freePort, startServer, stopServer } from './support/server-fixture.mjs';

test('saved views are per user, canonical, and reachable with a session or a user-created token', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-views-'));
  const port = await freePort();
  const child = await startServer(dataDir, port, { AUTH_DISABLED: 'false', API_TOKEN: 'shared-env-token' });
  t.after(async () => { await stopServer(child); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const send = (path, method = 'GET', body, headers = {}) => fetch(`${base}${path}`, {
    method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = async (response) => ({ status: response.status, body: response.status === 204 ? null : await response.json() });

  const setup = await send('/api/auth/setup', 'POST', { username: 'owner', password: 'correct horse battery staple' });
  const owner = { cookie: setup.headers.get('set-cookie').split(';', 1)[0] };
  await send('/api/users', 'POST', { username: 'viewer', password: 'read only password', role: 'read_only' }, owner);
  const login = await send('/api/auth/login', 'POST', { username: 'viewer', password: 'read only password' });
  const viewer = { cookie: login.headers.get('set-cookie').split(';', 1)[0] };

  const created = await json(await send('/api/views', 'POST', { name: 'Blocked work', params: '?f.status=Blocked&bogus=1&f.nope=x&sort=score:desc' }, owner));
  assert.equal(created.status, 201);
  assert.equal(created.body.params, 'sort=score%3Adesc&f.status=Blocked');
  assert.deepEqual(created.body.state.filters, { status: { in: ['Blocked'] } });
  const fromState = await json(await send('/api/views', 'POST', { name: 'Design', params: { filters: { team: { in: ['Design'] } }, columns: ['name', 'score'] } }, owner));
  assert.equal(fromState.body.params, 'cols=name%2Cscore&f.team=Design');
  assert.equal((await send('/api/views', 'POST', { name: 'blocked WORK' }, owner)).status, 409);
  assert.equal((await send('/api/views', 'POST', { name: '  ' }, owner)).status, 400);

  // Each person sees only their own views; a read-only person may keep views too.
  assert.deepEqual((await json(await send('/api/views', 'GET', undefined, viewer))).body, []);
  assert.equal((await send(`/api/views/${created.body.id}`, 'GET', undefined, viewer)).status, 404);
  assert.equal((await send(`/api/views/${created.body.id}`, 'DELETE', undefined, viewer)).status, 404);
  assert.equal((await send('/api/views', 'POST', { name: 'Mine' }, viewer)).status, 201);

  const renamed = await json(await send(`/api/views/${created.body.id}`, 'PUT', { name: 'Stuck' }, owner));
  assert.equal(renamed.body.name, 'Stuck');
  assert.equal(renamed.body.params, created.body.params);
  assert.equal((await send(`/api/views/${created.body.id}`, 'PUT', { name: 'design' }, owner)).status, 409);

  // A token acts for the user who created it; read tokens may only read.
  const readToken = (await json(await send('/api/api-tokens', 'POST', { name: 'Reader', scope: 'read' }, owner))).body.token;
  const reader = { authorization: `Bearer ${readToken}` };
  assert.deepEqual((await json(await send('/api/views', 'GET', undefined, reader))).body.map((view) => view.name), ['Design', 'Stuck']);
  assert.equal((await send('/api/views', 'POST', { name: 'Nope' }, reader)).status, 403);
  const writeToken = (await json(await send('/api/api-tokens', 'POST', { name: 'Writer', scope: 'write' }, owner))).body.token;
  const writer = { authorization: `Bearer ${writeToken}` };
  assert.equal((await send('/api/views', 'POST', { name: 'By token', params: 'sort=name:asc' }, writer)).status, 201);
  assert.equal((await send(`/api/views/${fromState.body.id}`, 'DELETE', undefined, writer)).status, 204);
  assert.deepEqual((await json(await send('/api/views', 'GET', undefined, owner))).body.map((view) => view.name), ['By token', 'Stuck']);

  // The shared environment token belongs to nobody, so it has no views.
  assert.equal((await send('/api/views', 'GET', undefined, { authorization: 'Bearer shared-env-token' })).status, 400);
  assert.equal((await send('/api/views')).status, 401);

  // The token generated from the admin page acts for the admin who generated it.
  const generated = (await json(await send('/api/api-token', 'POST', undefined, owner))).body.token;
  const legacy = { authorization: `Bearer ${generated}` };
  assert.equal((await json(await send('/api/token/self', 'GET', undefined, legacy))).body.createdBy.username, 'owner');
  assert.deepEqual((await json(await send('/api/views', 'GET', undefined, legacy))).body.map((view) => view.name), ['By token', 'Stuck']);
  assert.equal((await send('/api/views', 'POST', { name: 'Legacy made' }, legacy)).status, 201);
});
