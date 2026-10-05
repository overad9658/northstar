import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase, transaction } from './database.mjs';
import { createProjectService } from './project-service.mjs';
import { createTeamService } from './team-service.mjs';
import { createPlanningService } from './planning-service.mjs';
import { createBackupService } from './backup-service.mjs';
import { createAuthService } from './auth-service.mjs';
import { createSsoSettings } from './sso-settings.mjs';

test('PostgreSQL supports portfolio, planning, auth, transactions, restore and restart', {
  skip: !process.env.TEST_DATABASE_URL,
}, () => {
  const config = { client: 'postgres', connectionString: process.env.TEST_DATABASE_URL };
  let db = openDatabase(undefined, config);
  const req = { headers: {}, socket: {} };
  const headers = new Map();
  const res = { getHeader: (name) => headers.get(name), setHeader: (name, value) => headers.set(name, value) };
  try {
    const teams = createTeamService(db);
    const projects = createProjectService(db);
    const planning = createPlanningService(db);
    const backup = createBackupService(db);
    const auth = createAuthService(db, { disabled: false });
    const suffix = Date.now().toString();
    const team = teams.create({ name: `Postgres-${suffix}`, capacity: 10 });
    assert.throws(() => teams.create({ name: team.name.toLowerCase() }), /already exists/);
    const project = projects.create({ name: 'Postgres project', team: team.name.toLowerCase(), capacity: 2, impact: 4, urgency: 4, confidence: 5, effort: 5 });
    assert.equal(project.team, team.name);
    assert.equal(typeof project.score, 'number');
    assert.equal(typeof project.createdAt, 'string');
    assert.equal(teams.list().find((item) => item.id === team.id).projectCount, 1);
    assert.equal(projects.capacity().occupied, 2);
    projects.update(project.id, { impact: 5, moveComment: 'Database test' });
    assert.equal(projects.moves(project.id)[0].comment, 'Database test');

    const room = planning.create([project.id]);
    const session = planning.find(room.token);
    const vote = planning.vote(session, room.token, { projectId: project.id, voterName: 'Tester', impact: 6, urgency: 4, confidence: 5, effort: 5 });
    planning.vote(session, room.token, { projectId: project.id, voterToken: vote.voterToken, impact: 6, urgency: 5, confidence: 5, effort: 5 });
    assert.equal(planning.payload(room.token, vote.voterToken).participantCount, 1);
    planning.reveal(session, room.token, { projectId: project.id, leaderKey: room.leaderKey });
    assert.equal(planning.decide(session, room.token, { projectId: project.id, leaderKey: room.leaderKey, impact: 6, urgency: 5, confidence: 5, effort: 5 }).status, 'Closed');

    const username = `Pg-${suffix}`;
    const user = auth.createUser({ username, password: 'postgres test password' });
    assert.throws(() => auth.createUser({ username: username.toLowerCase(), password: 'postgres test password' }), /already in use/);
    assert.equal(auth.login({ username: username.toLowerCase(), password: 'postgres test password' }, req, res).id, user.id);
    req.headers.cookie = headers.get('set-cookie')[0].split(';')[0];
    assert.equal(auth.userForRequest(req).id, user.id);
    db.prepare('INSERT INTO auth_sso_requests (state, provider_id, browser_hash, payload, expires_at) VALUES (?, ?, ?, ?, ?)').run(suffix, 'test', 'hash', '{}', Date.now() + 60_000);
    assert.equal(db.prepare('DELETE FROM auth_sso_requests WHERE state = ? RETURNING payload').get(suffix).payload, '{}');
    const sso = createSsoSettings(db);
    const initialRevision = sso.view().revision;
    sso.save({ revision: sso.view().revision, publicUrl: 'https://northstar.example', providers: [] });
    sso.save({ revision: sso.view().revision, publicUrl: 'https://northstar.example', providers: [] });
    assert.equal(sso.view().revision, initialRevision + 2);

    assert.throws(() => transaction(db, () => {
      db.prepare('UPDATE teams SET capacity = 20 WHERE id = ?').run(team.id);
      throw new Error('rollback test');
    }), /rollback test/);
    assert.equal(db.prepare('SELECT capacity FROM teams WHERE id = ?').get(team.id).capacity, 10);

    const exported = backup.export();
    backup.restore(exported);
    assert.deepEqual(backup.export().projects, exported.projects);
    const invalid = structuredClone(exported);
    invalid.projects[0].team = 'unconfigured team';
    assert.throws(() => backup.restore(invalid), /unconfigured team/);
    assert.deepEqual(backup.export().projects, exported.projects);
    const next = projects.create({ name: 'After restore', team: team.name, impact: 2, urgency: 2, confidence: 5, effort: 5 });
    assert.ok(next.id > Math.max(...exported.projects.map((item) => item.id)));
    const legacy = { ...exported, teams: undefined };
    backup.restore(legacy);
    assert.ok(teams.list().length);
    db.close();
    db = openDatabase(undefined, config);
    assert.equal(createProjectService(db).list().find((item) => item.id === project.id).name, project.name);
    assert.equal(createAuthService(db, { disabled: false }).userForRequest(req).id, user.id);
  } finally { db.close(); }
});
