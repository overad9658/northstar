import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyFilters, drillFilter, hasTableParams, normalizeFilters, paramsToState, stateToParams,
} from './public/shared/project-table.js';

const projects = [
  { id: 1, projectId: 'OPS-10', name: 'Billing rewrite', team: 'Platform', status: 'Active', impact: 8, urgency: 3, score: 6.1, description: 'move invoices', updatedAt: '2026-01-02 10:00:00' },
  { id: 2, projectId: 'DES-2', name: 'Alpha site', team: 'Design', status: 'Blocked', impact: 5, urgency: 9, score: 7.4, updatedAt: '2026-01-05 10:00:00' },
  { id: 3, projectId: '', name: 'gamma', team: 'Platform', status: 'Complete', impact: 2, urgency: 9, score: 3.2, updatedAt: '2026-01-09 08:00:00' },
];
const ids = (list) => list.map((project) => project.id);

test('text contains ignores case; enums match any chosen value; ranges are inclusive and open-ended', () => {
  assert.deepEqual(ids(applyFilters(projects, { name: { contains: 'ALPHA' } })), [2]);
  assert.deepEqual(ids(applyFilters(projects, { team: { in: ['Platform'] }, status: { in: ['Active', 'Complete'] } })), [1, 3]);
  assert.deepEqual(ids(applyFilters(projects, { impact: { min: 5 } })), [1, 2]);
  assert.deepEqual(ids(applyFilters(projects, { impact: { min: 2, max: 5 } })), [2, 3]);
  assert.deepEqual(ids(applyFilters(projects, { updated: { min: '2026-01-05', max: '2026-01-05' } })), [2]);
});

test('global search runs alongside column filters over ID, name, team, description and source', () => {
  assert.deepEqual(ids(applyFilters(projects, {}, 'invoices')), [1]);
  assert.deepEqual(ids(applyFilters(projects, { team: { in: ['Platform'] } }, 'gam')), [3]);
});

test('empty or unknown filters are dropped, not applied', () => {
  assert.deepEqual(normalizeFilters({ name: { contains: '  ' }, team: { in: [] }, impact: { min: '', max: 'x' }, bogus: { contains: 'a' } }), {});
  assert.deepEqual(ids(applyFilters(projects, { bogus: { contains: 'nothing' } })), [1, 2, 3]);
});

test('drill-through filters on the clicked value exactly', () => {
  assert.deepEqual(drillFilter('team', projects[0]), { in: ['Platform'] });
  assert.deepEqual(drillFilter('impact', projects[0]), { min: 8, max: 8 });
  assert.deepEqual(drillFilter('updated', projects[0]), { min: '2026-01-02', max: '2026-01-02' });
  assert.deepEqual(drillFilter('id', projects[2]), null);
  assert.deepEqual(ids(applyFilters(projects, { impact: drillFilter('impact', projects[1]) })), [2]);
});

test('table state survives the query string both ways', () => {
  const state = {
    query: 'site', sort: [{ column: 'score', direction: 'desc' }, { column: 'name', direction: 'asc' }], columns: ['name', 'team', 'score'],
    filters: { team: { in: ['Design', 'Platform'] }, impact: { min: 3 }, name: { contains: 'a b' } },
  };
  const text = stateToParams(state).toString();
  assert.match(text, /f\.team=Design&f\.team=Platform/);
  assert.match(text, /f\.impact=3\.\./);
  assert.deepEqual(paramsToState(text), state);
  assert.deepEqual(paramsToState('f.urgency=9'), { query: '', sort: [], columns: [], filters: { urgency: { min: 9, max: 9 } } });
  assert.equal(hasTableParams('projectId=OPS-1'), false);
  assert.equal(hasTableParams('f.team=Design'), true);
});
