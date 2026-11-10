import assert from 'node:assert/strict';
import test from 'node:test';
import { columnKey, mergeBoards, targetColumn } from './public/shared/kanban-boards.js';

const boards = [
  { team: { id: 1, name: 'Platform' }, columns: [{ id: 10, name: 'To do' }, { id: 11, name: 'Doing' }, { id: 12, name: 'Done' }],
    cards: [{ id: 100, columnId: 10, title: 'A' }, { id: 101, columnId: 12, title: 'B' }] },
  { team: { id: 2, name: 'Design' }, columns: [{ id: 20, name: 'Ideas' }, { id: 21, name: ' to do ' }, { id: 22, name: 'Review' }, { id: 23, name: 'DONE' }],
    cards: [{ id: 200, columnId: 21, title: 'C' }, { id: 201, columnId: 22, title: 'D' }] },
  { team: { id: 3, name: 'Empty' }, columns: [], cards: [] },
];

test('columns merge by name in the first team\'s order, with each team\'s extra columns appended', () => {
  const merged = mergeBoards(boards);
  assert.deepEqual(merged.columns.map((column) => column.name), ['To do', 'Doing', 'Done', 'Ideas', 'Review']);
  assert.deepEqual(merged.columns.map((column) => column.key), ['to do', 'doing', 'done', 'ideas', 'review']);
  assert.deepEqual(merged.columns[0].columns, [{ teamId: 1, id: 10 }, { teamId: 2, id: 21 }]);
  assert.deepEqual(merged.columns[2].columns, [{ teamId: 1, id: 12 }, { teamId: 2, id: 23 }]);
  assert.deepEqual(merged.teams, [{ id: 1, name: 'Platform' }, { id: 2, name: 'Design' }, { id: 3, name: 'Empty' }]);
  assert.equal(columnKey('  Done '), columnKey('done'));
});

test('every card keeps its own column and team and carries the badge data', () => {
  const { cards } = mergeBoards(boards);
  assert.deepEqual(cards.map(({ id, columnId, teamId, teamName, columnKey: key }) => ({ id, columnId, teamId, teamName, key })), [
    { id: 100, columnId: 10, teamId: 1, teamName: 'Platform', key: 'to do' },
    { id: 101, columnId: 12, teamId: 1, teamName: 'Platform', key: 'done' },
    { id: 200, columnId: 21, teamId: 2, teamName: 'Design', key: 'to do' },
    { id: 201, columnId: 22, teamId: 2, teamName: 'Design', key: 'review' },
  ]);
});

test('a drop lands on the same-named column of the card\'s own team, or is refused', () => {
  const { columns } = mergeBoards(boards);
  const byKey = (key) => columns.find((column) => column.key === key);
  assert.equal(targetColumn(byKey('done'), 2), 23);
  assert.equal(targetColumn(byKey('done'), 1), 12);
  assert.equal(targetColumn(byKey('review'), 1), null);
  assert.equal(targetColumn(byKey('doing'), 2), null);
  assert.equal(targetColumn(undefined, 1), null);
});
