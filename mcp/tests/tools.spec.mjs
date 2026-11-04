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
  assert.deepEqual(names, ['add_card_note', 'add_milestone', 'apply_view', 'archive_card', 'audit_board', 'decide_card', 'define_metric', 'export_board', 'export_progress', 'get_activity', 'get_board', 'get_card_by_key', 'get_metrics', 'get_needs_you', 'get_project', 'get_report', 'list_cards', 'list_milestones', 'list_projects', 'list_reports', 'list_teams', 'list_views', 'move_card', 'move_project', 'record_metrics', 'restore_card', 'set_needs_you', 'set_team', 'status_export', 'upsert_card', 'upsert_project', 'upsert_report']);

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
  const idea = await call('upsert_project', { key: 'projectId', project: { projectId: 'MCP-IDEA', name: 'Agent idea', team: 'Platform Ops', status: 'Scheduled', scheduleStage: 'Idea' } });
  assert.equal(idea.isError, false, idea.text);
  assert.deepEqual((await call('list_projects', { stage: 'Idea' })).value.map((item) => item.projectId), ['MCP-IDEA']);
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
  const allBoards = await call('get_board', { team: 'all' });
  assert.equal(allBoards.isError, false, allBoards.text);
  assert.ok(allBoards.value.teams.some((item) => item.id === column.teamId), allBoards.text);
  assert.equal(allBoards.value.cards.find((item) => item.id === keyedId).teamName, allBoards.value.teams.find((item) => item.id === column.teamId).name);
  assert.equal((await call('get_board', { team: 'some' })).isError, true);
  assert.deepEqual((await call('list_cards', { teamId: column.teamId, key: 'sync:T-7' })).value.map((item) => item.id), [keyedId]);
  assert.deepEqual((await call('list_cards', { teamId: 99999, key: 'sync:T-7' })).value, []);

  const invalid = await call('move_project', { id: projectId, impact: 11, urgency: 6 });
  assert.deepEqual([invalid.isError, invalid.text], [true, 'Invalid input: arguments.impact must be from 1 to 10.']);
  assert.equal((await call('add_card_note', { cardId, body: 'x', extra: true })).isError, true);
});

test('saved views are listed and applied through the token owner', async (t) => {
  const { baseUrl, send, owner, token } = await startNorthstar(t);
  for (const [name, impact] of [['Alpha', 9], ['Bravo', 3], ['Charlie', 6]]) {
    await send('/api/projects', 'POST', { name, impact, urgency: 4, confidence: 5, effort: 5 }, owner);
  }
  const view = await send('/api/views', 'POST', { name: 'Big bets', params: 'f.impact=5..&sort=name:desc' }, owner);
  const { call } = await connect(t, { baseUrl, token: await token('Views reader', 'read') });

  assert.deepEqual((await call('list_views')).value.map((item) => item.name), ['Big bets']);
  const byName = await call('apply_view', { name: 'big BETS' });
  assert.equal(byName.isError, false, byName.text);
  assert.deepEqual(byName.value.projects.map((project) => project.name), ['Charlie', 'Alpha']);
  assert.deepEqual((await call('apply_view', { id: view.id })).value.view, { id: view.id, name: 'Big bets', params: view.params });
  assert.equal((await call('apply_view', { name: 'missing' })).text, 'Northstar returned HTTP 404: View not found.');
  assert.equal((await call('apply_view', {})).isError, true);
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
  assert.ok(['list_projects', 'audit_board', 'export_board'].every((name) => names.includes(name)));
  assert.ok(!names.some((name) => ['upsert_project', 'move_project', 'upsert_card', 'move_card', 'add_card_note', 'decide_card', 'set_team', 'archive_card', 'restore_card', 'record_metrics', 'define_metric', 'upsert_report', 'add_milestone', 'set_needs_you'].includes(name)));
  assert.ok(['get_metrics', 'get_report', 'list_reports', 'list_milestones', 'get_needs_you', 'export_progress'].every((name) => names.includes(name)));

  const declared = await connect(t, { baseUrl, token: readToken, scope: 'read' });
  assert.equal((await declared.client.listTools()).tools.length, 18);
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


test('cards are placed, moved, audited and exported across teams by name', async (t) => {
  const { baseUrl, send, owner, token } = await startNorthstar(t);
  const { call } = await connect(t, { baseUrl, token: await token('Board agent', 'write') });
  const first = await send('/api/kanban/columns', 'POST', { name: 'Backlog' }, owner);
  const other = (await call('set_team', { name: 'Data Ops', capacity: 3 })).value;
  for (const name of ['Backlog', 'In progress']) await send(`/api/kanban/columns?teamId=${other.id}`, 'POST', { name }, owner);
  const project = (await call('upsert_project', { key: 'projectId', project: { projectId: 'DO-1', name: 'Pipeline', team: 'Data Ops', status: 'Scheduled', impact: 5, urgency: 5, confidence: 5, effort: 5, description: 'Goal: one pipeline.' } })).value.project;

  // a new card needs the team and the column, and a column the team lacks is an error
  const card = { externalUrl: 'https://tracker.example/DO-1', title: 'Build the pipeline', assignee: 'ops-bot', projectId: project.id };
  assert.match((await call('upsert_card', { card, column: 'Backlog' })).text, /Name the team for a new card/);
  assert.match((await call('upsert_card', { card, team: 'Data Ops', column: 'Review' })).text, /Data Ops has no column "Review"\. Its columns: Backlog, In progress\./);
  assert.match((await call('upsert_card', { card, team: 'Nobody', column: 'Backlog' })).text, /No team "Nobody"/);
  const created = await call('upsert_card', { card, team: 'data ops', column: 'backlog' });
  assert.equal(created.value.created, true, created.text);
  assert.equal(created.value.card.teamId, other.id);
  const cardId = created.value.card.id;
  // an existing card keeps its team: updates by name on its own board, refused on another
  assert.equal((await call('upsert_card', { card: { ...card, title: 'Pipeline v1' } })).value.card.title, 'Pipeline v1');
  assert.match((await call('upsert_card', { card, team: String(first.teamId), column: 'Backlog' })).text, /a card stays on its own team/);

  // move_card: by key/url/id, with a dated status line; Scheduled goes Active outside the backlog
  const moved = await call('move_card', { externalUrl: card.externalUrl, column: 'In progress', projectStatus: 'Building the first stage' });
  assert.equal(moved.isError, false, moved.text);
  assert.equal(moved.value.card.columnId === created.value.card.columnId, false);
  assert.deepEqual(moved.value.projectChanged, ['description', 'status']);
  assert.equal(moved.value.project.status, 'Active');
  assert.match(moved.value.project.description, /^Status \d{4}-\d{2}-\d{2}: Building the first stage\n\nGoal: one pipeline\.$/);
  const again = await call('move_card', { id: cardId, column: 'In progress', projectStatus: 'Stage one done' });
  assert.equal((again.value.project.description.match(/^Status /gm) || []).length, 1);
  assert.match((await call('move_card', { id: cardId, column: 'Done' })).text, /Data Ops has no column "Done"/);
  assert.match((await call('move_card', { id: cardId, key: 'x', column: 'Backlog' })).text, /exactly one of id, key or externalUrl/);

  // archive, notes and decisions work on a card of any team
  assert.equal((await call('add_card_note', { cardId, body: 'From the agent' })).value.body, 'From the agent');
  await call('upsert_card', { card: { ...card, decision: { options: ['Ship', 'Wait'] } } });
  assert.equal((await call('decide_card', { id: cardId, option: 'Ship' })).value.decision.decidedOption, 'Ship');

  // audit: the caller names the active columns and the assignee variants
  await call('upsert_project', { key: 'projectId', project: { projectId: 'DO-2', name: 'Second', team: 'Data Ops', status: 'Scheduled', impact: 4, urgency: 4, confidence: 5, effort: 5 } });
  const second = (await call('list_projects', { projectId: 'DO-2' })).value[0];
  await call('upsert_card', { key: 'key', card: { key: 'do:2', title: 'Second card', projectId: second.id, externalUrl: 'https://tracker.example/DO-2' }, team: 'Data Ops', column: 'In progress' });
  const audit = await call('audit_board', { activeColumns: ['In progress'], assigneeVariants: { 'ops-bot': 'Ops Bot' } });
  assert.equal(audit.isError, false, audit.text);
  assert.deepEqual(audit.value.problems.map((item) => item.problem).sort(), ['assignee_variant', 'no_status_line', 'scheduled_with_active_cards']);
  assert.equal((await call('audit_board', { activeColumns: [] })).isError, true);

  // archive keeps the card in the export; two exports are byte for byte the same
  assert.equal((await call('archive_card', { id: cardId })).value.archived, true);
  const one = await call('export_board');
  assert.equal(one.isError, false, one.text);
  assert.ok(one.value.cards.some((item) => item.id === cardId && item.archived));
  assert.deepEqual(one.value.teams.map((item) => item.id), [...one.value.teams.map((item) => item.id)].sort((a, b) => a - b));
  assert.ok(one.value.projects.some((item) => item.projectId === 'DO-1'));
  assert.equal(one.text, (await call('export_board')).text);
});

test('progress: metrics, definitions, reports, milestones and the needs-you column, idempotent end to end', async (t) => {
  const { baseUrl, send, owner, token } = await startNorthstar(t);
  const { call } = await connect(t, { baseUrl, token: await token('Progress agent', 'write') });
  await send('/api/kanban/columns', 'POST', { name: 'Waiting on you' }, owner);

  const defined = await call('define_metric', { key: 'prs_merged', label: 'PRs merged', direction: 'up_good', band: 'momentum', question: 'How much did we merge?' });
  assert.equal(defined.value.created, true, defined.text);
  assert.deepEqual((await call('define_metric', { key: 'prs_merged', label: 'PRs merged', direction: 'up_good' })).value.changed, []);
  await call('define_metric', { key: 'queue_open', label: 'Open queue', direction: 'down_good', startsWhen: 'the queue is connected' });

  const day = { date: '2026-11-03', metrics: [{ key: 'prs_merged', value: 4, note: 'Release day' }, { key: 'queue_open', value: null }] };
  const recorded = await call('record_metrics', day);
  assert.equal(recorded.value.created, 2, recorded.text);
  const repeated = await call('record_metrics', day);
  assert.deepEqual([repeated.value.created, repeated.value.updated, repeated.value.unchanged], [0, 0, 2]);
  await call('record_metrics', { date: '2026-11-02', metrics: [{ key: 'prs_merged', value: 2, rebuilt: true }] });
  const metrics = await call('get_metrics', { keys: ['prs_merged'], from: '2026-11-01' });
  assert.deepEqual(metrics.value.metrics.map((item) => [item.date, item.value, item.rebuilt]), [['2026-11-02', 2, true], ['2026-11-03', 4, false]]);
  assert.deepEqual(metrics.value.defs.map((item) => item.key), ['prs_merged']);
  assert.match((await call('record_metrics', { date: '2026-11-3', metrics: [{ key: 'a', value: 1 }] })).text, /^Invalid input: arguments\.date/);
  assert.match((await call('record_metrics', { date: '2026-11-03', metrics: [{ key: 'a', value: '1' }] })).text, /must be a number/);
  assert.match((await call('record_metrics', { date: '2026-02-30', metrics: [{ key: 'a', value: 1 }] })).text, /HTTP 400: date must be a calendar date/);

  const report = { date: '2026-11-03', markdown: '# Release day\n\nFour merged.', bullets: [{ text: 'Four merged', metric_key: 'prs_merged' }] };
  assert.equal((await call('upsert_report', report)).value.created, true);
  assert.equal((await call('upsert_report', report)).value.changed, false);
  assert.deepEqual((await call('get_report', { date: '2026-11-03' })).value.bullets, report.bullets);
  assert.deepEqual((await call('list_reports', {})).value.map((item) => [item.date, item.title]), [['2026-11-03', 'Release day']]);
  assert.equal((await call('get_report', { date: '2026-11-04' })).text, 'Northstar returned HTTP 404: Report not found.');

  assert.equal((await call('add_milestone', { date: '2026-11-03', label: 'Pipeline live', metricKey: 'prs_merged' })).value.created, true);
  assert.equal((await call('add_milestone', { date: '2026-11-03', label: 'Pipeline live', metricKey: 'prs_merged' })).value.changed, false);
  assert.deepEqual((await call('list_milestones', { metricKey: 'prs_merged' })).value.map((item) => item.label), ['Pipeline live']);

  assert.deepEqual((await call('get_needs_you')).value, { configured: false, count: 0, items: [] });
  assert.match((await call('set_needs_you', { team: 'Nobody', column: 'Waiting on you' })).text, /No team "Nobody"/);
  const teams = (await call('list_teams')).value;
  const set = await call('set_needs_you', { team: teams[0].name, column: 'waiting on you' });
  assert.equal(set.isError, false, set.text);
  assert.equal((await call('get_needs_you')).value.configured, true);

  const one = await call('export_progress');
  assert.deepEqual(Object.keys(one.value), ['metricDefs', 'metrics', 'milestones', 'reports']);
  assert.equal(one.text, (await call('export_progress')).text);
  const activity = (await call('get_activity', { limit: 50 })).value.items.map((item) => item.type);
  for (const type of ['metrics.recorded', 'metric.defined', 'report.created', 'milestone.added']) assert.ok(activity.includes(type), type);
});
