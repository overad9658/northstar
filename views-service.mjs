import { paramsToState, stateToParams } from './public/shared/project-table.js';

// Saved views of the projects table: a name plus the table's query string (search, sort, columns
// and filters), kept per user so they follow the person across devices, the API and MCP.
export class ViewError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const VIEW_LIMIT = 100;

function viewName(value) {
  const name = String(value ?? '').trim();
  if (!name || name.length > 80) throw new ViewError(400, 'View name must be 1–80 characters.');
  return name;
}

// Accepts the query string ("sort=score:desc&f.team=Design") or the table state object and stores
// the canonical query string, so unknown columns and empty filters never reach storage.
function viewParams(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object' && !Array.isArray(value)) return stateToParams(value).toString();
  if (typeof value !== 'string' || value.length > 4000) throw new ViewError(400, 'View params must be a query string of up to 4000 characters, or a table state object.');
  return stateToParams(paramsToState(value.replace(/^\?/, ''))).toString();
}

function present(row) {
  return { id: row.id, name: row.name, params: row.params, state: paramsToState(row.params), createdAt: row.createdAt, updatedAt: row.updatedAt };
}

export function createViewsService(db) {
  const columns = 'id, name, params, created_at AS createdAt, updated_at AS updatedAt';
  const get = (userId, id) => {
    const row = db.prepare(`SELECT ${columns} FROM saved_views WHERE id = ? AND user_id = ?`).get(id, userId);
    if (!row) throw new ViewError(404, 'View not found.');
    return row;
  };
  const nameTaken = (userId, name, exceptId = 0) => db.prepare('SELECT 1 FROM saved_views WHERE user_id = ? AND lower(name) = lower(?) AND id != ?').get(userId, name, exceptId);
  return {
    list(userId) {
      return db.prepare(`SELECT ${columns} FROM saved_views WHERE user_id = ? ORDER BY lower(name), id`).all(userId).map(present);
    },
    get(userId, id) {
      return present(get(userId, id));
    },
    create(userId, input) {
      const name = viewName(input?.name);
      if (nameTaken(userId, name)) throw new ViewError(409, 'A view with that name already exists.');
      if (db.prepare('SELECT COUNT(*) AS count FROM saved_views WHERE user_id = ?').get(userId).count >= VIEW_LIMIT) throw new ViewError(400, `A user can keep up to ${VIEW_LIMIT} views.`);
      const result = db.prepare('INSERT INTO saved_views (user_id, name, params) VALUES (?, ?, ?)').run(userId, name, viewParams(input?.params));
      return present(get(userId, Number(result.lastInsertRowid)));
    },
    update(userId, id, input) {
      const current = get(userId, id);
      const name = input?.name === undefined ? current.name : viewName(input.name);
      if (nameTaken(userId, name, id)) throw new ViewError(409, 'A view with that name already exists.');
      const params = input?.params === undefined ? current.params : viewParams(input.params);
      db.prepare('UPDATE saved_views SET name = ?, params = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?').run(name, params, id, userId);
      return present(get(userId, id));
    },
    delete(userId, id) {
      get(userId, id);
      db.prepare('DELETE FROM saved_views WHERE id = ? AND user_id = ?').run(id, userId);
    },
  };
}
