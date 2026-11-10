import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { freePort, startServer, stopServer } from './support/server-fixture.mjs';

test('All boards merges every visible board, keeps cards on their team, and refuses cross-team moves', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-all-boards-'));
  const port = await freePort();
  const child = await startServer(dataDir, port, { AUTH_DISABLED: 'false' });
  t.after(async () => { await stopServer(child); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const json = async (path, method = 'GET', body, cookie) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  };
  const login = async (username, password) => (await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }),
  })).headers.get('set-cookie').split(';', 1)[0];

  const setup = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'correct horse battery staple' }) });
  const admin = setup.headers.get('set-cookie').split(';', 1)[0];
  const platform = (await json('/api/teams', 'GET', undefined, admin)).body[0];
  const design = (await json('/api/teams', 'POST', { name: 'Design', capacity: 3 }, admin)).body;
  const memberUser = (await json('/api/users', 'POST', { username: 'member', password: 'member password 123', role: 'read_only' }, admin)).body;
  assert.equal((await json(`/api/teams/${design.id}/members`, 'POST', { userId: memberUser.id }, admin)).status, 201);
  const member = await login('member', 'member password 123');

  const column = async (teamId, name) => (await json(`/api/kanban/columns?teamId=${teamId}`, 'POST', { name }, admin)).body;
  const platformTodo = await column(platform.id, 'To do');
  const platformDoing = await column(platform.id, 'Doing');
  const designIdeas = await column(design.id, 'Ideas');
  const designTodo = await column(design.id, 'to do');
  const designReview = await column(design.id, 'Review');
  const card = async (teamId, columnId, title, extra = {}) => (await json(`/api/kanban/cards?teamId=${teamId}`, 'POST', { columnId, title, ...extra }, admin)).body;
  const platformCard = await card(platform.id, platformTodo.id, 'Platform work');
  const designCard = await card(design.id, designIdeas.id, 'Design work');
  const hiddenProject = (await json('/api/projects', 'POST', { name: 'Private', team: 'Platform', impact: 3, urgency: 3, confidence: 5, effort: 5, hiddenFromReadOnly: true }, admin)).body;
  const hiddenCard = await card(platform.id, platformTodo.id, 'Hidden work', { projectId: hiddenProject.id });

  // Teams come in the team list's order (by name). Merge order: the first team's columns, then the
  // next team's extra columns in its own order.
  const all = await json('/api/kanban?teamId=all', 'GET', undefined, admin);
  assert.equal(all.status, 200);
  assert.deepEqual(all.body.columns.map((item) => item.name), ['Ideas', 'to do', 'Review', 'Doing']);
  assert.deepEqual(all.body.columns[1].columns, [{ teamId: design.id, id: designTodo.id }, { teamId: platform.id, id: platformTodo.id }]);
  assert.deepEqual(all.body.teams.map((team) => team.name), ['Design', 'Platform']);
  const shown = (board, id) => board.cards.find((item) => item.id === id);
  assert.deepEqual(
    [platformCard, designCard].map(({ id }) => { const item = shown(all.body, id); return [item.teamId, item.teamName, item.columnKey]; }),
    [[platform.id, 'Platform', 'to do'], [design.id, 'Design', 'ideas']],
  );
  assert.ok(shown(all.body, hiddenCard.id));

  // Read-only members see every board, but not cards on hidden projects of teams they don't manage.
  const memberView = (await json('/api/kanban?teamId=all', 'GET', undefined, member)).body;
  assert.ok(shown(memberView, platformCard.id) && shown(memberView, designCard.id));
  assert.equal(shown(memberView, hiddenCard.id), undefined);
  const memberProjects = (await json('/api/kanban/projects?teamId=all', 'GET', undefined, member)).body;
  assert.ok(!memberProjects.some((project) => project.id === hiddenProject.id));
  assert.ok((await json('/api/kanban/projects?teamId=all', 'GET', undefined, admin)).body.some((project) => project.id === hiddenProject.id && project.team === 'Platform'));

  // A card moves within its own team from All boards; another team's column is refused, clearly.
  assert.equal((await json(`/api/kanban/cards/${designCard.id}?teamId=all`, 'PUT', { columnId: designReview.id }, member)).status, 200);
  const refused = await json(`/api/kanban/cards/${designCard.id}?teamId=all`, 'PUT', { columnId: platformDoing.id }, member);
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /own team's board/);
  const crossTeam = await json(`/api/kanban/cards/${platformCard.id}?teamId=all`, 'PUT', { columnId: designReview.id }, admin);
  assert.equal(crossTeam.status, 400);
  const after = (await json('/api/kanban?teamId=all', 'GET', undefined, admin)).body;
  assert.equal(shown(after, platformCard.id).teamId, platform.id);
  assert.equal(shown(after, designCard.id).columnKey, 'review');

  // Board membership still applies to cards reached from All boards.
  assert.equal((await json(`/api/kanban/cards/${platformCard.id}?teamId=all`, 'PUT', { columnId: platformDoing.id }, member)).status, 403);
  assert.equal((await json('/api/kanban/cards?teamId=all', 'POST', { columnId: platformTodo.id, title: 'Not my team' }, member)).status, 403);
  assert.equal((await json('/api/kanban/cards?teamId=all', 'POST', { columnId: designTodo.id, title: 'My team' }, member)).status, 201);

  // Archived cards follow the same archived parameter as a single board.
  assert.equal((await json(`/api/kanban/cards/${designCard.id}?teamId=all`, 'PUT', { archived: true }, admin)).status, 200);
  assert.equal(shown((await json('/api/kanban?teamId=all', 'GET', undefined, admin)).body, designCard.id), undefined);
  assert.ok(shown((await json('/api/kanban?teamId=all&archived=include', 'GET', undefined, admin)).body, designCard.id));
});
