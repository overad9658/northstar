import { transaction } from './database.mjs';

// Daily progress: metric definitions, one value per metric per day, one Markdown report per day,
// and milestones. Every write is idempotent: repeating a call changes nothing and logs nothing.
export class ProgressError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const DIRECTIONS = Object.freeze(['up_good', 'down_good', 'neutral']);
// Bands read left to right as cause and effect: momentum drives health, health earns trust.
export const BANDS = Object.freeze(['momentum', 'health', 'trust']);
export const LIMITS = Object.freeze({
  metricsPerCall: 1000, note: 500, label: 80, unit: 20, description: 500, question: 120, startsWhen: 120, report: 200_000, bullets: 50, bullet: 300, milestone: 120, rows: 10_000,
});
const KEY = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_VALUE = 1e15;

export function progressDate(value, label = 'date') {
  const text = String(value ?? '');
  const parsed = DATE.test(text) ? new Date(`${text}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new ProgressError(400, `${label} must be a calendar date as YYYY-MM-DD.`);
  }
  return text;
}

export function metricKey(value, label = 'key') {
  const text = String(value ?? '');
  if (text.length > 64 || !KEY.test(text)) throw new ProgressError(400, `${label} must be a slug of lowercase letters, digits, "_" or "-" (1–64 characters), like prs_merged.`);
  return text;
}

function text(value, label, max, { required = false } = {}) {
  if (value !== undefined && value !== null && typeof value !== 'string') throw new ProgressError(400, `${label} must be text.`);
  const result = String(value ?? '').trim();
  if (required && !result) throw new ProgressError(400, `${label} must not be empty.`);
  if (result.length > max) throw new ProgressError(400, `${label} must be at most ${max} characters.`);
  return result;
}

function metricValue(value, label) {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAX_VALUE) {
    throw new ProgressError(400, `${label} must be a number from -1e15 to 1e15, or null.`);
  }
  return value;
}

function flag(value, label) {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new ProgressError(400, `${label} must be true or false.`);
  return value;
}

// An optional from/to range; both inclusive.
export function dateRange({ from, to } = {}) {
  const range = {
    from: from === undefined || from === null || from === '' ? '' : progressDate(from, 'from'),
    to: to === undefined || to === null || to === '' ? '' : progressDate(to, 'to'),
  };
  if (range.from && range.to && range.from > range.to) throw new ProgressError(400, 'from must not be after to.');
  return range;
}

const rangeSql = ({ from, to }, column = 'date') => ({
  sql: `${from ? ` AND ${column} >= ?` : ''}${to ? ` AND ${column} <= ?` : ''}`,
  params: [...(from ? [from] : []), ...(to ? [to] : [])],
});

const presentMetric = (row) => ({ date: row.date, key: row.key, value: row.value === null ? null : Number(row.value), note: row.note, rebuilt: Boolean(row.rebuilt), updatedAt: row.updatedAt });
const presentDef = (row) => ({ key: row.key, label: row.label, unit: row.unit, direction: row.direction, band: row.band, question: row.question, startsWhen: row.startsWhen, position: Number(row.position), description: row.description, updatedAt: row.updatedAt });
const presentMilestone = (row) => ({ id: Number(row.id), date: row.date, label: row.label, metricKey: row.metricKey || null, createdAt: row.createdAt });
const parseBullets = (text) => { try { return JSON.parse(text || '[]'); } catch { return []; } };
const presentReport = (row) => ({ date: row.date, markdown: row.body, bullets: parseBullets(row.bullets), createdAt: row.createdAt, updatedAt: row.updatedAt });

// Report bullets: short lines that each may name the metric they explain, so the page can link them.
function reportBullets(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > LIMITS.bullets) throw new ProgressError(400, `bullets must be a list of at most ${LIMITS.bullets} items.`);
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ProgressError(400, `bullets[${index}] must be an object.`);
    const result = { text: text(item.text, `bullets[${index}].text`, LIMITS.bullet, { required: true }) };
    const key = item.metric_key ?? item.metricKey;
    if (key !== undefined && key !== null && key !== '') result.metric_key = metricKey(key, `bullets[${index}].metric_key`);
    return result;
  });
}

// The first heading or line of a report, for lists.
export function reportTitle(markdown) {
  const line = String(markdown || '').split(/\r?\n/).map((item) => item.trim()).find(Boolean) || '';
  return line.replace(/^#{1,6}\s+/, '').replace(/[*_`]/g, '').slice(0, 140);
}

export function createProgressService(db) {
  const metricColumns = 'date, key, value, note, rebuilt, updated_at AS updatedAt';
  const defColumns = 'key, label, unit, direction, band, question, starts_when AS startsWhen, position, description, updated_at AS updatedAt';
  const milestoneColumns = 'id, date, label, metric_key AS metricKey, created_at AS createdAt';
  const log = (kind, subject, detail, actor) => db.prepare('INSERT INTO progress_changes (kind, subject, detail, actor) VALUES (?, ?, ?, ?)')
    .run(kind, subject, JSON.stringify(detail), String(actor || '').slice(0, 80));
  const getDef = (key) => db.prepare(`SELECT ${defColumns} FROM metric_defs WHERE key = ?`).get(key);
  const getReport = (date) => db.prepare('SELECT date, body, bullets, created_at AS createdAt, updated_at AS updatedAt FROM reports WHERE date = ?').get(date);

  return {
    // input: { date?, metrics: [{ date?, key, value, note?, rebuilt? }] }. Each entry replaces the stored
    // row for its date and key; an entry equal to the stored row is left untouched.
    recordMetrics(input, { actor = '' } = {}) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ProgressError(400, 'Send an object with a metrics list.');
      const shared = input.date === undefined ? '' : progressDate(input.date);
      if (!Array.isArray(input.metrics) || !input.metrics.length || input.metrics.length > LIMITS.metricsPerCall) {
        throw new ProgressError(400, `metrics must be a list of 1–${LIMITS.metricsPerCall} entries.`);
      }
      const seen = new Set();
      const entries = input.metrics.map((entry, index) => {
        const at = `metrics[${index}]`;
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new ProgressError(400, `${at} must be an object.`);
        if (!Object.hasOwn(entry, 'value')) throw new ProgressError(400, `${at}.value is required (a number, or null for no reading).`);
        const date = entry.date === undefined ? shared : progressDate(entry.date, `${at}.date`);
        if (!date) throw new ProgressError(400, `${at}.date is required when the call gives no date.`);
        const key = metricKey(entry.key, `${at}.key`);
        if (seen.has(`${date} ${key}`)) throw new ProgressError(400, `${at} repeats ${key} on ${date}.`);
        seen.add(`${date} ${key}`);
        return { date, key, value: metricValue(entry.value, `${at}.value`), note: text(entry.note, `${at}.note`, LIMITS.note), rebuilt: flag(entry.rebuilt, `${at}.rebuilt`) };
      });
      return transaction(db, () => {
        const counts = { created: 0, updated: 0, unchanged: 0 };
        const changed = [];
        for (const entry of entries) {
          const current = db.prepare('SELECT value, note, rebuilt FROM metrics WHERE date = ? AND key = ?').get(entry.date, entry.key);
          const same = current && (current.value === null ? null : Number(current.value)) === entry.value && current.note === entry.note && Boolean(current.rebuilt) === entry.rebuilt;
          if (same) { counts.unchanged += 1; continue; }
          if (current) {
            db.prepare('UPDATE metrics SET value = ?, note = ?, rebuilt = ?, updated_at = CURRENT_TIMESTAMP WHERE date = ? AND key = ?').run(entry.value, entry.note, entry.rebuilt ? 1 : 0, entry.date, entry.key);
            counts.updated += 1;
          } else {
            db.prepare('INSERT INTO metrics (date, key, value, note, rebuilt) VALUES (?, ?, ?, ?, ?)').run(entry.date, entry.key, entry.value, entry.note, entry.rebuilt ? 1 : 0);
            counts.created += 1;
          }
          changed.push(entry);
        }
        if (changed.length) {
          const dates = [...new Set(changed.map((entry) => entry.date))].sort();
          const keys = [...new Set(changed.map((entry) => entry.key))].sort();
          log('metrics', dates.length === 1 ? dates[0] : `${dates[0]}..${dates.at(-1)}`, { dates, keys, created: counts.created, updated: counts.updated }, actor);
        }
        const metrics = entries.map((entry) => presentMetric(db.prepare(`SELECT ${metricColumns} FROM metrics WHERE date = ? AND key = ?`).get(entry.date, entry.key)));
        return { ...counts, metrics };
      });
    },

    // Sorted by key, then date. At most LIMITS.rows rows: the newest ones when there are more.
    listMetrics({ keys, from, to } = {}) {
      const range = dateRange({ from, to });
      const list = keys === undefined || keys === null || keys === '' ? [] : (Array.isArray(keys) ? keys : String(keys).split(',')).map((key) => metricKey(String(key).trim(), 'keys'));
      if (list.length > 100) throw new ProgressError(400, 'keys may name at most 100 metrics.');
      const where = rangeSql(range);
      const keySql = list.length ? ` AND key IN (${list.map(() => '?').join(', ')})` : '';
      const rows = db.prepare(`SELECT ${metricColumns} FROM metrics WHERE 1 = 1${where.sql}${keySql} ORDER BY date DESC, key LIMIT ?`).all(...where.params, ...list, LIMITS.rows);
      return rows.map(presentMetric).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    },

    listDefs() {
      return db.prepare(`SELECT ${defColumns} FROM metric_defs ORDER BY position, key`).all().map(presentDef);
    },

    // Creates or updates one definition. Omitted fields keep their stored values (or defaults on create).
    defineMetric(keyValue, input, { actor = '' } = {}) {
      const key = metricKey(keyValue);
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ProgressError(400, 'Send the metric definition as an object.');
      return transaction(db, () => {
        const current = getDef(key);
        if (!current && input.label === undefined) throw new ProgressError(400, 'label is required for a new metric.');
        const direction = input.direction === undefined ? (current?.direction ?? 'neutral') : String(input.direction);
        if (!DIRECTIONS.includes(direction)) throw new ProgressError(400, `direction must be one of: ${DIRECTIONS.join(', ')}.`);
        const band = input.band === undefined ? (current?.band ?? 'momentum') : String(input.band);
        if (!BANDS.includes(band)) throw new ProgressError(400, `band must be one of: ${BANDS.join(', ')}.`);
        let position = current ? Number(current.position) : db.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS next FROM metric_defs').get().next;
        if (input.position !== undefined) {
          position = input.position;
          if (!Number.isInteger(position) || position < 0 || position > 9999) throw new ProgressError(400, 'position must be a whole number from 0 to 9999.');
        }
        const next = {
          label: input.label === undefined ? current.label : text(input.label, 'label', LIMITS.label, { required: true }),
          unit: input.unit === undefined ? (current?.unit ?? '') : text(input.unit, 'unit', LIMITS.unit),
          direction, band, position: Number(position),
          question: input.question === undefined ? (current?.question ?? '') : text(input.question, 'question', LIMITS.question),
          startsWhen: input.startsWhen === undefined ? (current?.startsWhen ?? '') : text(input.startsWhen, 'startsWhen', LIMITS.startsWhen),
          description: input.description === undefined ? (current?.description ?? '') : text(input.description, 'description', LIMITS.description),
        };
        const fields = current ? Object.keys(next).filter((name) => next[name] !== (name === 'position' ? Number(current.position) : current[name])) : Object.keys(next);
        if (current && !fields.length) return { created: false, changed: [], def: presentDef(current) };
        if (current) {
          db.prepare('UPDATE metric_defs SET label = ?, unit = ?, direction = ?, band = ?, question = ?, starts_when = ?, position = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?')
            .run(next.label, next.unit, next.direction, next.band, next.question, next.startsWhen, next.position, next.description, key);
        } else {
          db.prepare('INSERT INTO metric_defs (key, label, unit, direction, band, question, starts_when, position, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(key, next.label, next.unit, next.direction, next.band, next.question, next.startsWhen, next.position, next.description);
        }
        log('metric_def', key, { created: !current, fields }, actor);
        return { created: !current, changed: current ? fields : [], def: presentDef(getDef(key)) };
      });
    },

    // Newest first, without bodies.
    listReports({ from, to } = {}) {
      const where = rangeSql(dateRange({ from, to }));
      return db.prepare(`SELECT date, body, bullets, updated_at AS updatedAt FROM reports WHERE 1 = 1${where.sql} ORDER BY date DESC LIMIT ?`).all(...where.params, LIMITS.rows)
        .map((row) => ({ date: row.date, title: reportTitle(row.body), length: row.body.length, bullets: parseBullets(row.bullets), updatedAt: row.updatedAt }));
    },

    getReport(dateValue) {
      const row = getReport(progressDate(dateValue));
      if (!row) throw new ProgressError(404, 'Report not found.');
      return presentReport(row);
    },

    upsertReport(dateValue, input, { actor = '' } = {}) {
      const date = progressDate(dateValue);
      if (typeof input?.markdown !== 'string') throw new ProgressError(400, 'markdown must be text.');
      const markdown = input.markdown.replace(/\r\n?/g, '\n');
      if (!markdown.trim()) throw new ProgressError(400, 'markdown must not be empty.');
      if (markdown.length > LIMITS.report) throw new ProgressError(400, `markdown must be at most ${LIMITS.report} characters.`);
      return transaction(db, () => {
        const current = getReport(date);
        // Bullets left out keep the stored ones; an empty list clears them.
        const bullets = JSON.stringify(input.bullets === undefined ? parseBullets(current?.bullets) : reportBullets(input.bullets));
        if (current?.body === markdown && current.bullets === bullets) return { created: false, changed: false, report: presentReport(current) };
        if (current) db.prepare('UPDATE reports SET body = ?, bullets = ?, updated_at = CURRENT_TIMESTAMP WHERE date = ?').run(markdown, bullets, date);
        else db.prepare('INSERT INTO reports (date, body, bullets) VALUES (?, ?, ?)').run(date, markdown, bullets);
        log('report', date, { created: !current, title: reportTitle(markdown) }, actor);
        return { created: !current, changed: true, report: presentReport(getReport(date)) };
      });
    },

    listMilestones({ from, to, metricKey: key } = {}) {
      const where = rangeSql(dateRange({ from, to }));
      const keySql = key ? ' AND metric_key = ?' : '';
      return db.prepare(`SELECT ${milestoneColumns} FROM milestones WHERE 1 = 1${where.sql}${keySql} ORDER BY date, id LIMIT ?`)
        .all(...where.params, ...(key ? [metricKey(key, 'metricKey')] : []), LIMITS.rows).map(presentMilestone);
    },

    // A milestone is named by its date and label; repeating it changes nothing, and a new metricKey updates it.
    addMilestone(input, { actor = '' } = {}) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ProgressError(400, 'Send the milestone as an object.');
      const date = progressDate(input.date);
      const label = text(input.label, 'label', LIMITS.milestone, { required: true });
      const key = input.metricKey === undefined || input.metricKey === null || input.metricKey === '' ? '' : metricKey(input.metricKey, 'metricKey');
      return transaction(db, () => {
        const find = () => db.prepare(`SELECT ${milestoneColumns} FROM milestones WHERE date = ? AND label = ?`).get(date, label);
        const current = find();
        if (current && current.metricKey === key) return { created: false, changed: false, milestone: presentMilestone(current) };
        if (current) db.prepare('UPDATE milestones SET metric_key = ? WHERE id = ?').run(key, current.id);
        else db.prepare('INSERT INTO milestones (date, label, metric_key) VALUES (?, ?, ?)').run(date, label, key);
        log('milestone', date, { created: !current, label, metricKey: key || null }, actor);
        return { created: !current, changed: true, milestone: presentMilestone(find()) };
      });
    },

    deleteMilestone(id, { actor = '' } = {}) {
      const current = db.prepare(`SELECT ${milestoneColumns} FROM milestones WHERE id = ?`).get(id);
      if (!current) throw new ProgressError(404, 'Milestone not found.');
      transaction(db, () => {
        db.prepare('DELETE FROM milestones WHERE id = ?').run(id);
        log('milestone', current.date, { deleted: true, label: current.label, metricKey: current.metricKey || null }, actor);
      });
    },

    // Which board column holds the items that need the reader; both ids are null until it is set.
    settings() {
      const row = db.prepare('SELECT needs_team_id AS teamId, needs_column_id AS columnId FROM progress_settings WHERE id = 1').get();
      return { needsYou: { teamId: row?.teamId ?? null, columnId: row?.columnId ?? null } };
    },

    saveSettings(input) {
      const needs = input?.needsYou;
      if (!needs || typeof needs !== 'object' || Array.isArray(needs)) throw new ProgressError(400, 'Send needsYou as { teamId, columnId }, or both null to clear it.');
      const { teamId = null, columnId = null } = needs;
      if ((teamId === null) !== (columnId === null)) throw new ProgressError(400, 'Give both teamId and columnId, or neither.');
      if (teamId !== null) {
        if (!Number.isInteger(teamId) || !Number.isInteger(columnId)) throw new ProgressError(400, 'teamId and columnId must be whole numbers.');
        if (!db.prepare('SELECT 1 FROM kanban_columns WHERE id = ? AND team_id = ?').get(columnId, teamId)) throw new ProgressError(400, "That column is not on that team's board.");
      }
      db.prepare('UPDATE progress_settings SET needs_team_id = ?, needs_column_id = ? WHERE id = 1').run(teamId, columnId);
      return this.settings();
    },

    // Everything, in a stable order with sorted keys, so two exports diff cleanly.
    export() {
      const sortKeys = (value) => (Array.isArray(value) ? value.map(sortKeys) : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map((name) => [name, sortKeys(value[name])])) : value);
      return sortKeys({
        metricDefs: db.prepare(`SELECT ${defColumns} FROM metric_defs ORDER BY key`).all().map(presentDef),
        metrics: db.prepare(`SELECT ${metricColumns} FROM metrics ORDER BY key, date`).all().map(presentMetric),
        milestones: db.prepare(`SELECT ${milestoneColumns} FROM milestones ORDER BY date, label`).all().map(presentMilestone),
        reports: db.prepare('SELECT date, body, bullets, created_at AS createdAt, updated_at AS updatedAt FROM reports ORDER BY date').all().map(presentReport),
      });
    },
  };
}
