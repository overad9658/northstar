import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isFocusProject,
  scheduledCapacityConflict,
  validateProject,
  validateScores,
} from './project-domain.mjs';

test('validateProject normalizes a complete project', () => {
  const result = validateProject({
    name: '  API migration  ',
    project_id: ' API-42 ',
    external_url: 'https://example.com/project',
    blocked_note: ' Waiting on vendor ',
    archive_note: ' Superseded by platform work ',
    restore_note: ' Priority returned ',
    impact: '9',
    urgency: 8,
    confidence: 7,
    effort: 6,
    archived: true,
  });

  assert.deepEqual(result, { value: {
    name: 'API migration',
    projectId: 'API-42',
    externalUrl: 'https://example.com/project',
    blockedNote: 'Waiting on vendor',
    archiveNote: 'Superseded by platform work',
    restoreNote: 'Priority returned',
    impact: 9,
    urgency: 8,
    confidence: 7,
    effort: 6,
    archived: 1,
  } });
});

test('validateProject rejects missing fields, unsafe links, and invalid scores', () => {
  assert.match(validateProject({}).error, /required/);
  assert.match(validateProject({ name: 'Project', impact: 5, urgency: 5, confidence: 5, effort: 5, externalUrl: 'javascript:alert(1)' }).error, /HTTP or HTTPS/);
  assert.match(validateProject({ name: 'Project', impact: 11, urgency: 5, confidence: 5, effort: 5 }).error, /impact/);
});

test('validateScores requires every score', () => {
  assert.deepEqual(validateScores({ impact: 1, urgency: '2', confidence: 3, effort: 4 }), { impact: 1, urgency: 2, confidence: 3, effort: 4 });
  assert.throws(() => validateScores({ impact: 1, urgency: 2, confidence: 3 }), /effort/);
});

test('portfolio placement rules are independent of persistence', () => {
  assert.equal(isFocusProject({ archived: 0, status: 'Active', impact: 6, urgency: 6 }), true);
  assert.equal(isFocusProject({ archived: 1, status: 'Active', impact: 10, urgency: 10 }), false);
  assert.match(scheduledCapacityConflict({ status: 'Scheduled', scheduleStage: 'To plan', capacity: 1 }), /Planning/);
  assert.equal(scheduledCapacityConflict({ status: 'Scheduled', scheduleStage: 'Planning', capacity: 1 }), '');
});
