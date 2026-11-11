// The constraint register (Theory of Constraints): find the #1 constraint, exploit it, subordinate
// everything else to it, elevate it, then repeat with the next. Open constraints hold the ranks
// 1..n with no gaps, so there is always exactly one #1; a resolved constraint holds no rank. Every
// change is logged in toc_constraint_changes, which gives the stage history and the activity feed.
import { transaction } from './database.mjs';
import { metricKey as checkMetricKey } from './progress-service.mjs';
import { CONSTRAINT_RATINGS, CONSTRAINT_STAGES } from './public/shared/constraints.js';

export class ConstraintError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const MAX_CONSTRAINT_RANK = 1000;
const FIELDS = ['id', 'name', 'rank', 'stage', 'measure', 'metricKey', 'evidence', 'owner'];
const TEXT_FIELDS = { measure: 500, evidence: 2000, owner: 80 };
const TREND_DAYS = 30;
const DAY_MS = 86_400_000;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const lower = (value) => String(value ?? '').trim().toLocaleLowerCase();
// A card is open unless it is archived or sits in a column named Done (as on the Sequence page).
const isOpen = (card) => !card.archived && lower(card.columnName) !== 'done';

function text(value, label, max, { required = false, oneLine = false } = {}) {
  if (value !== undefined && value !== null && typeof value !== 'string') throw new ConstraintError(400, `${label} must be text.`);
  const result = String(value ?? '').trim();
  if (required && !result) throw new ConstraintError(400, `${label} must not be empty.`);
  if (result.length > max) throw new ConstraintError(400, `${label} must be at most ${max} characters.`);
  if (oneLine && /[\r\n]/.test(result)) throw new ConstraintError(400, `${label} must be one line.`);
  return result;
}

export function constraintStage(value) {
  if (!CONSTRAINT_STAGES.includes(value)) throw new ConstraintError(400, `stage must be one of ${CONSTRAINT_STAGES.join(', ')}.`);
  return value;
}

function constraintRank(value) {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 1 || value > MAX_CONSTRAINT_RANK) throw new ConstraintError(400, `rank must be a whole number from 1 to ${MAX_CONSTRAINT_RANK} (1 is the constraint), or null for last.`);
  return value;
}

function positiveId(value, label = 'id') {
  if (!Number.isSafeInteger(value) || value < 1) throw new ConstraintError(400, `${label} must be a positive whole number.`);
  return value;
}

const parseDetail = (textValue) => { try { return JSON.parse(textValue || '{}'); } catch { return {}; } };
const isoTimestamp = (value) => (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(value)) ? `${String(value).replace(' ', 'T')}.000Z` : value);

export function createConstraintService(db) {
  const columns = 'id, name, rank, stage, measure, metric_key AS metricKey, evidence, owner, created_at AS createdAt, updated_at AS updatedAt';
  const shape = (row) => (row ? { ...row, rank: row.rank ?? null, createdAt: isoTimestamp(row.createdAt), updatedAt: isoTimestamp(row.updatedAt) } : null);
  const byId = (id) => shape(db.prepare(`SELECT ${columns} FROM toc_constraints WHERE id = ?`).get(id));
  const byName = (name) => shape(db.prepare(`SELECT ${columns} FROM toc_constraints WHERE name = ? COLLATE NOCASE`).get(name));
  const history = (id) => db.prepare("SELECT kind, detail, actor, changed_at AS at FROM toc_constraint_changes WHERE constraint_id = ? AND kind IN ('created', 'stage') ORDER BY changed_at, id").all(id)
    .map((row) => {
      const detail = parseDetail(row.detail);
      return { from: row.kind === 'created' ? null : detail.from, to: row.kind === 'created' ? detail.stage : detail.to, note: detail.note ?? '', actor: row.actor, at: isoTimestamp(row.at) };
    });
  const withHistory = (item) => ({ ...item, history: history(item.id) });
  const log = (id, kind, detail, actor) => db.prepare('INSERT INTO toc_constraint_changes (constraint_id, kind, detail, actor) VALUES (?, ?, ?, ?)')
    .run(id, kind, JSON.stringify(detail), String(actor || '').slice(0, 80));

  // Rewrites the open ranks as 1..n with `id` at `wanted` (1-based; null or past the end = last), or
  // with `id` out of the order when wanted is false. Ranks are cleared first so the unique index never
  // sees two constraints on one rank mid-way.
  function place(id, wanted) {
    const others = db.prepare('SELECT id FROM toc_constraints WHERE rank IS NOT NULL AND id != ? ORDER BY rank, id').all(id).map((row) => row.id);
    if (wanted !== false) others.splice(wanted === null ? others.length : Math.min(wanted - 1, others.length), 0, id);
    db.prepare('UPDATE toc_constraints SET rank = NULL WHERE rank IS NOT NULL OR id = ?').run(id);
    const write = db.prepare('UPDATE toc_constraints SET rank = ? WHERE id = ?');
    others.forEach((otherId, index) => write.run(index + 1, otherId));
  }

  function checkMetric(key) {
    if (!key) return '';
    try { checkMetricKey(key, 'metricKey'); } catch (error) { throw new ConstraintError(400, error.message); }
    if (!db.prepare('SELECT 1 FROM metric_defs WHERE key = ?').get(key)) throw new ConstraintError(400, `metricKey "${key}" is not a defined Progress metric (define_metric first).`);
    return key;
  }

  // Moves a constraint to `stage` inside the caller's transaction: resolving takes it out of the order,
  // reopening puts it back last (or at `rank`). Returns true when the stage changed.
  function applyStage(current, stage, { note = '', rank, actor }) {
    if (current.stage === stage) return false;
    db.prepare('UPDATE toc_constraints SET stage = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(stage, current.id);
    if (stage === 'resolved') place(current.id, false);
    else if (current.stage === 'resolved') place(current.id, rank ?? null);
    log(current.id, 'stage', { from: current.stage, to: stage, note }, actor);
    return true;
  }

  // A rank move the caller asked for. Leaving or rejoining the order by resolving or reopening is the
  // stage event's to tell, so it logs no separate rank event.
  function logRank(before, actor, { restaged = false, stage = before.stage } = {}) {
    if (restaged && (stage === 'resolved' || before.stage === 'resolved')) return;
    const after = byId(before.id);
    if ((before.rank ?? null) !== after.rank) log(before.id, 'ranked', { from: before.rank ?? null, to: after.rank }, actor);
  }

  return {
    get(id) {
      const item = byId(positiveId(id));
      if (!item) throw new ConstraintError(404, 'Constraint not found.');
      return withHistory(item);
    },
    // Open constraints by rank, then resolved ones, most recently changed first.
    list() {
      return db.prepare(`SELECT ${columns} FROM toc_constraints ORDER BY CASE WHEN rank IS NULL THEN 1 ELSE 0 END, rank, updated_at DESC, id DESC`).all().map(shape).map(withHistory);
    },
    // input: { id?, name, rank?, stage?, measure?, metricKey?, evidence?, owner? }. Matches on id, else on
    // name (any case); creates when neither matches. Fields left out keep their values. rank places an
    // open constraint (others move down to make room); a resolved one holds no rank.
    upsert(input, { actor = '' } = {}) {
      if (!isObject(input)) throw new ConstraintError(400, 'Send a constraint object.');
      const unknown = Object.keys(input).find((key) => !FIELDS.includes(key));
      if (unknown) throw new ConstraintError(400, `${unknown} is not a constraint field. Fields: ${FIELDS.join(', ')}.`);
      const name = input.name === undefined ? undefined : text(input.name, 'name', 120, { required: true, oneLine: true });
      const rank = input.rank === undefined ? undefined : constraintRank(input.rank);
      const stage = input.stage === undefined ? undefined : constraintStage(input.stage);
      const fields = Object.fromEntries(Object.entries(TEXT_FIELDS).filter(([key]) => input[key] !== undefined).map(([key, max]) => [key, text(input[key], key, max)]));
      const metricKey = input.metricKey === undefined ? undefined : checkMetric(text(input.metricKey, 'metricKey', 64));
      return transaction(db, () => {
        let current = null;
        if (input.id !== undefined) {
          current = byId(positiveId(input.id));
          if (!current) throw new ConstraintError(404, `No constraint with id ${input.id}.`);
          const clash = name && byName(name);
          if (clash && clash.id !== current.id) throw new ConstraintError(409, `Another constraint is already named "${clash.name}".`);
        } else {
          if (name === undefined) throw new ConstraintError(400, 'name is required (or give the id of an existing constraint).');
          current = byName(name);
        }
        if (rank !== undefined && rank !== null && (stage ?? current?.stage) === 'resolved') throw new ConstraintError(400, 'A resolved constraint holds no rank; reopen it with a stage to rank it.');
        if (!current) {
          const startStage = stage ?? 'identify';
          const result = db.prepare('INSERT INTO toc_constraints (name, stage, measure, metric_key, evidence, owner) VALUES (?, ?, ?, ?, ?, ?)')
            .run(name, startStage, fields.measure ?? '', metricKey ?? '', fields.evidence ?? '', fields.owner ?? '');
          const id = Number(result.lastInsertRowid);
          if (startStage !== 'resolved') place(id, rank ?? null);
          log(id, 'created', { stage: startStage, rank: byId(id).rank }, actor);
          return { created: true, constraint: withHistory(byId(id)) };
        }
        // Matched by name, the name is the key, not a rename: a different case keeps the stored one.
        const next = { name: input.id === undefined ? current.name : name ?? current.name, measure: fields.measure ?? current.measure, metricKey: metricKey ?? current.metricKey, evidence: fields.evidence ?? current.evidence, owner: fields.owner ?? current.owner };
        const changed = Object.keys(next).filter((key) => next[key] !== current[key]);
        if (changed.length) {
          db.prepare('UPDATE toc_constraints SET name = ?, measure = ?, metric_key = ?, evidence = ?, owner = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run(next.name, next.measure, next.metricKey, next.evidence, next.owner, current.id);
          log(current.id, 'updated', { fields: changed }, actor);
        }
        const restaged = stage !== undefined && applyStage(current, stage, { rank, actor });
        const open = (stage ?? current.stage) !== 'resolved';
        if (rank !== undefined && open && !(restaged && current.stage === 'resolved') && rank !== current.rank) place(current.id, rank);
        logRank(current, actor, { restaged, stage: stage ?? current.stage });
        return { created: false, constraint: withHistory(byId(current.id)) };
      }, { lockKey: 'toc_constraints' });
    },
    // Moves a constraint to a stage, with an optional note on why. Repeating a call changes nothing.
    setStage(id, input, { actor = '' } = {}) {
      if (!isObject(input)) throw new ConstraintError(400, 'Send { stage, note? }.');
      const stage = constraintStage(input.stage);
      const note = text(input.note, 'note', 500);
      return transaction(db, () => {
        const current = byId(positiveId(id));
        if (!current) throw new ConstraintError(404, 'Constraint not found.');
        const changed = applyStage(current, stage, { note, actor });
        logRank(current, actor, { restaged: changed, stage });
        return { changed, constraint: withHistory(byId(current.id)) };
      }, { lockKey: 'toc_constraints' });
    },
    // The measure's trend: the metric's definition and its readings over the 30 days that end on its
    // latest reading, oldest first; null when the constraint names no metric or the metric is gone.
    trend(key) {
      if (!key) return null;
      const def = db.prepare('SELECT key, label, unit, direction FROM metric_defs WHERE key = ?').get(key);
      if (!def) return null;
      const latest = db.prepare('SELECT MAX(date) AS date FROM metrics WHERE key = ?').get(key)?.date;
      if (!latest) return { ...def, readings: [] };
      const from = new Date(Date.parse(`${latest}T00:00:00Z`) - (TREND_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
      const readings = db.prepare('SELECT date, value, rebuilt FROM metrics WHERE key = ? AND date >= ? ORDER BY date').all(key, from)
        .map((row) => ({ date: row.date, value: row.value ?? null, rebuilt: Boolean(row.rebuilt) }));
      return { ...def, readings };
    },
    // The register page's view: each constraint with its trend and the cards linked to it. cards are
    // the cards the viewer may see (with columnName); open ones count, done ones are listed apart.
    register({ cards }) {
      return buildRegister({ constraints: this.list(), cards, trend: (key) => this.trend(key) });
    },
  };
}

const ratingIndex = (rating) => { const index = CONSTRAINT_RATINGS.indexOf(rating); return index < 0 ? CONSTRAINT_RATINGS.length : index; };

export function buildRegister({ constraints, cards, trend = () => null }) {
  const status = new Map(constraints.map((item) => [item.id, item.stage]));
  const open = cards.filter(isOpen);
  const linked = (id) => cards.filter((card) => card.constraintId === id)
    .map((card) => ({ id: card.id, title: card.title, assignee: card.assignee || '', teamName: card.teamName ?? null, columnName: card.columnName ?? '', rating: card.constraintRating ?? null, open: isOpen(card) }))
    .sort((a, b) => Number(b.open) - Number(a.open) || ratingIndex(a.rating) - ratingIndex(b.rating) || a.id - b.id);
  return {
    constraints: constraints.map((item) => {
      const items = linked(item.id);
      const counts = Object.fromEntries([...CONSTRAINT_RATINGS, 'unrated'].map((rating) => [rating, items.filter((card) => card.open && (card.rating ?? 'unrated') === rating).length]));
      return { ...item, trend: trend(item.metricKey), cards: items, counts };
    }),
    // Once any constraint exists, every open card should say how it bears on one.
    unrated: constraints.length ? open.filter((card) => !card.constraintRating).length : 0,
    // Open cards still tied to a resolved constraint need re-rating against the new #1.
    needsRerating: open.filter((card) => status.get(card.constraintId) === 'resolved').length,
  };
}
