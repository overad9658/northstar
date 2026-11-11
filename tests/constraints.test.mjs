import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createActivityService } from '../activity-service.mjs';
import { createBackupService } from '../backup-service.mjs';
import { buildRegister, createConstraintService } from '../constraint-service.mjs';
import { openDatabase } from '../database.mjs';
import { createKanbanService } from '../kanban-service.mjs';
import { createProgressService } from '../progress-service.mjs';
import { constraintRow, resolvedRow, summaryLine } from '../public/constraints-view.js';
import { compareByConstraint } from '../public/shared/constraints.js';
import { freePort, startServer, stopServer } from '../support/server-fixture.mjs';

// Made-up constraints and cards only: this repository is public.
async function withDb(callback) {
  const dir = await mkdtemp(join(tmpdir(), 'northstar-constraints-'));
  const file = join(dir, 'board.db');
  const db = openDatabase(file);
  try { return await callback({ db, file, dir }); } finally { try { db.close(); } catch { /* closed by the test */ } await rm(dir, { recursive: true, force: true }); }
}

const ranks = (service) => service.list().map((item) => [item.name, item.rank, item.stage]);

test('open constraints hold ranks 1..n with one #1; placing one moves the rest; resolving takes it out', () => withDb(({ db }) => {
  const constraints = createConstraintService(db);
  const review = constraints.upsert({ name: 'Code review wait' }, { actor: 'sam' });
  assert.equal(review.created, true);
  assert.deepEqual([review.constraint.rank, review.constraint.stage], [1, 'identify']);
  constraints.upsert({ name: 'Test flakiness' });
  constraints.upsert({ name: 'Release window', rank: 1, owner: 'alex', measure: 'Hours to ship' });
  assert.deepEqual(ranks(constraints), [['Release window', 1, 'identify'], ['Code review wait', 2, 'identify'], ['Test flakiness', 3, 'identify']]);

  // Matched by name in any case; repeating a call changes nothing.
  const again = constraints.upsert({ name: 'release WINDOW', rank: 1, owner: 'alex', measure: 'Hours to ship' });
  assert.equal(again.created, false);
  const changeCount = () => db.prepare('SELECT COUNT(*) AS count FROM toc_constraint_changes').get().count;
  const before = changeCount();
  constraints.upsert({ name: 'Release window', rank: 1, owner: 'alex' });
  assert.equal(changeCount(), before, 'a no-op upsert logs nothing');

  constraints.upsert({ id: review.constraint.id, rank: 99 });
  assert.deepEqual(ranks(constraints).map(([name, rank]) => [name, rank]), [['Release window', 1], ['Test flakiness', 2], ['Code review wait', 3]], 'a rank past the end goes last');

  const window = constraints.list()[0];
  constraints.setStage(window.id, { stage: 'exploit', note: 'Owners named' }, { actor: 'sam' });
  const resolved = constraints.setStage(window.id, { stage: 'resolved', note: 'Deploys are continuous now' });
  assert.equal(resolved.changed, true);
  assert.deepEqual(ranks(constraints), [['Test flakiness', 1, 'identify'], ['Code review wait', 2, 'identify'], ['Release window', null, 'resolved']], 'the next one becomes #1');
  assert.equal(constraints.setStage(window.id, { stage: 'resolved' }).changed, false, 'repeating a stage changes nothing');
  assert.deepEqual(constraints.get(window.id).history.map((entry) => [entry.from, entry.to, entry.note, entry.actor]),
    [[null, 'identify', '', ''], ['identify', 'exploit', 'Owners named', 'sam'], ['exploit', 'resolved', 'Deploys are continuous now', '']]);
  assert.equal(constraints.get(review.constraint.id).history[0].actor, 'sam');

  // Reopening puts it back last, or where rank says.
  constraints.upsert({ id: window.id, stage: 'elevate', rank: 1 });
  assert.deepEqual(ranks(constraints).map(([name, rank]) => [name, rank]), [['Release window', 1], ['Test flakiness', 2], ['Code review wait', 3]]);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM toc_constraints WHERE rank = 1').get().count, 1);
}));

test('constraint input is checked: fields, stages, ranks, names and the metric link', () => withDb(({ db }) => {
  const constraints = createConstraintService(db);
  const progress = createProgressService(db);
  const one = constraints.upsert({ name: 'Queue depth' }).constraint;
  const two = constraints.upsert({ name: 'Disk' }).constraint;
  assert.throws(() => constraints.upsert({ name: 'X', colour: 'red' }), { status: 400, message: /colour is not a constraint field/ });
  assert.throws(() => constraints.upsert({ name: 'X', stage: 'done' }), { status: 400, message: /stage must be one of identify, exploit, subordinate, elevate, resolved/ });
  assert.throws(() => constraints.upsert({ name: 'X', rank: 0 }), { status: 400, message: /rank must be a whole number from 1/ });
  assert.throws(() => constraints.upsert({ name: '' }), { status: 400 });
  assert.throws(() => constraints.upsert({ name: 'Two\nlines' }), /one line/);
  assert.throws(() => constraints.upsert({ rank: 1 }), /name is required/);
  assert.throws(() => constraints.upsert({ id: 999, name: 'Ghost' }), { status: 404 });
  assert.throws(() => constraints.upsert({ id: two.id, name: 'queue DEPTH' }), { status: 409 });
  assert.throws(() => constraints.upsert({ name: 'Gone', stage: 'resolved', rank: 2 }), /holds no rank/);
  assert.throws(() => constraints.upsert({ id: one.id, metricKey: 'not_defined' }), /not a defined Progress metric/);
  assert.throws(() => constraints.upsert({ id: one.id, metricKey: 'Bad Key' }), /slug/);
  assert.throws(() => constraints.setStage(one.id, { stage: 'later' }), { status: 400 });
  assert.throws(() => constraints.setStage(999, { stage: 'exploit' }), { status: 404 });

  progress.defineMetric('queue_depth', { label: 'Queue depth', unit: 'jobs', direction: 'down_good' });
  for (const [date, value] of [['2030-01-01', 50], ['2030-01-20', 40], ['2030-02-10', 30], ['2030-02-11', 25]]) progress.recordMetrics({ date, metrics: [{ key: 'queue_depth', value }] });
  constraints.upsert({ id: one.id, metricKey: 'queue_depth' });
  const trend = constraints.trend('queue_depth');
  assert.deepEqual(trend.readings.map((item) => item.date), ['2030-01-20', '2030-02-10', '2030-02-11'], 'the 30 days ending on the latest reading');
  assert.deepEqual([trend.label, trend.unit, trend.direction], ['Queue depth', 'jobs', 'down_good']);
  assert.equal(constraints.upsert({ id: one.id, metricKey: '' }).constraint.metricKey, '', 'an empty key unlinks the metric');
  assert.equal(constraints.trend(''), null);
}));

test('cards carry a constraint and a rating; constraint order puts the #1 constraint first, then by rating', () => withDb(({ db }) => {
  const kanban = createKanbanService(db);
  const constraints = createConstraintService(db);
  const first = constraints.upsert({ name: 'Review wait' }).constraint;
  const second = constraints.upsert({ name: 'Flaky tests' }).constraint;
  const column = kanban.createColumn({ name: 'To do' });
  const make = (title, fields = {}) => kanban.createCard({ columnId: column.id, title, ...fields });
  const a = make('Add a second reviewer', { constraintId: first.id, constraintRating: 'eases', rank: 5 });
  const b = make('Big refactor', { constraintId: first.id, constraintRating: 'adds_load', rank: 1 });
  const c = make('Quarantine flaky tests', { constraintId: second.id, constraintRating: 'removes', rank: 2 });
  const d = make('Auto-assign reviewers', { constraintId: first.id, constraintRating: 'removes', rank: 9 });
  const e = make('Unrelated chore', { rank: 0 });
  make('Unrated on #1', { constraintId: first.id, rank: 3 });
  assert.deepEqual([a.constraintId, a.constraintRating], [first.id, 'eases']);
  assert.deepEqual([e.constraintId, e.constraintRating], [null, null]);
  assert.throws(() => make('Bad', { constraintRating: 'helps' }), { status: 400, message: /constraintRating must be one of removes, eases, neutral, adds_load/ });
  assert.throws(() => make('Bad', { constraintId: 999 }), { status: 400, message: /names no constraint/ });

  const order = kanban.findCards({ sort: 'constraint' }).map((card) => card.title);
  assert.deepEqual(order, ['Auto-assign reviewers', 'Add a second reviewer', 'Big refactor', 'Unrated on #1', 'Quarantine flaky tests', 'Unrelated chore']);
  assert.throws(() => kanban.findCards({ sort: 'rating' }), /sort must be "rank" or "constraint"/);

  // An update keeps fields it does not name, and null clears them; changes reach the activity feed.
  assert.equal(kanban.updateCard(b.id, { title: 'Big refactor, later' }).constraintRating, 'adds_load');
  const cleared = kanban.updateCard(b.id, { constraintId: null, constraintRating: null }, { actor: 'sam' });
  assert.deepEqual([cleared.constraintId, cleared.constraintRating], [null, null]);
  const updated = createActivityService(db).list({}).items.find((item) => item.type === 'card.updated' && item.cardId === b.id && item.fields.includes('constraintId'));
  assert.deepEqual(updated.fields, ['constraintId', 'constraintRating']);

  // A resolved constraint has no rank, so its cards sort with the unlinked ones.
  constraints.setStage(first.id, { stage: 'resolved' });
  assert.equal(kanban.findCards({ sort: 'constraint' })[0].id, c.id);
  assert.equal(kanban.getCard(d.id).constraintId, first.id, 'resolving keeps the link, so the audit can ask for a re-rating');

  const sorted = [{ id: 1, constraintId: 7, constraintRating: 'neutral' }, { id: 2 }, { id: 3, constraintId: 7, constraintRating: null }, { id: 4, constraintId: 8, constraintRating: 'removes' }]
    .sort(compareByConstraint(new Map([[7, 1], [8, 2]]), (x, y) => x.id - y.id)).map((card) => card.id);
  assert.deepEqual(sorted, [1, 3, 4, 2]);
}));

test('constraint changes are activity events: created, updated, stage and ranked', () => withDb(({ db }) => {
  const constraints = createConstraintService(db);
  const one = constraints.upsert({ name: 'Build minutes' }, { actor: 'sam' }).constraint;
  constraints.upsert({ name: 'Hiring', rank: 1 }, { actor: 'sam' });
  constraints.upsert({ id: one.id, evidence: 'CI queue 40 min at peak' }, { actor: 'alex' });
  constraints.setStage(one.id, { stage: 'exploit', note: 'Cache the deps' }, { actor: 'alex' });
  constraints.upsert({ id: one.id, rank: 1 }, { actor: 'alex' });
  const items = createActivityService(db).list({}).items.filter((item) => item.type.startsWith('constraint.'));
  const changeId = (item) => Number(item.id.split(':')[1]);
  const mine = items.filter((item) => item.constraintId === one.id).sort((x, y) => changeId(x) - changeId(y)).map(({ type, from, to, fields, stage, note, actor }) => ({ type, from, to, fields, stage, note, actor }));
  assert.deepEqual(mine, [
    { type: 'constraint.created', from: undefined, to: undefined, fields: undefined, stage: 'identify', note: undefined, actor: 'sam' },
    { type: 'constraint.updated', from: undefined, to: undefined, fields: ['evidence'], stage: undefined, note: undefined, actor: 'alex' },
    { type: 'constraint.stage', from: 'identify', to: 'exploit', fields: undefined, stage: undefined, note: 'Cache the deps', actor: 'alex' },
    { type: 'constraint.ranked', from: 2, to: 1, fields: undefined, stage: undefined, note: undefined, actor: 'alex' },
  ]);
  assert.ok(items.every((item) => item.name && item.id.startsWith(`${item.type}:`)));
  constraints.setStage(one.id, { stage: 'resolved' });
  constraints.setStage(one.id, { stage: 'exploit' });
  const latest = createActivityService(db).list({}).items.filter((item) => item.constraintId === one.id).sort((x, y) => changeId(y) - changeId(x)).slice(0, 2).map((item) => [item.type, item.to]);
  assert.deepEqual(latest, [['constraint.stage', 'exploit'], ['constraint.stage', 'resolved']], 'resolving and reopening log the stage only, not a rank event');
}));

test('the register lists each constraint with its trend, linked cards and counts, and what the board still owes', () => {
  const constraints = [
    { id: 1, name: 'Review wait', rank: 1, stage: 'exploit', metricKey: 'review_hours', history: [] },
    { id: 2, name: 'Old one', rank: null, stage: 'resolved', metricKey: '', history: [] },
  ];
  const card = (id, fields) => ({ id, title: `Card ${id}`, assignee: '', archived: false, columnName: 'To do', constraintId: null, constraintRating: null, ...fields });
  const cards = [
    card(1, { constraintId: 1, constraintRating: 'removes' }),
    card(2, { constraintId: 1, constraintRating: 'adds_load' }),
    card(3, { constraintId: 1 }),
    card(4, { constraintId: 1, constraintRating: 'eases', columnName: 'Done' }),
    card(5, { constraintId: 2, constraintRating: 'eases' }),
    card(6, {}),
    card(7, { archived: true }),
  ];
  const view = buildRegister({ constraints, cards, trend: (key) => (key ? { key, label: 'Review hours', readings: [] } : null) });
  const [first, old] = view.constraints;
  assert.deepEqual(first.cards.map((item) => [item.id, item.rating, item.open]), [[1, 'removes', true], [2, 'adds_load', true], [3, null, true], [4, 'eases', false]]);
  assert.deepEqual(first.counts, { removes: 1, eases: 0, neutral: 0, adds_load: 1, unrated: 1 });
  assert.equal(first.trend.label, 'Review hours');
  assert.equal(old.trend, null);
  assert.equal(view.unrated, 2, 'cards 3 and 6: open with no rating; done and archived cards are left out');
  assert.equal(view.needsRerating, 1, 'card 5 sits on a resolved constraint');
  assert.equal(buildRegister({ constraints: [], cards }).unrated, 0, 'no constraints, nothing to rate');
});

test('rows render without innerHTML: rank, stages, measure trend, cards by rating, evidence and history', () => {
  const doc = fakeDocument();
  const item = {
    id: 1, name: 'Review wait', rank: 1, stage: 'subordinate', owner: 'sam', measure: 'Median hours a PR waits', evidence: 'Queue grew 3x',
    trend: { key: 'review_hours', label: 'Review hours', unit: 'h', direction: 'down_good', readings: [{ date: '2030-01-01', value: 30, rebuilt: false }, { date: '2030-01-02', value: 24, rebuilt: false }] },
    cards: [{ id: 9, title: 'Auto-assign', assignee: 'alex', rating: 'removes', open: true, teamName: 'Platform', columnName: 'Doing' }],
    counts: { removes: 1, eases: 0, neutral: 0, adds_load: 0, unrated: 2 },
    history: [{ from: null, to: 'identify', at: '2030-01-01T10:00:00.000Z', note: '', actor: 'sam' }, { from: 'identify', to: 'subordinate', at: '2030-01-03T10:00:00.000Z', note: 'Others wait', actor: 'sam' }],
  };
  const row = constraintRow(doc, item);
  const text = textOf(row);
  assert.match(row.attributes.class, /is-first/);
  assert.match(text, /#1Review waitsam/);
  const steps = find(row, (node) => node.attributes?.class === 'toc-steps');
  assert.deepEqual(steps.children.map((node) => node.attributes.class), ['toc-step is-done', 'toc-step is-done', 'toc-step is-current', 'toc-step', 'toc-step']);
  assert.match(text, /Review hours24 h/);
  assert.match(text, /1 removes2 not rated/);
  assert.equal(find(row, (node) => node.tag === 'a').attributes.href, '/kanban.html?card=9');
  assert.match(text, /Identify Jan 1 → Subordinate Jan 3/);
  assert.ok(find(row, (node) => node.tag === 'details' && node.attributes.open === ''), 'the #1 shows its evidence open');
  assert.match(textOf(constraintRow(doc, { ...item, rank: 2, trend: null, measure: '', evidence: '', cards: [], counts: { removes: 0, eases: 0, neutral: 0, adds_load: 0, unrated: 0 }, history: [] })), /No measure yet\.No cards linked yet\./);
  const resolved = resolvedRow(doc, { ...item, stage: 'resolved', history: [...item.history, { from: 'subordinate', to: 'resolved', at: '2030-02-01T00:00:00Z', note: '', actor: '' }] });
  assert.match(textOf(resolved), /Resolved Feb 1.*3 open cards to re-rate/);
  assert.equal(summaryLine(doc, { unrated: 0, needsRerating: 0 }), null);
  assert.equal(textOf(summaryLine(doc, { unrated: 1, needsRerating: 2 })), '1 open card is not rated · 2 cards need re-rating');
});

async function startApi(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-constraints-api-'));
  const port = await freePort();
  const child = await startServer(dataDir, port, { AUTH_DISABLED: 'false', API_TOKEN: '' });
  t.after(async () => { await stopServer(child); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const send = (path, method = 'GET', body, headers = {}) => fetch(`${base}${path}`, {
    method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setup = await send('/api/auth/setup', 'POST', { username: 'owner', password: 'correct horse battery staple' });
  const owner = { cookie: setup.headers.get('set-cookie').split(';', 1)[0] };
  const token = async (name, scope) => ({ authorization: `Bearer ${(await (await send('/api/api-tokens', 'POST', { name, scope }, owner)).json()).token}` });
  return { base, send, owner, token };
}

test('the API reads the register with any token, writes with a write token, and links cards', async (t) => {
  const { send, owner, token } = await startApi(t);
  const writer = await token('agent', 'write');
  const reader = await token('viewer', 'read');
  assert.deepEqual(await (await send('/api/constraints', 'GET', undefined, reader)).json(), { constraints: [], unrated: 0, needsRerating: 0 });
  assert.equal((await send('/api/constraints/upsert', 'PUT', { name: 'Review wait' }, reader)).status, 403);
  assert.equal((await send('/api/constraints', 'GET')).status, 401);

  await send('/api/progress/metric-defs/review_hours', 'PUT', { label: 'Review hours', unit: 'h', direction: 'down_good' }, writer);
  await send('/api/progress/metrics', 'PUT', { date: '2030-01-01', metrics: [{ key: 'review_hours', value: 30 }] }, writer);
  const created = await send('/api/constraints/upsert', 'PUT', { name: 'Review wait', measure: 'Hours a PR waits', metricKey: 'review_hours', owner: 'sam' }, writer);
  assert.equal(created.status, 201);
  const { constraint } = await created.json();
  assert.equal((await send('/api/constraints/upsert', 'PUT', { name: 'review wait' }, writer)).status, 200);
  assert.equal((await send('/api/constraints/upsert', 'PUT', { name: 'X', stage: 'done' }, writer)).status, 400);

  const column = await (await send('/api/kanban/columns', 'POST', { name: 'To do' }, owner)).json();
  const card = await (await send('/api/kanban/cards', 'POST', { columnId: column.id, title: 'Auto-assign reviewers', constraintId: constraint.id, constraintRating: 'removes' }, owner)).json();
  await send('/api/kanban/cards', 'POST', { columnId: column.id, title: 'Unrated' }, owner);
  const upserted = await (await send('/api/kanban/cards/upsert?key=key', 'PUT', { key: 'C-1', columnId: column.id, title: 'Via upsert', constraintId: constraint.id, constraintRating: 'adds_load' }, writer)).json();
  assert.deepEqual([upserted.card.constraintId, upserted.card.constraintRating], [constraint.id, 'adds_load']);

  const register = await (await send('/api/constraints', 'GET', undefined, reader)).json();
  assert.deepEqual(register.constraints[0].cards.map((item) => [item.id, item.rating]), [[card.id, 'removes'], [upserted.card.id, 'adds_load']]);
  assert.deepEqual(register.constraints[0].trend.readings, [{ date: '2030-01-01', value: 30, rebuilt: false }]);
  assert.equal(register.unrated, 1);

  const staged = await send(`/api/constraints/${constraint.id}/stage`, 'PUT', { stage: 'resolved', note: 'Fixed' }, writer);
  assert.equal(staged.status, 200);
  assert.equal((await send(`/api/constraints/${constraint.id}/stage`, 'PUT', { stage: 'exploit' }, reader)).status, 403);
  assert.equal((await send('/api/constraints/999/stage', 'PUT', { stage: 'exploit' }, writer)).status, 404);
  assert.equal((await (await send('/api/constraints', 'GET', undefined, reader)).json()).needsRerating, 2);
  assert.equal((await (await send(`/api/constraints/${constraint.id}`, 'GET', undefined, reader)).json()).history.at(-1).to, 'resolved');
  const activity = await (await send('/api/activity', 'GET', undefined, reader)).json();
  assert.ok(activity.items.some((item) => item.type === 'constraint.stage' && item.to === 'resolved' && item.actor === 'agent'));
  const sorted = await (await send('/api/kanban/cards?sort=constraint', 'GET', undefined, reader)).json();
  assert.equal(sorted.length, 3);
});

test('backups carry constraints and card links; an older backup keeps the stored constraints; an older database gains them', () => withDb(({ db, file }) => {
  let kanban = createKanbanService(db);
  let constraints = createConstraintService(db);
  const one = constraints.upsert({ name: 'Review wait', evidence: 'Long queue' }).constraint;
  constraints.setStage(one.id, { stage: 'exploit' });
  const column = kanban.createColumn({ name: 'To do' });
  const card = kanban.createCard({ columnId: column.id, title: 'Auto-assign', constraintId: one.id, constraintRating: 'removes' });
  const backup = createBackupService(db);
  const exported = backup.export();
  assert.equal(exported.constraints.length, 1);
  constraints.upsert({ name: 'Added after the backup' });
  backup.restore(exported);
  assert.deepEqual(constraints.list().map((item) => [item.name, item.rank, item.stage]), [['Review wait', 1, 'exploit']]);
  assert.deepEqual([kanban.getCard(card.id).constraintId, kanban.getCard(card.id).constraintRating], [one.id, 'removes']);
  assert.equal(constraints.get(one.id).history.length, 2);

  const older = structuredClone(exported);
  delete older.constraints; delete older.constraintChanges;
  older.kanbanCards.forEach((row) => { delete row.constraint_id; delete row.constraint_rating; });
  backup.restore(older);
  assert.equal(constraints.list().length, 1, 'an older backup leaves the register as it is');
  assert.equal(kanban.getCard(card.id).constraintRating, null);

  const dangling = structuredClone(exported);
  dangling.kanbanCards[0].constraint_id = 999;
  backup.restore(dangling);
  assert.equal(kanban.getCard(card.id).constraintId, null, 'a link to a constraint the backup lacks is dropped');
  db.close();

  // A database from before the register: the tables and card columns are added, nothing is lost.
  const raw = new DatabaseSync(file);
  raw.exec('DROP INDEX idx_kanban_cards_constraint; ALTER TABLE kanban_cards DROP COLUMN constraint_id; ALTER TABLE kanban_cards DROP COLUMN constraint_rating; DROP TABLE toc_constraint_changes; DROP TABLE toc_constraints;');
  raw.close();
  const reopened = openDatabase(file);
  try {
    kanban = createKanbanService(reopened);
    constraints = createConstraintService(reopened);
    assert.deepEqual([kanban.getCard(card.id).title, kanban.getCard(card.id).constraintId, kanban.getCard(card.id).constraintRating, constraints.list()], ['Auto-assign', null, null, []]);
    const fresh = constraints.upsert({ name: 'After migration' }).constraint;
    assert.equal(kanban.updateCard(card.id, { constraintId: fresh.id, constraintRating: 'eases' }).constraintRating, 'eases');
  } finally { reopened.close(); }
  // Opening again changes nothing.
  const twice = openDatabase(file);
  try { assert.equal(createConstraintService(twice).list().length, 1); } finally { twice.close(); }
}));

test('PostgreSQL stores constraints, their history and the card fields', {
  skip: !process.env.TEST_DATABASE_URL,
}, () => {
  const config = { client: 'postgres', connectionString: process.env.TEST_DATABASE_URL };
  let db = openDatabase(undefined, config);
  try {
    const kanban = createKanbanService(db);
    const constraints = createConstraintService(db);
    const stamp = Date.now();
    const one = constraints.upsert({ name: `PG review ${stamp}` }).constraint;
    const two = constraints.upsert({ name: `PG tests ${stamp}`, rank: 1 }).constraint;
    assert.equal(constraints.get(two.id).rank, 1);
    assert.equal(constraints.get(one.id).rank, 2);
    const column = kanban.createColumn({ name: `PG constraints ${stamp}` });
    const card = kanban.createCard({ columnId: column.id, title: 'PG card', constraintId: one.id, constraintRating: 'eases' });
    constraints.setStage(two.id, { stage: 'resolved', note: 'done' });
    db.close();
    db = openDatabase(undefined, config);
    const again = createConstraintService(db);
    const cards = createKanbanService(db);
    assert.equal(again.get(one.id).rank, 1);
    assert.deepEqual(again.get(two.id).history.map((entry) => entry.to), ['identify', 'resolved']);
    assert.deepEqual([cards.getCard(card.id).constraintId, cards.getCard(card.id).constraintRating], [one.id, 'eases']);
    assert.ok(createActivityService(db).list({}).items.some((item) => item.type === 'constraint.stage' && item.constraintId === two.id));
    cards.deleteCard(card.id); cards.deleteColumn(column.id);
    db.exec(`DELETE FROM toc_constraints WHERE id IN (${one.id}, ${two.id})`);
  } finally { db.close(); }
});

test('the page is linked from the menu and builds its DOM without innerHTML or outside links', async () => {
  assert.match(await readFile('public/index.html', 'utf8'), /href="\/constraints.html"/);
  for (const file of ['public/constraints.js', 'public/constraints-view.js', 'public/constraints.css', 'public/shared/constraints.js']) assert.doesNotMatch(await readFile(file, 'utf8'), /\.innerHTML|https:\/\/[a-z]/i, file);
  assert.doesNotMatch(await readFile('public/constraints.html', 'utf8'), /style=/);
});

// A minimal document: enough DOM to render into; innerHTML throws so any use of it fails the test.
function fakeDocument() {
  const element = (tag) => {
    const node = { tag, attributes: {}, children: [], text: '' };
    Object.defineProperty(node, 'innerHTML', { set: () => { throw new Error('innerHTML must not be used'); } });
    Object.defineProperty(node, 'firstChild', { get: () => node.children[0] });
    Object.defineProperty(node, 'textContent', { get: () => node.text, set: (value) => { node.text = String(value); } });
    node.setAttribute = (name, value) => { node.attributes[name] = String(value); };
    node.appendChild = (child) => { node.children.push(child); return child; };
    return node;
  };
  return { createElement: element, createElementNS: (_, tag) => element(tag), createTextNode: (value) => ({ tag: '#text', text: String(value), children: [] }) };
}
const textOf = (node) => (node.tag === '#text' ? node.text : `${node.text || ''}${(node.children || []).map(textOf).join('')}`);
const find = (node, match) => (match(node) ? node : (node.children || []).map((child) => find(child, match)).find(Boolean));
