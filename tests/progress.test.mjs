import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createActivityService } from '../activity-service.mjs';
import { createBackupService } from '../backup-service.mjs';
import { openDatabase } from '../database.mjs';
import { createKanbanService } from '../kanban-service.mjs';
import { createProgressService } from '../progress-service.mjs';
import { becauseFor, chartGeometry, headline, signedChange, summarize, toneOf, changeText, niceTicks } from '../public/progress-model.js';
import { headlineNode, needsPanel, reportItem, singleReading, tile, focusChart, milestoneStrip } from '../public/progress-view.js';
import { freePort, startServer, stopServer } from '../support/server-fixture.mjs';

async function tempDb(t) {
  const dir = await mkdtemp(join(tmpdir(), 'northstar-progress-'));
  const db = openDatabase(join(dir, 'northstar.db'));
  t.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
  return db;
}

test('metrics are recorded idempotently, validated, and listed by key and date', async (t) => {
  const db = await tempDb(t);
  const progress = createProgressService(db);
  const first = progress.recordMetrics({ date: '2026-11-02', metrics: [{ key: 'prs_merged', value: 4 }, { key: 'queue_open', value: 30, note: 'After triage', rebuilt: true }] }, { actor: 'tester' });
  assert.deepEqual([first.created, first.updated, first.unchanged], [2, 0, 0]);
  const again = progress.recordMetrics({ date: '2026-11-02', metrics: [{ key: 'prs_merged', value: 4 }, { key: 'queue_open', value: 30, note: 'After triage', rebuilt: true }] });
  assert.deepEqual([again.created, again.updated, again.unchanged], [0, 0, 2]);
  const updatedAt = again.metrics[0].updatedAt;
  progress.recordMetrics({ metrics: [{ date: '2026-11-03', key: 'prs_merged', value: 6.5 }, { date: '2026-11-03', key: 'queue_open', value: null }] });
  assert.equal(progress.recordMetrics({ date: '2026-11-02', metrics: [{ key: 'prs_merged', value: 5 }] }).updated, 1);

  assert.deepEqual(progress.listMetrics({ keys: 'prs_merged' }).map((row) => [row.date, row.value]), [['2026-11-02', 5], ['2026-11-03', 6.5]]);
  assert.deepEqual(progress.listMetrics({ from: '2026-11-03' }).map((row) => [row.key, row.value]), [['prs_merged', 6.5], ['queue_open', null]]);
  const queue = progress.listMetrics({ keys: ['queue_open'], to: '2026-11-02' });
  assert.deepEqual(queue, [{ date: '2026-11-02', key: 'queue_open', value: 30, note: 'After triage', rebuilt: true, updatedAt: queue[0].updatedAt }]);
  assert.ok(updatedAt);

  for (const [input, message] of [
    [{ date: '2026-02-30', metrics: [{ key: 'a', value: 1 }] }, /calendar date/],
    [{ date: '2026-11-03', metrics: [{ key: 'Not A Slug', value: 1 }] }, /slug/],
    [{ date: '2026-11-03', metrics: [{ key: 'a', value: '1' }] }, /number/],
    [{ date: '2026-11-03', metrics: [{ key: 'a' }] }, /value is required/],
    [{ date: '2026-11-03', metrics: [{ key: 'a', value: 1 }, { key: 'a', value: 2 }] }, /repeats/],
    [{ metrics: [{ key: 'a', value: 1 }] }, /date is required/],
    [{ date: '2026-11-03', metrics: [] }, /1–1000/],
    [{ date: '2026-11-03', metrics: [{ key: 'a', value: 1, note: 'x'.repeat(501) }] }, /at most 500/],
    [{ date: '2026-11-03', metrics: [{ key: 'a', value: 1, rebuilt: 'yes' }] }, /true or false/],
  ]) assert.throws(() => progress.recordMetrics(input), message);
  assert.throws(() => progress.listMetrics({ from: '2026-11-04', to: '2026-11-01' }), /after/);
});

test('definitions, reports, milestones and the needs-you column are idempotent and logged once', async (t) => {
  const db = await tempDb(t);
  const progress = createProgressService(db);
  const kanban = createKanbanService(db);
  const activity = createActivityService(db);

  const created = progress.defineMetric('prs_merged', { label: 'PRs merged', direction: 'up_good', band: 'momentum', question: 'How much did we merge?' }, { actor: 'tester' });
  assert.equal(created.created, true);
  assert.equal(created.def.position, 0);
  assert.deepEqual(progress.defineMetric('prs_merged', { label: 'PRs merged' }).changed, []);
  assert.deepEqual(progress.defineMetric('prs_merged', { band: 'health', startsWhen: 'the first merge' }).changed, ['band', 'startsWhen']);
  assert.equal(progress.defineMetric('queue_open', { label: 'Open queue', direction: 'down_good' }).def.position, 1);
  assert.throws(() => progress.defineMetric('new_one', {}), /label is required/);
  assert.throws(() => progress.defineMetric('prs_merged', { direction: 'sideways' }), /direction/);
  assert.throws(() => progress.defineMetric('prs_merged', { band: 'other' }), /band/);
  assert.deepEqual(progress.listDefs().map((def) => [def.key, def.band, def.question]), [['prs_merged', 'health', 'How much did we merge?'], ['queue_open', 'momentum', '']]);

  const report = progress.upsertReport('2026-11-03', { markdown: '# Busy day\r\nText', bullets: [{ text: 'Merged four', metric_key: 'prs_merged' }, { text: 'No key' }] }, { actor: 'tester' });
  assert.equal(report.created, true);
  assert.equal(report.report.markdown, '# Busy day\nText');
  assert.equal(progress.upsertReport('2026-11-03', { markdown: '# Busy day\nText' }).changed, false);
  assert.deepEqual(progress.getReport('2026-11-03').bullets, [{ text: 'Merged four', metric_key: 'prs_merged' }, { text: 'No key' }]);
  assert.equal(progress.upsertReport('2026-11-03', { markdown: '# Busy day\nText', bullets: [] }).changed, true);
  assert.deepEqual(progress.listReports().map((item) => [item.date, item.title]), [['2026-11-03', 'Busy day']]);
  assert.throws(() => progress.getReport('2026-11-04'), /not found/);
  assert.throws(() => progress.upsertReport('2026-11-03', { markdown: ' ' }), /empty/);
  assert.throws(() => progress.upsertReport('2026-11-03', { markdown: 'x', bullets: [{ text: 'a', metric_key: 'Bad Key' }] }), /slug/);

  const milestone = progress.addMilestone({ date: '2026-11-01', label: 'Pipeline live', metricKey: 'prs_merged' });
  assert.equal(milestone.created, true);
  assert.equal(progress.addMilestone({ date: '2026-11-01', label: 'Pipeline live', metricKey: 'prs_merged' }).changed, false);
  assert.equal(progress.addMilestone({ date: '2026-11-01', label: 'Pipeline live' }).milestone.metricKey, null);
  assert.equal(progress.listMilestones().length, 1);
  progress.deleteMilestone(milestone.milestone.id);
  assert.deepEqual(progress.listMilestones(), []);

  assert.deepEqual(progress.settings(), { needsYou: { teamId: null, columnId: null } });
  const teamId = db.prepare('SELECT id FROM teams LIMIT 1').get().id;
  const column = kanban.createColumn({ name: 'Waiting on you', teamId });
  assert.throws(() => progress.saveSettings({ needsYou: { teamId, columnId: 9999 } }), /not on that team/);
  assert.throws(() => progress.saveSettings({ needsYou: { teamId } }), /both/);
  assert.deepEqual(progress.saveSettings({ needsYou: { teamId, columnId: column.id } }), { needsYou: { teamId, columnId: column.id } });

  const types = activity.list({ limit: 50 }).items.map((item) => item.type).filter((type) => /^(metric|report|milestone)/.test(type));
  assert.deepEqual(types.sort(), ['metric.defined', 'metric.defined', 'metric.defined', 'milestone.added', 'milestone.deleted', 'milestone.updated', 'report.created', 'report.updated']);
  progress.recordMetrics({ date: '2026-11-03', metrics: [{ key: 'prs_merged', value: 1 }] }, { actor: 'tester' });
  const recorded = activity.list({ limit: 50 }).items.find((item) => item.type === 'metrics.recorded');
  assert.deepEqual([recorded.dates, recorded.keys, recorded.created, recorded.actor], [['2026-11-03'], ['prs_merged'], 1, 'tester']);
});

test('backups carry progress data, and an older backup without it leaves it in place', async (t) => {
  const db = await tempDb(t);
  const progress = createProgressService(db);
  const backup = createBackupService(db);
  progress.defineMetric('prs_merged', { label: 'PRs merged', direction: 'up_good', question: 'How much did we merge?' });
  progress.recordMetrics({ date: '2026-11-03', metrics: [{ key: 'prs_merged', value: 3, rebuilt: true }] });
  progress.upsertReport('2026-11-03', { markdown: 'Text', bullets: [{ text: 'Three', metric_key: 'prs_merged' }] });
  progress.addMilestone({ date: '2026-11-03', label: 'Start' });
  const exported = backup.export();
  for (const name of ['metricDefs', 'metrics', 'reports', 'milestones', 'progressChanges']) assert.ok(exported[name].length, name);
  const before = progress.export();

  db.exec('DELETE FROM metrics; DELETE FROM reports; DELETE FROM milestones; DELETE FROM metric_defs');
  backup.restore(exported);
  assert.deepEqual(progress.export(), before);

  const older = Object.fromEntries(Object.entries(exported).filter(([name]) => !['metricDefs', 'metrics', 'reports', 'milestones', 'progressChanges', 'progressSettings'].includes(name)));
  backup.restore(older);
  assert.deepEqual(progress.export(), before);
  assert.throws(() => backup.restore({ ...exported, metrics: 'nope' }), /invalid metrics/);
});

test('the page model: direction colors, signed changes, the ask-only headline and because lines', () => {
  assert.equal(toneOf('up_good', 2), 'good');
  assert.equal(toneOf('down_good', 2), 'bad');
  assert.equal(toneOf('down_good', -2), 'good');
  assert.equal(toneOf('neutral', 5), 'neutral');
  const def = (key, direction, extra = {}) => ({ key, label: key, direction, unit: '', ...extra });
  const shipped = summarize(def('prs_merged', 'up_good'), [{ date: '2026-11-02', value: 10 }, { date: '2026-11-03', value: 13, note: '' }]);
  const queue = summarize(def('queue_open', 'down_good'), [{ date: '2026-11-02', value: 3 }, { date: '2026-11-03', value: 6, note: '' }]);
  const rate = summarize(def('pass_rate', 'up_good', { unit: '%' }), [{ date: '2026-10-30', value: 90 }, { date: '2026-11-03', value: 89.5 }]);
  assert.deepEqual([signedChange(shipped), shipped.tone], ['+3', 'good']);
  assert.deepEqual([signedChange(queue), queue.tone], ['+3', 'bad']);
  assert.equal(signedChange(rate), '−0.5%');
  assert.equal(changeText(rate), 'Down 0.5% since Oct 30');
  assert.equal(changeText(shipped), 'Up 3 since yesterday');
  assert.equal(signedChange(summarize(def('a', 'up_good'), [{ date: '2026-11-03', value: 1 }])), '');
  const flat = summarize(def('a', 'down_good'), [{ date: '2026-11-02', value: 4 }, { date: '2026-11-03', value: 4 }]);
  assert.deepEqual([signedChange(flat), changeText(flat)], ['', 'No change since yesterday']);

  const because = (summary) => becauseFor(summary, { bullets: [{ text: 'A batch closed the queue gap', metric_key: 'queue_open' }] });
  assert.equal(headline({ summaries: [shipped, queue], latestDate: '2026-11-03', needs: { configured: true, count: 0 } }).text, '');
  assert.equal(headline({ summaries: [shipped, queue], latestDate: '2026-11-03', needs: { configured: false, count: 4 } }).text, '');
  assert.equal(headline({ summaries: [shipped], latestDate: '2026-11-03', needs: { configured: true, count: 1 } }).text, '1 item is waiting on you.');
  const asked = headline({ summaries: [shipped, queue], latestDate: '2026-11-03', needs: { configured: true, count: 35 }, because });
  assert.equal(asked.text, 'A batch closed the queue gap. 35 items are waiting on you.');
  assert.equal(asked.worst.key, 'queue_open');

  const noted = summarize(def('a', 'up_good'), [{ date: '2026-11-03', value: 1, note: 'From the note' }]);
  assert.equal(becauseFor(noted, { bullets: [{ text: 'From a bullet', metric_key: 'a' }] }), 'From the note');
  const plain = summarize(def('a', 'up_good'), [{ date: '2026-11-03', value: 1, note: '' }]);
  assert.equal(becauseFor(plain, { milestones: [{ date: '2026-11-03', label: 'Launch', metricKey: 'a' }] }), 'Launch');
  assert.equal(becauseFor(plain, { milestones: [{ date: '2026-11-03', label: 'Other', metricKey: 'b' }] }), '');

  const geometry = chartGeometry([
    { date: '2026-11-01', value: 1, rebuilt: true }, { date: '2026-11-02', value: 2, rebuilt: true }, { date: '2026-11-03', value: 3 }, { date: '2026-11-04', value: null }, { date: '2026-11-05', value: 5 },
  ], { width: 100, height: 50 });
  assert.match(geometry.estimated, /^M/);
  assert.equal(geometry.points.length, 4);
  assert.equal(geometry.line.split('M').length - 1, 1);
  assert.equal(geometry.estimated.split('M').length - 1, 2);
  assert.deepEqual(niceTicks(0, 640, 4), [0, 200, 400, 600, 800]);
});

// Enough DOM to render into; innerHTML throws so any use of it fails the test.
function fakeDocument() {
  const node = (tag, ns = null) => {
    const item = { tag, ns, attributes: {}, children: [], text: '' };
    Object.defineProperty(item, 'textContent', { get: () => item.text || item.children.map((child) => child.textContent ?? child.text).join(''), set: (value) => { item.text = String(value); item.children = []; } });
    Object.defineProperty(item, 'innerHTML', { set: () => { throw new Error('innerHTML must not be used'); } });
    item.setAttribute = (name, value) => { item.attributes[name] = String(value); };
    item.appendChild = (child) => { item.children.push(child); return child; };
    return item;
  };
  return { createElement: (tag) => node(tag), createElementNS: (ns, tag) => node(tag, ns), createTextNode: (text) => ({ tag: '#text', text: String(text) }) };
}
const all = (node, predicate) => [...(predicate(node) ? [node] : []), ...(node.children || []).flatMap((child) => all(child, predicate))];
const byClass = (node, name) => all(node, (item) => (item.attributes?.class || '').split(' ').includes(name));

test('the page renders tiles, the ask, the needs panel, the chart and reports as text only', () => {
  const doc = fakeDocument();
  const series = [{ date: '2026-11-01', value: 4, rebuilt: true, note: '' }, { date: '2026-11-02', value: 5, note: '' }, { date: '2026-11-03', value: 9, note: '<img src=x onerror=alert(1)>' }];
  const summary = summarize({ key: 'prs_merged', label: 'PRs merged', question: 'How much did we merge?', direction: 'up_good', unit: '' }, series);
  const node = tile(doc, summary, { because: series[2].note, series, from: '2026-11-01', to: '2026-11-03' });
  assert.equal(node.tag, 'button');
  assert.equal(byClass(node, 'tile-number')[0].textContent, '9');
  assert.equal(byClass(node, 'tile-chip')[0].textContent, '+4');
  assert.match(byClass(node, 'tile-chip')[0].attributes.class, /tone-good/);
  assert.equal(byClass(node, 'tile-because')[0].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(all(node, (item) => item.tag === 'img').length, 0);
  assert.equal(byClass(node, 'estimated').length, 1);
  assert.equal(node.attributes['aria-label'], 'How much did we merge? 9. Up 4 since yesterday.');
  assert.equal(byClass(node, 'tile-label')[0].textContent, 'PRs merged');
  assert.equal(node.attributes.title, 'How much did we merge?');
  assert.equal(all(node, (item) => item.tag === 'linearGradient').length, 1);

  const empty = tile(doc, summarize({ key: 'drill', label: 'Drill', question: 'How long does a restore take?', direction: 'down_good', unit: 'minutes', startsWhen: 'the first drill runs' }, []), { series: [] });
  assert.match(empty.attributes.class, /unmeasured/);
  assert.equal(empty.attributes.title, 'How long does a restore take? Not measured yet. Starts when the first drill runs.');
  assert.equal(byClass(empty, 'tile-number').length, 0);
  assert.equal(byClass(empty, 'spark-empty').length, 1);

  assert.equal(headlineNode(doc, { text: '' }), null);
  assert.equal(headlineNode(doc, { text: '2 items are waiting on you.' }).textContent, '2 items are waiting on you.');
  const panel = needsPanel(doc, { configured: true, count: 4, teamId: 1, columnName: 'Waiting', teamName: 'Ops', items: [{ title: 'Approve <b>it</b>', externalUrl: 'https://tracker.example/1', nextStep: 'Read it' }] });
  assert.equal(all(panel, (item) => item.tag === 'a')[0].attributes.rel, 'noopener noreferrer');
  assert.match(panel.textContent, /Approve <b>it<\/b>/);
  assert.match(panel.textContent, /See all on the board$/);
  assert.doesNotMatch(panel.textContent, /4/);
  assert.equal(byClass(panel, 'visually-hidden')[0].textContent, 'Waiting on you');
  assert.match(needsPanel(doc, { configured: false, count: 0 }, { admin: true }).textContent, /Choose a column/);

  const { node: chart } = focusChart(doc, summary, { series, milestones: [{ id: 1, date: '2026-11-02', label: 'Pipeline live', metricKey: null }], width: 600, height: 300, from: '2026-11-01', to: '2026-11-03' });
  assert.equal(chart.attributes.tabindex, '0');
  assert.equal(byClass(chart, 'flag').length, 1);
  assert.equal(all(chart, (item) => item.tag === 'title')[0].textContent, 'Nov 2: Pipeline live');
  assert.equal(milestoneStrip(doc, [{ id: 1, date: '2026-11-02', label: 'Pipeline live' }], { from: '2026-11-01', to: '2026-11-03' }).textContent, 'Nov 2Pipeline live');

  const item = reportItem(doc, { date: '2026-11-03', title: 'Busy day', bullets: [{ text: 'Merged four', metric_key: 'prs_merged' }] }, { open: true });
  assert.equal(byClass(item, 'report-toggle')[0].attributes['aria-expanded'], 'true');
  assert.equal(all(item, (node) => node.attributes?.['data-key'] === 'prs_merged').length, 1);
});

test('the progress API follows the token model and the page is served with the CSP', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-progress-api-'));
  const port = await freePort();
  const child = await startServer(dataDir, port, { AUTH_DISABLED: 'false', API_TOKEN: '' });
  t.after(async () => { await stopServer(child); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const send = (path, method = 'GET', body, headers = {}) => fetch(`${base}${path}`, {
    method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setup = await send('/api/auth/setup', 'POST', { username: 'owner', password: 'correct horse battery staple' });
  const owner = { cookie: setup.headers.get('set-cookie').split(';', 1)[0] };
  const token = async (scope) => ({ authorization: `Bearer ${(await (await send('/api/api-tokens', 'POST', { name: scope, scope }, owner)).json()).token}` });
  const reader = await token('read');
  const writer = await token('write');

  assert.equal((await send('/api/progress/metrics')).status, 401);
  assert.equal((await send('/api/progress/metrics', 'GET', undefined, reader)).status, 200);
  assert.equal((await send('/api/progress/metrics', 'PUT', { date: '2026-11-03', metrics: [{ key: 'prs_merged', value: 1 }] }, reader)).status, 403);
  const recorded = await send('/api/progress/metrics', 'PUT', { date: '2026-11-03', metrics: [{ key: 'prs_merged', value: 1 }] }, writer);
  assert.equal(recorded.status, 200);
  assert.equal((await recorded.json()).created, 1);
  assert.equal((await send('/api/progress/metric-defs/prs_merged', 'PUT', { label: 'PRs merged' }, writer)).status, 201);
  assert.equal((await send('/api/progress/metric-defs/prs_merged', 'PUT', { label: 'PRs merged' }, writer)).status, 200);
  assert.equal((await send('/api/progress/reports/2026-11-03', 'PUT', { markdown: '# Day' }, writer)).status, 201);
  assert.equal((await send('/api/progress/reports/2026-11-31', 'GET', undefined, reader)).status, 400);
  assert.equal((await send('/api/progress/reports/2026-11-04', 'GET', undefined, reader)).status, 404);
  assert.equal((await send('/api/progress/milestones', 'PUT', { date: '2026-11-03', label: 'Start' }, writer)).status, 201);
  assert.equal((await send('/api/progress/nothing', 'GET', undefined, reader)).status, 404);
  assert.equal((await send('/api/progress/metric-defs', 'DELETE', undefined, writer)).status, 405);
  assert.deepEqual(await (await send('/api/progress/needs-you', 'GET', undefined, reader)).json(), { configured: false, count: 0, items: [] });

  const column = await (await send('/api/kanban/columns', 'POST', { name: 'Waiting on you' }, owner)).json();
  for (const title of ['One', 'Two', 'Three', 'Four']) await send('/api/kanban/cards', 'POST', { title, columnId: column.id }, owner);
  assert.equal((await send('/api/progress/settings', 'PUT', { needsYou: { teamId: column.teamId, columnId: column.id } }, reader)).status, 403);
  assert.equal((await send('/api/progress/settings', 'PUT', { needsYou: { teamId: column.teamId, columnId: column.id } }, owner)).status, 200);
  const needs = await (await send('/api/progress/needs-you', 'GET', undefined, reader)).json();
  assert.deepEqual([needs.count, needs.items.map((item) => item.title), needs.columnName], [4, ['One', 'Two', 'Three'], 'Waiting on you']);

  const exported = await (await send('/api/progress/export', 'GET', undefined, reader)).json();
  assert.deepEqual(Object.keys(exported), ['metricDefs', 'metrics', 'milestones', 'reports']);
  const backup = await (await send('/api/backup', 'GET', undefined, owner)).json();
  assert.equal(backup.metrics.length, 1);

  const page = await send('/progress.html');
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.headers.get('content-security-policy'), /unsafe-inline/);
  const html = await page.text();
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/);
  assert.doesNotMatch(html, /style=/);
  assert.match(await readFile('public/index.html', 'utf8'), /href="\/progress.html"/);
});

test('a milestone without a metric key is never a cause, on a tile or in the headline', () => {
  const def = (key, direction) => ({ key, label: key, direction, unit: '' });
  const issues = summarize(def('issues_open', 'down_good'), [{ date: '2026-11-02', value: 4, note: '' }, { date: '2026-11-03', value: 5, note: '' }]);
  const shipped = summarize(def('prs_merged', 'up_good'), [{ date: '2026-11-02', value: 4, note: '' }, { date: '2026-11-03', value: 6, note: '' }]);
  const milestones = [
    { date: '2026-11-03', label: 'Moved to its own database', metricKey: null },
    { date: '2026-11-03', label: 'Merge queue turned on', metricKey: 'prs_merged' },
  ];
  const because = (summary) => becauseFor(summary, { milestones });
  assert.equal(because(issues), '');
  assert.equal(because(shipped), 'Merge queue turned on');
  const noted = summarize(def('issues_open', 'down_good'), [{ date: '2026-11-02', value: 4 }, { date: '2026-11-03', value: 5, note: 'Two new reports from the beta' }]);
  assert.equal(becauseFor(noted, { milestones }), 'Two new reports from the beta');

  const asked = headline({ summaries: [issues, shipped], latestDate: '2026-11-03', needs: { configured: true, count: 3 }, because });
  assert.equal(asked.worst.key, 'issues_open');
  assert.equal(asked.text, '3 items are waiting on you.');
});

test('fewer than two readings draw no sparkline, and the chart shows the one value and its date', () => {
  const doc = fakeDocument();
  const def = { key: 'restore_minutes', label: 'Restore time', question: 'How long does a restore take?', direction: 'down_good', unit: 'minutes' };
  const one = [{ date: '2026-11-03', value: 42, note: 'First drill', rebuilt: false }];
  const summary = summarize(def, one);
  const node = tile(doc, summary, { series: one, from: '2026-10-05', to: '2026-11-03' });
  const spark = byClass(node, 'spark')[0];
  assert.deepEqual(spark.children, []);
  assert.equal(byClass(node, 'tile-number')[0].textContent, '42');
  assert.equal(byClass(node, 'tile-chip')[0].textContent, '');
  const single = singleReading(doc, summary, one);
  assert.equal(single.textContent, '42 minuteson Tuesday, November 3, 2026First drill');

  const two = [...one, { date: '2026-11-04', value: 40, note: '' }];
  const drawn = tile(doc, summarize(def, two), { series: two, from: '2026-10-06', to: '2026-11-04' });
  assert.equal(byClass(drawn, 'spark-line').length, 1);
});

test('a hidden metric keeps recording, and removing a definition keeps its readings', async (t) => {
  const db = await tempDb(t);
  const progress = createProgressService(db);
  const activity = createActivityService(db);
  const backup = createBackupService(db);
  progress.defineMetric('issues_open', { label: 'Open issues', direction: 'down_good' }, { actor: 'tester' });
  assert.equal(progress.listDefs()[0].hidden, false);
  assert.deepEqual(progress.defineMetric('issues_open', { hidden: true }).changed, ['hidden']);
  assert.deepEqual(progress.defineMetric('issues_open', { hidden: true }).changed, []);
  assert.throws(() => progress.defineMetric('issues_open', { hidden: 'yes' }), /true or false/);
  assert.equal(progress.recordMetrics({ date: '2026-11-03', metrics: [{ key: 'issues_open', value: 5 }] }).created, 1);
  assert.equal(progress.listDefs()[0].hidden, true);

  const exported = backup.export();
  assert.equal(exported.metricDefs[0].hidden, 1);
  backup.restore(exported);
  assert.equal(progress.listDefs()[0].hidden, true);

  assert.deepEqual(progress.removeMetric('issues_open', { actor: 'tester' }), { removed: true, key: 'issues_open', readingsKept: 1 });
  assert.deepEqual(progress.listDefs(), []);
  assert.equal(progress.listMetrics({ keys: 'issues_open' }).length, 1);
  assert.throws(() => progress.removeMetric('issues_open'), /not found/);
  const removed = activity.list({ limit: 50 }).items.find((item) => item.type === 'metric.removed');
  assert.deepEqual([removed.key, removed.label, removed.actor], ['issues_open', 'Open issues', 'tester']);
  assert.equal(progress.defineMetric('issues_open', { label: 'Open issues' }).created, true);
  assert.equal(progress.listMetrics({ keys: 'issues_open' }).length, 1);
});

test('a database made before the hidden column gains it on open', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'northstar-hidden-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'northstar.db');
  let db = openDatabase(path);
  createProgressService(db).defineMetric('prs_merged', { label: 'PRs merged' });
  db.exec('ALTER TABLE metric_defs DROP COLUMN hidden');
  db.close();
  db = openDatabase(path);
  try {
    assert.deepEqual(createProgressService(db).listDefs().map((def) => [def.key, def.hidden]), [['prs_merged', false]]);
  } finally { db.close(); }
});

test('DELETE /api/progress/metric-defs/:key follows the token model', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-progress-remove-'));
  const port = await freePort();
  const child = await startServer(dataDir, port, { AUTH_DISABLED: 'false', API_TOKEN: '' });
  t.after(async () => { await stopServer(child); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const send = (path, method = 'GET', body, headers = {}) => fetch(`${base}${path}`, {
    method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setup = await send('/api/auth/setup', 'POST', { username: 'owner', password: 'correct horse battery staple' });
  const owner = { cookie: setup.headers.get('set-cookie').split(';', 1)[0] };
  const token = async (scope) => ({ authorization: `Bearer ${(await (await send('/api/api-tokens', 'POST', { name: scope, scope }, owner)).json()).token}` });
  const reader = await token('read');
  const writer = await token('write');
  assert.equal((await send('/api/progress/metric-defs/issues_open', 'PUT', { label: 'Open issues', hidden: true }, writer)).status, 201);
  assert.equal((await (await send('/api/progress/metric-defs', 'GET', undefined, reader)).json())[0].hidden, true);
  await send('/api/progress/metrics', 'PUT', { date: '2026-11-03', metrics: [{ key: 'issues_open', value: 2 }] }, writer);
  assert.equal((await send('/api/progress/metric-defs/issues_open', 'DELETE')).status, 401);
  assert.equal((await send('/api/progress/metric-defs/issues_open', 'DELETE', undefined, reader)).status, 403);
  const removed = await send('/api/progress/metric-defs/issues_open', 'DELETE', undefined, writer);
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { removed: true, key: 'issues_open', readingsKept: 1 });
  assert.equal((await send('/api/progress/metric-defs/issues_open', 'DELETE', undefined, writer)).status, 404);
  assert.equal((await (await send('/api/progress/metrics?keys=issues_open', 'GET', undefined, reader)).json()).length, 1);
});
