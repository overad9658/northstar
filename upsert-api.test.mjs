import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { freePort, startServer, stopServer } from './support/server-fixture.mjs';

async function startApi(t, prefix) {
  const dataDir = await mkdtemp(join(tmpdir(), prefix));
  const port = await freePort();
  const child = await startServer(dataDir, port, { API_TOKEN: 'upsert-token' });
  t.after(async () => { await stopServer(child); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  return (path, method = 'GET', body) => fetch(`${base}${path}`, {
    method,
    headers: { authorization: 'Bearer upsert-token', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('projects can be looked up and upserted by projectId or externalUrl', async (t) => {
  const send = await startApi(t, 'northstar-project-upsert-');
  const input = { projectId: 'OPS-12', externalUrl: 'https://tracker.example/OPS-12', name: 'Sync', impact: 4, urgency: 4, confidence: 5, effort: 5 };

  const created = await send('/api/projects/upsert?key=projectId', 'PUT', input);
  assert.equal(created.status, 201);
  const first = await created.json();
  assert.equal(first.created, true);
  assert.equal(first.project.projectId, 'OPS-12');

  const repeated = await send('/api/projects/upsert?key=projectId', 'PUT', input);
  assert.equal(repeated.status, 200);
  const second = await repeated.json();
  assert.deepEqual([second.created, second.project.id], [false, first.project.id]);
  assert.equal((await send('/api/projects').then((response) => response.json())).length, 1);
  assert.deepEqual(await send(`/api/projects/${first.project.id}/moves`).then((response) => response.json()), []);

  const byUrl = await send('/api/projects/upsert?key=externalUrl', 'PUT', { externalUrl: ' https://tracker.example/OPS-12 ', impact: 8 });
  assert.equal(byUrl.status, 200);
  const updated = (await byUrl.json()).project;
  assert.deepEqual([updated.id, updated.impact], [first.project.id, 8]);
  const found = await send(`/api/projects?externalUrl=${encodeURIComponent('https://tracker.example/OPS-12')}`).then((response) => response.json());
  assert.deepEqual(found.map((project) => [project.id, project.impact, project.name]), [[first.project.id, 8, 'Sync']]);
  assert.deepEqual((await send('/api/projects?projectId=OPS-12').then((response) => response.json())).map((project) => project.id), [first.project.id]);
  assert.deepEqual(await send('/api/projects?projectId=NONE-1').then((response) => response.json()), []);

  assert.equal((await send('/api/projects/upsert?key=name', 'PUT', input)).status, 400);
  assert.equal((await send('/api/projects/upsert?key=projectId', 'PUT', { ...input, projectId: ' ' })).status, 400);
  assert.equal((await send('/api/projects/upsert?key=projectId', 'POST', input)).status, 405);
  assert.equal((await send('/api/projects/upsert?key=projectId', 'PUT', { projectId: 'NEW-1', name: 'Missing scores' })).status, 400);

  await send('/api/projects', 'POST', { ...input, projectId: 'DUP-1', name: 'Duplicate one' });
  await send('/api/projects', 'POST', { ...input, projectId: 'DUP-1', name: 'Duplicate two' });
  assert.equal((await send('/api/projects/upsert?key=projectId', 'PUT', { ...input, projectId: 'DUP-1' })).status, 409);
});

test('cards can be looked up by externalUrl or projectId and upserted by externalUrl', async (t) => {
  const send = await startApi(t, 'northstar-card-upsert-');
  const column = await send('/api/kanban/columns', 'POST', { name: 'To do' }).then((response) => response.json());
  const done = await send('/api/kanban/columns', 'POST', { name: 'Done' }).then((response) => response.json());
  const project = await send('/api/projects', 'POST', { name: 'Linked', impact: 4, urgency: 4, confidence: 5, effort: 5 }).then((response) => response.json());
  const input = { columnId: column.id, projectId: project.id, title: 'Review PR', externalUrl: 'https://code.example/pull/7' };

  const created = await send('/api/kanban/cards/upsert', 'PUT', input);
  assert.equal(created.status, 201);
  const first = await created.json();
  assert.equal(first.created, true);

  const repeated = await send('/api/kanban/cards/upsert', 'PUT', input);
  assert.equal(repeated.status, 200);
  assert.deepEqual([(await repeated.json()).card.id], [first.card.id]);
  assert.equal((await send('/api/kanban').then((response) => response.json())).cards.length, 1);
  assert.equal((await send(`/api/kanban/cards/${first.card.id}/history`).then((response) => response.json())).entries.length, 1);

  const moved = await send('/api/kanban/cards/upsert', 'PUT', { externalUrl: 'https://code.example/pull/7', columnId: done.id });
  assert.equal(moved.status, 200);
  assert.deepEqual([(await moved.json()).card.columnId], [done.id]);

  const byUrl = await send(`/api/kanban/cards?externalUrl=${encodeURIComponent('https://code.example/pull/7')}`).then((response) => response.json());
  assert.deepEqual(byUrl.map((card) => [card.id, card.title, card.columnId]), [[first.card.id, 'Review PR', done.id]]);
  assert.deepEqual((await send(`/api/kanban/cards?projectId=${project.id}`).then((response) => response.json())).map((card) => card.id), [first.card.id]);
  assert.deepEqual(await send('/api/kanban/cards?externalUrl=https%3A%2F%2Fcode.example%2Fpull%2F8').then((response) => response.json()), []);

  assert.equal((await send('/api/kanban/cards/upsert', 'PUT', { ...input, externalUrl: '' })).status, 400);
  assert.equal((await send('/api/kanban/cards/upsert', 'PUT', { ...input, externalUrl: 'not a url' })).status, 400);
  assert.equal((await send('/api/kanban/cards/upsert', 'PUT', { externalUrl: 'https://code.example/pull/9', title: 'No column' })).status, 400);

  await send('/api/kanban/cards', 'POST', { ...input, externalUrl: 'https://code.example/pull/10', title: 'Duplicate one' });
  await send('/api/kanban/cards', 'POST', { ...input, externalUrl: 'https://code.example/pull/10', title: 'Duplicate two' });
  assert.equal((await send('/api/kanban/cards/upsert', 'PUT', { ...input, externalUrl: 'https://code.example/pull/10' })).status, 409);
});

const statuses = (responses) => responses.map((response) => response.status).sort();

test('concurrent upserts of one new key create one record', async (t) => {
  const send = await startApi(t, 'northstar-upsert-race-');
  const project = { projectId: 'RACE-1', name: 'Race', impact: 4, urgency: 4, confidence: 5, effort: 5 };
  assert.deepEqual(statuses(await Promise.all([1, 2].map(() => send('/api/projects/upsert?key=projectId', 'PUT', project)))), [200, 201]);
  assert.equal((await send('/api/projects?projectId=RACE-1').then((response) => response.json())).length, 1);

  const column = await send('/api/kanban/columns', 'POST', { name: 'To do' }).then((response) => response.json());
  const card = { columnId: column.id, title: 'Race', externalUrl: 'https://code.example/race' };
  assert.deepEqual(statuses(await Promise.all([1, 2].map(() => send('/api/kanban/cards/upsert', 'PUT', card)))), [200, 201]);
  assert.equal((await send(`/api/kanban/cards?externalUrl=${encodeURIComponent(card.externalUrl)}`).then((response) => response.json())).length, 1);
});

test('concurrent upserts from two PostgreSQL-backed servers create one project per key', {
  skip: !process.env.TEST_DATABASE_URL,
}, async (t) => {
  const env = { DATABASE_CLIENT: 'postgres', DATABASE_URL: process.env.TEST_DATABASE_URL, API_TOKEN: '' };
  const servers = [];
  for (const name of ['a', 'b']) {
    const dataDir = await mkdtemp(join(tmpdir(), `northstar-upsert-pg-${name}-`));
    const port = await freePort();
    servers.push({ dataDir, base: `http://127.0.0.1:${port}`, child: await startServer(dataDir, port, env) });
  }
  t.after(async () => {
    for (const server of servers) { await stopServer(server.child); await rm(server.dataDir, { recursive: true, force: true }); }
  });
  const suffix = Date.now().toString(36).slice(-6);
  const keys = Array.from({ length: 20 }, (_, index) => `PG${suffix}${index}`);
  const upsert = (server, projectId) => fetch(`${server.base}/api/projects/upsert?key=projectId`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId, name: `Race ${projectId}`, impact: 3, urgency: 3, confidence: 5, effort: 5 }),
  });
  for (const projectId of keys) {
    assert.deepEqual(statuses(await Promise.all(servers.map((server) => upsert(server, projectId)))), [200, 201], projectId);
  }
  for (const projectId of keys) {
    const found = await fetch(`${servers[0].base}/api/projects?projectId=${projectId}`).then((response) => response.json());
    assert.equal(found.length, 1, projectId);
    await fetch(`${servers[0].base}/api/projects/${found[0].id}`, { method: 'DELETE' });
  }
});
