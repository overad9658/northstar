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

export function createKanbanService(db) {
  const column = (id) => {
    const row = db.prepare('SELECT id, name, position FROM kanban_columns WHERE id = ?').get(id);
    if (!row) throw new KanbanError(404, 'Column not found.');
    return row;
  };
  const card = (id) => {
    const row = db.prepare('SELECT id, column_id AS columnId, project_id AS projectId, title, description, position, created_at AS createdAt, updated_at AS updatedAt FROM kanban_cards WHERE id = ?').get(id);
    if (!row) throw new KanbanError(404, 'Card not found.');
    return row;
  };
  const projectId = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const id = positiveId(value, 'Project');
    if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id)) throw new KanbanError(400, 'Project not found.');
    return id;
  };
  const nextPosition = (table, where = '', value) => db.prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS next FROM ${table} ${where}`).get(...(value === undefined ? [] : [value])).next;

  return {
    list({ includeHidden = false } = {}) {
      const columns = db.prepare('SELECT id, name, position FROM kanban_columns ORDER BY position, id').all();
      const cards = db.prepare(`
        SELECT c.id, c.column_id AS columnId, c.project_id AS projectId, c.title, c.description,
          c.position, c.created_at AS createdAt, c.updated_at AS updatedAt,
          p.name AS projectName, p.project_id AS projectCode
        FROM kanban_cards c LEFT JOIN projects p ON p.id = c.project_id
        ${includeHidden ? '' : 'WHERE p.id IS NULL OR p.hidden_from_read_only = 0'}
        ORDER BY c.column_id, c.position, c.id
      `).all();
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
      const result = db.prepare('INSERT INTO kanban_cards (column_id, project_id, title, description, position) VALUES (?, ?, ?, ?, ?)')
        .run(columnId, linkedProjectId, title, description, nextPosition('kanban_cards', 'WHERE column_id = ?', columnId));
      return card(result.lastInsertRowid);
    },
    updateCard(id, input) {
      const current = card(id);
      const columnId = input?.columnId === undefined ? current.columnId : positiveId(input.columnId, 'Column');
      column(columnId);
      const title = input?.title === undefined ? current.title : requiredText(input.title, 'Card title', 200);
      const description = input?.description === undefined ? current.description : optionalText(input.description, 'Description', 2000);
      const linkedProjectId = input?.projectId === undefined ? current.projectId : projectId(input.projectId);
      const position = columnId === current.columnId ? current.position : nextPosition('kanban_cards', 'WHERE column_id = ?', columnId);
      db.prepare('UPDATE kanban_cards SET column_id = ?, project_id = ?, title = ?, description = ?, position = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(columnId, linkedProjectId, title, description, position, id);
      return card(id);
    },
    deleteCard(id) {
      card(id);
      db.prepare('DELETE FROM kanban_cards WHERE id = ?').run(id);
    },
  };
}
