// The board helpers on their own: team and column resolution, the status line, the audit and the export.
import assert from 'node:assert/strict';
import test from 'node:test';
import { auditBoard, exportBoard, resolveColumn, resolveTeam, withStatusLine } from '../board.mjs';

const DAY = new Date('2026-10-30T12:00:00Z');

test('a team is named by id or by name, and a missing one lists the teams', () => {
  const teams = [{ id: 1, name: 'Platform' }, { id: 2, name: 'Data Ops' }];
  assert.equal(resolveTeam(teams, 'data ops').id, 2);
  assert.equal(resolveTeam(teams, '1').name, 'Platform');
  assert.throws(() => resolveTeam(teams, 'Ghosts'), { status: 404, message: 'No team "Ghosts". Teams: Platform, Data Ops.' });
});

test('a column is found on the named team only, never by default', () => {
  const columns = [{ id: 5, name: 'To do' }, { id: 6, name: 'In progress' }];
  assert.equal(resolveColumn(columns, ' in PROGRESS ', 'Platform').id, 6);
  assert.throws(() => resolveColumn(columns, 'Done', 'Platform'), { status: 404, message: 'Platform has no column "Done". Its columns: To do, In progress.' });
  assert.throws(() => resolveColumn([], 'To do', 'Empty'), /Its columns: none\./);
});

test('the status line replaces the older one in place, and goes first when there is none', () => {
  assert.equal(withStatusLine('', 'Started', DAY), 'Status 2026-10-30: Started');
  assert.equal(withStatusLine('Goal: ship it.', 'Started', DAY), 'Status 2026-10-30: Started\n\nGoal: ship it.');
  const older = 'Goal: ship it.\nStatus 2026-10-01: Planned\nOwner: ops\nStatus 2026-09-01: Stale';
  assert.equal(withStatusLine(older, '  Half   done ', DAY), 'Goal: ship it.\nStatus 2026-10-30: Half done\nOwner: ops');
  assert.throws(() => withStatusLine('x'.repeat(990), 'Too long for the limit', DAY), { status: 400 });
});

const BOARDS = [
  { team: { id: 1, name: 'Platform' }, columns: [{ id: 10, name: 'Backlog', position: 0 }, { id: 11, name: 'In progress', position: 1 }],
    cards: [
      { id: 3, columnId: 11, projectId: 100, title: 'Build', assignee: 'ops-bot', externalUrl: 'https://t.example/1', archived: 0, teamName: 'Platform', columnKey: 'in progress' },
      { id: 4, columnId: 10, projectId: 101, title: 'Later', assignee: 'Ops Bot', externalUrl: '', archived: 0 },
      { id: 5, columnId: 11, projectId: 102, title: 'Idea work', assignee: '', externalUrl: 'https://t.example/1', archived: 1 },
    ] },
  { team: { id: 2, name: 'Data' }, columns: [{ id: 20, name: 'in progress', position: 0 }],
    cards: [{ id: 7, columnId: 20, projectId: 103, title: 'Pipeline', assignee: 'ops-bot', externalUrl: 'https://t.example/2', archived: 0 }] },
];
const PROJECTS = [
  { id: 100, projectId: 'P-1', name: 'Build it', status: 'Scheduled', scheduleStage: 'To plan', description: 'No status yet', archived: 0 },
  { id: 101, projectId: 'P-2', name: 'Later', status: 'Scheduled', scheduleStage: 'To plan', description: '', archived: 0 },
  { id: 102, projectId: 'P-3', name: 'An idea', status: 'Scheduled', scheduleStage: 'Idea', description: '', archived: 0 },
  { id: 103, projectId: 'P-4', name: 'Pipeline', status: 'Active', scheduleStage: 'To plan', description: 'Status 2026-10-29: Flowing', archived: 0, openDecisionCount: 2, score: 40 },
];

test('the audit lists each kind of problem, with the active columns the caller names', () => {
  const problems = auditBoard({ boards: BOARDS, projects: PROJECTS, activeColumns: ['In Progress'], assigneeVariants: { 'ops-bot': 'Ops Bot' } });
  assert.deepEqual(problems.map((p) => [p.problem, p.projectId ?? p.cardId ?? p.externalUrl]), [
    ['scheduled_with_active_cards', 100],
    ['no_status_line', 100],
    ['assignee_variant', 3],
    ['assignee_variant', 7],
    ['duplicate_external_url', 'https://t.example/1'],
  ]);
  assert.deepEqual(problems[0].cards, [{ cardId: 3, key: null, title: 'Build', team: 'Platform', column: 'In progress' }]);
  assert.deepEqual(problems[4].cards.map((c) => [c.cardId, c.archived]), [[3, false], [5, true]]);
  // nothing counts as active unless the caller says so
  assert.deepEqual(auditBoard({ boards: BOARDS, projects: PROJECTS, activeColumns: ['Review'] }).map((p) => p.problem), ['duplicate_external_url']);
});

test('the export is stable: id order, sorted keys, no per-request fields', () => {
  const teams = [{ id: 2, name: 'Data', capacity: 3, projectCount: 1 }, { id: 1, name: 'Platform', capacity: 5, projectCount: 3 }];
  const out = exportBoard({ teams, boards: [...BOARDS].reverse(), projects: [...PROJECTS].reverse() });
  assert.deepEqual(Object.keys(out), ['cards', 'columns', 'projects', 'teams']);
  assert.deepEqual(out.teams, [{ capacity: 5, id: 1, name: 'Platform' }, { capacity: 3, id: 2, name: 'Data' }]);
  assert.deepEqual(out.columns.map((c) => c.id), [10, 11, 20]);
  assert.deepEqual(out.cards.map((c) => c.id), [3, 4, 5, 7]);
  assert.equal(out.cards[0].teamName, undefined);
  assert.equal(out.cards[0].columnKey, undefined);
  assert.equal(out.projects.at(-1).openDecisionCount, undefined);
  assert.equal(JSON.stringify(out), JSON.stringify(exportBoard({ teams: [...teams].reverse(), boards: BOARDS, projects: PROJECTS })));
});
