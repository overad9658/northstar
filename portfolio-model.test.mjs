import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filterProjects,
  findFocusNowOccupant,
  projectLabel,
  projectStatusClass,
  projectStatusLabel,
  selectPortfolioProjects,
} from './public/portfolio-model.js';

const projects = [
  { id: 1, projectId: 'API-1', name: 'API migration', team: 'Platform', status: 'Active', description: 'Move traffic', externalUrl: '', archived: 0, impact: 8, urgency: 8 },
  { id: 2, projectId: '', name: 'Design refresh', team: 'Design', status: 'Scheduled', scheduleStage: 'Planning', description: '', externalUrl: '', archived: 0, impact: 4, urgency: 5 },
  { id: 3, projectId: '', name: 'Old service', team: 'Platform', status: 'Complete', description: '', externalUrl: '', archived: 0, impact: 7, urgency: 7 },
  { id: 4, projectId: '', name: 'Archived work', team: 'Platform', status: 'Active', description: '', externalUrl: '', archived: 1, impact: 3, urgency: 3 },
];

test('portfolio presentation helpers keep labels and status classes consistent', () => {
  assert.equal(projectLabel(projects[0]), 'API-1');
  assert.equal(projectLabel(projects[1]), 'DR');
  assert.equal(projectStatusLabel(projects[1]), 'Scheduled · Planning');
  assert.equal(projectStatusClass(projects[1]), 'scheduled-planning');
  assert.equal(projectStatusClass({ status: 'On hold' }), 'hold');
});

test('project filters combine archive, status, team, and text criteria', () => {
  const filters = { showArchived: false, status: 'All', selectedTeams: ['Platform'], query: 'traffic' };
  assert.deepEqual(filterProjects(projects, filters).map((project) => project.id), [1]);
  assert.deepEqual(filterProjects(projects, { ...filters, query: '', status: 'Complete' }).map((project) => project.id), [3]);
});

test('portfolio selectors distinguish visible, matrix, and active projects', () => {
  const selected = selectPortfolioProjects(projects, { showArchived: false, showCompleted: false, status: 'All', selectedTeams: [], query: '' });
  assert.deepEqual(selected.visible.map((project) => project.id), [1, 2, 3]);
  assert.deepEqual(selected.matrix.map((project) => project.id), [1, 2]);
  assert.deepEqual(selected.active.map((project) => project.id), [1]);
});

test('Focus Now conflict previews are team-scoped and ignore the edited project', () => {
  const edited = { ...projects[1], team: 'Platform' };
  assert.equal(findFocusNowOccupant(projects, edited, 6, 6)?.id, 1);
  assert.equal(findFocusNowOccupant(projects, edited, 5, 6), null);
  assert.equal(findFocusNowOccupant(projects, projects[0], 9, 9), null);
});
