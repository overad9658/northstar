import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { freePort, startServer, stopServer } from './support/server-fixture.mjs';

test('API tokens page builds DOM safely, copies only on click and is linked from the app', async () => {
  const script = await readFile('public/tokens.js', 'utf8');
  assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(script, /\bconfirm\(|\balert\(|\bprompt\(/);
  assert.equal(script.match(/navigator\.clipboard/g).length, 2);
  assert.match(script, /async function copyToken\(\) \{\n  try \{\n    if \(!navigator\.clipboard\?\.writeText\)/);
  assert.match(script, /\$\('#copy-token'\)\.addEventListener\('click', copyToken\)/);
  assert.equal(script.match(/copyToken/g).length, 2);
  assert.match(script, /createdValue\.select\(\)/);

  const index = await readFile('public/index.html', 'utf8');
  assert.match(index, /<a class="app-menu-item" data-admin href="\/tokens\.html">/);
  assert.match(index, /id="api-token-dialog"[\s\S]*href="\/tokens\.html"/);
  assert.match(await readFile('public/docs.js', 'utf8'), /getElementById\('api-tokens'\)[\s\S]*'\/tokens\.html'/);
});

test('API tokens page is served under the CSP and only admins can list, create or revoke', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-tokens-page-'));
  const port = await freePort();
  const child = await startServer(dataDir, port, { AUTH_DISABLED: 'false' });
  t.after(async () => { await stopServer(child); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const send = (path, method = 'GET', body, headers = {}) => fetch(`${base}${path}`, {
    method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sessionCookie = (response) => ({ cookie: response.headers.get('set-cookie').split(';', 1)[0] });

  const page = await send('/tokens.html');
  assert.equal(page.status, 200);
  const policy = page.headers.get('content-security-policy');
  assert.match(policy, /script-src 'self'/);
  assert.match(policy, /style-src 'self'/);
  assert.doesNotMatch(policy, /unsafe-inline/);
  const html = await page.text();
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>|<style\b|\sstyle=|\son[a-z]+=/i);

  const admin = sessionCookie(await send('/api/auth/setup', 'POST', { username: 'owner', password: 'correct horse battery staple' }));
  for (const role of ['read_only', 'team_manager']) {
    assert.equal((await send('/api/users', 'POST', { username: role, password: 'a long enough passphrase', role }, admin)).status, 201);
  }
  const created = await send('/api/api-tokens', 'POST', { name: 'Reporting agent', scope: 'read' }, admin);
  assert.equal(created.status, 201);
  const token = await created.json();
  assert.equal(token.createdBy.username, 'owner');

  for (const role of ['read_only', 'team_manager']) {
    const session = sessionCookie(await send('/api/auth/login', 'POST', { username: role, password: 'a long enough passphrase' }));
    assert.equal((await send('/api/api-tokens', 'GET', undefined, session)).status, 403, role);
    assert.equal((await send('/api/api-tokens', 'POST', { name: 'Escalate', scope: 'write' }, session)).status, 403, role);
    assert.equal((await send(`/api/api-tokens/${token.id}`, 'DELETE', undefined, session)).status, 403, role);
  }
  assert.equal((await send('/api/api-tokens')).status, 401);

  const listed = await send('/api/api-tokens', 'GET', undefined, admin).then((response) => response.json());
  assert.deepEqual(listed.map(({ name, scope, revokedAt }) => [name, scope, revokedAt]), [['Reporting agent', 'read', null]]);
  assert.ok(listed.every((item) => !('token' in item)));
  assert.equal((await send(`/api/api-tokens/${token.id}`, 'DELETE', undefined, admin)).status, 204);
  assert.ok((await send('/api/api-tokens', 'GET', undefined, admin).then((response) => response.json()))[0].revokedAt);
});
