import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { freePort, startServer, stopServer } from './support/server-fixture.mjs';

test('status, archive, team and capacity changes appear in the activity feed with notes and actor', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-project-changes-'));
  const port = await freePort();
  const child = await startServer(dataDir, port, { AUTH_DISABLED: 'false', API_TOKEN: '' });
  t.after(async () => { await stopServer(child); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const send = (path, method = 'GET', body, headers = {}) => fetch(`${base}${path}`, {
    method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const setup = await send('/api/auth/setup', 'POST', { username: 'owner', password: 'correct horse battery staple' });
  const cookie = { cookie: setup.headers.get('set-cookie').split(';', 1)[0] };
  const bot = { authorization: `Bearer ${(await send('/api/api-tokens', 'POST', { name: 'Sync bot', scope: 'write' }, cookie).then((response) => response.json())).token}` };
  await send('/api/teams', 'POST', { name: 'Alpha', capacity: 5 }, cookie);
  await send('/api/teams', 'POST', { name: 'Beta', capacity: 5 }, cookie);
  const project = await send('/api/projects', 'POST', { projectId: 'CHG-1', name: 'Changes', team: 'Alpha', capacity: 1, status: 'Active', impact: 4, urgency: 4, confidence: 5, effort: 5 }, cookie).then((response) => response.json());
  const put = async (body, headers = cookie) => {
    const response = await send(`/api/projects/${project.id}`, 'PUT', body, headers);
    assert.equal(response.status, 200, JSON.stringify(body));
  };

  await put({ status: 'Blocked', blockedNote: 'Waiting on vendor' });
  await put({ status: 'Blocked', blockedNote: 'Still waiting' });
  await put({ status: 'Active' }, bot);
  await put({ team: 'Beta', capacity: 2 });
  await put({ archived: true, archiveNote: 'Paused for now' });
  await put({ archived: false, restoreNote: 'Back on' }, bot);
  assert.equal((await send('/api/projects/bulk/archive', 'POST', { projectIds: [project.id] }, bot)).status, 200);

  const { items } = await send('/api/activity?limit=500', 'GET', undefined, cookie).then((response) => response.json());
  const events = items.filter((item) => item.projectId === project.id && item.type !== 'project.created');
  const ofType = (type) => events.filter((item) => item.type === type);

  const statuses = ofType('project.status').map(({ from, to, note, actor }) => ({ from, to, note, actor }))
    .sort((a, b) => a.to.localeCompare(b.to));
  assert.deepEqual(statuses, [
    { from: 'Blocked', to: 'Active', note: '', actor: 'Sync bot' },
    { from: 'Active', to: 'Blocked', note: 'Waiting on vendor', actor: 'owner' },
  ]);
  assert.deepEqual(ofType('project.team').map(({ from, to, actor }) => [from, to, actor]), [['Alpha', 'Beta', 'owner']]);
  assert.deepEqual(ofType('project.capacity').map(({ from, to }) => [from, to]), [[1, 2]]);
  assert.deepEqual(ofType('project.archived').map(({ note, actor }) => [note, actor]).sort(), [['Paused for now', 'Sync bot'], ['Paused for now', 'owner']]);
  assert.deepEqual(ofType('project.restored').map(({ note, actor }) => [note, actor]), [['Back on', 'Sync bot']]);
  assert.equal(events.length, 7);
  assert.ok(events.every((item) => item.projectCode === 'CHG-1' && /T.*Z$/.test(item.at)));

  const reader = { authorization: `Bearer ${(await send('/api/api-tokens', 'POST', { name: 'Reader', scope: 'read' }, cookie).then((response) => response.json())).token}` };
  await send('/api/projects', 'POST', { name: 'Hidden', hiddenFromReadOnly: true, team: 'Alpha', status: 'Active', impact: 3, urgency: 3, confidence: 5, effort: 5 }, cookie)
    .then((response) => response.json())
    .then((hidden) => send(`/api/projects/${hidden.id}`, 'PUT', { status: 'Blocked', blockedNote: 'Secret' }, cookie));
  const readerItems = (await send('/api/activity?limit=500', 'GET', undefined, reader).then((response) => response.json())).items;
  assert.ok(!readerItems.some((item) => item.note === 'Secret'));
  assert.ok(readerItems.some((item) => item.type === 'project.status' && item.note === 'Waiting on vendor'));
});
