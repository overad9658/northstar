import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { freePort, startServer, stopServer } from './support/server-fixture.mjs';

// Reads server-sent events from a fetch body; next() resolves with the next event or null on timeout.
async function openStream(url, headers) {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const queue = [];
  let buffer = '';
  let wake = null;
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = block.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n');
          const id = block.split('\n').find((line) => line.startsWith('id: '))?.slice(4);
          if (data) { queue.push({ id, ...JSON.parse(data) }); wake?.(); }
        }
      }
    } catch { /* aborted */ }
  })();
  return {
    response,
    async next(ms = 2000) {
      if (!queue.length) await new Promise((resolve) => { wake = resolve; setTimeout(resolve, ms); });
      wake = null;
      return queue.shift() ?? null;
    },
    close: () => controller.abort(),
  };
}

test('change events reach open pages after token writes, hide hidden projects from viewers, and require auth', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-events-'));
  const port = await freePort();
  const child = await startServer(dataDir, port, { AUTH_DISABLED: 'false', API_TOKEN: '' });
  const streams = [];
  t.after(async () => { streams.forEach((stream) => stream.close()); await stopServer(child); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const send = (path, method = 'GET', body, headers = {}) => fetch(`${base}${path}`, {
    method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const open = async (headers) => { const stream = await openStream(`${base}/api/events`, headers); streams.push(stream); return stream; };

  const unauthenticated = await send('/api/events');
  assert.equal(unauthenticated.status, 401);
  assert.equal((await send('/api/version')).status, 401);

  const setup = await send('/api/auth/setup', 'POST', { username: 'owner', password: 'correct horse battery staple' });
  const admin = { cookie: setup.headers.get('set-cookie').split(';', 1)[0] };
  await send('/api/users', 'POST', { username: 'viewer', password: 'read only password', role: 'read_only' }, admin);
  const login = await send('/api/auth/login', 'POST', { username: 'viewer', password: 'read only password' });
  const viewer = { cookie: login.headers.get('set-cookie').split(';', 1)[0] };
  const writeToken = (await send('/api/api-tokens', 'POST', { name: 'sync agent', scope: 'write' }, admin).then((response) => response.json())).token;
  const readToken = (await send('/api/api-tokens', 'POST', { name: 'reader', scope: 'read' }, admin).then((response) => response.json())).token;
  const writer = { authorization: `Bearer ${writeToken}` };

  const adminStream = await open(admin);
  assert.equal(adminStream.response.status, 200);
  assert.match(adminStream.response.headers.get('content-type'), /^text\/event-stream/);
  const viewerStream = await open(viewer);
  const readerStream = await open({ authorization: `Bearer ${readToken}` });
  assert.equal(readerStream.response.status, 200);
  const viewerVersion = (await send('/api/version', 'GET', undefined, viewer).then((response) => response.json())).version;

  // A hidden project: admins hear about it, viewers get no event and no version bump.
  assert.equal((await send('/api/projects', 'POST', { name: 'Hidden work', hiddenFromReadOnly: true, impact: 3, urgency: 3, confidence: 5, effort: 5 }, writer)).status, 201);
  const hiddenEvent = await adminStream.next();
  assert.ok(hiddenEvent.kinds.includes('projects'));
  assert.equal(String(hiddenEvent.version), hiddenEvent.id);
  assert.equal(await viewerStream.next(400), null);
  assert.equal((await send('/api/version', 'GET', undefined, viewer).then((response) => response.json())).version, viewerVersion);

  // A visible write through the token reaches every stream, with only the kinds that changed.
  const column = await send('/api/kanban/columns', 'POST', { name: 'To do' }, writer).then((response) => response.json());
  for (const stream of [adminStream, viewerStream, readerStream]) assert.deepEqual((await stream.next()).kinds, ['kanban']);
  await send('/api/kanban/cards', 'POST', { columnId: column.id, title: 'Visible card' }, writer);
  // A new card also changes its team's card count.
  const viewerEvent = await viewerStream.next();
  assert.deepEqual(viewerEvent.kinds, ['kanban', 'teams']);
  assert.equal(viewerEvent.version, viewerVersion + 2);
  assert.deepEqual((await adminStream.next()).kinds, ['kanban', 'teams']);

  // A failed or no-op write is silent.
  assert.equal((await send('/api/kanban/cards', 'POST', { columnId: column.id, title: '' }, writer)).status, 400);
  assert.equal(await adminStream.next(400), null);

  // A reconnect with a stale Last-Event-ID is told to refresh everything at once.
  const resumed = await open({ ...viewer, 'last-event-id': String(viewerVersion) });
  assert.deepEqual((await resumed.next()).kinds, ['projects', 'kanban', 'teams']);
  const current = await open({ ...viewer, 'last-event-id': String(viewerEvent.version) });
  assert.equal(await current.next(400), null);
});
