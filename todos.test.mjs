import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDatabase } from './database.mjs';
import { createTodoService } from './todo-service.mjs';
import { freePort, startServer, stopServer } from './support/server-fixture.mjs';

test('personal to-dos require a login and remain private across accounts, tokens, exports and restarts', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'northstar-todos-'));
  const port = await freePort();
  let child = await startServer(dir, port, { AUTH_DISABLED: 'false', API_TOKEN: 'shared-token' });
  t.after(async () => { await stopServer(child); await rm(dir, { recursive: true, force: true }); });
  const send = (path, method = 'GET', body, headers = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
    method, redirect: 'manual', headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const cookieFor = (response) => ({ cookie: response.headers.get('set-cookie').split(';', 1)[0] });
  const owner = cookieFor(await send('/api/auth/setup', 'POST', { username: 'owner', password: 'a good long password' }));
  const readerResponse = await send('/api/users', 'POST', { username: 'reader', password: 'a good long password', role: 'read_only' }, owner);
  const readerId = (await readerResponse.json()).id;
  const reader = cookieFor(await send('/api/auth/login', 'POST', { username: 'reader', password: 'a good long password' }));
  const managerResponse = await send('/api/users', 'POST', { username: 'manager', password: 'a good long password', role: 'team_manager' }, owner);
  assert.equal(managerResponse.status, 201);
  const manager = cookieFor(await send('/api/auth/login', 'POST', { username: 'manager', password: 'a good long password' }));
  assert.equal((await send('/todos.html')).status, 302);
  assert.equal((await send('/todos.html', 'HEAD')).status, 302);
  const page = await send('/todos.html', 'GET', undefined, reader);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(await page.text(), /My to-do list/);
  for (const headers of [{}, { authorization: 'Bearer shared-token' }]) {
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
      assert.equal((await send(method === 'PUT' || method === 'DELETE' ? '/api/todos/fake' : '/api/todos', method, method === 'POST' || method === 'PUT' ? { title: 'Denied' } : undefined, headers)).status, 401);
    }
  }
  const beforeVersion = await send('/api/version', 'GET', undefined, owner).then((r) => r.json());
  const created = await send('/api/todos', 'POST', { title: '  Private reader task  ', userId: 1 }, reader);
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  const task = await created.json();
  assert.equal(task.title, 'Private reader task');
  assert.equal(task.completed, false);
  assert.deepEqual(await send('/api/todos', 'GET', undefined, owner).then((r) => r.json()), []);
  for (const other of [owner, manager]) {
    for (const method of ['PUT', 'DELETE']) {
      assert.equal((await send(`/api/todos/${task.id}`, method, method === 'PUT' ? { title: 'Hijacked' } : undefined, other)).status, 404);
    }
  }
  assert.equal((await send('/api/todos', 'POST', { title: 'Manager task' }, manager)).status, 201);
  const updated = await send(`/api/todos/${task.id}`, 'PUT', { completed: true, title: 'Private completed task' }, reader).then((r) => r.json());
  assert.equal(updated.completed, true);
  for (const body of [null, [], { title: '' }, { title: 'x'.repeat(201) }, { title: 4 }, { completed: 'true' }]) {
    assert.equal((await send(`/api/todos/${task.id}`, 'PUT', body, reader)).status, 400);
  }
  assert.equal((await send('/api/todos', 'POST', {}, reader)).status, 400);
  assert.equal((await send('/api/todos', 'PATCH', {}, reader)).status, 405);
  assert.deepEqual(await send('/api/version', 'GET', undefined, owner).then((r) => r.json()), beforeVersion);
  for (const path of ['/api/backup', '/api/activity', '/api/kanban']) {
    assert.doesNotMatch(await send(path, 'GET', undefined, owner).then((r) => r.text()), /Private completed task|Private reader task|Manager task/);
  }
  await stopServer(child);
  child = await startServer(dir, port, { AUTH_DISABLED: 'false', API_TOKEN: 'shared-token' });
  assert.equal((await send('/api/todos', 'GET', undefined, reader).then((r) => r.json()))[0].title, updated.title);
  assert.equal((await send(`/api/todos/${task.id}`, 'DELETE', undefined, reader)).status, 204);
  assert.deepEqual(await send('/api/todos', 'GET', undefined, reader).then((r) => r.json()), []);
  await send('/api/todos', 'POST', { title: 'Remove with account' }, reader);
  assert.equal((await send(`/api/users/${readerId}`, 'DELETE', undefined, owner)).status, 204);
  assert.equal((await send('/api/todos', 'GET', undefined, reader)).status, 401);
  await stopServer(child);
  const db = openDatabase(join(dir, 'northstar.db'));
  try { assert.equal(db.prepare('SELECT COUNT(*) AS count FROM personal_todos WHERE user_id = ?').get(readerId).count, 0); }
  finally { db.close(); }
});

test('personal to-dos are unavailable when authentication is disabled', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'northstar-todos-disabled-'));
  const port = await freePort();
  const child = await startServer(dir, port);
  t.after(async () => { await stopServer(child); await rm(dir, { recursive: true, force: true }); });
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/todos`)).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${port}/todos.html`, { redirect: 'manual' })).status, 302);
});

test('to-do service isolates owners on either database backend', { skip: !process.env.TEST_DATABASE_URL }, () => {
  const db = openDatabase(undefined, { client: 'postgres', connectionString: process.env.TEST_DATABASE_URL });
  const suffix = Date.now().toString();
  const id = db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, '', 'read_only')").run(`Todo-${suffix}`).lastInsertRowid;
  try {
    const todos = createTodoService(db);
    const task = todos.create(id, { title: 'Postgres task' });
    assert.equal(todos.list(id)[0].id, task.id);
    assert.throws(() => todos.update(0, task.id, { completed: true }), /not found/);
    assert.equal(todos.update(id, task.id, { completed: true }).completed, true);
    todos.delete(id, task.id);
    assert.deepEqual(todos.list(id), []);
  } finally { db.prepare('DELETE FROM users WHERE id = ?').run(id); db.close(); }
});
