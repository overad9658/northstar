import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startServer, stopServer } from './support/server-fixture.mjs';

function sessionCookie(response) { return response.headers.get('set-cookie').split(';', 1)[0]; }
function jsonRequest(url, body, cookie, method = 'POST') {
  return fetch(url, { method, headers: { 'content-type':'application/json', ...(cookie ? { cookie } : {}) }, body:JSON.stringify(body) });
}

test('authentication enforces roles and hides selected projects from read-only users', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-auth-'));
  const port = 34000 + (process.pid % 1000);
  const server = await startServer(dataDir, port, { AUTH_DISABLED:'false' });
  const base = `http://127.0.0.1:${port}`;
  try {
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /Northstar — Engineering Priority Matrix/);
    const loginPage = await fetch(`${base}/login.html`);
    assert.equal(loginPage.status, 200);
    assert.match(await loginPage.text(), /Sign in — Northstar/);
    assert.equal((await fetch(`${base}/api/projects`)).status, 401);
    const setup = await jsonRequest(`${base}/api/auth/setup`, { username:'owner', password:'correct horse battery staple' });
    assert.equal(setup.status, 201);
    const adminCookie = sessionCookie(setup);
    assert.equal((await jsonRequest(`${base}/api/users`, { username:'viewer', password:'read only password', role:'read_only' }, adminCookie)).status, 201);

    const hidden = await jsonRequest(`${base}/api/projects`, { name:'Secret launch', hiddenFromReadOnly:true, impact:6, urgency:6, confidence:6, effort:6 }, adminCookie);
    assert.equal(hidden.status, 201);
    const visible = await jsonRequest(`${base}/api/projects`, { name:'Shared work', impact:5, urgency:5, confidence:5, effort:5 }, adminCookie);
    assert.equal(visible.status, 201);
    const visibleProject = await visible.json();

    const privateRoomResponse = await jsonRequest(`${base}/api/planning-sessions`, { projectIds:[visibleProject.id], guestAccess:false }, adminCookie);
    assert.equal(privateRoomResponse.status, 201);
    const privateRoom = await privateRoomResponse.json();
    assert.equal((await fetch(`${base}/api/sessions/${privateRoom.token}`)).status, 401);
    assert.equal((await fetch(`${base}/api/sessions/${privateRoom.token}`, { headers:{ cookie:adminCookie } })).status, 200);

    const guestRoomResponse = await jsonRequest(`${base}/api/planning-sessions`, { projectIds:[visibleProject.id], guestAccess:true }, adminCookie);
    assert.equal(guestRoomResponse.status, 201);
    const guestRoom = await guestRoomResponse.json();
    assert.equal(guestRoom.guestAccess, true);
    assert.equal((await fetch(`${base}/api/sessions/${guestRoom.token}`)).status, 200);

    const login = await jsonRequest(`${base}/api/auth/login`, { username:'viewer', password:'read only password' });
    assert.equal(login.status, 200);
    const viewerCookie = sessionCookie(login);
    const projects = await fetch(`${base}/api/projects`, { headers:{ cookie:viewerCookie } }).then((response) => response.json());
    assert.deepEqual(projects.map((project) => project.name), ['Shared work']);
    assert.equal((await jsonRequest(`${base}/api/projects`, { name:'Nope' }, viewerCookie)).status, 403);
    assert.equal((await fetch(`${base}/api/projects/${(await hidden.json()).id}/moves`, { headers:{ cookie:viewerCookie } })).status, 404);
    assert.equal((await fetch(`${base}/api/users`, { headers:{ cookie:viewerCookie } })).status, 403);
  } finally { await stopServer(server); await rm(dataDir, { recursive:true, force:true }); }
});

test('signup setting persists, rejects disabled signup and never grants admin access', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-signup-'));
  const port = 37000 + (process.pid % 1000), base = `http://127.0.0.1:${port}`;
  const env = { AUTH_DISABLED: 'false', SIGNUP_ALLOWED: 'false', SSO_PROVIDERS: '[]', SSO_CONFIG_FILE: '', PUBLIC_URL: '' };
  let server = await startServer(dataDir, port, env);
  const send = (path, body, cookie, method) => jsonRequest(`${base}${path}`, body, cookie, method);
  try {
    assert.equal((await fetch(`${base}/api/auth/status`).then(r => r.json())).signupAllowed, false);
    assert.equal((await send('/api/auth/signup', { username: 'reader', password: 'read only password' })).status, 403);
    const admin = sessionCookie(await send('/api/auth/setup', { username: 'owner', password: 'correct horse battery staple' }));
    const view = await fetch(`${base}/api/admin/sso`, { headers: { cookie: admin } }).then(r => r.json());
    assert.equal((await send('/api/admin/sso', { ...view, signupAllowed: 'true' }, admin, 'PUT')).status, 400);
    assert.equal((await send('/api/admin/sso', { ...view, signupAllowed: true }, admin, 'PUT')).status, 200);
    const signup = await send('/api/auth/signup', { username: 'reader', password: 'read only password', role: 'admin' });
    assert.equal(signup.status, 201); assert.equal((await signup.json()).role, 'read_only');
    assert.equal((await fetch(`${base}/api/users`, { headers: { cookie: sessionCookie(signup) } })).status, 403);
    assert.equal((await send('/api/auth/signup', { username: 'reader', password: 'read only password' })).status, 409);
    await stopServer(server); server = await startServer(dataDir, port, env);
    assert.equal((await fetch(`${base}/api/auth/status`).then(r => r.json())).signupAllowed, true);
    const saved = await fetch(`${base}/api/admin/sso`, { headers: { cookie: admin } }).then(r => r.json());
    assert.equal((await send('/api/admin/sso', { ...saved, signupAllowed: false }, admin, 'PUT')).status, 200);
    assert.equal((await send('/api/auth/signup', { username: 'another', password: 'read only password' })).status, 403);
    assert.equal((await send('/api/auth/login', { username: 'reader', password: 'read only password' })).status, 200);
  } finally { await stopServer(server); await rm(dataDir, { recursive: true, force: true }); }
});
