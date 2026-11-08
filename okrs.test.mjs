import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { freePort, startServer, stopServer } from './support/server-fixture.mjs';

test('OKRs track results and link existing projects and tasks with role boundaries', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-okrs-'));
  const port = await freePort();
  const child = await startServer(dataDir, port, { AUTH_DISABLED: 'false' });
  t.after(async () => { await stopServer(child); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const send = (path, method = 'GET', body, cookie) => fetch(`${base}${path}`, {
    method, headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const setup = await send('/api/auth/setup', 'POST', { username: 'owner', password: 'correct horse battery staple' });
  const admin = setup.headers.get('set-cookie').split(';', 1)[0];
  const project = await (await send('/api/projects', 'POST', { name: 'Delivery', impact: 4, urgency: 4, confidence: 5, effort: 5 }, admin)).json();
  const column = await (await send('/api/kanban/columns', 'POST', { name: 'To do' }, admin)).json();
  const task = await (await send('/api/kanban/cards', 'POST', { columnId: column.id, title: 'Ship release', projectId: project.id }, admin)).json();
  assert.equal((await send('/api/okrs')).status, 401);
  assert.equal((await send('/okrs.html')).status, 200);

  const objectiveResponse = await send('/api/okrs', 'POST', { title: 'Improve delivery', period: 'Q1', description: 'Ship more reliably' }, admin);
  assert.equal(objectiveResponse.status, 201);
  const objective = await objectiveResponse.json();
  const resultResponse = await send(`/api/okrs/${objective.id}/key-results`, 'POST', { title: 'Release milestones', current: 1, target: 4 }, admin);
  assert.equal(resultResponse.status, 201);
  const result = await resultResponse.json();
  assert.equal((await send(`/api/okrs/${objective.id}/key-results/${result.id}/projects`, 'POST', { id: project.id }, admin)).status, 201);
  assert.equal((await send(`/api/okrs/${objective.id}/key-results/${result.id}/tasks`, 'POST', { id: task.id }, admin)).status, 201);
  const listed = await (await send('/api/okrs', 'GET', undefined, admin)).json();
  assert.equal(listed[0].keyResults[0].projects[0].id, project.id);
  assert.equal(listed[0].keyResults[0].tasks[0].id, task.id);
  assert.equal(listed[0].keyResults[0].current, 1);
  assert.equal((await send(`/api/okrs/${objective.id}/key-results/${result.id}`, 'PUT', { title: 'Release milestones', current: 2, target: 4 }, admin)).status, 200);
  assert.equal((await send('/api/okrs/options', 'GET', undefined, admin).then((response) => response.json())).tasks[0].id, task.id);
  const backup = await (await send('/api/backup', 'GET', undefined, admin)).json();
  assert.equal(backup.okrObjectives.length, 1);
  assert.equal(backup.okrProjectLinks.length, 1);
  assert.equal(backup.okrTaskLinks.length, 1);
  assert.equal((await send('/api/backup', 'POST', backup, admin)).status, 200);
  assert.equal((await send('/api/okrs', 'GET', undefined, admin).then((response) => response.json()))[0].keyResults[0].tasks[0].id, task.id);

  await send('/api/users', 'POST', { username: 'viewer', password: 'read only password', role: 'read_only' }, admin);
  const login = await send('/api/auth/login', 'POST', { username: 'viewer', password: 'read only password' });
  const viewer = login.headers.get('set-cookie').split(';', 1)[0];
  assert.equal((await send('/api/okrs', 'GET', undefined, viewer)).status, 200);
  assert.equal((await send('/api/okrs', 'POST', { title: 'Denied' }, viewer)).status, 403);
  assert.equal((await send(`/api/okrs/${objective.id}/key-results/${result.id}/projects/${project.id}`, 'DELETE', undefined, admin)).status, 204);
  assert.equal((await send(`/api/okrs/${objective.id}/key-results/${result.id}`, 'DELETE', undefined, admin)).status, 204);
  assert.equal((await send(`/api/okrs/${objective.id}`, 'DELETE', undefined, admin)).status, 204);
  assert.deepEqual(await (await send('/api/okrs', 'GET', undefined, admin)).json(), []);
  assert.equal((await send('/api/projects', 'GET', undefined, admin)).status, 200);
});
