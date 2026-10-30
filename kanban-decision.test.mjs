import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { freePort, startServer, stopServer } from './support/server-fixture.mjs';

test('kanban cards carry a next step and a decision through updates, upserts, filters and backups', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-kanban-decision-'));
  const port = await freePort();
  const child = await startServer(dataDir, port, { AUTH_DISABLED: 'false', API_TOKEN: 'decision-token' });
  t.after(async () => { await stopServer(child); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const request = (auth) => (path, method = 'GET', body) => fetch(`${base}${path}`, {
    method,
    headers: { ...auth, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // Card writes go through the API token; backups stay session-only.
  const send = request({ authorization: 'Bearer decision-token' });
  const setup = await request({})('/api/auth/setup', 'POST', { username: 'owner', password: 'correct horse battery staple' });
  const admin = request({ cookie: setup.headers.get('set-cookie').split(';', 1)[0] });
  const json = (response) => response.json();

  assert.equal((await fetch(`${base}/kanban.html`).then((response) => response.text())).includes('id="decision-filter"'), true);
  const column = await send('/api/kanban/columns', 'POST', { name: 'Doing' }).then(json);
  const plain = await send('/api/kanban/cards', 'POST', { columnId: column.id, title: 'Plain' }).then(json);
  assert.deepEqual([plain.nextStep, plain.decision], ['', null]);

  const decision = { options: ['Ship now', 'Wait for review'], recommendation: 'Wait for review', confidence: 70 };
  const created = await send('/api/kanban/cards', 'POST', { columnId: column.id, title: 'Release', nextStep: '  Merge PR 12 once checks pass  ', decision }).then(json);
  assert.equal(created.nextStep, 'Merge PR 12 once checks pass');
  assert.deepEqual(created.decision, { ...decision, decidedOption: '', decidedAt: null });

  for (const bad of [
    { options: [] },
    { options: ['A', 'A'] },
    { options: ['A', 'B'], recommendation: 'C' },
    { options: ['A', 'B'], confidence: 101 },
    { options: ['A', 'B'], confidence: 5.5 },
    { options: ['A', 'B'], decidedOption: 'C' },
    { options: ['A', 'B'], decidedOption: 'A', decidedAt: 'not a date' },
    { options: Array.from({ length: 11 }, (_, index) => `Option ${index}`) },
    ['A'],
  ]) {
    assert.equal((await send('/api/kanban/cards', 'POST', { columnId: column.id, title: 'Bad', decision: bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await send('/api/kanban/cards', 'POST', { columnId: column.id, title: 'Bad', nextStep: 'x'.repeat(1001) })).status, 400);

  let open = await send('/api/kanban/cards?decision=open').then(json);
  assert.deepEqual(open.map((card) => card.id), [created.id]);
  assert.equal((await send('/api/kanban/cards?decision=closed')).status, 400);

  const decided = await send(`/api/kanban/cards/${created.id}`, 'PUT', { decision: { ...decision, decidedOption: 'Ship now' } }).then(json);
  assert.equal(decided.decision.decidedOption, 'Ship now');
  assert.ok(Date.parse(decided.decision.decidedAt) > 0);
  assert.equal(decided.nextStep, 'Merge PR 12 once checks pass');
  const kept = await send(`/api/kanban/cards/${created.id}`, 'PUT', { title: 'Release 1.2', decision: { ...decision, decidedOption: 'Ship now' } }).then(json);
  assert.equal(kept.decision.decidedAt, decided.decision.decidedAt);
  assert.deepEqual(await send('/api/kanban/cards?decision=open').then(json), []);

  const upsertBody = { externalUrl: 'https://tracker.example/T-9', columnId: column.id, title: 'Synced', nextStep: 'Reply to the reviewer', decision: { options: ['Yes', 'No'], recommendation: 'Yes', confidence: 55 } };
  const first = await send('/api/kanban/cards/upsert', 'PUT', upsertBody).then(json);
  const again = await send('/api/kanban/cards/upsert', 'PUT', upsertBody).then(json);
  assert.deepEqual([first.created, again.created, again.card.id], [true, false, first.card.id]);
  assert.deepEqual([again.card.nextStep, again.card.decision.recommendation], ['Reply to the reviewer', 'Yes']);
  open = await send('/api/kanban/cards?decision=open').then(json);
  assert.deepEqual(open.map((card) => card.id), [first.card.id]);

  const board = await send('/api/kanban').then(json);
  assert.equal(board.cards.find((card) => card.id === created.id).decision.decidedOption, 'Ship now');
  assert.equal(board.cards.find((card) => card.id === plain.id).decision, null);

  const backup = await admin('/api/backup').then(json);
  assert.equal((await send(`/api/kanban/cards/${created.id}`, 'PUT', { nextStep: '', decision: null })).status, 200);
  assert.equal((await admin('/api/backup', 'POST', backup)).status, 200);
  const restored = await send(`/api/kanban/cards/${created.id}`).then(json);
  assert.equal(restored.nextStep, 'Merge PR 12 once checks pass');
  assert.deepEqual(restored.decision, kept.decision);

  const olderBackup = { ...backup, kanbanCards: backup.kanbanCards.map(({ next_step, decision: stored, ...card }) => card) };
  assert.equal((await admin('/api/backup', 'POST', olderBackup)).status, 200);
  const older = await send(`/api/kanban/cards/${created.id}`).then(json);
  assert.deepEqual([older.nextStep, older.decision], ['', null]);
});
