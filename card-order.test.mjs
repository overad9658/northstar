import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { compareCards, ranksForMove } from './public/shared/card-order.js';
import { freePort, startServer, stopServer } from './support/server-fixture.mjs';

const card = (id, rank = null, position = id) => ({ id, rank, position });
// Applies ranksForMove and returns the column's new display order.
function move(column, id, index) {
  const changes = ranksForMove(column, id, index);
  const next = column.map((item) => ({ ...item, rank: changes.find((change) => change.id === item.id)?.rank ?? item.rank }));
  return { changes, order: next.sort(compareCards).map((item) => item.id) };
}

test('a column shows ranked cards first by rank, then unranked cards by position', () => {
  const cards = [card(1, null, 0), card(2, 5, 1), card(3, null, 2), card(4, 1, 3), card(5, 5, 4), card(6, null, 1)];
  assert.deepEqual([...cards].sort(compareCards).map((item) => item.id), [4, 2, 5, 1, 6, 3]);
  assert.deepEqual([card(9, 0), card(8, null, 0)].sort(compareCards).map((item) => item.id), [9, 8], 'rank 0 is ranked');
});

test('a move between ranked cards takes the midpoint when there is room and changes nothing else', () => {
  const column = [card(1, 10), card(2, 20), card(3, 30)];
  assert.deepEqual(move(column, 3, 1), { changes: [{ id: 3, rank: 15 }], order: [1, 3, 2] });
  assert.deepEqual(move(column, 1, 2), { changes: [{ id: 1, rank: 31 }], order: [2, 3, 1] });
  assert.deepEqual(move(column, 3, 0), { changes: [{ id: 3, rank: 4 }], order: [3, 1, 2] });
  assert.deepEqual(move(column, 2, 1), { changes: [], order: [1, 2, 3] }, 'dropping a card where it is writes nothing');
});

test('dense ranks push the cards below down by one, only as far as needed', () => {
  const column = [card(1, 1), card(2, 2), card(3, 3), card(4, 4), card(5, 9)];
  const { changes, order } = move(column, 4, 1);
  assert.deepEqual(order, [1, 4, 2, 3, 5]);
  assert.deepEqual(changes, [{ id: 4, rank: 2 }, { id: 2, rank: 3 }, { id: 3, rank: 4 }], 'card 5 keeps rank 9');
  assert.deepEqual(move([card(1, 0), card(2, 1)], 2, 0).order, [2, 1], 'to the top above rank 0');
});

test('dropping among unranked cards ranks the cards above it and leaves the ones below unranked', () => {
  const column = [card(1, 3), card(2, null, 0), card(3, null, 1), card(4, null, 2)];
  const { changes, order } = move(column, 4, 2);
  assert.deepEqual(order, [1, 2, 4, 3]);
  assert.deepEqual(changes, [{ id: 2, rank: 4 }, { id: 4, rank: 5 }]);
  assert.deepEqual(move([card(1, null, 0), card(2, null, 1)], 2, 0), { changes: [{ id: 2, rank: 0 }], order: [2, 1] });
  assert.deepEqual(move([card(1, 7), card(2, null, 0)], 1, 1).order, [2, 1], 'a ranked card dragged below an unranked one');
});

test('every move puts the card exactly where it was dropped, for every start and target', () => {
  const columns = [
    [card(1, 1), card(2, 2), card(3, 3), card(4, null, 0), card(5, null, 1)],
    [card(1, 0), card(2, 0), card(3, 5), card(4, null, 7)],
    [card(1, null, 0), card(2, null, 1), card(3, null, 2)],
    [card(1, 100), card(2, 200), card(3, 300)],
  ];
  for (const column of columns) {
    const start = [...column].sort(compareCards).map((item) => item.id);
    for (const id of start) {
      for (let index = 0; index < start.length; index += 1) {
        const expected = start.filter((item) => item !== id);
        expected.splice(index, 0, id);
        assert.deepEqual(move(column, id, index).order, expected, `card ${id} to ${index} in ${JSON.stringify(column)}`);
      }
    }
  }
});

test('the board lists each column in rank order, then by position', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-card-order-'));
  const port = await freePort();
  const child = await startServer(dataDir, port, { API_TOKEN: 'order-token' });
  t.after(async () => { await stopServer(child); await rm(dataDir, { recursive: true, force: true }); });
  const send = (path, method = 'GET', body) => fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { authorization: 'Bearer order-token', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  }).then((response) => response.json());
  const todo = await send('/api/kanban/columns', 'POST', { name: 'To do' });
  const ids = [];
  for (const title of ['first', 'second', 'third', 'fourth']) ids.push((await send('/api/kanban/cards', 'POST', { columnId: todo.id, title })).id);
  await send('/api/kanban/cards/ranks', 'PUT', { ranks: [{ id: ids[3], rank: 1 }, { id: ids[1], rank: 2 }] });
  const expected = [ids[3], ids[1], ids[0], ids[2]];
  assert.deepEqual((await send('/api/kanban')).cards.map((item) => item.id), expected);
  assert.deepEqual((await send('/api/kanban/cards')).map((item) => item.id), expected);
  assert.deepEqual((await send('/api/kanban?teamId=all')).cards.map((item) => item.id), expected);
});
