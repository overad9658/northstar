import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { freePort, startServer, stopServer } from './support/server-fixture.mjs';

test('pages carry a self-only Content-Security-Policy and use no inline scripts or styles', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-csp-'));
  const port = await freePort();
  const child = await startServer(dataDir, port);
  t.after(async () => { await stopServer(child); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;

  const pages = (await readdir('public')).filter((name) => name.endsWith('.html'));
  for (const path of ['/', ...pages.map((name) => `/${name}`)]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200, path);
    const policy = response.headers.get('content-security-policy') || '';
    for (const directive of ["default-src 'self'", "script-src 'self'", "style-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) {
      assert.ok(policy.includes(directive), `${path} lacks ${directive}`);
    }
    assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval|https?:/, path);
  }
  assert.equal((await fetch(`${base}/app.js`)).headers.get('content-security-policy'), null);

  // Live updates stay same-origin, so connect-src 'self' covers the event stream and the polling fallback.
  const live = await readFile(join('public', 'live-updates.js'), 'utf8');
  assert.match(live, /EventSourceImpl\('\/api\/events'\)/);
  assert.match(live, /fetchImpl\('\/api\/version'/);

  for (const name of pages) {
    const html = await readFile(join('public', name), 'utf8');
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, `${name} has an inline script`);
    assert.doesNotMatch(html, /<style\b|\sstyle=|\son[a-z]+=/i, `${name} has an inline style or handler`);
  }
  for (const name of (await readdir('public')).filter((file) => file.endsWith('.js'))) {
    assert.doesNotMatch(await readFile(join('public', name), 'utf8'), /\sstyle="|\son[a-z]+="/i, `${name} renders an inline style or handler`);
  }
});

test('failed sign-ins are limited per address and username with Retry-After', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-login-limit-'));
  const port = await freePort();
  const child = await startServer(dataDir, port, { AUTH_DISABLED: 'false', LOGIN_FAILURES_PER_MINUTE: '3', LOGIN_IP_FAILURES_PER_MINUTE: '5' });
  t.after(async () => { await stopServer(child); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const login = (username, password) => fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }),
  });
  const password = 'correct horse battery staple';
  assert.equal((await fetch(`${base}/api/auth/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password }),
  })).status, 201);

  // A success clears that username's failures.
  assert.equal((await login('owner', 'wrong password 1')).status, 401);
  assert.equal((await login('owner', password)).status, 200);

  for (let attempt = 0; attempt < 3; attempt += 1) assert.equal((await login('Owner', `wrong password ${attempt}`)).status, 401);
  const limited = await login('owner', password);
  assert.equal(limited.status, 429);
  const retryAfter = Number(limited.headers.get('retry-after'));
  assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60, `Retry-After ${retryAfter}`);
  assert.match((await limited.json()).error, /Too many/);

  // Another username from the same address still works until the per-address limit (5 failures) is reached.
  assert.equal((await login('someone', 'wrong password')).status, 401);
  assert.equal((await login('someone-else', 'wrong password')).status, 429);
});
