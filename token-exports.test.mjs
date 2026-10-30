import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { freePort, startServer, stopServer } from './support/server-fixture.mjs';

test('write tokens download backups, read tokens export status without hidden projects, restore stays session-only', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-token-exports-'));
  const port = await freePort();
  const child = await startServer(dataDir, port, { AUTH_DISABLED: 'false', API_TOKEN: 'legacy-token' });
  t.after(async () => { await stopServer(child); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const send = (path, method = 'GET', body, headers = {}) => fetch(`${base}${path}`, {
    method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const setup = await send('/api/auth/setup', 'POST', { username: 'owner', password: 'correct horse battery staple' });
  const cookie = { cookie: setup.headers.get('set-cookie').split(';', 1)[0] };
  const reader = await send('/api/api-tokens', 'POST', { name: 'Backup job', scope: 'read' }, cookie).then((response) => response.json());
  const writer = await send('/api/api-tokens', 'POST', { name: 'Writer', scope: 'write' }, cookie).then((response) => response.json());
  assert.equal((await send('/api/projects', 'POST', { name: 'Exported project', impact: 4, urgency: 4, confidence: 5, effort: 5 }, cookie)).status, 201);
  assert.equal((await send('/api/projects', 'POST', { name: 'Hidden project', impact: 3, urgency: 3, confidence: 5, effort: 5, hiddenFromReadOnly: true }, cookie)).status, 201);

  for (const token of [writer.token, 'legacy-token']) {
    const bearer = { authorization: `Bearer ${token}` };
    const backup = await send('/api/backup', 'GET', undefined, bearer);
    assert.equal(backup.status, 200);
    assert.equal(backup.headers.get('cache-control'), 'no-store');
    assert.deepEqual((await backup.json()).projects.map((project) => project.name), ['Exported project', 'Hidden project']);
    const csv = await send('/api/status-export', 'GET', undefined, bearer);
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /^text\/csv/);
    const text = await csv.text();
    assert.match(text, /Exported project/);
    assert.match(text, /Hidden project/);
  }

  const readBearer = { authorization: `Bearer ${reader.token}` };
  const readBackup = await send('/api/backup', 'GET', undefined, readBearer);
  assert.equal(readBackup.status, 403);
  assert.match((await readBackup.json()).error, /read-only/);
  const readCsv = await send('/api/status-export', 'GET', undefined, readBearer);
  assert.equal(readCsv.status, 200);
  const readText = await readCsv.text();
  assert.match(readText, /Exported project/);
  assert.doesNotMatch(readText, /Hidden project/);

  const backup = await send('/api/backup', 'GET', undefined, cookie).then((response) => response.json());
  for (const bearer of [readBearer, { authorization: `Bearer ${writer.token}` }, { authorization: 'Bearer legacy-token' }]) {
    assert.equal((await send('/api/backup', 'POST', backup, bearer)).status, 401);
  }
  assert.equal((await send('/api/status-export', 'POST', {}, readBearer)).status, 401);

  const anonymous = await send('/api/backup');
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get('www-authenticate'), /^Bearer /);
  assert.equal((await send('/api/status-export', 'GET', undefined, { authorization: 'Bearer wrong' })).status, 401);

  assert.equal((await send(`/api/api-tokens/${reader.id}`, 'DELETE', undefined, cookie)).status, 204);
  assert.equal((await send('/api/status-export', 'GET', undefined, readBearer)).status, 401);

  assert.equal((await send('/api/backup', 'POST', backup, cookie)).status, 200);
});
