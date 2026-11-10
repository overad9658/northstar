// The sequence: ranked, open cards in order, with why each sits there, what it unblocks and what it
// reaches. A sequencing pass (an agent, through MCP) records a run: it sets every card's rank and
// reasons in one transaction and stores the order it chose, so the next pass can show what moved.
import { transaction } from './database.mjs';
import { KanbanError, normalizeRank, positiveId, sequenceFields } from './kanban-service.mjs';

const SCORE_KEYS = ['refuted', 'coverage', 'violations', 'obsolete'];
const ITEM_KEYS = ['id', 'rank', 'rankReason', 'reasonFull', 'waitUntil', 'outcome'];
const CHAIN_DEPTH = 3;
const CHAIN_WIDTH = 4;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const lower = (value) => String(value ?? '').trim().toLocaleLowerCase();

// A card is open unless it is archived or sits in a column named Done.
export const isOpen = (card) => !card.archived && lower(card.columnName) !== 'done';

function parseJson(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}

function runRow(row) {
  if (!row) return null;
  return { id: row.id, at: row.at, skillVersion: row.skillVersion, scores: parseJson(row.scores, {}), items: parseJson(row.items, []) };
}

function normalizeScores(value) {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) throw new KanbanError(400, 'scores must be an object.');
  const scores = {};
  for (const [key, number] of Object.entries(value)) {
    if (!SCORE_KEYS.includes(key)) throw new KanbanError(400, `scores can only hold ${SCORE_KEYS.join(', ')}.`);
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0) throw new KanbanError(400, `scores.${key} must be a number of 0 or more.`);
    scores[key] = number;
  }
  return scores;
}

// Each card's place among the cards two runs share, so a card only "moves" when the pass reordered it,
// not when a card above it closed or a new one arrived.
function sharedPlaces(run, shared) {
  const ordered = run.items.filter((item) => item.rank !== null && shared.has(item.cardId)).sort((a, b) => a.rank - b.rank || a.cardId - b.cardId);
  return new Map(ordered.map((item, index) => [item.cardId, index]));
}

// How far each card moved between the previous run and the latest: { cardId: places up (+) or down (-) }.
export function movesBetween(latest, previous) {
  if (!latest || !previous) return new Map();
  const ranked = (run) => new Set(run.items.filter((item) => item.rank !== null).map((item) => item.cardId));
  const before = ranked(previous);
  const shared = new Set([...ranked(latest)].filter((id) => before.has(id)));
  const now = sharedPlaces(latest, shared);
  const then = sharedPlaces(previous, shared);
  const moves = new Map();
  for (const [id, place] of now) if (then.get(id) !== place) moves.set(id, then.get(id) - place);
  return moves;
}

// The cards this card unblocks, level by level: [[{ id, title }], ...], open cards only.
function chainFrom(card, unblocks, byId) {
  const levels = [];
  const seen = new Set([card.id]);
  let current = [card.id];
  while (levels.length < CHAIN_DEPTH && current.length) {
    const next = [];
    for (const id of current) for (const childId of unblocks.get(id) || []) if (!seen.has(childId)) { seen.add(childId); next.push(childId); }
    if (!next.length) break;
    levels.push(next.slice(0, CHAIN_WIDTH).map((id) => ({ id, title: byId.get(id).title })));
    current = next;
  }
  return levels;
}

// cards: every card the viewer can see (with columnName, blockedBy and the sequence fields).
export function buildSequence({ cards, latest = null, previous = null, viewer = '', mine = false, now = new Date() }) {
  const open = cards.filter(isOpen);
  const byId = new Map(open.map((card) => [card.id, card]));
  const unblocks = new Map();
  for (const card of [...open].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.id - b.id)) {
    for (const blockerId of card.blockedBy || []) if (byId.has(blockerId)) unblocks.set(blockerId, [...(unblocks.get(blockerId) || []), card.id]);
  }
  const moves = movesBetween(latest, previous);
  const reasons = new Map((latest?.items || []).map((item) => [item.cardId, item.reason]));
  const viewerName = lower(viewer);
  const rows = open.filter((card) => card.rank !== null && card.rank !== undefined)
    .sort((a, b) => a.rank - b.rank || a.id - b.id)
    .map((card, index) => {
      const move = moves.get(card.id) ?? 0;
      return {
        place: index + 1, id: card.id, rank: card.rank, title: card.title, teamName: card.teamName ?? null,
        owner: card.assignee || '', mine: Boolean(viewerName) && lower(card.assignee) === viewerName,
        now: card.nextStep || card.title,
        objective: card.objective || '', rankReason: card.rankReason || reasons.get(card.id) || '', reasonFull: card.reasonFull || '',
        waitUntil: card.waitUntil ?? null, waiting: Boolean(card.waitUntil) && new Date(card.waitUntil) > now,
        then: chainFrom(card, unblocks, byId),
        // Only a real outcome is a destination; the objective already shows as the reason's mark.
        reaches: card.outcome || '',
        moved: move ? { places: Math.abs(move), direction: move > 0 ? 'up' : 'down' } : null,
      };
    });
  const queue = [...rows.reduce((counts, row) => {
    if (row.owner) counts.set(row.owner, { name: row.owner, count: (counts.get(row.owner)?.count || 0) + 1, mine: row.mine });
    return counts;
  }, new Map()).values()].sort((a, b) => Number(b.mine) - Number(a.mine) || b.count - a.count || a.name.localeCompare(b.name));
  // Alphabetical, so an objective keeps its mark from one pass to the next.
  const objectives = [...new Set(rows.map((row) => row.objective).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  // A link joins a ranked card to a ranked card it unblocks (from = the blocker, to = the card it frees).
  const ranked = new Set(rows.map((row) => row.id));
  const links = rows.flatMap((row) => (byId.get(row.id).blockedBy || []).filter((id) => ranked.has(id)).map((from) => ({ from, to: row.id })));
  const fyi = (latest?.items || []).filter((item) => item.rank === null && byId.has(item.cardId)).map((item) => ({ id: item.cardId, title: byId.get(item.cardId).title }));
  return {
    run: latest ? { id: latest.id, at: latest.at, skillVersion: latest.skillVersion, scores: latest.scores } : null,
    viewer: viewer || '', queue, objectives, fyi, links,
    rows: mine ? rows.filter((row) => row.mine) : rows,
  };
}

const DESIGN_KEY = 'sequence.designUrl';

// The page's design link: an https URL, or '' for none. Kept in the database, never in the code.
export function normalizeDesignUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  let url;
  try { url = new URL(text); } catch { url = null; }
  if (!url || url.protocol !== 'https:' || text.length > 2048) throw new KanbanError(400, 'designUrl must be an https URL (at most 2048 characters), or empty to remove it.');
  return url.href;
}

export function createSequenceService(db, kanban) {
  const runs = (limit) => db.prepare('SELECT id, at, skill_version AS skillVersion, scores, items FROM sequence_runs ORDER BY at DESC, id DESC LIMIT ?').all(limit).map(runRow);
  return {
    latestRuns: () => runs(2),
    settings() {
      return { designUrl: db.prepare('SELECT value FROM page_settings WHERE key = ?').get(DESIGN_KEY)?.value ?? '' };
    },
    saveSettings(input) {
      if (!isObject(input) || input.designUrl === undefined) throw new KanbanError(400, 'Send { designUrl } (empty removes it).');
      const designUrl = normalizeDesignUrl(input.designUrl);
      db.prepare('DELETE FROM page_settings WHERE key = ?').run(DESIGN_KEY);
      if (designUrl) db.prepare('INSERT INTO page_settings (key, value) VALUES (?, ?)').run(DESIGN_KEY, designUrl);
      return this.settings();
    },
    // input: { skillVersion, scores, items: [{ id, rank, rankReason?, reasonFull?, waitUntil?, outcome? }] }.
    // rank null leaves a card out of the order (shown as for its owner). canEdit(card) refuses a card
    // the caller may not change; any refusal or bad item fails the whole run.
    recordRun(input, { canEdit = () => {} } = {}) {
      if (!isObject(input)) throw new KanbanError(400, 'Send { skillVersion, scores, items }.');
      const skillVersion = String(input.skillVersion ?? '').trim();
      if (!skillVersion || skillVersion.length > 40 || /[\r\n]/.test(skillVersion)) throw new KanbanError(400, 'skillVersion must be 1–40 characters on one line.');
      const scores = normalizeScores(input.scores);
      if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 1000) throw new KanbanError(400, 'items must be a list of 1–1000 cards.');
      const items = input.items.map((item, index) => {
        if (!isObject(item)) throw new KanbanError(400, `items[${index}] must be an object.`);
        const unknown = Object.keys(item).find((key) => !ITEM_KEYS.includes(key));
        if (unknown) throw new KanbanError(400, `items[${index}].${unknown} is not a known field.`);
        if (item.rank === undefined) throw new KanbanError(400, `items[${index}] needs a rank (null leaves the card out of the order).`);
        return { id: positiveId(item.id, `items[${index}].id`), rank: normalizeRank(item.rank), fields: sequenceFields(item), given: item };
      });
      if (new Set(items.map((item) => item.id)).size !== items.length) throw new KanbanError(400, 'Each card can appear once in a run.');
      return transaction(db, () => {
        const write = db.prepare('UPDATE kanban_cards SET rank = ?, rank_reason = ?, reason_full = ?, wait_until = ?, outcome = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
        let changed = 0;
        for (const item of items) {
          const card = kanban.getCard(item.id, { includeHidden: true });
          canEdit(card);
          const next = { rank: item.rank, ...sequenceFields(item.given, card) };
          if (['rank', 'rankReason', 'reasonFull', 'waitUntil', 'outcome'].some((key) => (card[key] ?? null) !== (next[key] ?? null))) {
            write.run(next.rank, next.rankReason, next.reasonFull, next.waitUntil, next.outcome, item.id);
            changed += 1;
          }
        }
        const stored = items.map((item) => ({ cardId: item.id, rank: item.rank, reason: item.fields.rankReason }));
        const at = new Date().toISOString();
        const result = db.prepare('INSERT INTO sequence_runs (at, skill_version, scores, items) VALUES (?, ?, ?, ?)').run(at, skillVersion, JSON.stringify(scores), JSON.stringify(stored));
        return { run: { id: Number(result.lastInsertRowid), at, skillVersion, scores, items: stored }, changed };
      }, { lockKey: 'sequence_runs' });
    },
  };
}
