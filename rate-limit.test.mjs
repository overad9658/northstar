import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createFailureLimiter, positiveInteger } from './rate-limit.mjs';
import { freePort, startServer, stopServer } from './support/server-fixture.mjs';

test('failure limiter blocks after the limit until its window ends', () => {
  let clock = 1_000_000;
  const limiter = createFailureLimiter({ limit: 2, windowMs: 60_000, now: () => clock });
  limiter.fail('a');
  assert.equal(limiter.retryAfter('a'), 0);
  limiter.fail('a');
  assert.equal(limiter.retryAfter('a'), 60);
  assert.equal(limiter.retryAfter('b'), 0);
  clock += 59_500;
  assert.equal(limiter.retryAfter('a'), 1);
  clock += 500;
  assert.equal(limiter.retryAfter('a'), 0);
  limiter.fail('a');
  limiter.fail('a');
  limiter.reset('a');
  assert.equal(limiter.retryAfter('a'), 0);
  assert.equal(positiveInteger('5', 10), 5);
  for (const value of [undefined, '', '0', '-1', '2.5', 'many']) assert.equal(positiveInteger(value, 10), 10);
});

test('repeated unknown bearer tokens from one address get 429 with Retry-After', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-token-limit-'));
  const port = await freePort();
  const child = await startServer(dataDir, port, { AUTH_DISABLED: 'false', API_TOKEN: 'legacy-token', TOKEN_AUTH_FAILURES_PER_MINUTE: '3' });
  t.after(async () => { await stopServer(child); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const send = (path, headers = {}) => fetch(`${base}${path}`, { headers });
  const setup = await fetch(`${base}/api/auth/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'owner', password: 'correct horse battery staple' }),
  });
  const cookie = { cookie: setup.headers.get('set-cookie').split(';', 1)[0] };

  assert.equal((await send('/api/projects', { authorization: 'Bearer legacy-token' })).status, 200);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal((await send('/api/projects', { authorization: `Bearer wrong-${attempt}` })).status, 401);
  }
  const limited = await send('/api/kanban', { authorization: 'Bearer wrong-again' });
  assert.equal(limited.status, 429);
  const retryAfter = Number(limited.headers.get('retry-after'));
  assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60, `Retry-After ${retryAfter}`);
  assert.match((await limited.json()).error, /Too many/);

  // While limited, the address cannot use any bearer token; browser sessions are unaffected.
  assert.equal((await send('/api/projects', { authorization: 'Bearer legacy-token' })).status, 429);
  assert.equal((await send('/api/projects', cookie)).status, 200);
});
