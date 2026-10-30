import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { freePort, startServer, stopServer } from './support/server-fixture.mjs';

test('columns reorder by position within their own team board', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-column-order-'));
  const port = await freePort();
  const child = await startServer(dataDir, port);
  t.after(async () => { await stopServer(child); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const send = (path, method = 'GET', body) => fetch(`${base}${path}`, {
    method, headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const read = (path) => send(path).then((response) => response.json());

  const platform = (await read('/api/teams'))[0];
  const design = await send('/api/teams', 'POST', { name: 'Design', capacity: 3 }).then((response) => response.json());
  const board = (teamId) => `?teamId=${teamId}`;
  const add = (teamId, name) => send(`/api/kanban/columns${board(teamId)}`, 'POST', { name }).then((response) => response.json());
  const order = async (teamId) => (await read(`/api/kanban${board(teamId)}`)).columns.map((column) => [column.name, column.position]);

  const [a, , c] = [await add(platform.id, 'A'), await add(platform.id, 'B'), await add(platform.id, 'C')];
  const [x, y] = [await add(design.id, 'X'), await add(design.id, 'Y')];
  assert.deepEqual(await order(platform.id), [['A', 0], ['B', 1], ['C', 2]]);

  const moved = await send(`/api/kanban/columns/${c.id}${board(platform.id)}`, 'PUT', { position: 0 });
  assert.equal(moved.status, 200);
  assert.deepEqual([(await moved.json()).position], [0]);
  assert.deepEqual(await order(platform.id), [['C', 0], ['A', 1], ['B', 2]]);
  assert.equal((await send(`/api/kanban/columns/${a.id}${board(platform.id)}`, 'PUT', { position: 99 })).status, 200);
  assert.deepEqual(await order(platform.id), [['C', 0], ['B', 1], ['A', 2]]);
  assert.deepEqual(await order(design.id), [['X', 0], ['Y', 1]]);

  assert.equal((await send(`/api/kanban/columns/${y.id}${board(design.id)}`, 'PUT', { position: 0 })).status, 200);
  assert.deepEqual(await order(design.id), [['Y', 0], ['X', 1]]);
  assert.deepEqual(await order(platform.id), [['C', 0], ['B', 1], ['A', 2]]);
  assert.equal((await send(`/api/kanban/columns/${x.id}${board(platform.id)}`, 'PUT', { position: 0 })).status, 404);
  assert.deepEqual(await order(design.id), [['Y', 0], ['X', 1]]);

  const renamed = await send(`/api/kanban/columns/${c.id}${board(platform.id)}`, 'PUT', { name: 'Done' }).then((response) => response.json());
  assert.deepEqual([renamed.name, renamed.position], ['Done', 0]);
  const both = await send(`/api/kanban/columns/${c.id}${board(platform.id)}`, 'PUT', { name: 'Shipped', position: 2 }).then((response) => response.json());
  assert.deepEqual([both.name, both.position], ['Shipped', 2]);
  assert.deepEqual(await order(platform.id), [['B', 0], ['A', 1], ['Shipped', 2]]);

  for (const body of [{ position: -1 }, { position: 1.5 }, { position: 'first' }, {}]) {
    assert.equal((await send(`/api/kanban/columns/${a.id}${board(platform.id)}`, 'PUT', body)).status, 400, JSON.stringify(body));
  }
});
