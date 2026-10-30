import { transaction } from './database.mjs';

export class KanbanError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function requiredText(value, label, max) {
  const text = String(value ?? '').trim();
  if (!text || text.length > max) throw new KanbanError(400, `${label} must be 1–${max} characters.`);
  return text;
}

function optionalText(value, label, max) {
  const text = String(value ?? '').trim();
  if (text.length > max) throw new KanbanError(400, `${label} must be at most ${max} characters.`);
  return text;
}

function optionalUrl(value) {
  const text = optionalText(value, 'Link', 2048);
  if (!text) return '';
  try {
    if (['http:', 'https:'].includes(new URL(text).protocol)) return text;
  } catch {}
  throw new KanbanError(400, 'Link must be a valid HTTP or HTTPS URL.');
}

function requiredUrl(value) {
  const url = optionalUrl(value);
  if (!url) throw new KanbanError(400, 'externalUrl must not be empty.');
  return url;
}

// A decision is stored as JSON text; '' means the card has none.
function normalizeDecision(value, current = null) {
  if (value === null || value === '') return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new KanbanError(400, 'Decision must be an object or null.');
  if (!Array.isArray(value.options) || value.options.length < 1 || value.options.length > 10) throw new KanbanError(400, 'Decision options must be a list of 1–10 choices.');
  const options = value.options.map((item) => {
    if (typeof item !== 'string') throw new KanbanError(400, 'Decision options must be text.');
    return requiredText(item, 'Each decision option', 200);
  });
  if (new Set(options).size !== options.length) throw new KanbanError(400, 'Decision options must be distinct.');
  const choice = (field, label) => {
    const text = optionalText(value[field], label, 200);
    if (text && !options.includes(text)) throw new KanbanError(400, `${label} must be one of the options.`);
    return text;
  };
  const recommendation = choice('recommendation', 'Recommendation');
  let confidence = null;
  if (value.confidence !== undefined && value.confidence !== null && value.confidence !== '') {
    confidence = Number(value.confidence);
    if (!Number.isInteger(confidence) || confidence < 0 || confidence > 100) throw new KanbanError(400, 'Confidence must be a whole number from 0 to 100.');
  }
  const decidedOption = choice('decidedOption', 'Decided option');
  let decidedAt = null;
  if (decidedOption) {
    if (value.decidedAt) {
      const parsed = new Date(String(value.decidedAt));
      if (Number.isNaN(parsed.getTime())) throw new KanbanError(400, 'decidedAt must be an ISO date and time.');
      decidedAt = parsed.toISOString();
    } else decidedAt = current?.decidedOption === decidedOption ? current.decidedAt : new Date().toISOString();
  }
  return { options, recommendation, confidence, decidedOption, decidedAt };
}

function parseDecision(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

const UPDATED_FIELDS = ['title', 'description', 'nextStep', 'externalUrl'];

// Records content, decision, assignee and archive changes for the activity feed.
export function recordCardChanges(db, current, next, actor = '') {
  const insert = db.prepare('INSERT INTO card_changes (card_id, kind, detail, actor) VALUES (?, ?, ?, ?)');
  const record = (kind, detail = {}) => insert.run(current.id, kind, JSON.stringify(detail), String(actor || '').slice(0, 80));
  const fields = UPDATED_FIELDS.filter((field) => (current[field] ?? '') !== (next[field] ?? ''));
  if (fields.length) record('updated', { fields });
  const option = next.decision?.decidedOption || '';
  if (option && option !== (current.decision?.decidedOption || '')) record('decided', { option });
  if ((current.assignee ?? '') !== (next.assignee ?? '')) record('assigned', { from: current.assignee ?? '', to: next.assignee ?? '' });
  if (next.archived !== undefined && Boolean(current.archived) !== Boolean(next.archived)) record(next.archived ? 'archived' : 'restored');
}

function requiredKey(value) {
  const key = optionalKey(value);
  if (!key) throw new KanbanError(400, 'key must not be empty.');
  return key;
}

function positiveId(value, label) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new KanbanError(400, `${label} must be a valid ID.`);
  return id;
}

// An optional client-chosen card key; empty means none, stored as NULL so the unique index ignores it.
function optionalKey(value) {
  return optionalText(value, 'Card key', 120) || null;
}

function uniqueKey(write) {
  try {
    return write();
  } catch (error) {
    if (/UNIQUE/.test(error.message) && /card_key|kanban_cards_key/.test(error.message)) throw new KanbanError(409, 'A card with that key already exists.');
    throw error;
  }
}

// Board and lookup show active cards unless asked for archived ones too ("include") or only them ("only").
function archivedCondition(value) {
  if (value === undefined || value === null || value === '' || value === 'exclude') return 'c.archived = 0';
  if (value === 'include') return '';
  if (value === 'only') return 'c.archived = 1';
  throw new KanbanError(400, 'archived must be include or only.');
}

function archivedFlag(value) {
  if (typeof value !== 'boolean') throw new KanbanError(400, 'archived must be true or false.');
  return value;
}

function normalizeTags(value) {
  if (!Array.isArray(value)) throw new KanbanError(400, 'Tags must be a list.');
  if (value.length > 20) throw new KanbanError(400, 'A card can have at most 20 tags.');
  const tags = value.map((item) => {
    if (typeof item !== 'string') throw new KanbanError(400, 'Tags must be text.');
    const name = item.trim().replace(/\s+/g, ' ').toLowerCase();
    if (!name || name.length > 40 || name.includes(',')) throw new KanbanError(400, 'Each tag must be 1–40 characters and cannot contain a comma.');
    return name;
  });
  return [...new Set(tags)];
}

function timestampMs(value) {
  const text = String(value).replace(' ', 'T');
  return Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(text) ? text : `${text}Z`);
}

function withDuration(row, asOf) {
  const durationMs = Math.max(0, timestampMs(row.exitedAt || asOf) - timestampMs(row.enteredAt));
  return { ...row, durationSeconds: Math.round(durationMs) / 1000, isCurrent: row.exitedAt === null };
}

export function createKanbanService(db) {
  const tagsFor = (cardId) => db.prepare('SELECT name FROM kanban_card_tags WHERE card_id = ? ORDER BY name').all(cardId).map((row) => row.name);
  const saveTags = (cardId, tags) => {
    db.prepare('DELETE FROM kanban_card_tags WHERE card_id = ?').run(cardId);
    const insert = db.prepare('INSERT INTO kanban_card_tags (card_id, name) VALUES (?, ?)');
    tags.forEach((tag) => insert.run(cardId, tag));
  };
  const column = (id) => {
    const row = db.prepare('SELECT id, name, position, team_id AS teamId FROM kanban_columns WHERE id = ?').get(id);
    if (!row) throw new KanbanError(404, 'Column not found.');
    return row;
  };
  const card = (id) => {
    const row = db.prepare('SELECT id, column_id AS columnId, project_id AS projectId, team_id AS teamId, title, description, assignee, external_url AS externalUrl, card_key AS key, source, archived, archived_at AS archivedAt, next_step AS nextStep, decision, position, created_at AS createdAt, updated_at AS updatedAt FROM kanban_cards WHERE id = ?').get(id);
    if (!row) throw new KanbanError(404, 'Card not found.');
    return { ...row, archived: Boolean(row.archived), decision: parseDecision(row.decision), tags: tagsFor(id) };
  };
  const projectId = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const id = positiveId(value, 'Project');
    if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id)) throw new KanbanError(400, 'Project not found.');
    return id;
  };
  const visibleCard = (id, includeHidden) => {
    const row = db.prepare(`
      SELECT c.id FROM kanban_cards c LEFT JOIN projects p ON p.id = c.project_id
      WHERE c.id = ? ${includeHidden ? '' : 'AND (p.id IS NULL OR p.hidden_from_read_only = 0)'}
    `).get(id);
    if (!row) throw new KanbanError(404, 'Card not found.');
  };
  const nextPosition = (table, where = '', value) => db.prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS next FROM ${table} ${where}`).get(...(value === undefined ? [] : [value])).next;
  const defaultTeamId = () => db.prepare('SELECT id FROM teams ORDER BY id LIMIT 1').get()?.id;
  const checkTeam = (actual, expected) => { if (expected && actual !== expected) throw new KanbanError(404, 'Item not found on this team board.'); };
  const checkProjectTeam = (linkedProjectId, teamId) => {
    if (!linkedProjectId) return;
    const project = db.prepare('SELECT team FROM projects WHERE id = ?').get(linkedProjectId);
    const team = db.prepare('SELECT name FROM teams WHERE id = ?').get(teamId);
    if (!team || project.team.toLocaleLowerCase() !== team.name.toLocaleLowerCase()) throw new KanbanError(400, 'A card can only link to a project on its team.');
  };

  return {
    getCard(id, { includeHidden = false, teamId } = {}) {
      visibleCard(id, includeHidden);
      const item = card(id); checkTeam(item.teamId, teamId); return item;
    },
    list({ includeHidden = false, archived, teamId } = {}) {
      const columns = db.prepare(`SELECT id, name, position, team_id AS teamId FROM kanban_columns ${teamId ? 'WHERE team_id = ?' : ''} ORDER BY position, id`).all(...(teamId ? [teamId] : []));
      const conditions = [archivedCondition(archived), includeHidden ? '' : '(p.id IS NULL OR p.hidden_from_read_only = 0)', teamId ? 'c.team_id = ?' : ''].filter(Boolean);
      const cards = db.prepare(`
        SELECT c.id, c.column_id AS columnId, c.project_id AS projectId, c.team_id AS teamId, c.title, c.description, c.assignee, c.external_url AS externalUrl,
          c.card_key AS key, c.source, c.archived, c.archived_at AS archivedAt, c.next_step AS nextStep, c.decision,
          c.position, c.created_at AS createdAt, c.updated_at AS updatedAt,
          p.name AS projectName, p.project_id AS projectCode,
          (SELECT COUNT(*) FROM kanban_card_notes n WHERE n.card_id = c.id) AS noteCount
        FROM kanban_cards c LEFT JOIN projects p ON p.id = c.project_id
        ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
        ORDER BY c.column_id, c.position, c.id
      `).all(...(teamId ? [teamId] : []));
      const tags = db.prepare('SELECT card_id AS cardId, name FROM kanban_card_tags ORDER BY name').all();
      const cardTags = new Map();
      tags.forEach((tag) => cardTags.set(tag.cardId, [...(cardTags.get(tag.cardId) || []), tag.name]));
      cards.forEach((item) => { item.tags = cardTags.get(item.id) || []; item.archived = Boolean(item.archived); item.decision = parseDecision(item.decision); });
      return { columns, cards };
    },
    createColumn(input) {
      const name = requiredText(input?.name, 'Column name', 80);
      const teamId = input?.teamId || defaultTeamId();
      if (!db.prepare('SELECT 1 FROM teams WHERE id = ?').get(teamId)) throw new KanbanError(400, 'Team not found.');
      const result = db.prepare('INSERT INTO kanban_columns (name, position, team_id) VALUES (?, ?, ?)').run(name, nextPosition('kanban_columns', 'WHERE team_id = ?', teamId), teamId);
      return column(result.lastInsertRowid);
    },
    // Renames a column and/or moves it to `position` on its own team's board; positions stay 0..n-1.
    updateColumn(id, input) {
      const current = column(id);
      checkTeam(current.teamId, input?.teamId);
      if (input?.name === undefined && input?.position === undefined) throw new KanbanError(400, 'Send a name or a position.');
      const name = input?.name === undefined ? current.name : requiredText(input.name, 'Column name', 80);
      const position = input?.position === undefined ? null : Number(input.position);
      if (position !== null && (!Number.isInteger(position) || position < 0)) throw new KanbanError(400, 'Column position must be a whole number of 0 or more.');
      transaction(db, () => {
        db.prepare('UPDATE kanban_columns SET name = ? WHERE id = ?').run(name, id);
        if (position === null) return;
        const others = db.prepare('SELECT id FROM kanban_columns WHERE team_id = ? AND id != ? ORDER BY position, id').all(current.teamId, id).map((row) => row.id);
        others.splice(Math.min(position, others.length), 0, id);
        const move = db.prepare('UPDATE kanban_columns SET position = ? WHERE id = ?');
        others.forEach((columnId, index) => move.run(index, columnId));
      });
      return column(id);
    },
    deleteColumn(id, teamId) {
      checkTeam(column(id).teamId, teamId);
      db.prepare('DELETE FROM kanban_columns WHERE id = ?').run(id);
    },
    createCard(input) {
      const columnId = positiveId(input?.columnId, 'Column');
      const teamId = input?.teamId || column(columnId).teamId || defaultTeamId();
      checkTeam(column(columnId).teamId, teamId);
      const title = requiredText(input?.title, 'Card title', 200);
      const description = optionalText(input?.description, 'Description', 2000);
      const assignee = optionalText(input?.assignee, 'Assignee', 80);
      const externalUrl = optionalUrl(input?.externalUrl);
      const key = optionalKey(input?.key);
      const source = optionalText(input?.source, 'Source', 80);
      const archived = input?.archived === undefined ? false : archivedFlag(input.archived);
      const nextStep = optionalText(input?.nextStep, 'Next step', 1000);
      const decision = input?.decision === undefined ? null : normalizeDecision(input.decision);
      const linkedProjectId = projectId(input?.projectId);
      checkProjectTeam(linkedProjectId, teamId);
      const tags = normalizeTags(input?.tags ?? []);
      return transaction(db, () => {
        const result = uniqueKey(() => db.prepare('INSERT INTO kanban_cards (column_id, project_id, team_id, title, description, assignee, external_url, card_key, source, archived, archived_at, next_step, decision, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(columnId, linkedProjectId, teamId, title, description, assignee, externalUrl, key, source, archived ? 1 : 0, archived ? new Date().toISOString() : null, nextStep, decision ? JSON.stringify(decision) : '', nextPosition('kanban_cards', 'WHERE column_id = ?', columnId)));
        db.prepare('INSERT INTO kanban_card_history (card_id, column_id, column_name, entered_at) VALUES (?, ?, ?, ?)')
          .run(result.lastInsertRowid, columnId, column(columnId).name, new Date().toISOString());
        saveTags(result.lastInsertRowid, tags);
        return card(result.lastInsertRowid);
      });
    },
    updateCard(id, input, { actor } = {}) {
      const current = card(id);
      checkTeam(current.teamId, input?.teamId);
      const columnId = input?.columnId === undefined ? current.columnId : positiveId(input.columnId, 'Column');
      checkTeam(column(columnId).teamId, current.teamId);
      const title = input?.title === undefined ? current.title : requiredText(input.title, 'Card title', 200);
      const description = input?.description === undefined ? current.description : optionalText(input.description, 'Description', 2000);
      const assignee = input?.assignee === undefined ? current.assignee : optionalText(input.assignee, 'Assignee', 80);
      const externalUrl = input?.externalUrl === undefined ? current.externalUrl : optionalUrl(input.externalUrl);
      const key = input?.key === undefined ? current.key : optionalKey(input.key);
      const source = input?.source === undefined ? current.source : optionalText(input.source, 'Source', 80);
      const archived = input?.archived === undefined ? current.archived : archivedFlag(input.archived);
      const archivedAt = archived === current.archived ? current.archivedAt : (archived ? new Date().toISOString() : null);
      const nextStep = input?.nextStep === undefined ? current.nextStep : optionalText(input.nextStep, 'Next step', 1000);
      const decision = input?.decision === undefined ? current.decision : normalizeDecision(input.decision, current.decision);
      const linkedProjectId = input?.projectId === undefined ? current.projectId : projectId(input.projectId);
      checkProjectTeam(linkedProjectId, current.teamId);
      const tags = input?.tags === undefined ? null : normalizeTags(input.tags);
      const position = columnId === current.columnId ? current.position : nextPosition('kanban_cards', 'WHERE column_id = ?', columnId);
      return transaction(db, () => {
        if (columnId !== current.columnId) {
          const movedAt = new Date().toISOString();
          db.prepare('UPDATE kanban_card_history SET exited_at = ? WHERE card_id = ? AND exited_at IS NULL').run(movedAt, id);
          db.prepare('INSERT INTO kanban_card_history (card_id, column_id, column_name, entered_at) VALUES (?, ?, ?, ?)')
            .run(id, columnId, column(columnId).name, movedAt);
        }
        uniqueKey(() => db.prepare('UPDATE kanban_cards SET column_id = ?, project_id = ?, title = ?, description = ?, assignee = ?, external_url = ?, card_key = ?, source = ?, archived = ?, archived_at = ?, next_step = ?, decision = ?, position = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(columnId, linkedProjectId, title, description, assignee, externalUrl, key, source, archived ? 1 : 0, archivedAt, nextStep, decision ? JSON.stringify(decision) : '', position, id));
        if (tags) saveTags(id, tags);
        const updated = card(id);
        recordCardChanges(db, current, updated, actor);
        return updated;
      });
    },
    findCards({ key, externalUrl, projectId: linkedProjectId, decision, tag, source, archived, includeHidden = false } = {}) {
      const conditions = [archivedCondition(archived), includeHidden ? '' : '(p.id IS NULL OR p.hidden_from_read_only = 0)'].filter(Boolean);
      const params = [];
      if (tag !== undefined) { conditions.push('EXISTS (SELECT 1 FROM kanban_card_tags t WHERE t.card_id = c.id AND t.name = ?)'); params.push(normalizeTags([tag])[0]); }
      if (source !== undefined) { conditions.push('c.source = ?'); params.push(optionalText(source, 'Source', 80)); }
      if (key !== undefined) { conditions.push('c.card_key = ?'); params.push(requiredKey(key)); }
      if (externalUrl !== undefined) { conditions.push('c.external_url = ?'); params.push(requiredUrl(externalUrl)); }
      if (linkedProjectId !== undefined) { conditions.push('c.project_id = ?'); params.push(positiveId(linkedProjectId, 'Project')); }
      if (decision !== undefined) {
        if (decision !== 'open') throw new KanbanError(400, 'decision filter must be "open".');
        conditions.push("c.decision != ''");
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      return db.prepare(`SELECT c.id FROM kanban_cards c LEFT JOIN projects p ON p.id = c.project_id ${where} ORDER BY c.column_id, c.position, c.id`)
        .all(...params).map((row) => card(row.id))
        .filter((item) => decision === undefined || !item.decision?.decidedOption);
    },
    // Creates the card, or updates the one card matching `key` (the card key or externalUrl); repeating a request changes nothing.
    upsertCard(input, { key: matchOn = 'externalUrl', ...options } = {}) {
      if (!['key', 'externalUrl'].includes(matchOn)) throw new KanbanError(400, 'key must be key or externalUrl.');
      const value = matchOn === 'key' ? requiredKey(input?.key) : requiredUrl(input?.externalUrl);
      const column = matchOn === 'key' ? 'card_key' : 'external_url';
      // Lookup and write share one transaction so concurrent upserts of a new key create one card.
      return transaction(db, () => {
        const matches = db.prepare(`SELECT id FROM kanban_cards WHERE ${column} = ?`).all(value);
        if (matches.length > 1) throw new KanbanError(409, `More than one card has this ${matchOn}.`);
        if (matches.length) return { created: false, card: this.updateCard(matches[0].id, input, options) };
        return { created: true, card: this.createCard(input, options) };
      }, { lockKey: `kanban_cards:${matchOn}:${value}` });
    },
    deleteCard(id, teamId) {
      checkTeam(card(id).teamId, teamId);
      db.prepare('DELETE FROM kanban_cards WHERE id = ?').run(id);
    },
    listNotes(cardId, { includeHidden = false, teamId } = {}) {
      visibleCard(cardId, includeHidden);
      checkTeam(card(cardId).teamId, teamId);
      return db.prepare('SELECT id, card_id AS cardId, body, created_at AS createdAt FROM kanban_card_notes WHERE card_id = ? ORDER BY created_at, id').all(cardId);
    },
    createNote(cardId, input) {
      checkTeam(card(cardId).teamId, input?.teamId);
      const body = requiredText(input?.body, 'Note', 2000);
      const result = db.prepare('INSERT INTO kanban_card_notes (card_id, body) VALUES (?, ?)').run(cardId, body);
      return db.prepare('SELECT id, card_id AS cardId, body, created_at AS createdAt FROM kanban_card_notes WHERE id = ?').get(result.lastInsertRowid);
    },
    deleteNote(cardId, noteId, teamId) {
      checkTeam(card(cardId).teamId, teamId);
      if (!db.prepare('DELETE FROM kanban_card_notes WHERE id = ? AND card_id = ?').run(noteId, cardId).changes) {
        throw new KanbanError(404, 'Note not found.');
      }
    },
    history(cardId, { includeHidden = false, teamId } = {}) {
      visibleCard(cardId, includeHidden);
      checkTeam(card(cardId).teamId, teamId);
      const asOf = new Date().toISOString();
      const entries = db.prepare(`
        SELECT id, card_id AS cardId, column_id AS columnId, column_name AS columnName,
          entered_at AS enteredAt, exited_at AS exitedAt
        FROM kanban_card_history WHERE card_id = ? ORDER BY entered_at, id
      `).all(cardId).map((row) => withDuration(row, asOf));
      return { asOf, entries };
    },
    report({ includeHidden = false, teamId } = {}) {
      const asOf = new Date().toISOString();
      const rows = db.prepare(`
        SELECT h.id, h.card_id AS cardId, c.title AS cardTitle,
          c.project_id AS projectId, p.project_id AS projectCode, p.name AS projectName,
          h.column_id AS columnId, h.column_name AS columnName,
          h.entered_at AS enteredAt, h.exited_at AS exitedAt
        FROM kanban_card_history h JOIN kanban_cards c ON c.id = h.card_id
        LEFT JOIN projects p ON p.id = c.project_id
        WHERE (${includeHidden ? '1 = 1' : 'p.id IS NULL OR p.hidden_from_read_only = 0'}) ${teamId ? 'AND c.team_id = ?' : ''}
        ORDER BY c.id, h.entered_at, h.id
      `).all(...(teamId ? [teamId] : [])).map((row) => withDuration(row, asOf));
      return { asOf, rows };
    },
  };
}
