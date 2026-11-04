// Fills a SQLite database with 90 days of sample progress data, for trying the Progress page.
// Usage: node support/progress-sample.mjs <data directory> [last date, YYYY-MM-DD]
// Use a new, empty data directory: it adds sample metrics, reports, milestones and board cards.
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDatabase } from '../database.mjs';
import { createKanbanService } from '../kanban-service.mjs';
import { createProgressService } from '../progress-service.mjs';
import { addDays } from '../public/progress-model.js';

const dataDir = resolve(process.argv[2] || '');
if (!process.argv[2]) { console.error('Usage: node support/progress-sample.mjs <data directory> [last date]'); process.exit(1); }
const last = process.argv[3] || new Date().toISOString().slice(0, 10);
mkdirSync(dataDir, { recursive: true });
const db = openDatabase(join(dataDir, 'northstar.db'));
const progress = createProgressService(db);
const kanban = createKanbanService(db);
const actor = 'sample data';

let seed = 7;
const random = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const jitter = (size) => Math.round((random() - 0.5) * 2 * size);

const defs = [
  ['shipped_total', { label: 'Shipped', direction: 'up_good', band: 'momentum', question: 'How much have we shipped?' }],
  ['queue_open', { label: 'Queue', direction: 'down_good', band: 'momentum', question: 'How long is the queue?' }],
  ['unreleased', { label: 'Waiting to release', direction: 'down_good', band: 'momentum', question: 'How much is waiting to release?' }],
  ['alerts_open', { label: 'Open alerts', direction: 'down_good', band: 'health', question: 'How many alerts are open?' }],
  ['targets_met', { label: 'Service targets', unit: '%', direction: 'up_good', band: 'health', question: 'Are we meeting our service targets?' }],
  ['restore_drill', { label: 'Restore time', unit: 'minutes', direction: 'down_good', band: 'health', question: 'How long does a restore take?', startsWhen: 'the first restore drill runs' }],
  ['findings_open', { label: 'Security findings', direction: 'down_good', band: 'trust', question: 'How many security findings are open?' }],
  ['mistakes', { label: 'Mistakes that reached people', direction: 'down_good', band: 'trust', question: 'How many mistakes reached people this week?' }],
  ['review_wait', { label: 'Review wait', unit: 'days', direction: 'down_good', band: 'trust', question: 'How long do changes wait for review?' }],
];
defs.forEach(([key, def], position) => progress.defineMetric(key, { ...def, position }, { actor }));

// Ninety days. The first 40 were worked out later from history; the rest were read on the day.
const days = 90;
const notes = new Map([
  [`${addDays(last, -1)} alerts_open`, 'A noisy disk alert fired on every node'],
  [`${addDays(last, 0)} alerts_open`, 'The disk alert was tuned; two real alerts remain'],
  [`${addDays(last, 0)} queue_open`, 'Six items closed after the planning session'],
  [`${addDays(last, -30)} shipped_total`, 'First release from the new pipeline'],
]);
let shipped = 120; let queue = 64; let unreleased = 18; let alerts = 9; let targets = 96.2; let findings = 22; let wait = 3.4;
for (let index = days - 1; index >= 0; index -= 1) {
  const date = addDays(last, -index);
  const day = days - index;
  const rebuilt = day <= 40;
  shipped += index === 0 ? 9 : Math.max(0, 5 + jitter(4) + (day > 60 ? 2 : 0));
  queue = index === 0 ? queue - 6 : Math.max(14, queue + jitter(3) - (day > 50 ? 1 : 0));
  unreleased = index === 2 ? 1 : Math.max(0, unreleased + jitter(3) - (day % 14 === 0 ? 12 : 0));
  alerts = index === 1 ? 11 : index === 0 ? 2 : Math.max(1, Math.min(8, alerts + jitter(2)));
  targets = Math.min(99.9, Math.max(93, targets + jitter(4) / 10 + (day > 45 ? 0.05 : 0)));
  findings = index === 3 ? findings - 3 : Math.max(2, findings - (day % 6 === 0 ? 2 : 0) + (day % 17 === 0 ? 1 : 0));
  wait = Math.max(0.5, wait + jitter(3) / 10 - (day > 70 ? 0.08 : 0));
  const readings = [
    ['shipped_total', shipped], ['queue_open', queue], ['unreleased', unreleased], ['alerts_open', alerts],
    ['targets_met', Number(targets.toFixed(1))], ['findings_open', findings], ['review_wait', Number(wait.toFixed(1))],
  ];
  // Mistakes are counted weekly, on Mondays; there was no count before day 30.
  if (new Date(`${date}T00:00:00Z`).getUTCDay() === 1 && day > 30) readings.push(['mistakes', Math.max(0, 3 - Math.floor(day / 30) + jitter(1))]);
  // Two days with no alert reading while the monitor moved.
  const metrics = readings.map(([key, value]) => ({
    key, value: key === 'alerts_open' && (day === 55 || day === 56) ? null : value,
    rebuilt, note: notes.get(`${date} ${key}`) ?? '',
  }));
  progress.recordMetrics({ date, metrics }, { actor });
}

for (const [offset, label, metricKey] of [[-62, 'New release pipeline'], [-41, 'Daily readings start'], [-30, 'First release from the pipeline', 'shipped_total'], [-12, 'Alert rules reviewed', 'alerts_open'], [-3, 'Security review done', 'findings_open']]) {
  progress.addMilestone({ date: addDays(last, offset), label, metricKey }, { actor });
}

const reports = [
  [0, '# Queue shorter, alerts calmer', [['Six items closed after the planning session.', 'queue_open'], ['The disk alert was tuned; two real alerts remain.', 'alerts_open'], ['Nine items shipped, the most in a week.', 'shipped_total']],
    'The planning session closed six items that had no owner. The disk alert that fired on every node yesterday now uses a longer window.\n\n## Next\n\n- Release the eleven changes waiting in staging.\n- Review the two open alerts with the on-call team.'],
  [-1, '# A noisy alert', [['A disk alert fired on every node; it was not a real problem.', 'alerts_open'], ['Two security findings closed.', 'findings_open']],
    'Most of the day went to a disk alert that fired on every node. It was not a real problem, but it hid two alerts that were.'],
  [-2, '# Release day', [['Twelve changes released; the unreleased count is back near zero.', 'unreleased']], 'The weekly release went out in the morning. Nothing had to be rolled back.'],
  [-3, '# Security review done', [['The security review closed four findings.', 'findings_open']], 'The review closed four findings and opened one, about an old library. It is planned for next week.'],
  [-6, '# A slow day', [], 'Most of the team was at the planning session.'],
];
for (const [offset, title, bullets, body] of reports) {
  progress.upsertReport(addDays(last, offset), { markdown: `${title}\n\n${body}`, bullets: bullets.map(([text, metric_key]) => ({ text, metric_key })) }, { actor });
}

// A board column that holds what is waiting on the reader.
const teamId = db.prepare('SELECT id FROM teams ORDER BY id LIMIT 1').get().id;
const columns = kanban.list({ teamId }).columns;
const waiting = columns.find((column) => column.name === 'Waiting on you') ?? kanban.createColumn({ name: 'Waiting on you', teamId });
if (!columns.some((column) => column.name === 'In progress')) kanban.createColumn({ name: 'In progress', teamId });
const asks = [
  ['Approve the release plan for next week', 'Read the plan and approve it'],
  ['Choose a date for the restore drill', 'Pick one of three dates'],
  ['Review the alert rule changes', 'Two rules need a yes or no'],
  ['Sign off the security review', ''], ['Answer the question about the old library', ''], ['Approve the new on-call rota', ''], ['Merge the pipeline clean-up', ''],
];
if (!kanban.list({ teamId }).cards.some((card) => card.columnId === waiting.id)) {
  for (const [title, nextStep] of asks) kanban.createCard({ title, nextStep, columnId: waiting.id, teamId });
}
progress.saveSettings({ needsYou: { teamId, columnId: waiting.id } });
db.close();
console.log(`Sample progress data for ${addDays(last, -(days - 1))} to ${last} is in ${dataDir}.`);
