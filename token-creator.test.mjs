import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { freePort, startServer, stopServer } from './support/server-fixture.mjs';

test('tokens record who issued them and can describe themselves', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-token-creator-'));
  const port = await freePort();
  const child = await startServer(dataDir, port, { AUTH_DISABLED: 'false', API_TOKEN: 'legacy-env-token' });
  t.after(async () => { await stopServer(child); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const send = (path, method = 'GET', body, headers = {}) => fetch(`${base}${path}`, {
    method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const bearer = (token) => ({ authorization: `Bearer ${token}` });
  const self = (headers) => send('/api/token/self', 'GET', undefined, headers);

  const setup = await send('/api/auth/setup', 'POST', { username: 'owner', password: 'correct horse battery staple' });
  const owner = { cookie: setup.headers.get('set-cookie').split(';', 1)[0] };
  const ops = await send('/api/users', 'POST', { username: 'ops', password: 'ops admin password 123', role: 'admin' }, owner).then((response) => response.json());
  const opsLogin = await send('/api/auth/login', 'POST', { username: 'ops', password: 'ops admin password 123' });
  const opsCookie = { cookie: opsLogin.headers.get('set-cookie').split(';', 1)[0] };

  const reader = await send('/api/api-tokens', 'POST', { name: 'Reader', scope: 'read' }, opsCookie).then((response) => response.json());
  const writer = await send('/api/api-tokens', 'POST', { name: 'Writer', scope: 'write' }, opsCookie).then((response) => response.json());
  assert.deepEqual(reader.createdBy, { id: ops.id, username: 'ops' });
  const listed = await send('/api/api-tokens', 'GET', undefined, owner).then((response) => response.json());
  assert.deepEqual(listed.map(({ name, createdBy }) => [name, createdBy]), [['Reader', { id: ops.id, username: 'ops' }], ['Writer', { id: ops.id, username: 'ops' }]]);

  const readSelf = await self(bearer(reader.token));
  assert.equal(readSelf.status, 200);
  assert.equal(readSelf.headers.get('cache-control'), 'no-store');
  const readBody = await readSelf.text();
  assert.doesNotMatch(readBody, /hash|northstar_/i);
  assert.deepEqual(JSON.parse(readBody), { name: 'Reader', scope: 'read', createdBy: { id: ops.id, username: 'ops' } });
  assert.deepEqual(await self(bearer(writer.token)).then((response) => response.json()), { name: 'Writer', scope: 'write', createdBy: { id: ops.id, username: 'ops' } });
  assert.deepEqual(await self(bearer('legacy-env-token')).then((response) => response.json()), { name: 'API token', scope: 'write', createdBy: null });

  assert.equal((await self()).status, 401);
  assert.equal((await self(owner)).status, 401);
  assert.equal((await self(bearer('wrong'))).status, 401);
  assert.equal((await send('/api/token/self', 'POST', {}, bearer(writer.token))).status, 405);

  assert.equal((await send(`/api/api-tokens/${reader.id}`, 'DELETE', undefined, owner)).status, 204);
  assert.equal((await self(bearer(reader.token))).status, 401);

  assert.equal((await send(`/api/users/${ops.id}`, 'DELETE', undefined, owner)).status, 204);
  assert.deepEqual(await self(bearer(writer.token)).then((response) => response.json()), { name: 'Writer', scope: 'write', createdBy: null });
  const afterDelete = await send('/api/api-tokens', 'GET', undefined, owner).then((response) => response.json());
  assert.ok(afterDelete.every((token) => token.createdBy === null));

  const ownerToken = await send('/api/api-tokens', 'POST', { name: 'Owner token', scope: 'read' }, owner).then((response) => response.json());
  assert.equal(ownerToken.createdBy.username, 'owner');
});
