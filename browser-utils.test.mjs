import assert from 'node:assert/strict';
import test from 'node:test';
import {
  capacityForTeams,
  escapeHtml,
  initials,
  isFocusProject,
  matrixPosition,
  needsBlockedNote,
  scoresFromPoint,
} from './public/browser-utils.js';
import { layoutProjectDots } from './public/matrix-geometry.js';

test('browser formatting helpers normalize labels safely', () => {
  assert.equal(initials('API migration'), 'AM');
  assert.equal(escapeHtml('<script>"unsafe"</script>'), '&lt;script&gt;&quot;unsafe&quot;&lt;/script&gt;');
});

test('matrix helpers convert scores and pointer positions consistently', () => {
  assert.deepEqual(matrixPosition(1, 1), { left: 95, bottom: 5 });
  assert.deepEqual(matrixPosition(10, 10), { left: 5, bottom: 95 });
  assert.deepEqual(scoresFromPoint({ left: 0, right: 100, bottom: 100, width: 100, height: 100 }, 50, 50), { urgency: 6, impact: 6 });
});

test('matrix layout separates projects with identical scores inside its bounds', () => {
  const dots = [
    { impact: 8, urgency: 8, width: 40, height: 40 },
    { impact: 8, urgency: 8, width: 40, height: 40 },
  ];
  const [first, second] = layoutProjectDots(dots, 600, 400);
  assert.notDeepEqual(first, second);
  assert.ok(Math.abs(first.x - second.x) >= 45 || Math.abs(first.y - second.y) >= 45);
  for (const position of [first, second]) {
    assert.ok(position.x >= 23 && position.x <= 577);
    assert.ok(position.y >= 23 && position.y <= 377);
  }
});

test('browser Focus Now preview matches portfolio eligibility rules', () => {
  assert.equal(isFocusProject({ archived: 0, status: 'Active', impact: 6, urgency: 6 }), true);
  assert.equal(isFocusProject({ archived: 0, status: 'Complete', impact: 10, urgency: 10 }), false);
});

test('capacity totals follow all or multiple selected teams', () => {
  const teams = [{ name: 'Platform', capacity: 8 }, { name: 'Design', capacity: 5 }, { name: 'Data', capacity: 4 }];
  const projects = [
    { team: 'Platform', capacity: 3, status: 'Active', archived: 0 },
    { team: 'Design', capacity: 2, status: 'Blocked', archived: 0 },
    { team: 'Data', capacity: 4, status: 'Complete', archived: 0 },
  ];
  assert.deepEqual(capacityForTeams(teams, projects), { total: 17, occupied: 5, available: 12 });
  assert.deepEqual(capacityForTeams(teams, projects, ['Platform', 'Data']), { total: 12, occupied: 3, available: 9 });
});

test('blocked notes are requested only when entering Blocked', () => {
  assert.equal(needsBlockedNote('Active', 'Blocked'), true);
  assert.equal(needsBlockedNote('Blocked', 'Blocked'), false);
  assert.equal(needsBlockedNote('Blocked', 'Active'), false);
});
