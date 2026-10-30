// Run from the repository root (`node --test 'mcp/tests/*.spec.mjs'`): the fixture starts ./server.mjs there.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { freePort, startServer, stopServer } from '../../support/server-fixture.mjs';
import { parseBaseUrl } from '../client.mjs';
import { createNorthstarServer } from '../server.mjs';

async function startNorthstar(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-mcp-'));
  const port = await freePort();
  const child = await startServer(dataDir, port, { AUTH_DISABLED: 'false', API_TOKEN: '' });
  t.after(async () => { await stopServer(child); await rm(dataDir, { recursive: true, force: true }); });
  const baseUrl = `http://127.0.0.1:${port}`;
  const send = (path, method = 'GET', body, headers = {}) => fetch(`${baseUrl}${path}`, {
    method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((response) => response.json());
  const setup = await fetch(`${baseUrl}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'correct horse battery staple' }) });
  const owner = { cookie: setup.headers.get('set-cookie').split(';', 1)[0] };
  const token = async (name, scope) => (await send('/api/api-tokens', 'POST', { name, scope }, owner)).token;
  return { baseUrl, send, owner, token };
}

async function connect(t, options) {
  const server = createNorthstarServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'northstar-mcp-test', version: '1.0.0' });
  await client.connect(clientTransport);
  t.after(() => client.close());
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content[0].text;
    let value = text;
    try { value = JSON.parse(text); } catch { /* plain text */ }
    return { isError: Boolean(result.isError), text, value };
  };
  return { client, call };
}

test('every tool works against a running Northstar with a write token', async (t) => {
  const { baseUrl, send, owner, token } = await startNorthstar(t);
  const column = await send('/api/kanban/columns', 'POST', { name: 'To do' }, owner);
  const writeToken = await token('MCP agent', 'write');
  const { client, call } = await connect(t, { baseUrl, token: writeToken });

  const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ['add_card_note', 'archive_card', 'decide_card', 'get_activity', 'get_board', 'get_card_by_key', 'get_project', 'list_cards', 'list_projects', 'list_teams', 'move_project', 'restore_card', 'set_team', 'status_export', 'upsert_card', 'upsert_project']);

  const team = await call('set_team', { name: 'Platform Ops', capacity: 4 });
  assert.equal(team.isError, false, team.text);
  assert.equal(team.value.capacity, 4);
  assert.equal((await call('set_team', { name: 'platform ops', capacity: 6 })).value.capacity, 6);
  assert.equal((await call('list_teams')).value.find((item) => item.name === 'Platform Ops').capacity, 6);

  const project = { projectId: 'MCP-1', name: 'Agent sync', team: 'Platform Ops', impact: 4, urgency: 4, confidence: 5, effort: 5 };
  const created = await call('upsert_project', { key: 'projectId', project });
  assert.equal(created.value.created, true, created.text);
  assert.equal((await call('upsert_project', { key: 'projectId', project })).value.created, false);
  const projectId = created.value.project.id;
  assert.deepEqual((await call('list_projects', { projectId: 'MCP-1' })).value.map((item) => item.id), [projectId]);
  assert.equal((await call('get_project', { id: projectId })).value.name, 'Agent sync');
  assert.equal((await call('get_project', { id: 99999 })).isError, true);
  const moved = await call('move_project', { id: projectId, impact: 7, urgency: 6, comment: 'Raised by the agent' });
  assert.deepEqual([moved.value.impact, moved.value.urgency], [7, 6]);

  const card = { externalUrl: 'https://tracker.example/T-1', columnId: column.id, title: 'Review', assignee: 'agent', tags: ['sync'], decision: { options: ['Merge', 'Wait'], recommendation: 'Merge', confidence: 80 } };
  const upserted = await call('upsert_card', { card });
  assert.equal(upserted.value.created, true, upserted.text);
  const cardId = upserted.value.card.id;
  assert.equal((await call('upsert_card', { card })).value.card.id, cardId);
  assert.equal((await call('add_card_note', { cardId, body: 'Checks are green' })).value.body, 'Checks are green');
  assert.deepEqual((await call('list_cards', { decision: 'open' })).value.map((item) => item.id), [cardId]);
  assert.deepEqual((await call('list_cards', { assignee: 'agent', tag: 'Sync' })).value.map((item) => item.id), [cardId]);
  assert.deepEqual((await call('list_cards', { assignee: 'nobody' })).value, []);
  assert.equal((await call('decide_card', { id: cardId, option: 'Merge' })).value.decision.decidedOption, 'Merge');
  assert.equal((await call('decide_card', { id: cardId, option: 'Neither' })).isError, true);
  assert.deepEqual((await call('list_cards', { decision: 'open' })).value, []);

  const activity = await call('get_activity', { limit: 50 });
  assert.ok(activity.value.items.some((item) => item.type === 'project.moved' && item.comment === 'Raised by the agent'));
  const exported = await call('status_export');
  assert.equal(exported.isError, false, exported.text);
  assert.match(exported.text, /Project ID/);
  assert.match(exported.text, /"MCP-1","Agent sync","Platform Ops"/);

  // Card keys, archive and team boards.
  const keyed = await call('upsert_card', { key: 'key', card: { key: 'sync:T-7', columnId: column.id, title: 'Keyed', source: 'agent' } });
  assert.equal(keyed.value.created, true, keyed.text);
  const keyedId = keyed.value.card.id;
  assert.equal((await call('upsert_card', { key: 'key', card: { key: 'sync:T-7', columnId: column.id, title: 'Keyed again' } })).value.card.id, keyedId);
  assert.equal((await call('get_card_by_key', { key: 'sync:T-7' })).value.title, 'Keyed again');
  assert.equal((await call('get_card_by_key', { key: 'missing' })).isError, true);
  assert.deepEqual((await call('list_cards', { key: 'sync:T-7' })).value.map((item) => item.id), [keyedId]);
  assert.deepEqual((await call('list_cards', { source: 'agent' })).value.map((item) => item.id), [keyedId]);
  assert.equal((await call('archive_card', { id: keyedId })).value.archived, true);
  assert.deepEqual((await call('list_cards', { source: 'agent' })).value, []);
  assert.deepEqual((await call('list_cards', { source: 'agent', archived: 'only' })).value.map((item) => item.id), [keyedId]);
  assert.equal((await call('get_card_by_key', { key: 'sync:T-7' })).value.archived, true);
  assert.equal((await call('restore_card', { id: keyedId })).value.archived, false);
  const board = await call('get_board', { teamId: column.teamId });
  assert.ok(board.value.cards.some((item) => item.id === keyedId), board.text);
  assert.deepEqual((await call('list_cards', { teamId: column.teamId, key: 'sync:T-7' })).value.map((item) => item.id), [keyedId]);
  assert.deepEqual((await call('list_cards', { teamId: 99999, key: 'sync:T-7' })).value, []);

  const invalid = await call('move_project', { id: projectId, impact: 11, urgency: 6 });
  assert.deepEqual([invalid.isError, invalid.text], [true, 'Invalid input: arguments.impact must be from 1 to 10.']);
  assert.equal((await call('add_card_note', { cardId, body: 'x', extra: true })).isError, true);
});

test('a read token keeps read tools and drops write tools after the first refusal', async (t) => {
  const { baseUrl, token } = await startNorthstar(t);
  const readToken = await token('Reader', 'read');
  const { client, call } = await connect(t, { baseUrl, token: readToken });
  let changed = false;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { changed = true; });

  assert.equal((await call('list_teams')).isError, false);
  const refused = await call('set_team', { name: 'Denied', capacity: 1 });
  assert.equal(refused.isError, true);
  assert.equal(refused.text, 'Northstar returned HTTP 403: This API token is read-only.');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(changed, true);
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(names.includes('list_projects'));
  assert.ok(!names.some((name) => ['upsert_project', 'move_project', 'upsert_card', 'add_card_note', 'decide_card', 'set_team', 'archive_card', 'restore_card'].includes(name)));

  const declared = await connect(t, { baseUrl, token: readToken, scope: 'read' });
  assert.equal((await declared.client.listTools()).tools.length, 8);
});

test('a bad token is refused with the API status, and the token never appears in errors', async (t) => {
  const { baseUrl } = await startNorthstar(t);
  const badToken = 'northstar_not-a-real-token';
  const bad = await connect(t, { baseUrl, token: badToken });
  const refused = await bad.call('list_projects');
  assert.equal(refused.isError, true);
  assert.match(refused.text, /^Northstar returned HTTP 401: /);
  assert.ok(!refused.text.includes(badToken));

  const secret = 'northstar_secret-value';
  const echoing = await connect(t, {
    baseUrl, token: secret,
    fetchImpl: async () => new Response(JSON.stringify({ error: `Token ${secret} was rejected.` }), { status: 401, headers: { 'content-type': 'application/json' } }),
  });
  const echoed = await echoing.call('list_teams');
  assert.equal(echoed.text, 'Northstar returned HTTP 401: Token [redacted] was rejected.');

  const offline = await connect(t, { baseUrl: 'http://127.0.0.1:1', token: secret });
  const unreachable = await offline.call('list_teams');
  assert.equal(unreachable.isError, true);
  assert.match(unreachable.text, /^Northstar is unreachable at http:\/\/127\.0\.0\.1:1/);
  assert.ok(!unreachable.text.includes(secret));
});

test('NORTHSTAR_URL must be http or https without credentials', () => {
  assert.equal(parseBaseUrl(), 'http://127.0.0.1:3000');
  assert.equal(parseBaseUrl('https://northstar.example/'), 'https://northstar.example');
  assert.throws(() => parseBaseUrl('file:///etc/passwd'), /http or https/);
  assert.throws(() => parseBaseUrl('ftp://northstar.example'), /http or https/);
  assert.throws(() => parseBaseUrl('https://user:pass@northstar.example'), /credentials/);
  assert.throws(() => parseBaseUrl('not a url'), /valid URL/);
});
