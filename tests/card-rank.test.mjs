import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createBackupService } from '../backup-service.mjs';
import { openDatabase } from '../database.mjs';
import { createKanbanService } from '../kanban-service.mjs';
import { freePort, startServer, stopServer } from '../support/server-fixture.mjs';

async function startApi(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-card-rank-'));
  const port = await freePort();
  const child = await startServer(dataDir, port, { API_TOKEN: 'rank-token' });
  t.after(async () => { await stopServer(child); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const send = (path, method = 'GET', body) => fetch(`${base}${path}`, {
    method,
    headers: { authorization: 'Bearer rank-token', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = async (path, method, body, status) => {
    const response = await send(path, method, body);
    if (status !== undefined) assert.equal(response.status, status, `${method} ${path} ${JSON.stringify(body)}`);
    return response.json();
  };
  return { send, json };
}

test('rank, objective and blockedBy are stored, survive a column move and are listed in rank order', async (t) => {
  const { send, json } = await startApi(t);
  const todo = await json('/api/kanban/columns', 'POST', { name: 'To do' }, 201);
  const doing = await json('/api/kanban/columns', 'POST', { name: 'Doing' }, 201);
  const upsert = (key, body) => json('/api/kanban/cards/upsert?key=key', 'PUT', { key, columnId: todo.id, title: key, ...body });

  const a = (await upsert('a', { rank: 30, objective: 'Ship the sequence loop' })).card;
  const b = (await upsert('b', { rank: 10, blockedBy: [a.id] })).card;
  const c = (await upsert('c', {})).card;
  assert.deepEqual([a.rank, a.objective, a.blockedBy], [30, 'Ship the sequence loop', []]);
  assert.deepEqual([b.rank, b.objective, b.blockedBy], [10, '', [a.id]]);
  assert.deepEqual([c.rank, c.blockedBy], [null, []]);

  // The reported bug: position is assigned by the board, so a sent position is ignored; rank is what sticks.
  const repeated = await upsert('a', { rank: 30, position: 0 });
  assert.equal(repeated.created, false);
  assert.equal(repeated.card.rank, 30);
  const moved = await json(`/api/kanban/cards/${a.id}`, 'PUT', { columnId: doing.id }, 200);
  assert.deepEqual([moved.columnId, moved.rank, moved.objective], [doing.id, 30, 'Ship the sequence loop']);

  // Fields left out keep their values; blockedBy replaces the list; null clears rank.
  const touched = (await upsert('b', { title: 'b renamed' })).card;
  assert.deepEqual([touched.rank, touched.blockedBy], [10, [a.id]]);
  const replaced = (await upsert('b', { blockedBy: [c.id, a.id, c.id] })).card;
  assert.deepEqual(replaced.blockedBy, [a.id, c.id].sort((x, y) => x - y));
  assert.equal((await upsert('c', { rank: 20 })).card.rank, 20);
  assert.equal((await upsert('c', { rank: null })).card.rank, null);
  await upsert('c', { rank: 20 });

  const ranked = await json('/api/kanban/cards?sort=rank', 'GET', undefined, 200);
  assert.deepEqual(ranked.map((card) => [card.key, card.rank]), [['b', 10], ['c', 20], ['a', 30]]);
  const unsorted = await json('/api/kanban/cards', 'GET', undefined, 200);
  assert.deepEqual(unsorted.map((card) => card.key), ['b', 'c', 'a'], 'without sort, cards come in board order (column, position)');
  assert.equal((await send('/api/kanban/cards?sort=title')).status, 400);

  const board = await json('/api/kanban', 'GET', undefined, 200);
  const onBoard = Object.fromEntries(board.cards.map((card) => [card.key, card]));
  assert.deepEqual([onBoard.a.objective, onBoard.b.blockedBy, onBoard.c.rank], ['Ship the sequence loop', [a.id, c.id], 20]);
  const all = await json('/api/kanban?teamId=all', 'GET', undefined, 200);
  assert.deepEqual(all.cards.find((card) => card.key === 'b').blockedBy, [a.id, c.id]);

  // An objective change and a blocker change show in the activity feed; a rank change does not.
  const updates = (await json('/api/activity?limit=500', 'GET', undefined, 200)).items.filter((item) => item.type === 'card.updated');
  assert.ok(updates.some((item) => item.fields?.includes('blockedBy')), JSON.stringify(updates));

  // Deleting a blocker removes it from the cards it blocked.
  await send(`/api/kanban/cards/${c.id}`, 'DELETE');
  assert.deepEqual((await json(`/api/kanban/cards/${b.id}`, 'GET', undefined, 200)).blockedBy, [a.id]);
});

test('bad rank, objective and blockedBy values are refused', async (t) => {
  const { send, json } = await startApi(t);
  const todo = await json('/api/kanban/columns', 'POST', { name: 'To do' }, 201);
  const card = await json('/api/kanban/cards', 'POST', { columnId: todo.id, title: 'One' }, 201);
  const status = async (body) => (await send(`/api/kanban/cards/${card.id}`, 'PUT', body)).status;
  for (const rank of [-1, 1.5, 1_000_001, 'high', true]) assert.equal(await status({ rank }), 400, `rank ${rank}`);
  assert.equal(await status({ rank: 0 }), 200);
  assert.equal(await status({ rank: 1_000_000 }), 200);
  assert.equal(await status({ objective: 'x'.repeat(301) }), 400);
  assert.equal(await status({ blockedBy: card.id }), 400);
  assert.equal(await status({ blockedBy: [card.id] }), 400, 'a card cannot block itself');
  assert.equal(await status({ blockedBy: [999999] }), 400, 'unknown card');
  assert.equal(await status({ blockedBy: ['x'] }), 400);
  assert.equal(await status({ blockedBy: Array.from({ length: 51 }, (_, index) => index + 1) }), 400);
  assert.equal((await send('/api/kanban/cards', 'POST', { columnId: todo.id, title: 'Two', blockedBy: [424242] })).status, 400);
  assert.equal((await json('/api/kanban', 'GET', undefined, 200)).cards.length, 1, 'a refused create writes nothing');
  assert.deepEqual((await json(`/api/kanban/cards/${card.id}`, 'GET', undefined, 200)).blockedBy, []);
});

test('PUT /api/kanban/cards/ranks sets many ranks at once, all or none', async (t) => {
  const { send, json } = await startApi(t);
  const todo = await json('/api/kanban/columns', 'POST', { name: 'To do' }, 201);
  const ids = [];
  for (const title of ['one', 'two', 'three']) ids.push((await json('/api/kanban/cards', 'POST', { columnId: todo.id, title }, 201)).id);
  const [one, two, three] = ids;

  const set = await json('/api/kanban/cards/ranks', 'PUT', { ranks: [{ id: one, rank: 3 }, { id: two, rank: 1 }, { id: three, rank: 2 }] }, 200);
  assert.deepEqual(set.ranks, [{ id: one, rank: 3, changed: true }, { id: two, rank: 1, changed: true }, { id: three, rank: 2, changed: true }]);
  assert.deepEqual((await json('/api/kanban/cards?sort=rank', 'GET', undefined, 200)).map((card) => card.id), [two, three, one]);
  assert.deepEqual((await json('/api/kanban/cards/ranks', 'PUT', { ranks: [{ id: one, rank: 3 }, { id: two, rank: null }] }, 200)).ranks.map((item) => item.changed), [false, true]);

  const before = (await json('/api/kanban/cards?sort=rank', 'GET', undefined, 200)).map((card) => [card.id, card.rank]);
  for (const body of [
    { ranks: [{ id: one, rank: 9 }, { id: 999999, rank: 1 }] },
    { ranks: [{ id: one, rank: 9 }, { id: one, rank: 8 }] },
    { ranks: [{ id: one, rank: 9 }, { id: three, rank: -2 }] },
    { ranks: [{ id: one }] },
    { ranks: [] },
    { ranks: 'nope' },
    {},
  ]) {
    const response = await send('/api/kanban/cards/ranks', 'PUT', body);
    assert.ok([400, 404].includes(response.status), `${JSON.stringify(body)} -> ${response.status}`);
  }
  assert.deepEqual((await json('/api/kanban/cards?sort=rank', 'GET', undefined, 200)).map((card) => [card.id, card.rank]), before, 'a refused call changes nothing');
  assert.equal((await send('/api/kanban/cards/ranks', 'POST', { ranks: [{ id: one, rank: 1 }] })).status, 405);
});

test('a backup carries rank, objective and blockedBy, and an older backup restores without them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'northstar-card-rank-backup-'));
  const db = openDatabase(join(dir, 'board.db'));
  try {
    const kanban = createKanbanService(db);
    const backup = createBackupService(db);
    const column = kanban.createColumn({ name: 'To do' });
    const first = kanban.createCard({ columnId: column.id, title: 'First', rank: 5, objective: 'Why it matters' });
    const second = kanban.createCard({ columnId: column.id, title: 'Second', blockedBy: [first.id] });
    const exported = backup.export();
    backup.restore(exported);
    assert.deepEqual([kanban.getCard(first.id).rank, kanban.getCard(first.id).objective, kanban.getCard(second.id).blockedBy], [5, 'Why it matters', [first.id]]);

    const older = structuredClone(exported);
    delete older.kanbanCardBlockers;
    older.kanbanCards.forEach((row) => { delete row.rank; delete row.objective; });
    backup.restore(older);
    assert.deepEqual([kanban.getCard(first.id).rank, kanban.getCard(first.id).objective, kanban.getCard(second.id).blockedBy], [null, '', []]);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a database from before rank and blockers gains them on open, keeping its cards', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'northstar-card-rank-migrate-'));
  const file = join(dir, 'board.db');
  try {
    let db = openDatabase(file);
    const kanban = createKanbanService(db);
    const column = kanban.createColumn({ name: 'To do' });
    const card = kanban.createCard({ columnId: column.id, title: 'Legacy' });
    db.close();
    // Take the file back to the previous schema.
    const raw = new DatabaseSync(file);
    raw.exec('DROP INDEX idx_kanban_cards_rank; DROP TABLE kanban_card_blockers; ALTER TABLE kanban_cards DROP COLUMN rank; ALTER TABLE kanban_cards DROP COLUMN objective;');
    assert.equal(raw.prepare('PRAGMA table_info(kanban_cards)').all().some((item) => item.name === 'rank'), false);
    raw.close();

    db = openDatabase(file);
    const reopened = createKanbanService(db);
    assert.deepEqual([reopened.getCard(card.id).title, reopened.getCard(card.id).rank, reopened.getCard(card.id).objective, reopened.getCard(card.id).blockedBy], ['Legacy', null, '', []]);
    assert.equal(reopened.updateCard(card.id, { rank: 7 }).rank, 7);
    db.close();
    db = openDatabase(file);
    assert.equal(createKanbanService(db).getCard(card.id).rank, 7, 'opening again is a no-op');
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('PostgreSQL migrates and stores rank, objective and blockedBy', {
  skip: !process.env.TEST_DATABASE_URL,
}, () => {
  const config = { client: 'postgres', connectionString: process.env.TEST_DATABASE_URL };
  let db = openDatabase(undefined, config);
  try {
    const kanban = createKanbanService(db);
    const column = kanban.createColumn({ name: `PG rank ${Date.now()}` });
    const first = kanban.createCard({ columnId: column.id, title: 'PG first', rank: 900_001, objective: 'Sequence' });
    const second = kanban.createCard({ columnId: column.id, title: 'PG second', rank: 900_000, blockedBy: [first.id] });
    assert.deepEqual([first.rank, first.objective, second.blockedBy], [900_001, 'Sequence', [first.id]]);
    assert.throws(() => kanban.updateCard(first.id, { blockedBy: [first.id] }), /cannot block itself/);
    kanban.setRanks([{ id: first.id, rank: 900_002 }, { id: second.id, rank: null }]);
    assert.throws(() => kanban.setRanks([{ id: first.id, rank: 1 }, { id: 2_000_000_000, rank: 1 }]), /Card not found/);
    assert.equal(kanban.getCard(first.id).rank, 900_002, 'a refused call changes nothing');
    const ranked = kanban.findCards({ sort: 'rank', archived: 'include', includeHidden: true }).map((card) => card.id);
    assert.ok(ranked.indexOf(first.id) < ranked.indexOf(second.id), 'unranked cards come after ranked ones');
    assert.deepEqual(kanban.list({ includeHidden: true, teamId: column.teamId }).cards.find((card) => card.id === second.id).blockedBy, [first.id]);
    kanban.deleteCard(first.id);
    assert.deepEqual(kanban.getCard(second.id).blockedBy, []);
    db.close();
    db = openDatabase(undefined, config);
    assert.equal(createKanbanService(db).getCard(second.id).rank, null);
    createKanbanService(db).deleteCard(second.id);
    createKanbanService(db).deleteColumn(column.id);
  } finally { db.close(); }
});
