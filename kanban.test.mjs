import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startServer, stopServer } from './support/server-fixture.mjs';

test('Docker image includes every local server module', async () => {
  const dockerfile = await readFile(new URL('./Dockerfile', import.meta.url), 'utf8');
  const runtimeCopy = dockerfile.match(/^COPY package\.json (.+) \.\/$/m)?.[1];
  assert.ok(runtimeCopy, 'Dockerfile must list runtime modules');
  const copied = new Set(runtimeCopy.split(/\s+/));
  for (const filename of copied) {
    const source = await readFile(new URL(`./${filename}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/\bfrom ['"]\.\/([^'"]+\.mjs)['"]/g)) {
      assert.ok(copied.has(match[1]), `${filename} imports ${match[1]}, but Docker does not copy it`);
    }
  }
});

test('kanban cards can stand alone, link to projects, move, and survive backup restore', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-kanban-'));
  const port = 33000 + (process.pid % 1000);
  const child = await startServer(dataDir, port);
  const base = `http://127.0.0.1:${port}`;
  const request = (path, method = 'GET', body) => fetch(`${base}${path}`, {
    method, headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    assert.equal((await request('/kanban.html')).status, 200);
    assert.deepEqual(await (await request('/api/kanban')).json(), { columns: [], cards: [] });
    const todo = await (await request('/api/kanban/columns', 'POST', { name: 'To do' })).json();
    const done = await (await request('/api/kanban/columns', 'POST', { name: 'Done' })).json();
    assert.equal(todo.name, 'To do');
    assert.equal(done.position, 1);
    const general = await (await request('/api/kanban/cards', 'POST', { columnId: todo.id, title: 'Order supplies' })).json();
    assert.equal(general.projectId, null);
    assert.equal((await request('/api/kanban/cards', 'POST', { columnId: todo.id, title: 'Bad link', projectId: 99999 })).status, 400);
    const project = await (await request('/api/projects', 'POST', { name: 'Launch', impact: 4, urgency: 4, confidence: 5, effort: 5 })).json();
    const linked = await (await request('/api/kanban/cards', 'POST', { columnId: todo.id, title: 'Prepare release', projectId: project.id })).json();
    assert.equal(linked.projectId, project.id);
    const moved = await (await request(`/api/kanban/cards/${linked.id}`, 'PUT', { columnId: done.id })).json();
    assert.equal(moved.columnId, done.id);
    let board = await (await request('/api/kanban')).json();
    assert.equal(board.cards.find((card) => card.id === linked.id).projectName, 'Launch');
    const backup = await (await request('/api/backup')).json();
    assert.equal(backup.kanbanColumns.length, 2);
    assert.equal(backup.kanbanCards.length, 2);
    assert.equal((await request(`/api/kanban/cards/${general.id}`, 'DELETE')).status, 204);
    assert.equal((await request('/api/backup', 'POST', backup)).status, 200);
    board = await (await request('/api/kanban')).json();
    assert.equal(board.cards.length, 2);
    assert.equal(board.cards.find((card) => card.id === general.id).projectId, null);
    assert.equal((await request(`/api/projects/${project.id}`, 'DELETE')).status, 204);
    board = await (await request('/api/kanban')).json();
    assert.equal(board.cards.find((card) => card.id === linked.id).projectId, null);
    assert.equal((await request(`/api/kanban/columns/${todo.id}`, 'DELETE')).status, 204);
    board = await (await request('/api/kanban')).json();
    assert.equal(board.cards.length, 1);
    assert.equal(board.cards[0].id, linked.id);
  } finally {
    await stopServer(child);
    await rm(dataDir, { recursive: true, force: true });
  }
});
