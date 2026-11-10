import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openDatabase } from './database.mjs';
import { selectPortfolioProjects } from './public/portfolio-model.js';
import { isFocusProject, validateProject } from './project-domain.mjs';
import { freePort, startServer, stopServer } from './support/server-fixture.mjs';

const filters = { query: '', status: 'All', selectedTeams: [], showArchived: false, showCompleted: false, showIdeas: false };
const idea = { id: 1, name: 'Try a new queue', team: 'Platform', status: 'Scheduled', scheduleStage: 'Idea', archived: 0, impact: 9, urgency: 9, description: '', projectId: '' };
const plan = { ...idea, id: 2, name: 'Ship the queue', scheduleStage: 'To plan' };

test('an idea stays off the matrix and out of Focus Now until the viewer asks for ideas', () => {
  assert.deepEqual(selectPortfolioProjects([idea, plan], filters).matrix.map((project) => project.id), [2]);
  assert.deepEqual(selectPortfolioProjects([idea, plan], { ...filters, showIdeas: true }).matrix.map((project) => project.id), [1, 2]);
  assert.deepEqual(selectPortfolioProjects([idea, plan], filters).visible.map((project) => project.id), [1, 2]);
  assert.equal(isFocusProject(idea), false);
  assert.equal(isFocusProject(plan), true);
});

test('an idea may leave its scores out; anything else still needs all four', () => {
  const { value } = validateProject({ name: 'Idea', status: 'Scheduled', scheduleStage: 'Idea', impact: 8 });
  assert.deepEqual([value.impact, value.urgency, value.confidence, value.effort], [8, 5, 5, 5]);
  assert.match(validateProject({ name: 'Plan', status: 'Scheduled', scheduleStage: 'To plan' }).error, /all four scores/);
  assert.match(validateProject({ name: 'Idea', status: 'Scheduled', scheduleStage: 'Idea', impact: 11 }).error, /impact/);
});

test('ideas are created without scores, filtered by stage, and promoted to plan', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-ideas-'));
  const port = await freePort();
  const child = await startServer(dataDir, port, { AUTH_DISABLED: 'false' });
  t.after(async () => { await stopServer(child); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const send = (path, method = 'GET', body, cookie) => fetch(`${base}${path}`, {
    method, headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = async (path, method, body, cookie) => {
    const response = await send(path, method, body, cookie);
    return { status: response.status, body: await response.json() };
  };
  const admin = (await send('/api/auth/setup', 'POST', { username: 'owner', password: 'correct horse battery staple' })).headers.get('set-cookie').split(';', 1)[0];
  await json('/api/users', 'POST', { username: 'viewer', password: 'viewer password 123', role: 'read_only' }, admin);
  const viewer = (await send('/api/auth/login', 'POST', { username: 'viewer', password: 'viewer password 123' })).headers.get('set-cookie').split(';', 1)[0];

  const created = await json('/api/projects', 'POST', { name: 'Try a new queue', status: 'Scheduled', scheduleStage: 'Idea' }, admin);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual([created.body.scheduleStage, created.body.impact, created.body.effort], ['Idea', 5, 5]);
  await json('/api/projects', 'POST', { name: 'Ship it', status: 'Scheduled', impact: 6, urgency: 6, confidence: 6, effort: 6 }, admin);
  await json('/api/projects', 'POST', { name: 'Running', impact: 6, urgency: 6, confidence: 6, effort: 6 }, admin);

  const names = async (query) => (await json(`/api/projects?${query}`, 'GET', undefined, admin)).body.map((project) => project.name).sort();
  assert.deepEqual(await names('f.stage=Idea'), ['Try a new queue']);
  assert.deepEqual(await names('f.status=Scheduled'), ['Ship it', 'Try a new queue']);
  assert.deepEqual(await names('f.stage=To%20plan'), ['Ship it']);

  assert.equal((await json(`/api/projects/${created.body.id}/promote`, 'POST', undefined, viewer)).status, 403);
  const promoted = await json(`/api/projects/${created.body.id}/promote`, 'POST', undefined, admin);
  assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
  assert.equal(promoted.body.scheduleStage, 'To plan');
  assert.deepEqual(await names('f.stage=Idea'), []);
  assert.equal((await json(`/api/projects/${created.body.id}/promote`, 'POST', undefined, admin)).status, 409);
  assert.equal((await json('/api/projects/99999/promote', 'POST', undefined, admin)).status, 404);
});

test('an existing database gains the Idea stage without losing columns, rows or indexes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'northstar-idea-migration-'));
  const file = join(directory, 'northstar.db');
  try {
    openDatabase(file).close();
    // Put the projects table back to the pre-Idea check, as an older install has it.
    const old = new DatabaseSync(file);
    const definition = old.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'projects'").get().sql;
    old.exec('PRAGMA foreign_keys = OFF');
    old.exec(`${definition.replace("'Idea', 'To plan', 'Planning'", "'To plan', 'Planning'").replace('CREATE TABLE projects', 'CREATE TABLE projects_old')};
      DROP TABLE projects; ALTER TABLE projects_old RENAME TO projects;`);
    old.prepare("INSERT INTO projects (name, status, schedule_stage, hidden_from_read_only, impact, urgency, confidence, effort) VALUES ('Private plan', 'Scheduled', 'To plan', 1, 4, 4, 4, 4)").run();
    assert.throws(() => old.prepare("INSERT INTO projects (name, status, schedule_stage, impact, urgency, confidence, effort) VALUES ('x', 'Scheduled', 'Idea', 5, 5, 5, 5)").run(), /CHECK/);
    old.close();

    const db = openDatabase(file);
    try {
      const row = db.prepare("SELECT name, hidden_from_read_only AS hidden FROM projects WHERE name = 'Private plan'").get();
      assert.deepEqual({ ...row }, { name: 'Private plan', hidden: 1 });
      db.prepare("INSERT INTO projects (name, status, schedule_stage, impact, urgency, confidence, effort) VALUES ('An idea', 'Scheduled', 'Idea', 5, 5, 5, 5)").run();
      const indexes = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'projects'").all().map((item) => item.name);
      assert.ok(indexes.includes('idx_projects_status') && indexes.includes('idx_projects_priority'), indexes.join(','));
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { db.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
