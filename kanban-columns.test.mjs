import assert from 'node:assert/strict';
import test from 'node:test';
import { columnControls, dropTarget, moveTarget, reorderColumns } from './public/kanban-columns.js';

const columns = [{ id: 1, name: 'To do', position: 0 }, { id: 2, name: 'Doing', position: 1 }, { id: 3, name: 'Done', position: 2 }];
const names = (list) => list.map((column) => [column.name, column.position]);

test('moving a column left or right lands one place over and stops at the edges', () => {
  assert.equal(moveTarget(columns, 2, -1), 0);
  assert.equal(moveTarget(columns, 2, 1), 2);
  assert.equal(moveTarget(columns, 1, -1), null);
  assert.equal(moveTarget(columns, 3, 1), null);
  assert.equal(moveTarget(columns, 99, 1), null);
});

test('dropping a column on another takes that column place, and the board reorders to match', () => {
  assert.equal(dropTarget(columns, 3, 1), 0);
  assert.equal(dropTarget(columns, 1, 3), 2);
  assert.equal(dropTarget(columns, 2, 2), null);
  assert.deepEqual(names(reorderColumns(columns, 3, 0)), [['Done', 0], ['To do', 1], ['Doing', 2]]);
  assert.deepEqual(names(reorderColumns(columns, 1, 2)), [['Doing', 0], ['Done', 1], ['To do', 2]]);
  assert.deepEqual(names(reorderColumns(columns, 2, 99)), [['To do', 0], ['Done', 1], ['Doing', 2]]);
  assert.equal(reorderColumns(columns, 99, 0), columns);
});

test('only column managers get the move controls, and the edge moves are disabled', () => {
  assert.equal(columnControls(columns[0], 0, 3, false), '');
  const first = columnControls(columns[0], 0, 3, true);
  assert.match(first, /class="column-move-left" aria-label="Move To do left" title="Move left" disabled/);
  assert.doesNotMatch(first, /class="column-move-right"[^>]*disabled/);
  const last = columnControls(columns[2], 2, 3, true);
  assert.match(last, /class="column-move-right"[^>]*disabled/);
  assert.match(columnControls({ id: 4, name: '<b>', position: 0 }, 0, 1, true), /Move &lt;b&gt; left/);
});
