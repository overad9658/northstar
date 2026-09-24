import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { startServer, stopServer } from './support/server-fixture.mjs';

const token = 'test-bulk-token';
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

test('bulk project API requires a token and applies add, archive, and delete atomically', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-bulk-api-'));
  const port = 32000 + (process.pid % 1000);
  const child = await startServer(dataDir, port, { API_TOKEN: token });
  const base = `http://127.0.0.1:${port}/api/projects`;

  t.after(async () => {
    await stopServer(child);
    await rm(dataDir, { recursive: true, force: true });
  });

  const unauthorized = await fetch(`${base}/bulk/add`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projects: [] }),
  });
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get('www-authenticate'), /^Bearer/);

  const wrongToken = await fetch(`${base}/bulk/add`, {
    method: 'POST', headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' }, body: JSON.stringify({ projects: [] }),
  });
  assert.equal(wrongToken.status, 401);

  const addResponse = await fetch(`${base}/bulk/add`, {
    method: 'POST', headers, body: JSON.stringify({ projects: [
      { name: 'Bulk one', team: 'Platform', impact: 5, urgency: 5, confidence: 7, effort: 3 },
      { name: 'Bulk two', team: 'Platform', status: 'Scheduled', impact: 4, urgency: 3, confidence: 6, effort: 4 },
    ] }),
  });
  assert.equal(addResponse.status, 201);
  const added = await addResponse.json();
  assert.equal(added.count, 2);
  assert.deepEqual(added.projects.map((project) => project.name), ['Bulk one', 'Bulk two']);

  const invalidAdd = await fetch(`${base}/bulk/add`, {
    method: 'POST', headers, body: JSON.stringify({ projects: [
      { name: 'Would otherwise work', impact: 2, urgency: 2, confidence: 5, effort: 5 },
      { name: '', impact: 2, urgency: 2, confidence: 5, effort: 5 },
    ] }),
  });
  assert.equal(invalidAdd.status, 400);
  assert.equal((await (await fetch(base)).json()).length, 2);

  const ids = added.projects.map((project) => project.id);
  const archiveResponse = await fetch(`${base}/bulk/archive`, {
    method: 'POST', headers, body: JSON.stringify({ projectIds: ids }),
  });
  assert.equal(archiveResponse.status, 200);
  const archived = await archiveResponse.json();
  assert.equal(archived.count, 2);
  assert.ok(archived.projects.every((project) => project.archived === 1));

  const failedDelete = await fetch(`${base}/bulk/delete`, {
    method: 'POST', headers, body: JSON.stringify({ projectIds: [ids[0], 999999] }),
  });
  assert.equal(failedDelete.status, 404);
  assert.equal((await (await fetch(base)).json()).length, 2);

  const deleteResponse = await fetch(`${base}/bulk/delete`, {
    method: 'POST', headers, body: JSON.stringify({ projectIds: ids }),
  });
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(await deleteResponse.json(), { count: 2, projectIds: ids });
  assert.deepEqual(await (await fetch(base)).json(), []);
});

test('bulk project API is disabled when API_TOKEN is not configured', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-bulk-disabled-'));
  const port = 33000 + (process.pid % 1000);
  const child = await startServer(dataDir, port, { API_TOKEN: '' });
  t.after(async () => {
    await stopServer(child);
    await rm(dataDir, { recursive: true, force: true });
  });

  const response = await fetch(`http://127.0.0.1:${port}/api/projects/bulk/add`, {
    method: 'POST', headers: { authorization: 'Bearer anything', 'content-type': 'application/json' }, body: '{"projects":[]}',
  });
  assert.equal(response.status, 503);
});

test('UI-generated API tokens are hashed, persisted, and rotated', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-generated-token-'));
  const port = 34000 + (process.pid % 1000);
  let child = await startServer(dataDir, port, { API_TOKEN: 'environment-token' });
  const root = `http://127.0.0.1:${port}`;

  t.after(async () => {
    await stopServer(child);
    await rm(dataDir, { recursive: true, force: true });
  });

  const initialStatusResponse = await fetch(`${root}/api/api-token`);
  assert.equal(initialStatusResponse.status, 200);
  assert.equal(initialStatusResponse.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await initialStatusResponse.json(), { configured: true, managed: false, createdAt: null });

  const generatedResponse = await fetch(`${root}/api/api-token`, { method: 'POST' });
  assert.equal(generatedResponse.status, 201);
  assert.equal(generatedResponse.headers.get('cache-control'), 'no-store');
  const generated = await generatedResponse.json();
  assert.match(generated.token, /^northstar_[A-Za-z0-9_-]{43}$/);
  assert.match(generated.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(await fetch(`${root}/api/projects/bulk/add`, {
    method: 'POST', headers: { authorization: 'Bearer environment-token', 'content-type': 'application/json' }, body: '{"projects":[]}',
  }).then((response) => response.status), 401);

  const addWithGeneratedToken = await fetch(`${root}/api/projects/bulk/add`, {
    method: 'POST',
    headers: { authorization: `Bearer ${generated.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ projects: [{ name: 'Generated token project', impact: 4, urgency: 4, confidence: 5, effort: 5 }] }),
  });
  assert.equal(addWithGeneratedToken.status, 201);
  const generatedProject = (await addWithGeneratedToken.json()).projects[0];

  const replacement = await (await fetch(`${root}/api/api-token`, { method: 'POST' })).json();
  assert.notEqual(replacement.token, generated.token);
  assert.equal(await fetch(`${root}/api/projects/bulk/archive`, {
    method: 'POST', headers: { authorization: `Bearer ${generated.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ projectIds: [generatedProject.id] }),
  }).then((response) => response.status), 401);
  assert.equal(await fetch(`${root}/api/projects/bulk/archive`, {
    method: 'POST', headers: { authorization: `Bearer ${replacement.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ projectIds: [generatedProject.id] }),
  }).then((response) => response.status), 200);

  await stopServer(child);
  const inspectionDb = new DatabaseSync(join(dataDir, 'northstar.db'));
  const stored = inspectionDb.prepare('SELECT api_token_hash AS hash FROM portfolio_settings WHERE id = 1').get();
  inspectionDb.close();
  assert.match(stored.hash, /^[a-f0-9]{64}$/);
  assert.notEqual(stored.hash, replacement.token);

  child = await startServer(dataDir, port, { API_TOKEN: '' });
  const statusAfterRestart = await (await fetch(`${root}/api/api-token`)).json();
  assert.equal(statusAfterRestart.configured, true);
  assert.equal(statusAfterRestart.managed, true);
  assert.equal(await fetch(`${root}/api/projects/bulk/archive`, {
    method: 'POST', headers: { authorization: `Bearer ${replacement.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ projectIds: [generatedProject.id] }),
  }).then((response) => response.status), 200);
});
