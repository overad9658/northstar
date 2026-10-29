import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startServer, stopServer } from './support/server-fixture.mjs';

test('team managers, members, boards, and the portfolio rollup stay scoped', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-team-workspaces-'));
  const port = 39000 + (process.pid % 1000);
  const child = await startServer(dataDir, port, { AUTH_DISABLED: 'false' });
  t.after(async () => { await stopServer(child); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const send = (path, method = 'GET', body, cookie) => fetch(`${base}${path}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = async (path, method, body, cookie) => {
    const response = await send(path, method, body, cookie);
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  };
  const setup = await send('/api/auth/setup', 'POST', { username: 'owner', password: 'correct horse battery staple' });
  const admin = setup.headers.get('set-cookie').split(';', 1)[0];
  const managerUser = (await json('/api/users', 'POST', { username: 'manager', password: 'manager password 123', role: 'team_manager' }, admin)).body;
  const memberUser = (await json('/api/users', 'POST', { username: 'member', password: 'member password 123', role: 'read_only' }, admin)).body;
  const outsiderUser = (await json('/api/users', 'POST', { username: 'outsider', password: 'outsider password 123', role: 'read_only' }, admin)).body;
  const platform = (await json('/api/teams', 'GET', undefined, admin)).body[0];
  const design = (await json('/api/teams', 'POST', { name: 'Design', capacity: 5 }, admin)).body;
  assert.equal((await json(`/api/teams/${platform.id}/members`, 'POST', { userId: managerUser.id }, admin)).status, 201);
  const manager = (await send('/api/auth/login', 'POST', { username: 'manager', password: 'manager password 123' })).headers.get('set-cookie').split(';', 1)[0];
  assert.deepEqual((await json('/api/auth/me', 'GET', undefined, manager)).body.teamIds, [platform.id]);
  assert.equal((await json(`/api/teams/${platform.id}/members`, 'POST', { userId: memberUser.id }, manager)).status, 201);
  assert.equal((await json(`/api/teams/${design.id}/members`, 'POST', { userId: outsiderUser.id }, manager)).status, 403);
  const member = (await send('/api/auth/login', 'POST', { username: 'member', password: 'member password 123' })).headers.get('set-cookie').split(';', 1)[0];
  const outsider = (await send('/api/auth/login', 'POST', { username: 'outsider', password: 'outsider password 123' })).headers.get('set-cookie').split(';', 1)[0];

  const projectInput = { name: 'Platform launch', team: 'Platform', impact: 7, urgency: 6, confidence: 7, effort: 4 };
  const created = await json('/api/projects', 'POST', projectInput, manager);
  assert.equal(created.status, 201);
  const project = created.body;
  assert.equal((await json('/api/projects', 'POST', { ...projectInput, team: 'Design', name: 'Forbidden' }, manager)).status, 403);
  assert.equal((await json('/api/projects', 'POST', projectInput, member)).status, 403);
  const designProject = (await json('/api/projects', 'POST', { ...projectInput, team: 'Design', name: 'Design launch' }, admin)).body;
  assert.deepEqual((await json('/api/projects', 'GET', undefined, admin)).body.map((item) => item.id).sort(), [project.id, designProject.id].sort());
  const privateProject = (await json('/api/projects', 'POST', { ...projectInput, name: 'Private work', impact: 2, urgency: 2, hiddenFromReadOnly: true }, manager)).body;
  assert.ok((await json('/api/projects', 'GET', undefined, manager)).body.some((item) => item.id === privateProject.id));
  assert.ok(!(await json('/api/projects', 'GET', undefined, member)).body.some((item) => item.id === privateProject.id));

  const platformColumn = await json(`/api/kanban/columns?teamId=${platform.id}`, 'POST', { name: 'To do' }, manager);
  assert.equal(platformColumn.status, 201);
  const designColumn = (await json(`/api/kanban/columns?teamId=${design.id}`, 'POST', { name: 'To do' }, admin)).body;
  assert.equal((await json(`/api/kanban/columns?teamId=${platform.id}`, 'POST', { name: 'No' }, member)).status, 403);
  const card = await json(`/api/kanban/cards?teamId=${platform.id}`, 'POST', { columnId: platformColumn.body.id, projectId: project.id, title: 'Ship it' }, member);
  assert.equal(card.status, 201);
  assert.equal((await json(`/api/kanban/cards?teamId=${design.id}`, 'POST', { columnId: designColumn.id, title: 'No' }, member)).status, 403);
  assert.equal((await json(`/api/kanban/cards?teamId=${platform.id}`, 'POST', { columnId: platformColumn.body.id, projectId: designProject.id, title: 'Wrong team' }, member)).status, 400);
  assert.equal((await json(`/api/kanban/cards?teamId=${platform.id}`, 'POST', { columnId: platformColumn.body.id, projectId: privateProject.id, title: 'Private' }, member)).status, 404);
  assert.equal((await json(`/api/kanban/cards/${card.body.id}?teamId=${design.id}`, 'PUT', { title: 'Wrong board' }, admin)).status, 404);
  assert.equal((await json(`/api/kanban/cards/${card.body.id}?teamId=${platform.id}`, 'DELETE', undefined, outsider)).status, 403);
  assert.equal((await json(`/api/kanban?teamId=${platform.id}`, 'GET', undefined, admin)).body.cards.length, 1);
  assert.equal((await json(`/api/kanban?teamId=${design.id}`, 'GET', undefined, admin)).body.cards.length, 0);
  assert.equal((await json(`/api/teams/${platform.id}/members/${memberUser.id}`, 'DELETE', undefined, manager)).status, 204);
  assert.equal((await json(`/api/kanban/cards?teamId=${platform.id}`, 'POST', { columnId: platformColumn.body.id, title: 'After removal' }, member)).status, 403);
});
