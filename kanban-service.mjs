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
    const row = db.prepare('SELECT id, name, position, team_id AS teamId FROM kanban_columns WHERE id = ?').get(id);
    if (!row) throw new KanbanError(404, 'Column not found.');
    return row;
  };
  const card = (id) => {
    const row = db.prepare('SELECT id, column_id AS columnId, project_id AS projectId, team_id AS teamId, title, description, position, created_at AS createdAt, updated_at AS updatedAt FROM kanban_cards WHERE id = ?').get(id);
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
    list({ includeHidden = false, teamId } = {}) {
      const columns = db.prepare(`SELECT id, name, position, team_id AS teamId FROM kanban_columns ${teamId ? 'WHERE team_id = ?' : ''} ORDER BY position, id`).all(...(teamId ? [teamId] : []));
      const cards = db.prepare(`
        SELECT c.id, c.column_id AS columnId, c.project_id AS projectId, c.team_id AS teamId, c.title, c.description,
          c.position, c.created_at AS createdAt, c.updated_at AS updatedAt,
          p.name AS projectName, p.project_id AS projectCode,
          (SELECT COUNT(*) FROM kanban_card_notes n WHERE n.card_id = c.id) AS noteCount
        FROM kanban_cards c LEFT JOIN projects p ON p.id = c.project_id
        WHERE (${includeHidden ? '1 = 1' : 'p.id IS NULL OR p.hidden_from_read_only = 0'}) ${teamId ? 'AND c.team_id = ?' : ''}
        ORDER BY c.column_id, c.position, c.id
      `).all(...(teamId ? [teamId] : []));
      const tags = db.prepare('SELECT card_id AS cardId, name FROM kanban_card_tags ORDER BY name').all();
      const cardTags = new Map();
      tags.forEach((tag) => cardTags.set(tag.cardId, [...(cardTags.get(tag.cardId) || []), tag.name]));
      cards.forEach((item) => { item.tags = cardTags.get(item.id) || []; });
      return { columns, cards };
    },
    createColumn(input) {
      const name = requiredText(input?.name, 'Column name', 80);
      const teamId = input?.teamId || defaultTeamId();
      if (!db.prepare('SELECT 1 FROM teams WHERE id = ?').get(teamId)) throw new KanbanError(400, 'Team not found.');
      const result = db.prepare('INSERT INTO kanban_columns (name, position, team_id) VALUES (?, ?, ?)').run(name, nextPosition('kanban_columns', 'WHERE team_id = ?', teamId), teamId);
      return column(result.lastInsertRowid);
    },
    updateColumn(id, input) {
      checkTeam(column(id).teamId, input?.teamId);
      const name = requiredText(input?.name, 'Column name', 80);
      db.prepare('UPDATE kanban_columns SET name = ? WHERE id = ?').run(name, id);
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
      const linkedProjectId = projectId(input?.projectId);
      checkProjectTeam(linkedProjectId, teamId);
      const tags = normalizeTags(input?.tags ?? []);
      return transaction(db, () => {
        const result = db.prepare('INSERT INTO kanban_cards (column_id, project_id, team_id, title, description, position) VALUES (?, ?, ?, ?, ?, ?)')
          .run(columnId, linkedProjectId, teamId, title, description, nextPosition('kanban_cards', 'WHERE column_id = ?', columnId));
        db.prepare('INSERT INTO kanban_card_history (card_id, column_id, column_name, entered_at) VALUES (?, ?, ?, ?)')
          .run(result.lastInsertRowid, columnId, column(columnId).name, new Date().toISOString());
        saveTags(result.lastInsertRowid, tags);
        return card(result.lastInsertRowid);
      });
    },
    updateCard(id, input) {
      const current = card(id);
      checkTeam(current.teamId, input?.teamId);
      const columnId = input?.columnId === undefined ? current.columnId : positiveId(input.columnId, 'Column');
      checkTeam(column(columnId).teamId, current.teamId);
      const title = input?.title === undefined ? current.title : requiredText(input.title, 'Card title', 200);
      const description = input?.description === undefined ? current.description : optionalText(input.description, 'Description', 2000);
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
        db.prepare('UPDATE kanban_cards SET column_id = ?, project_id = ?, title = ?, description = ?, position = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(columnId, linkedProjectId, title, description, position, id);
        if (tags) saveTags(id, tags);
        return card(id);
      });
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
