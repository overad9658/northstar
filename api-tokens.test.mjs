import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { freePort, startServer, stopServer } from './support/server-fixture.mjs';

test('named API tokens are scoped, revocable, hashed, and track last use', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-api-tokens-'));
  const port = await freePort();
  const child = await startServer(dataDir, port, { AUTH_DISABLED: 'false', API_TOKEN: 'legacy-token' });
  let stopped = false;
  t.after(async () => { if (!stopped) await stopServer(child); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const send = (path, method = 'GET', body, headers = {}) => fetch(`${base}${path}`, {
    method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const setup = await send('/api/auth/setup', 'POST', { username: 'owner', password: 'correct horse battery staple' });
  const cookie = { cookie: setup.headers.get('set-cookie').split(';', 1)[0] };

  assert.equal((await send('/api/api-tokens')).status, 401);
  assert.equal((await send('/api/api-tokens', 'POST', { name: 'Reader', scope: 'read' })).status, 401);
  assert.equal((await send('/api/api-tokens', 'POST', { name: '', scope: 'read' }, cookie)).status, 400);
  assert.equal((await send('/api/api-tokens', 'POST', { name: 'Admin', scope: 'admin' }, cookie)).status, 400);

  const readResponse = await send('/api/api-tokens', 'POST', { name: 'Reader', scope: 'read' }, cookie);
  assert.equal(readResponse.status, 201);
  assert.equal(readResponse.headers.get('cache-control'), 'no-store');
  const reader = await readResponse.json();
  assert.match(reader.token, /^northstar_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual([reader.name, reader.scope, reader.lastUsedAt, reader.revokedAt], ['Reader', 'read', null, null]);
  const writer = await send('/api/api-tokens', 'POST', { name: 'Writer', scope: 'write' }, cookie).then((response) => response.json());
  const readBearer = { authorization: `Bearer ${reader.token}` };
  const writeBearer = { authorization: `Bearer ${writer.token}` };

  const created = await send('/api/projects', 'POST', { name: 'Named token project', impact: 4, urgency: 4, confidence: 5, effort: 5 }, writeBearer);
  assert.equal(created.status, 201);
  const project = await created.json();
  assert.deepEqual((await send('/api/projects', 'GET', undefined, readBearer).then((response) => response.json())).map((item) => item.name), ['Named token project']);
  assert.equal((await send('/api/kanban', 'GET', undefined, readBearer)).status, 200);

  const readWrite = await send(`/api/projects/${project.id}`, 'PUT', { impact: 7 }, readBearer);
  assert.equal(readWrite.status, 403);
  assert.match((await readWrite.json()).error, /read-only/);
  for (const [path, method, body] of [
    ['/api/projects', 'POST', { name: 'Denied', impact: 1, urgency: 1, confidence: 5, effort: 5 }],
    [`/api/projects/${project.id}`, 'PUT', { impact: 1 }],
    [`/api/projects/${project.id}`, 'DELETE', undefined],
    ['/api/kanban/columns', 'POST', { name: 'Denied' }],
    ['/api/kanban/cards', 'POST', { title: 'Denied' }],
    ['/api/kanban/cards/1', 'PUT', { title: 'Denied' }],
    ['/api/kanban/cards/1', 'DELETE', undefined],
  ]) assert.equal((await send(path, method, body, readBearer)).status, 403, `${method} ${path}`);
  assert.equal((await send('/api/projects', 'GET', undefined, readBearer).then((response) => response.json())).length, 1);
  assert.equal((await send('/api/projects/bulk/archive', 'POST', { projectIds: [project.id] }, readBearer)).status, 401);
  const legacyAdd = await send('/api/projects/bulk/add', 'POST', { projects: [{ name: 'Legacy token project', impact: 2, urgency: 2, confidence: 5, effort: 5 }] }, { authorization: 'Bearer legacy-token' });
  assert.equal(legacyAdd.status, 201);

  // Token administration needs a browser session; no token is accepted there, whatever its scope.
  for (const bearer of [readBearer, writeBearer]) {
    assert.equal((await send('/api/api-tokens', 'GET', undefined, bearer)).status, 401);
    assert.equal((await send('/api/api-tokens', 'POST', { name: 'Escalate', scope: 'write' }, bearer)).status, 401);
    assert.equal((await send(`/api/api-tokens/${reader.id}`, 'DELETE', undefined, bearer)).status, 401);
  }
  assert.equal((await send('/api/users', 'GET', undefined, writeBearer)).status, 401);

  const listed = await send('/api/api-tokens', 'GET', undefined, cookie).then((response) => response.json());
  assert.deepEqual(listed.map(({ name, scope }) => [name, scope]), [['Reader', 'read'], ['Writer', 'write']]);
  assert.ok(listed.every((item) => item.lastUsedAt));
  assert.ok(listed.every((item) => !('token' in item) && !('tokenHash' in item) && !('token_hash' in item)));

  assert.equal((await send(`/api/api-tokens/${writer.id}`, 'DELETE', undefined, cookie)).status, 204);
  assert.equal((await send(`/api/api-tokens/${writer.id}`, 'DELETE', undefined, cookie)).status, 404);
  assert.equal((await send('/api/projects', 'GET', undefined, writeBearer)).status, 401);
  assert.equal((await send('/api/projects', 'GET', undefined, readBearer)).status, 200);
  assert.equal((await send(`/api/api-tokens/${reader.id}`, 'DELETE', undefined, cookie)).status, 204);
  assert.equal((await send('/api/projects', 'GET', undefined, readBearer)).status, 401);
  const revoked = await send('/api/api-tokens', 'GET', undefined, cookie).then((response) => response.json());
  assert.match(revoked.find((item) => item.id === writer.id).revokedAt, /^\d{4}-\d{2}-\d{2}/);

  await stopServer(child);
  stopped = true;
  const inspectionDb = new DatabaseSync(join(dataDir, 'northstar.db'));
  const hashes = inspectionDb.prepare('SELECT token_hash AS hash FROM api_tokens ORDER BY id').all().map((row) => row.hash);
  inspectionDb.close();
  assert.equal(hashes.length, 2);
  assert.ok(hashes.every((hash) => /^[a-f0-9]{64}$/.test(hash)));
  assert.ok(!hashes.includes(reader.token) && !hashes.includes(writer.token));
});

test('a named write token enables the bulk API without API_TOKEN', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-api-tokens-bulk-'));
  const port = await freePort();
  const child = await startServer(dataDir, port, { API_TOKEN: '' });
  t.after(async () => { await stopServer(child); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const add = (headers = {}) => fetch(`${base}/api/projects/bulk/add`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ projects: [{ name: 'Bulk via named token', impact: 2, urgency: 2, confidence: 5, effort: 5 }] }),
  });

  assert.equal((await add()).status, 503);
  const reader = await fetch(`${base}/api/api-tokens`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"Reader","scope":"read"}' }).then((response) => response.json());
  assert.equal((await add({ authorization: `Bearer ${reader.token}` })).status, 503);
  const writer = await fetch(`${base}/api/api-tokens`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"Writer","scope":"write"}' }).then((response) => response.json());
  assert.equal((await add({ authorization: `Bearer ${reader.token}` })).status, 401);
  assert.equal((await add({ authorization: `Bearer ${writer.token}` })).status, 201);
});
