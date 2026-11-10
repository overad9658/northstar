import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createBackupService } from './backup-service.mjs';
import { openDatabase } from './database.mjs';
import { createKanbanService } from './kanban-service.mjs';
import { buildSequence, createSequenceService, movesBetween } from './sequence-service.mjs';
import { footer, linkGeometry, row } from './public/sequence-view.js';
import { freePort, startServer, stopServer } from './support/server-fixture.mjs';

// Made-up cards only: this repository is public.
const card = (id, fields = {}) => ({ id, title: `Card ${id}`, nextStep: '', assignee: '', rank: null, archived: false, columnName: 'To do', blockedBy: [], objective: '', rankReason: '', reasonFull: '', waitUntil: null, outcome: '', ...fields });
const run = (id, items) => ({ id, at: '2030-01-02T18:42:00.000Z', skillVersion: 'v1', scores: {}, items: items.map(([cardId, rank, reason = '']) => ({ cardId, rank, reason })) });

test('the sequence lists ranked, open cards in order, with who, why, what they unblock and what they reach', () => {
  const now = new Date('2030-01-02T12:00:00Z');
  const cards = [
    card(1, { rank: 2, assignee: 'sam', nextStep: 'Approve the schema', objective: 'Faster search', rankReason: 'One approval left', reasonFull: 'The schema change needs one approval.' }),
    card(2, { rank: 1, assignee: 'Alex', title: 'Ship the importer', outcome: 'Imports run nightly', objective: 'Reliable imports' }),
    card(3, { rank: 3, assignee: 'sam', waitUntil: '2030-01-03T00:00:00Z', blockedBy: [1] }),
    card(4, { blockedBy: [3] }),
    card(5, { blockedBy: [4], title: 'Deep follow-up' }),
    card(6, { rank: 0, columnName: ' done ' }),
    card(7, { rank: 0, archived: true }),
    card(8, { rank: 4, blockedBy: [6] }),
  ];
  const view = buildSequence({ cards, viewer: 'Sam', now, latest: run(2, [[2, 1], [1, 2], [3, 3], [9, null]]), previous: null });
  assert.deepEqual(view.rows.map((item) => [item.place, item.id]), [[1, 2], [2, 1], [3, 3], [4, 8]], 'Done and archived cards drop out');
  const [first, second, third, fourth] = view.rows;
  assert.deepEqual([first.now, first.owner, first.mine, first.reaches], ['Ship the importer', 'Alex', false, 'Imports run nightly']);
  assert.deepEqual([second.now, second.mine, second.rankReason, second.reasonFull, second.reaches], ['Approve the schema', true, 'One approval left', 'The schema change needs one approval.', ''], 'no outcome: Reaches stays empty, never the objective');
  assert.deepEqual(second.then, [[{ id: 3, title: 'Card 3' }], [{ id: 4, title: 'Card 4' }], [{ id: 5, title: 'Deep follow-up' }]]);
  assert.equal(third.waiting, true);
  assert.equal(buildSequence({ cards, now: new Date('2030-01-04T00:00:00Z') }).rows[2].waiting, false, 'a past wait time no longer dims the row');
  assert.deepEqual(fourth.then, []);
  assert.deepEqual(view.queue, [{ name: 'sam', count: 2, mine: true }, { name: 'Alex', count: 1, mine: false }]);
  assert.deepEqual(view.objectives, ['Faster search', 'Reliable imports'], 'alphabetical, so marks stay put between passes');
  assert.deepEqual(view.links, [{ from: 1, to: 3 }], 'links join ranked cards only');
  assert.deepEqual(view.fyi, [], 'an unranked run item that is not an open card is not listed');
  assert.deepEqual(buildSequence({ cards, viewer: 'sam', mine: true, now }).rows.map((item) => [item.place, item.id]), [[2, 1], [3, 3]], 'Mine keeps each row\'s place');
  assert.deepEqual(buildSequence({ cards: [card(4)], latest: run(1, [[4, null]]) }).fyi, [{ id: 4, title: 'Card 4' }]);
  assert.equal(buildSequence({ cards: [] }).run, null);
});

test('a card only moves when the pass reordered it, not when a card above it closed or a new one arrived', () => {
  const previous = run(1, [[1, 1], [2, 2], [3, 3], [4, 4]]);
  const latest = run(2, [[9, 1], [3, 2], [1, 3], [4, 4], [5, null]]);
  assert.deepEqual([...movesBetween(latest, previous)], [[3, 1], [1, -1]], 'card 9 is new and card 2 left: only the 1/3 swap counts');
  assert.deepEqual([...movesBetween(latest, null)], []);
  const cards = [card(1, { rank: 3 }), card(3, { rank: 2 }), card(4, { rank: 4 }), card(9, { rank: 1 })];
  const view = buildSequence({ cards, latest, previous });
  assert.deepEqual(view.rows.map((item) => item.moved), [null, { places: 1, direction: 'up' }, { places: 1, direction: 'down' }, null]);
});

test('row and footer render without innerHTML; the design link is https only and opens in a new tab', () => {
  const doc = fakeDocument();
  const view = buildSequence({ cards: [card(1, { rank: 1, assignee: 'sam', objective: 'Goal', rankReason: 'Why', blockedBy: [] }), card(2, { blockedBy: [1] })], viewer: 'sam', latest: run(1, [[1, 1], [2, null]]) });
  const node = row(doc, view.rows[0], { objectives: view.objectives });
  assert.equal(node.attributes.class, 'seq-row is-mine has-line no-reach', 'a Then without an outcome still draws the line');
  const bare = buildSequence({ cards: [card(3, { rank: 1, objective: 'Goal' })], latest: run(1, [[3, 1]]) });
  assert.equal(row(doc, bare.rows[0], { objectives: bare.objectives }).attributes.class, 'seq-row no-reach', 'no Then and no outcome: no line');
  const links = all(node, 'a');
  assert.deepEqual(links.map((link) => link.attributes.href), ['/kanban.html?card=1', '/kanban.html?card=2']);
  assert.equal(text(all(node, 'strong')[0]), 'You');
  const withDesign = footer(doc, { ...view, designUrl: 'https://design.example/sequence' });
  const design = all(withDesign[1], 'a').find((link) => text(link) === 'Design');
  assert.deepEqual([design.attributes.target, design.attributes.rel], ['_blank', 'noopener noreferrer']);
  assert.equal(all(footer(doc, { ...view, designUrl: 'javascript:alert(1)' })[1], 'a').some((link) => text(link) === 'Design'), false);
  assert.equal(all(footer(doc, { ...view, designUrl: '' })[1], 'a').some((link) => text(link) === 'Design'), false);
  assert.deepEqual(all(withDesign[1], 'a').map((link) => text(link)), ['#2', 'Design'], 'the unranked run item is listed for its owner');
});

test('brackets join visible rows only, and overlapping spans take separate lanes', () => {
  const centres = new Map([[1, 40], [2, 120], [3, 200], [4, 280]]);
  const geometry = linkGeometry([{ from: 1, to: 4 }, { from: 2, to: 3 }, { from: 1, to: 9 }], centres);
  assert.deepEqual(geometry.map((link) => [link.from, link.to, link.y1, link.y2, link.lane]), [[2, 3, 120, 200, 0], [1, 4, 40, 280, 1]]);
});

async function startApi(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-sequence-'));
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

test('a run sets every card in one transaction, is stored, and the page and events follow it', async (t) => {
  const { base, send, owner, token } = await startApi(t);
  const writer = await token('sequencer', 'write');
  const reader = await token('viewer', 'read');
  const column = await (await send('/api/kanban/columns', 'POST', { name: 'To do' }, owner)).json();
  const ids = [];
  for (const title of ['Draft the plan', 'Review the plan', 'Ship it']) ids.push((await (await send('/api/kanban/cards', 'POST', { columnId: column.id, title, assignee: 'owner' }, owner)).json()).id);
  await send(`/api/kanban/cards/${ids[1]}`, 'PUT', { blockedBy: [ids[0]] }, owner);

  assert.deepEqual((await (await send('/api/sequence', 'GET', undefined, owner)).json()).rows, []);
  const stream = await openStream(`${base}/api/events`, reader);
  t.after(() => stream.close());
  const body = { skillVersion: 'seq-1', scores: { refuted: 1, coverage: 34 }, items: [
    { id: ids[1], rank: 2, rankReason: 'Waits for the draft', waitUntil: '2099-01-01T00:00:00Z' },
    { id: ids[0], rank: 1, rankReason: 'Starts the chain', reasonFull: 'Everything else follows the draft.', outcome: 'A reviewed plan' },
    { id: ids[2], rank: null },
  ] };
  const recorded = await send('/api/sequence/runs', 'POST', body, writer);
  assert.equal(recorded.status, 201);
  const result = await recorded.json();
  assert.deepEqual([result.changed, result.run.skillVersion, result.run.items], [2, 'seq-1', [{ cardId: ids[1], rank: 2, reason: 'Waits for the draft' }, { cardId: ids[0], rank: 1, reason: 'Starts the chain' }, { cardId: ids[2], rank: null, reason: '' }]]);
  const event = await stream.next();
  assert.ok(event?.kinds.includes('sequence'), JSON.stringify(event));

  const view = await (await send('/api/sequence', 'GET', undefined, owner)).json();
  assert.deepEqual(view.rows.map((item) => [item.id, item.mine, item.owner, item.waiting]), [[ids[0], true, 'owner', false], [ids[1], true, 'owner', true]]);
  assert.deepEqual([view.rows[0].then, view.rows[0].reaches, view.links, view.fyi], [[[{ id: ids[1], title: 'Review the plan' }]], 'A reviewed plan', [{ from: ids[0], to: ids[1] }], [{ id: ids[2], title: 'Ship it' }]]);
  assert.deepEqual([view.run.skillVersion, view.run.scores, view.designUrl], ['seq-1', { refuted: 1, coverage: 34 }, '']);
  const card = await (await send(`/api/kanban/cards/${ids[1]}`, 'GET', undefined, owner)).json();
  assert.deepEqual([card.rank, card.rankReason, card.waitUntil], [2, 'Waits for the draft', '2099-01-01T00:00:00.000Z']);
  assert.deepEqual((await (await send('/api/sequence?mine=true', 'GET', undefined, reader)).json()).rows, [], 'a token named "viewer" owns nothing');

  // Repeating the run changes no card; a second run makes moves visible.
  assert.equal((await (await send('/api/sequence/runs', 'POST', body, writer)).json()).changed, 0);
  await send('/api/sequence/runs', 'POST', { skillVersion: 'seq-2', items: [{ id: ids[1], rank: 1 }, { id: ids[0], rank: 2 }] }, writer);
  assert.deepEqual((await (await send('/api/sequence', 'GET', undefined, owner)).json()).rows.map((item) => [item.id, item.moved]), [[ids[1], { places: 1, direction: 'up' }], [ids[0], { places: 1, direction: 'down' }]]);

  // Every refusal leaves the cards and the runs as they were.
  const before = await (await send('/api/sequence', 'GET', undefined, owner)).json();
  for (const bad of [
    { items: [{ id: ids[0], rank: 1 }] },
    { skillVersion: 'x', items: [] },
    { skillVersion: 'x', items: [{ id: ids[0], rank: 5 }, { id: 999999, rank: 1 }] },
    { skillVersion: 'x', items: [{ id: ids[0], rank: 5 }, { id: ids[0], rank: 6 }] },
    { skillVersion: 'x', items: [{ id: ids[0] }] },
    { skillVersion: 'x', items: [{ id: ids[0], rank: 5, rankReason: 'two\nlines' }] },
    { skillVersion: 'x', items: [{ id: ids[0], rank: 5, rankReason: 'x'.repeat(81) }] },
    { skillVersion: 'x', items: [{ id: ids[0], rank: 5, reasonFull: 'x'.repeat(301) }] },
    { skillVersion: 'x', items: [{ id: ids[0], rank: 5, waitUntil: 'tomorrow' }] },
    { skillVersion: 'x', items: [{ id: ids[0], rank: 5, color: 'red' }] },
    { skillVersion: 'x', scores: { mood: 3 }, items: [{ id: ids[0], rank: 5 }] },
    { skillVersion: 'x', scores: { refuted: -1 }, items: [{ id: ids[0], rank: 5 }] },
  ]) {
    const response = await send('/api/sequence/runs', 'POST', bad, writer);
    assert.ok([400, 404].includes(response.status), `${JSON.stringify(bad)} -> ${response.status}`);
  }
  assert.equal((await send('/api/sequence/runs', 'POST', { skillVersion: 'x', items: [{ id: ids[0], rank: 5 }] }, reader)).status, 403);
  assert.deepEqual(await (await send('/api/sequence', 'GET', undefined, owner)).json(), before);
  assert.equal((await send('/api/sequence', 'POST', {}, owner)).status, 405);
  assert.equal((await send('/api/sequence')).status, 401);

  // A card that closes drops out.
  const done = await (await send('/api/kanban/columns', 'POST', { name: 'Done' }, owner)).json();
  await send(`/api/kanban/cards/${ids[1]}`, 'PUT', { columnId: done.id }, owner);
  assert.deepEqual((await (await send('/api/sequence', 'GET', undefined, owner)).json()).rows.map((item) => item.id), [ids[0]]);
});

test('the design link is an admin setting, https only, and empty removes it', async (t) => {
  const { send, owner, token } = await startApi(t);
  const reader = await token('viewer', 'read');
  const writer = await token('sequencer', 'write');
  const put = (designUrl, headers = owner) => send('/api/sequence/settings', 'PUT', { designUrl }, headers);
  assert.deepEqual(await (await send('/api/sequence/settings', 'GET', undefined, reader)).json(), { designUrl: '' });
  for (const bad of ['http://design.example/a', 'javascript:alert(1)', 'not a url', `https://design.example/${'x'.repeat(2050)}`]) assert.equal((await put(bad)).status, 400, bad);
  assert.equal((await put('https://design.example/a', reader)).status, 403);
  assert.deepEqual(await (await put(' https://design.example/a ', writer)).json(), { designUrl: 'https://design.example/a' });
  assert.equal((await (await send('/api/sequence', 'GET', undefined, reader)).json()).designUrl, 'https://design.example/a');
  assert.deepEqual(await (await put('')).json(), { designUrl: '' });
  assert.equal((await send('/api/sequence/settings', 'PUT', {}, owner)).status, 400);
});

test('the page is served with no inline script or style, and the menu links to it', async (t) => {
  const { send } = await startApi(t);
  const page = await send('/sequence.html');
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.headers.get('content-security-policy'), /unsafe-inline/);
  const html = await page.text();
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/);
  assert.doesNotMatch(html, /style=/);
  assert.match(await readFile('public/index.html', 'utf8'), /href="\/sequence.html"/);
  for (const file of ['public/sequence.js', 'public/sequence-view.js', 'public/sequence.css']) assert.doesNotMatch(await readFile(file, 'utf8'), /\.innerHTML|https:\/\/[a-z]/i, file);
});

test('backups carry runs, settings and the card fields; an older database gains them on open', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'northstar-sequence-db-'));
  const file = join(dir, 'board.db');
  try {
    let db = openDatabase(file);
    let kanban = createKanbanService(db);
    let sequence = createSequenceService(db, kanban);
    const column = kanban.createColumn({ name: 'To do' });
    const one = kanban.createCard({ columnId: column.id, title: 'One', rankReason: 'Short', outcome: 'Done well' });
    assert.throws(() => kanban.updateCard(one.id, { waitUntil: 'soon' }), /waitUntil/);
    sequence.recordRun({ skillVersion: 'v1', items: [{ id: one.id, rank: 1, waitUntil: '2030-01-01T10:00:00+02:00' }] });
    sequence.saveSettings({ designUrl: 'https://design.example/s' });
    const backup = createBackupService(db);
    const exported = backup.export();
    backup.restore(exported);
    assert.deepEqual([kanban.getCard(one.id).rankReason, kanban.getCard(one.id).outcome, kanban.getCard(one.id).waitUntil], ['Short', 'Done well', '2030-01-01T08:00:00.000Z']);
    assert.equal(sequence.latestRuns().length, 1);
    assert.equal(sequence.settings().designUrl, 'https://design.example/s');
    const older = structuredClone(exported);
    delete older.sequenceRuns; delete older.pageSettings;
    older.kanbanCards.forEach((rowData) => { delete rowData.rank_reason; delete rowData.reason_full; delete rowData.wait_until; delete rowData.outcome; });
    backup.restore(older);
    assert.equal(sequence.latestRuns().length, 1, 'an older backup leaves runs as they are');
    assert.equal(kanban.getCard(one.id).rankReason, '');
    db.close();

    const raw = new DatabaseSync(file);
    raw.exec('DROP TABLE sequence_runs; DROP TABLE page_settings; ALTER TABLE kanban_cards DROP COLUMN rank_reason; ALTER TABLE kanban_cards DROP COLUMN reason_full; ALTER TABLE kanban_cards DROP COLUMN wait_until; ALTER TABLE kanban_cards DROP COLUMN outcome;');
    raw.close();
    db = openDatabase(file);
    kanban = createKanbanService(db);
    sequence = createSequenceService(db, kanban);
    assert.deepEqual([kanban.getCard(one.id).title, kanban.getCard(one.id).rankReason, kanban.getCard(one.id).waitUntil, sequence.latestRuns(), sequence.settings().designUrl], ['One', '', null, [], '']);
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('PostgreSQL stores sequence runs, settings and the card fields', {
  skip: !process.env.TEST_DATABASE_URL,
}, () => {
  const config = { client: 'postgres', connectionString: process.env.TEST_DATABASE_URL };
  let db = openDatabase(undefined, config);
  try {
    const kanban = createKanbanService(db);
    const sequence = createSequenceService(db, kanban);
    const column = kanban.createColumn({ name: `PG sequence ${Date.now()}` });
    const one = kanban.createCard({ columnId: column.id, title: 'PG one' });
    const two = kanban.createCard({ columnId: column.id, title: 'PG two', blockedBy: [one.id] });
    const { run: recorded } = sequence.recordRun({ skillVersion: 'pg', scores: { coverage: 1 }, items: [{ id: one.id, rank: 1, rankReason: 'First', waitUntil: '2099-01-01T00:00:00Z', outcome: 'Out' }, { id: two.id, rank: 2 }] });
    assert.throws(() => sequence.recordRun({ skillVersion: 'pg', items: [{ id: one.id, rank: 9 }, { id: 2_000_000_000, rank: 1 }] }), /Card not found/);
    assert.equal(kanban.getCard(one.id).rank, 1, 'a refused run changes nothing');
    sequence.saveSettings({ designUrl: 'https://design.example/pg' });
    db.close();
    db = openDatabase(undefined, config);
    const reopened = createKanbanService(db);
    const again = createSequenceService(db, reopened);
    assert.equal(again.latestRuns()[0].id, recorded.id);
    assert.deepEqual(again.latestRuns()[0].scores, { coverage: 1 });
    assert.deepEqual([reopened.getCard(one.id).rankReason, reopened.getCard(one.id).waitUntil, reopened.getCard(one.id).outcome], ['First', '2099-01-01T00:00:00.000Z', 'Out']);
    assert.equal(again.settings().designUrl, 'https://design.example/pg');
    again.saveSettings({ designUrl: '' });
    reopened.deleteCard(two.id); reopened.deleteCard(one.id); reopened.deleteColumn(column.id);
  } finally { db.close(); }
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
const all = (node, tag) => [...(node?.tag === tag ? [node] : []), ...(node?.children || []).flatMap((child) => all(child, tag))];
const text = (node) => node.tag === '#text' ? node.text : node.text || node.children.map(text).join('');

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
          const data = buffer.slice(0, end).split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n');
          buffer = buffer.slice(end + 2);
          if (data) { queue.push(JSON.parse(data)); wake?.(); }
        }
      }
    } catch { /* aborted */ }
  })();
  return {
    async next(ms = 3000) {
      if (!queue.length) await new Promise((resolve) => { wake = resolve; setTimeout(resolve, ms); });
      wake = null;
      return queue.shift() ?? null;
    },
    close: () => controller.abort(),
  };
}
