import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { freePort, startServer, stopServer } from './support/server-fixture.mjs';

test('kanban cards accept an optional HTTP or HTTPS link that survives backups', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-kanban-link-'));
  const port = await freePort();
  const child = await startServer(dataDir, port);
  t.after(async () => { await stopServer(child); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const request = (path, method = 'GET', body) => fetch(`${base}${path}`, {
    method, headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const column = await (await request('/api/kanban/columns', 'POST', { name: 'Review' })).json();
  const plain = await (await request('/api/kanban/cards', 'POST', { columnId: column.id, title: 'No link' })).json();
  assert.equal(plain.externalUrl, '');
  const linked = await (await request('/api/kanban/cards', 'POST', { columnId: column.id, title: 'Review change', externalUrl: ' https://example.com/pull/12 ' })).json();
  assert.equal(linked.externalUrl, 'https://example.com/pull/12');
  for (const externalUrl of ['javascript:alert(1)', 'not a url', 'ftp://example.com/file', `https://example.com/${'x'.repeat(2048)}`]) {
    assert.equal((await request('/api/kanban/cards', 'POST', { columnId: column.id, title: 'Bad link', externalUrl })).status, 400, externalUrl);
  }
  assert.equal((await request(`/api/kanban/cards/${plain.id}`, 'PUT', { externalUrl: 'data:text/html,hi' })).status, 400);

  let board = await (await request('/api/kanban')).json();
  assert.equal(board.cards.find((card) => card.id === linked.id).externalUrl, 'https://example.com/pull/12');
  assert.equal((await (await request(`/api/kanban/cards/${plain.id}`, 'PUT', { externalUrl: 'http://example.com/ticket/7' })).json()).externalUrl, 'http://example.com/ticket/7');
  assert.equal((await (await request(`/api/kanban/cards/${plain.id}`, 'PUT', { title: 'Has link now' })).json()).externalUrl, 'http://example.com/ticket/7');
  assert.equal((await (await request(`/api/kanban/cards/${linked.id}`, 'PUT', { externalUrl: '' })).json()).externalUrl, '');

  const backup = await (await request('/api/backup')).json();
  assert.deepEqual(backup.kanbanCards.map((card) => card.external_url), ['http://example.com/ticket/7', '']);
  assert.equal((await request(`/api/kanban/cards/${plain.id}`, 'DELETE')).status, 204);
  assert.equal((await request('/api/backup', 'POST', backup)).status, 200);
  board = await (await request('/api/kanban')).json();
  assert.equal(board.cards.find((card) => card.id === plain.id).externalUrl, 'http://example.com/ticket/7');

  const olderBackup = { ...backup, kanbanCards: backup.kanbanCards.map(({ external_url, ...card }) => card) };
  assert.equal((await request('/api/backup', 'POST', olderBackup)).status, 200);
  board = await (await request('/api/kanban')).json();
  assert.deepEqual(board.cards.map((card) => card.externalUrl), ['', '']);
});
