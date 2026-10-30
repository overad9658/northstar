import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { freePort, startServer, stopServer } from './support/server-fixture.mjs';

async function startApi(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-card-changes-'));
  const port = await freePort();
  const child = await startServer(dataDir, port, { AUTH_DISABLED: 'false', API_TOKEN: '' });
  t.after(async () => { await stopServer(child); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const send = (path, method = 'GET', body, headers = {}) => fetch(`${base}${path}`, {
    method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setup = await send('/api/auth/setup', 'POST', { username: 'owner', password: 'correct horse battery staple' });
  const owner = { cookie: setup.headers.get('set-cookie').split(';', 1)[0] };
  const token = async (name, scope) => ({ authorization: `Bearer ${(await send('/api/api-tokens', 'POST', { name, scope }, owner).then((response) => response.json())).token}` });
  const bot = await token('Sync bot', 'write');
  const column = await send('/api/kanban/columns', 'POST', { name: 'To do' }, owner).then((response) => response.json());
  const nextColumn = await send('/api/kanban/columns', 'POST', { name: 'Done' }, owner).then((response) => response.json());
  const put = async (cardId, body, headers) => {
    const response = await send(`/api/kanban/cards/${cardId}`, 'PUT', body, headers);
    assert.equal(response.status, 200, JSON.stringify(body));
    return response.json();
  };
  const events = async (type, cardId, headers = owner) => (await send('/api/activity?limit=500', 'GET', undefined, headers).then((response) => response.json()))
    .items.filter((item) => item.type === type && (cardId === undefined || item.cardId === cardId));
  return { send, owner, bot, token, column, nextColumn, put, events };
}

test('card.updated records which content fields changed and who changed them', async (t) => {
  const { send, owner, bot, column, nextColumn, put, events } = await startApi(t);
  const card = await send('/api/kanban/cards', 'POST', { columnId: column.id, title: 'Draft' }, owner).then((response) => response.json());
  await put(card.id, { title: 'Release notes', nextStep: 'Send for review' }, bot);
  await put(card.id, { title: 'Release notes', nextStep: 'Send for review' }, bot);
  await put(card.id, { columnId: nextColumn.id }, owner);
  await put(card.id, { externalUrl: 'https://tracker.example/T-1', description: 'Context' }, owner);
  const updated = (await events('card.updated', card.id)).map(({ fields, actor, title }) => ({ fields, actor, title }));
  assert.deepEqual(updated.sort((a, b) => a.actor.localeCompare(b.actor)), [
    { fields: ['description', 'externalUrl'], actor: 'owner', title: 'Release notes' },
    { fields: ['title', 'nextStep'], actor: 'Sync bot', title: 'Release notes' },
  ]);
});

test('card.decided records the option and who decided, once per decision', async (t) => {
  const { send, owner, bot, column, put, events } = await startApi(t);
  const decision = { options: ['Ship', 'Wait'], recommendation: 'Wait', confidence: 60 };
  const card = await send('/api/kanban/cards', 'POST', { columnId: column.id, title: 'Go or wait', decision }, owner).then((response) => response.json());
  await put(card.id, { decision: { ...decision, confidence: 70 } }, owner);
  assert.deepEqual(await events('card.decided', card.id), []);
  await put(card.id, { decision: { ...decision, decidedOption: 'Wait' } }, owner);
  await put(card.id, { title: 'Go or wait (decided)', decision: { ...decision, decidedOption: 'Wait' } }, owner);
  await put(card.id, { decision: { ...decision, decidedOption: 'Ship' } }, bot);
  const decided = (await events('card.decided', card.id)).map(({ cardId, option, by }) => ({ cardId, option, by }));
  assert.deepEqual(decided.sort((a, b) => a.option.localeCompare(b.option)), [
    { cardId: card.id, option: 'Ship', by: 'Sync bot' },
    { cardId: card.id, option: 'Wait', by: 'owner' },
  ]);
});

test('card.assigned records assignee changes from the dialog and from upserts', async (t) => {
  const { send, owner, bot, column, put, events } = await startApi(t);
  const body = { externalUrl: 'https://tracker.example/T-2', columnId: column.id, title: 'Synced', assignee: 'fe' };
  const { card } = await send('/api/kanban/cards/upsert', 'PUT', body, bot).then((response) => response.json());
  await send('/api/kanban/cards/upsert', 'PUT', { ...body, assignee: '3a' }, bot);
  await send('/api/kanban/cards/upsert', 'PUT', { ...body, assignee: '3a' }, bot);
  await put(card.id, { assignee: '' }, owner);
  const assigned = (await events('card.assigned', card.id)).map(({ from, to, actor }) => ({ from, to, actor }));
  assert.deepEqual(assigned.sort((a, b) => a.from.localeCompare(b.from)), [
    { from: '3a', to: '', actor: 'owner' },
    { from: 'fe', to: '3a', actor: 'Sync bot' },
  ]);
});

test('card change events follow project visibility', async (t) => {
  const { send, owner, token, column, put, events } = await startApi(t);
  const hidden = await send('/api/projects', 'POST', { name: 'Hidden', hiddenFromReadOnly: true, impact: 3, urgency: 3, confidence: 5, effort: 5 }, owner).then((response) => response.json());
  const secret = await send('/api/kanban/cards', 'POST', { columnId: column.id, projectId: hidden.id, title: 'Secret' }, owner).then((response) => response.json());
  const open = await send('/api/kanban/cards', 'POST', { columnId: column.id, title: 'Open' }, owner).then((response) => response.json());
  await put(secret.id, { assignee: 'fe', title: 'Secret plan' }, owner);
  await put(open.id, { assignee: 'fe' }, owner);
  const reader = await token('Reader', 'read');
  const seen = [...await events('card.assigned', undefined, reader), ...await events('card.updated', undefined, reader)];
  assert.deepEqual(seen.map((item) => item.cardId), [open.id]);
  assert.equal((await events('card.updated', secret.id)).length, 1);
});
