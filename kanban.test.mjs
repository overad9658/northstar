import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { freePort, startServer, stopServer } from './support/server-fixture.mjs';

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
  const port = await freePort();
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
    const general = await (await request('/api/kanban/cards', 'POST', { columnId: todo.id, title: 'Order supplies', tags: ['Operations', 'Quick win'] })).json();
    assert.equal(general.projectId, null);
    assert.deepEqual(general.tags, ['operations', 'quick win']);
    assert.equal((await request('/api/kanban/cards', 'POST', { columnId: todo.id, title: 'Bad tag', tags: ['x'.repeat(41)] })).status, 400);
    assert.equal((await request('/api/kanban/cards', 'POST', { columnId: todo.id, title: 'Bad link', projectId: 99999 })).status, 400);
    const project = await (await request('/api/projects', 'POST', { name: 'Launch', impact: 4, urgency: 4, confidence: 5, effort: 5 })).json();
    assert.equal(project.cardCount, 0);
    const linked = await (await request('/api/kanban/cards', 'POST', { columnId: todo.id, title: 'Prepare release', projectId: project.id, tags: ['Release', 'release', 'Urgent'] })).json();
    assert.equal(linked.projectId, project.id);
    assert.deepEqual(linked.tags, ['release', 'urgent']);
    assert.equal((await (await request('/api/projects')).json()).find((item) => item.id === project.id).cardCount, 1);
    let history = await (await request(`/api/kanban/cards/${linked.id}/history`)).json();
    assert.equal(history.entries.length, 1);
    assert.equal(history.entries[0].columnName, 'To do');
    assert.equal(history.entries[0].isCurrent, true);
    const firstNote = await (await request(`/api/kanban/cards/${linked.id}/notes`, 'POST', { body: 'Check release window' })).json();
    const secondNote = await (await request(`/api/kanban/cards/${linked.id}/notes`, 'POST', { body: 'Confirm with support' })).json();
    assert.equal((await request(`/api/kanban/cards/${linked.id}/notes`, 'POST', { body: '   ' })).status, 400);
    assert.deepEqual((await (await request(`/api/kanban/cards/${linked.id}/notes`)).json()).map((note) => note.body), ['Check release window', 'Confirm with support']);
    assert.equal((await request(`/api/kanban/cards/${general.id}/notes/${firstNote.id}`, 'DELETE')).status, 404);
    const moved = await (await request(`/api/kanban/cards/${linked.id}`, 'PUT', { columnId: done.id })).json();
    assert.equal(moved.columnId, done.id);
    history = await (await request(`/api/kanban/cards/${linked.id}/history`)).json();
    assert.deepEqual(history.entries.map((entry) => [entry.columnName, entry.isCurrent]), [['To do', false], ['Done', true]]);
    assert.equal(history.entries[0].exitedAt, history.entries[1].enteredAt);
    assert.ok(history.entries[0].durationSeconds >= 0);
    await request(`/api/kanban/cards/${linked.id}`, 'PUT', { title: 'Prepare final release' });
    history = await (await request(`/api/kanban/cards/${linked.id}/history`)).json();
    assert.equal(history.entries.length, 2);
    const report = await (await request('/api/kanban/report')).json();
    assert.equal(report.rows.filter((row) => row.cardId === linked.id).length, 2);
    assert.equal(report.rows.find((row) => row.cardId === linked.id).cardTitle, 'Prepare final release');
    let board = await (await request('/api/kanban')).json();
    assert.equal(board.cards.find((card) => card.id === linked.id).projectName, 'Launch');
    assert.deepEqual(board.cards.find((card) => card.id === linked.id).tags, ['release', 'urgent']);
    assert.equal(board.cards.find((card) => card.id === linked.id).noteCount, 2);
    const backup = await (await request('/api/backup')).json();
    assert.equal(backup.kanbanColumns.length, 2);
    assert.equal(backup.kanbanCards.length, 2);
    assert.equal(backup.kanbanCardNotes.length, 2);
    assert.equal(backup.kanbanCardHistory.filter((entry) => entry.card_id === linked.id).length, 2);
    assert.equal(backup.kanbanCardTags.length, 4);
    assert.equal((await request(`/api/kanban/cards/${linked.id}/notes/${firstNote.id}`, 'DELETE')).status, 204);
    assert.deepEqual((await (await request(`/api/kanban/cards/${linked.id}/notes`)).json()).map((note) => note.id), [secondNote.id]);
    assert.equal((await request(`/api/kanban/cards/${general.id}`, 'DELETE')).status, 204);
    assert.equal((await request('/api/backup', 'POST', backup)).status, 200);
    board = await (await request('/api/kanban')).json();
    assert.equal(board.cards.length, 2);
    assert.equal(board.cards.find((card) => card.id === general.id).projectId, null);
    assert.deepEqual(board.cards.find((card) => card.id === linked.id).tags, ['release', 'urgent']);
    assert.equal((await (await request(`/api/kanban/cards/${linked.id}/notes`)).json()).length, 2);
    history = await (await request(`/api/kanban/cards/${linked.id}/history`)).json();
    assert.equal(history.entries.length, 2);
    const olderBackup = { ...backup };
    delete olderBackup.kanbanCardHistory;
    delete olderBackup.kanbanCardTags;
    assert.equal((await request('/api/backup', 'POST', olderBackup)).status, 200);
    history = await (await request(`/api/kanban/cards/${linked.id}/history`)).json();
    assert.equal(history.entries.length, 1);
    assert.equal(history.entries[0].columnName, 'Done');
    board = await (await request('/api/kanban')).json();
    assert.deepEqual(board.cards.find((card) => card.id === linked.id).tags, []);
    assert.deepEqual((await (await request(`/api/kanban/cards/${linked.id}`, 'PUT', { tags: ['Follow up'] })).json()).tags, ['follow up']);
    assert.equal((await (await request('/api/projects')).json()).find((item) => item.id === project.id).cardCount, 1);
    await request(`/api/kanban/cards/${linked.id}`, 'PUT', { projectId: null });
    assert.equal((await (await request('/api/projects')).json()).find((item) => item.id === project.id).cardCount, 0);
    await request(`/api/kanban/cards/${linked.id}`, 'PUT', { projectId: project.id });
    assert.equal((await (await request('/api/projects')).json()).find((item) => item.id === project.id).cardCount, 1);
    assert.equal((await request(`/api/projects/${project.id}`, 'DELETE')).status, 204);
    board = await (await request('/api/kanban')).json();
    assert.equal(board.cards.find((card) => card.id === linked.id).projectId, null);
    assert.equal((await request(`/api/kanban/columns/${todo.id}`, 'DELETE')).status, 204);
    board = await (await request('/api/kanban')).json();
    assert.equal(board.cards.length, 1);
    assert.equal(board.cards[0].id, linked.id);
    assert.equal((await (await request(`/api/kanban/cards/${linked.id}/notes`)).json()).length, 2);
    assert.equal((await request(`/api/kanban/cards/${linked.id}`, 'DELETE')).status, 204);
    assert.equal((await request(`/api/kanban/cards/${linked.id}/notes`)).status, 404);
  } finally {
    await stopServer(child);
    await rm(dataDir, { recursive: true, force: true });
  }
});
