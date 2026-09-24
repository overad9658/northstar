import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { startServer, stopServer } from './support/server-fixture.mjs';

test('complete portfolio workflow remains consistent across persistence and restore', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-test-'));
  const port = 31000 + (process.pid % 1000);
  const legacyDb = new DatabaseSync(join(dataDir, 'northstar.db'));
  legacyDb.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      team TEXT NOT NULL DEFAULT 'Platform', status TEXT NOT NULL DEFAULT 'Active', impact INTEGER NOT NULL,
      urgency INTEGER NOT NULL, confidence INTEGER NOT NULL, effort INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO projects (name, status, impact, urgency, confidence, effort) VALUES ('Jfrog Migration', 'Planned', 8, 5, 7, 6);
  `);
  legacyDb.close();
  let child = await startServer(dataDir, port);
  const base = `http://127.0.0.1:${port}/api/projects`;
  let migrated;
  let created;
  let session;
  try {
    await t.test('legacy migration, CRUD, capacity, export, and move history', async () => {
    migrated = await (await fetch(base)).json();
    assert.equal(migrated[0].name, 'Jfrog Migration');
    assert.equal(migrated[0].projectId, '');
    assert.equal(migrated[0].externalUrl, '');
    assert.equal(migrated[0].status, 'Scheduled');
    assert.equal(migrated[0].scheduleStage, 'To plan');
    assert.equal(migrated[0].capacity, 0);
    assert.equal(migrated[0].archived, 0);
    assert.equal(migrated[0].retrospective, '');

    const initialCapacity = await (await fetch(`http://127.0.0.1:${port}/api/capacity`)).json();
    assert.deepEqual(initialCapacity, { total: 0, occupied: 0, available: 0 });
    const capacityResponse = await fetch(`http://127.0.0.1:${port}/api/capacity`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ total: 8 }),
    });
    assert.equal(capacityResponse.status, 200);
    assert.equal((await capacityResponse.json()).available, 8);
    let teams = await (await fetch(`http://127.0.0.1:${port}/api/teams`)).json();
    assert.equal(teams.length, 1);
    assert.equal(teams[0].name, 'Platform');
    assert.equal(teams[0].capacity, 8);

    const unplannedAssignment = await fetch(base, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Future migration', status: 'Scheduled', scheduleStage: 'To plan', capacity: 1, impact: 2, urgency: 2, confidence: 5, effort: 5 }),
    });
    assert.equal(unplannedAssignment.status, 409);
    assert.match((await unplannedAssignment.json()).error, /stage is Planning/);

    const planningAssignment = await fetch(base, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Planning migration', status: 'Scheduled', scheduleStage: 'Planning', capacity: 1, impact: 2, urgency: 2, confidence: 5, effort: 5 }),
    });
    assert.equal(planningAssignment.status, 201);
    const planningProject = await planningAssignment.json();
    assert.equal(planningProject.scheduleStage, 'Planning');
    assert.equal(planningProject.capacity, 1);
    assert.equal((await fetch(`${base}/${planningProject.id}`, { method: 'DELETE' })).status, 204);

    const createdResponse = await fetch(base, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'API-42', externalUrl: 'https://github.com/example/api-migration', name: 'API migration', description: 'Move the public API', team: 'Platform', status: 'Blocked', blockedNote: 'Waiting for the vendor firewall change.', capacity: 3, impact: 9, urgency: 8, confidence: 7, effort: 6 }),
    });
    assert.equal(createdResponse.status, 201);
    created = await createdResponse.json();
    assert.equal(created.name, 'API migration');
    assert.equal(created.projectId, 'API-42');
    assert.equal(created.externalUrl, 'https://github.com/example/api-migration');
    assert.equal(created.status, 'Blocked');
    assert.equal(created.blockedNote, 'Waiting for the vendor firewall change.');
    assert.equal(created.capacity, 3);
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/capacity`)).json()).available, 5);
    assert.equal(created.score, 8);

    const tooSmallTeamCapacity = await fetch(`http://127.0.0.1:${port}/api/teams/${teams[0].id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ capacity: 2 }),
    });
    assert.equal(tooSmallTeamCapacity.status, 409);
    assert.match((await tooSmallTeamCapacity.json()).error, /3 people currently assigned/);

    const designTeamResponse = await fetch(`http://127.0.0.1:${port}/api/teams`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Design', capacity: 5 }),
    });
    assert.equal(designTeamResponse.status, 201);
    const designTeam = await designTeamResponse.json();

    const otherTeamFocusResponse = await fetch(base, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Design focus', team: 'Design', impact: 8, urgency: 8, confidence: 7, effort: 5 }),
    });
    assert.equal(otherTeamFocusResponse.status, 201);
    const otherTeamFocus = await otherTeamFocusResponse.json();
    assert.equal(await fetch(`${base}/${otherTeamFocus.id}`, { method: 'DELETE' }).then((response) => response.status), 204);
    assert.equal(await fetch(`http://127.0.0.1:${port}/api/teams/${designTeam.id}`, { method: 'DELETE' }).then((response) => response.status), 204);

    const statusExportResponse = await fetch(`http://127.0.0.1:${port}/api/status-export`);
    assert.equal(statusExportResponse.status, 200);
    assert.match(statusExportResponse.headers.get('content-type'), /^text\/csv/);
    assert.match(statusExportResponse.headers.get('content-disposition'), /northstar-project-status-/);
    const statusExport = await statusExportResponse.text();
    assert.match(statusExport, /"API-42","API migration","Platform","Blocked"/);
    assert.match(statusExport, /"Blocked","Waiting for the vendor firewall change\."/);
    assert.doesNotMatch(statusExport, /Jfrog Migration/);

    const invalidSourceResponse = await fetch(base, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Invalid source', externalUrl: 'javascript:alert(1)', impact: 2, urgency: 2, confidence: 5, effort: 5 }),
    });
    assert.equal(invalidSourceResponse.status, 400);
    assert.match((await invalidSourceResponse.json()).error, /HTTP or HTTPS/);

    const overbookedProject = await fetch(base, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Overbooked work', status: 'Active', capacity: 6, impact: 2, urgency: 2, confidence: 5, effort: 5 }),
    });
    assert.equal(overbookedProject.status, 409);
    assert.match((await overbookedProject.json()).error, /Platform capacity is 8/);

    const overbookedUpdate = await fetch(`${base}/${created.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ capacity: 9 }),
    });
    assert.equal(overbookedUpdate.status, 409);

    const tooSmallCapacity = await fetch(`http://127.0.0.1:${port}/api/capacity`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ total: 2 }),
    });
    assert.equal(tooSmallCapacity.status, 409);
    assert.match((await tooSmallCapacity.json()).error, /3 people currently assigned/);

    const focusConflictResponse = await fetch(`${base}/${migrated[0].id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ urgency: 8 }),
    });
    assert.equal(focusConflictResponse.status, 409);
    assert.match((await focusConflictResponse.json()).error, /Each team can have one project/);

    const updatedResponse = await fetch(`${base}/${created.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ urgency: 10, moveComment: 'Customer deadline moved forward.' }) });
    assert.equal(updatedResponse.status, 200);
    assert.equal((await updatedResponse.json()).urgency, 10);
    const firstMoves = await (await fetch(`${base}/${created.id}/moves`)).json();
    assert.equal(firstMoves.length, 1);
    assert.equal(firstMoves[0].fromUrgency, 8);
    assert.equal(firstMoves[0].toUrgency, 10);
    assert.equal(firstMoves[0].source, 'Project update');
    assert.equal(firstMoves[0].comment, 'Customer deadline moved forward.');
    assert.match(firstMoves[0].movedAt, /^\d{4}-\d{2}-\d{2}/);

    });

    await t.test('planning rooms support voting, decisions, and placement conflicts', async () => {
    const sessionResponse = await fetch(`http://127.0.0.1:${port}/api/planning-sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectIds: [created.id, migrated[0].id] }),
    });
    assert.equal(sessionResponse.status, 201);
    session = await sessionResponse.json();
    assert.ok(session.token);
    assert.ok(session.leaderKey);

    const anonymousVoteResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/${session.token}/votes`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: created.id, voterName: '', impact: 8, urgency: 7, confidence: 6, effort: 5 }),
    });
    assert.equal(anonymousVoteResponse.status, 200);
    const anonymousVote = await anonymousVoteResponse.json();
    assert.match(anonymousVote.voterName, /^[A-Z][a-z]+ [A-Z][a-z]+ \d{2}$/);
    assert.equal(anonymousVote.room.votes.length, 1);
    assert.equal(anonymousVote.room.projects.length, 2);
    assert.equal(anonymousVote.room.projects.find((project) => project.id === created.id).impact, 9);
    assert.equal(anonymousVote.room.projects.find((project) => project.id === created.id).urgency, 10);

    const secondProjectVoteResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/${session.token}/votes`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: migrated[0].id, voterToken: anonymousVote.voterToken, voterName: '', impact: 6, urgency: 5, confidence: 8, effort: 4 }),
    });
    assert.equal(secondProjectVoteResponse.status, 200);
    const secondProjectVote = await secondProjectVoteResponse.json();
    assert.equal(secondProjectVote.room.votes.length, 2);
    assert.equal(secondProjectVote.room.participantCount, 1);

    const updatedVoteResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/${session.token}/votes`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: created.id, voterToken: anonymousVote.voterToken, voterName: '', impact: 9, urgency: 8, confidence: 7, effort: 6 }),
    });
    const updatedVote = await updatedVoteResponse.json();
    assert.equal(updatedVote.room.votes.length, 2);
    const updatedCreatedVote = updatedVote.room.votes.find((vote) => vote.projectId === created.id);
    assert.equal(updatedCreatedVote.voterName, anonymousVote.voterName);
    assert.equal(updatedCreatedVote.impact, 9);

    const privateRoom = await (await fetch(`http://127.0.0.1:${port}/api/sessions/${session.token}`)).json();
    assert.equal(privateRoom.votes.find((vote) => vote.projectId === created.id).impact, null);
    assert.equal(privateRoom.projects.find((project) => project.id === created.id).revealed, 0);

    const forbiddenDecision = await fetch(`http://127.0.0.1:${port}/api/sessions/${session.token}/decide`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ leaderKey: 'wrong', projectId: created.id, impact: 10, urgency: 9, confidence: 8, effort: 5 }),
    });
    assert.equal(forbiddenDecision.status, 403);

    const hiddenDecision = await fetch(`http://127.0.0.1:${port}/api/sessions/${session.token}/decide`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ leaderKey: session.leaderKey, projectId: created.id, impact: 10, urgency: 9, confidence: 8, effort: 5 }),
    });
    assert.equal(hiddenDecision.status, 409);

    const revealResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/${session.token}/reveal`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ leaderKey: session.leaderKey, projectId: created.id }),
    });
    assert.equal(revealResponse.status, 200);
    const revealedRoom = await revealResponse.json();
    assert.equal(revealedRoom.projects.find((project) => project.id === created.id).revealed, 1);
    assert.equal(revealedRoom.votes.find((vote) => vote.projectId === created.id).impact, 9);

    const decisionResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/${session.token}/decide`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ leaderKey: session.leaderKey, projectId: created.id, impact: 10, urgency: 9, confidence: 8, effort: 5, moveComment: 'Team consensus after revealing estimates.' }),
    });
    assert.equal(decisionResponse.status, 200);
    const decidedRoom = await decisionResponse.json();
    assert.equal(decidedRoom.status, 'Open');
    assert.equal(decidedRoom.projects.find((project) => project.id === created.id).finalImpact, 10);
    const tentativeMoves = await (await fetch(`${base}/${created.id}/moves`)).json();
    assert.equal(tentativeMoves.length, 1);
    assert.equal((await (await fetch(base)).json()).find((project) => project.id === created.id).impact, 9);

    const closedVote = await fetch(`http://127.0.0.1:${port}/api/sessions/${session.token}/votes`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: created.id, voterName: 'Late voter', impact: 5, urgency: 5, confidence: 5, effort: 5 }),
    });
    assert.equal(closedVote.status, 409);

    const finalRevealResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/${session.token}/reveal`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ leaderKey: session.leaderKey, projectId: migrated[0].id }),
    });
    assert.equal(finalRevealResponse.status, 200);

    const finalDecisionResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/${session.token}/decide`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ leaderKey: session.leaderKey, projectId: migrated[0].id, keepCurrent: true }),
    });
    assert.equal(finalDecisionResponse.status, 200);
    const completedRoom = await finalDecisionResponse.json();
    assert.equal(completedRoom.status, 'Closed');
    const planningMoves = await (await fetch(`${base}/${created.id}/moves`)).json();
    assert.equal(planningMoves.length, 2);
    assert.equal(planningMoves[0].source, 'Planning room');
    assert.equal(planningMoves[0].comment, 'Team consensus after revealing estimates.');
    assert.equal(planningMoves[0].fromImpact, 9);
    assert.equal(planningMoves[0].toImpact, 10);

    const retrospectiveResponse = await fetch(`${base}/${created.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'Complete', retrospective: 'The staged rollout worked well. Add rollback drills earlier next time.' }),
    });
    assert.equal(retrospectiveResponse.status, 200);
    const completedProject = await retrospectiveResponse.json();
    assert.equal(completedProject.status, 'Complete');
    assert.match(completedProject.retrospective, /rollback drills/);

    const focusCandidateA = await (await fetch(base, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Focus candidate A', status: 'Scheduled', scheduleStage: 'To plan', impact: 3, urgency: 3, confidence: 5, effort: 5 }),
    })).json();
    const focusCandidateB = await (await fetch(base, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Focus candidate B', status: 'Scheduled', scheduleStage: 'To plan', impact: 4, urgency: 4, confidence: 5, effort: 5 }),
    })).json();
    const conflictSession = await (await fetch(`http://127.0.0.1:${port}/api/planning-sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectIds: [focusCandidateA.id, focusCandidateB.id] }),
    })).json();
    for (const projectId of [focusCandidateA.id, focusCandidateB.id]) {
      const response = await fetch(`http://127.0.0.1:${port}/api/sessions/${conflictSession.token}/reveal`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ leaderKey: conflictSession.leaderKey, projectId }),
      });
      assert.equal(response.status, 200);
    }
    const firstFocusPlacement = await fetch(`http://127.0.0.1:${port}/api/sessions/${conflictSession.token}/decide`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ leaderKey: conflictSession.leaderKey, projectId: focusCandidateA.id, impact: 9, urgency: 9, confidence: 7, effort: 5 }),
    });
    assert.equal(firstFocusPlacement.status, 200);
    const conflictingPlacement = await fetch(`http://127.0.0.1:${port}/api/sessions/${conflictSession.token}/decide`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ leaderKey: conflictSession.leaderKey, projectId: focusCandidateB.id, impact: 8, urgency: 8, confidence: 7, effort: 5 }),
    });
    assert.equal(conflictingPlacement.status, 409);
    const conflict = await conflictingPlacement.json();
    assert.match(conflict.error, /cannot be placed in Focus Now/);
    assert.deepEqual(new Set(conflict.conflictProjectIds), new Set([focusCandidateA.id, focusCandidateB.id]));
    assert.equal(conflict.room.projects.filter((project) => project.status === 'Open').length, 2);
    assert.equal((await (await fetch(base)).json()).find((project) => project.id === focusCandidateA.id).impact, 3);

    for (const [projectId, impact, urgency] of [[focusCandidateA.id, 9, 9], [focusCandidateB.id, 4, 4]]) {
      const response = await fetch(`http://127.0.0.1:${port}/api/sessions/${conflictSession.token}/decide`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ leaderKey: conflictSession.leaderKey, projectId, impact, urgency, confidence: 7, effort: 5 }),
      });
      assert.equal(response.status, 200);
    }
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/sessions/${conflictSession.token}`)).json()).status, 'Closed');
    assert.equal((await fetch(`${base}/${focusCandidateA.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await fetch(`${base}/${focusCandidateB.id}`, { method: 'DELETE' })).status, 204);

    });

    await t.test('backup validation and atomic restore preserve portfolio data', async () => {
    const backupResponse = await fetch(`http://127.0.0.1:${port}/api/backup`);
    assert.equal(backupResponse.status, 200);
    assert.match(backupResponse.headers.get('content-disposition'), /northstar-backup-/);
    const backup = await backupResponse.json();
    assert.equal(backup.format, 'northstar-priority-matrix');
    assert.equal(backup.version, 1);
    assert.equal(backup.settings.totalCapacity, 8);
    assert.equal(backup.teams.length, 1);
    assert.equal(backup.teams[0].name, 'Platform');
    assert.equal(backup.teams[0].capacity, 8);
    assert.equal(backup.projects.length, 2);
    assert.equal(backup.projects.find((project) => project.id === created.id).external_url, 'https://github.com/example/api-migration');
    assert.equal(backup.projects.find((project) => project.id === created.id).blocked_note, '');
    assert.equal(backup.projects.find((project) => project.id === migrated[0].id).schedule_stage, 'To plan');
    assert.equal(backup.projectMoves.length, 2);
    assert.equal(backup.planningSessions.length, 1);
    assert.equal(backup.planningVotes.length, 2);

    assert.equal((await fetch(`${base}/${created.id}`, { method: 'DELETE' })).status, 204);
    const invalidRestore = await fetch(`http://127.0.0.1:${port}/api/backup`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...backup, version: 2 }),
    });
    assert.equal(invalidRestore.status, 400);
    assert.equal((await (await fetch(base)).json()).length, 1);

    const corruptRestore = await fetch(`http://127.0.0.1:${port}/api/backup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...backup, projects: backup.projects.map((project, index) => index ? project : { ...project, name: '' }) }),
    });
    assert.equal(corruptRestore.status, 400);
    assert.equal((await (await fetch(base)).json()).length, 1);

    const restoreResponse = await fetch(`http://127.0.0.1:${port}/api/backup`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(backup),
    });
    assert.equal(restoreResponse.status, 200);
    assert.deepEqual((await restoreResponse.json()).restored, { projects: 2, moves: 2, planningRooms: 1, votes: 2 });
    assert.equal((await (await fetch(base)).json()).length, 2);
    assert.equal((await (await fetch(`${base}/${created.id}/moves`)).json()).length, 2);
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/sessions/${session.token}`)).json()).votes.length, 2);

    });

    await t.test('restart persistence, archive capacity, and cascade deletion', async () => {
    await stopServer(child);
    child = await startServer(dataDir, port);
    const persisted = await (await fetch(base)).json();
    assert.equal(persisted.length, 2);
    assert.equal(persisted[0].name, 'API migration');
    assert.equal(persisted[0].projectId, 'API-42');
    assert.equal(persisted[0].externalUrl, 'https://github.com/example/api-migration');
    assert.equal(persisted[0].scheduleStage, 'To plan');
    assert.equal(persisted[0].impact, 10);
    assert.match(persisted[0].retrospective, /staged rollout/);
    assert.equal((await (await fetch(`${base}/${created.id}/moves`)).json()).length, 2);

    const missingArchiveNote = await fetch(`${base}/${created.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ archived: true }),
    });
    assert.equal(missingArchiveNote.status, 400);
    assert.match((await missingArchiveNote.json()).error, /archive note/i);
    const archiveResponse = await fetch(`${base}/${created.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ archived: true, archiveNote: 'Work has been superseded.' }),
    });
    assert.equal(archiveResponse.status, 200);
    const archivedProject = await archiveResponse.json();
    assert.equal(archivedProject.archived, 1);
    assert.equal(archivedProject.archiveNote, 'Work has been superseded.');
    const archivedCapacity = await (await fetch(`http://127.0.0.1:${port}/api/capacity`)).json();
    assert.deepEqual(archivedCapacity, { total: 8, occupied: 0, available: 8 });

    const missingRestoreNote = await fetch(`${base}/${created.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ archived: false }),
    });
    assert.equal(missingRestoreNote.status, 400);
    assert.match((await missingRestoreNote.json()).error, /restore note/i);
    const restoreProjectResponse = await fetch(`${base}/${created.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ archived: false, restoreNote: 'Funding has been restored.' }),
    });
    assert.equal(restoreProjectResponse.status, 200);
    const restoredProject = await restoreProjectResponse.json();
    assert.equal(restoredProject.archived, 0);
    assert.equal(restoredProject.restoreNote, 'Funding has been restored.');

    assert.equal((await fetch(`${base}/${created.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await fetch(`${base}/${created.id}/moves`)).status, 404);
    const remaining = await (await fetch(base)).json();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].projectId, '');
    });
  } finally {
    if (child.exitCode === null) await stopServer(child);
    await rm(dataDir, { recursive: true, force: true });
  }
});
