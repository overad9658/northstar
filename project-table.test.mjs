import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ariaSort, COLUMN_IDS, DEFAULT_SORT, formatSort, MOBILE_COLUMNS, parseSort, sortProjects, toggleSort, visibleColumns,
} from './public/shared/project-table.js';

const projects = [
  { id: 1, projectId: 'OPS-10', name: 'beta', team: 'Platform', status: 'Active', impact: 8, urgency: 3, score: 6.1, cardCount: 2, openDecisionCount: 1, updatedAt: '2026-01-02 10:00:00' },
  { id: 2, projectId: 'OPS-9', name: 'Alpha', team: 'Design', status: 'Blocked', impact: 8, urgency: 9, score: 7.4, cardCount: 0, openDecisionCount: 0, updatedAt: '2026-01-05 10:00:00' },
  { id: 3, projectId: '', name: 'gamma', team: 'Platform', status: 'Active', impact: 2, urgency: 9, score: 3.2, updatedAt: '2026-01-01 10:00:00' },
];
const ids = (list) => list.map((project) => project.id);

test('the table has the agreed columns in order', () => {
  assert.deepEqual(COLUMN_IDS, ['id', 'name', 'team', 'status', 'stage', 'impact', 'urgency', 'confidence', 'effort', 'people', 'score', 'cards', 'decisions', 'updated']);
  assert.deepEqual(visibleColumns(MOBILE_COLUMNS).map((column) => column.id), ['name', 'status', 'score']);
  assert.deepEqual(visibleColumns(['nope']).map((column) => column.id), COLUMN_IDS.filter((id) => id !== 'stage'));
});

test('default sort is score, highest first', () => {
  assert.deepEqual(ids(sortProjects(projects)), [2, 1, 3]);
  assert.deepEqual(DEFAULT_SORT[0], { column: 'score', direction: 'desc' });
});

test('text sorts ignore case and compare numbers inside IDs; empty values go last both ways', () => {
  assert.deepEqual(ids(sortProjects(projects, [{ column: 'name', direction: 'asc' }])), [2, 1, 3]);
  assert.deepEqual(ids(sortProjects(projects, [{ column: 'id', direction: 'asc' }])), [2, 1, 3]);
  assert.deepEqual(ids(sortProjects(projects, [{ column: 'id', direction: 'desc' }])), [1, 2, 3]);
  assert.deepEqual(ids(sortProjects(projects, [{ column: 'decisions', direction: 'desc' }])), [1, 2, 3]);
});

test('secondary sort breaks ties, and the input is not mutated', () => {
  const before = ids(projects);
  assert.deepEqual(ids(sortProjects(projects, [{ column: 'impact', direction: 'desc' }, { column: 'urgency', direction: 'asc' }])), [1, 2, 3]);
  assert.deepEqual(ids(sortProjects(projects, [{ column: 'team', direction: 'asc' }, { column: 'updated', direction: 'desc' }])), [2, 1, 3]);
  assert.deepEqual(ids(projects), before);
});

test('header clicks: plain click replaces and flips, shift-click adds and flips', () => {
  let sorts = toggleSort(DEFAULT_SORT, 'name');
  assert.deepEqual(sorts, [{ column: 'name', direction: 'asc' }]);
  sorts = toggleSort(sorts, 'name');
  assert.deepEqual(sorts, [{ column: 'name', direction: 'desc' }]);
  assert.deepEqual(toggleSort(sorts, 'impact'), [{ column: 'impact', direction: 'desc' }]);
  sorts = toggleSort(sorts, 'impact', { add: true });
  assert.deepEqual(sorts, [{ column: 'name', direction: 'desc' }, { column: 'impact', direction: 'desc' }]);
  sorts = toggleSort(sorts, 'impact', { add: true });
  assert.deepEqual(sorts[1], { column: 'impact', direction: 'asc' });
  assert.equal(ariaSort(sorts, 'name'), 'descending');
  assert.equal(ariaSort(sorts, 'impact'), 'ascending');
  assert.equal(ariaSort(sorts, 'team'), 'none');
});

test('sort text round-trips and drops unknown or repeated columns', () => {
  assert.deepEqual(parseSort('score:desc,name,bogus:asc,score:asc'), [{ column: 'score', direction: 'desc' }, { column: 'name', direction: 'asc' }]);
  assert.equal(formatSort(parseSort('team:asc,updated:desc')), 'team:asc,updated:desc');
  assert.deepEqual(parseSort(''), []);
});
