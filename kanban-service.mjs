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

function positiveId(value, label) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new KanbanError(400, `${label} must be a valid ID.`);
  return id;
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
    const row = db.prepare('SELECT id, name, position FROM kanban_columns WHERE id = ?').get(id);
    if (!row) throw new KanbanError(404, 'Column not found.');
    return row;
  };
  const card = (id) => {
    const row = db.prepare('SELECT id, column_id AS columnId, project_id AS projectId, title, description, position, created_at AS createdAt, updated_at AS updatedAt FROM kanban_cards WHERE id = ?').get(id);
    if (!row) throw new KanbanError(404, 'Card not found.');
    return { ...row, tags: tagsFor(id) };
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

  return {
    list({ includeHidden = false } = {}) {
      const columns = db.prepare('SELECT id, name, position FROM kanban_columns ORDER BY position, id').all();
      const cards = db.prepare(`
        SELECT c.id, c.column_id AS columnId, c.project_id AS projectId, c.title, c.description,
          c.position, c.created_at AS createdAt, c.updated_at AS updatedAt,
          p.name AS projectName, p.project_id AS projectCode,
          (SELECT COUNT(*) FROM kanban_card_notes n WHERE n.card_id = c.id) AS noteCount
        FROM kanban_cards c LEFT JOIN projects p ON p.id = c.project_id
        ${includeHidden ? '' : 'WHERE p.id IS NULL OR p.hidden_from_read_only = 0'}
        ORDER BY c.column_id, c.position, c.id
      `).all();
      const tags = db.prepare('SELECT card_id AS cardId, name FROM kanban_card_tags ORDER BY name').all();
      const cardTags = new Map();
      tags.forEach((tag) => cardTags.set(tag.cardId, [...(cardTags.get(tag.cardId) || []), tag.name]));
      cards.forEach((item) => { item.tags = cardTags.get(item.id) || []; });
      return { columns, cards };
    },
    createColumn(input) {
      const name = requiredText(input?.name, 'Column name', 80);
      const result = db.prepare('INSERT INTO kanban_columns (name, position) VALUES (?, ?)').run(name, nextPosition('kanban_columns'));
      return column(result.lastInsertRowid);
    },
    updateColumn(id, input) {
      column(id);
      const name = requiredText(input?.name, 'Column name', 80);
      db.prepare('UPDATE kanban_columns SET name = ? WHERE id = ?').run(name, id);
      return column(id);
    },
    deleteColumn(id) {
      column(id);
      db.prepare('DELETE FROM kanban_columns WHERE id = ?').run(id);
    },
    createCard(input) {
      const columnId = positiveId(input?.columnId, 'Column');
      column(columnId);
      const title = requiredText(input?.title, 'Card title', 200);
      const description = optionalText(input?.description, 'Description', 2000);
      const linkedProjectId = projectId(input?.projectId);
      const tags = normalizeTags(input?.tags ?? []);
      return transaction(db, () => {
        const result = db.prepare('INSERT INTO kanban_cards (column_id, project_id, title, description, position) VALUES (?, ?, ?, ?, ?)')
          .run(columnId, linkedProjectId, title, description, nextPosition('kanban_cards', 'WHERE column_id = ?', columnId));
        db.prepare('INSERT INTO kanban_card_history (card_id, column_id, column_name, entered_at) VALUES (?, ?, ?, ?)')
          .run(result.lastInsertRowid, columnId, column(columnId).name, new Date().toISOString());
        saveTags(result.lastInsertRowid, tags);
        return card(result.lastInsertRowid);
      });
    },
    updateCard(id, input) {
      const current = card(id);
      const columnId = input?.columnId === undefined ? current.columnId : positiveId(input.columnId, 'Column');
      column(columnId);
      const title = input?.title === undefined ? current.title : requiredText(input.title, 'Card title', 200);
      const description = input?.description === undefined ? current.description : optionalText(input.description, 'Description', 2000);
      const linkedProjectId = input?.projectId === undefined ? current.projectId : projectId(input.projectId);
      const tags = input?.tags === undefined ? null : normalizeTags(input.tags);
      const position = columnId === current.columnId ? current.position : nextPosition('kanban_cards', 'WHERE column_id = ?', columnId);
      return transaction(db, () => {
        if (columnId !== current.columnId) {
          const movedAt = new Date().toISOString();
          db.prepare('UPDATE kanban_card_history SET exited_at = ? WHERE card_id = ? AND exited_at IS NULL').run(movedAt, id);
          db.prepare('INSERT INTO kanban_card_history (card_id, column_id, column_name, entered_at) VALUES (?, ?, ?, ?)')
            .run(id, columnId, column(columnId).name, movedAt);
        }
        db.prepare('UPDATE kanban_cards SET column_id = ?, project_id = ?, title = ?, description = ?, position = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(columnId, linkedProjectId, title, description, position, id);
        if (tags) saveTags(id, tags);
        return card(id);
      });
    },
    deleteCard(id) {
      card(id);
      db.prepare('DELETE FROM kanban_cards WHERE id = ?').run(id);
    },
    listNotes(cardId, { includeHidden = false } = {}) {
      visibleCard(cardId, includeHidden);
      return db.prepare('SELECT id, card_id AS cardId, body, created_at AS createdAt FROM kanban_card_notes WHERE card_id = ? ORDER BY created_at, id').all(cardId);
    },
    createNote(cardId, input) {
      card(cardId);
      const body = requiredText(input?.body, 'Note', 2000);
      const result = db.prepare('INSERT INTO kanban_card_notes (card_id, body) VALUES (?, ?)').run(cardId, body);
      return db.prepare('SELECT id, card_id AS cardId, body, created_at AS createdAt FROM kanban_card_notes WHERE id = ?').get(result.lastInsertRowid);
    },
    deleteNote(cardId, noteId) {
      card(cardId);
      if (!db.prepare('DELETE FROM kanban_card_notes WHERE id = ? AND card_id = ?').run(noteId, cardId).changes) {
        throw new KanbanError(404, 'Note not found.');
      }
    },
    history(cardId, { includeHidden = false } = {}) {
      visibleCard(cardId, includeHidden);
      const asOf = new Date().toISOString();
      const entries = db.prepare(`
        SELECT id, card_id AS cardId, column_id AS columnId, column_name AS columnName,
          entered_at AS enteredAt, exited_at AS exitedAt
        FROM kanban_card_history WHERE card_id = ? ORDER BY entered_at, id
      `).all(cardId).map((row) => withDuration(row, asOf));
      return { asOf, entries };
    },
    report({ includeHidden = false } = {}) {
      const asOf = new Date().toISOString();
      const rows = db.prepare(`
        SELECT h.id, h.card_id AS cardId, c.title AS cardTitle,
          c.project_id AS projectId, p.project_id AS projectCode, p.name AS projectName,
          h.column_id AS columnId, h.column_name AS columnName,
          h.entered_at AS enteredAt, h.exited_at AS exitedAt
        FROM kanban_card_history h JOIN kanban_cards c ON c.id = h.card_id
        LEFT JOIN projects p ON p.id = c.project_id
        ${includeHidden ? '' : 'WHERE p.id IS NULL OR p.hidden_from_read_only = 0'}
        ORDER BY c.id, h.entered_at, h.id
      `).all().map((row) => withDuration(row, asOf));
      return { asOf, rows };
    },
  };
}
