import { randomUUID } from 'node:crypto';
import { AuthError } from './auth-service.mjs';

export function createTodoService(db) {
  const fields = 'id, title, completed, created_at AS createdAt, updated_at AS updatedAt';
  const view = (row) => ({ ...row, completed: Boolean(row.completed) });
  function get(userId, id) {
    const row = db.prepare(`SELECT ${fields} FROM personal_todos WHERE user_id = ? AND id = ?`).get(userId, id);
    if (!row) throw new AuthError(404, 'To-do not found.');
    return view(row);
  }
  function validate(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AuthError(400, 'Expected a to-do object.');
    if (input.title !== undefined && (typeof input.title !== 'string' || !input.title.trim() || input.title.trim().length > 200)) {
      throw new AuthError(400, 'Title must be between 1 and 200 characters.');
    }
    if (input.completed !== undefined && typeof input.completed !== 'boolean') throw new AuthError(400, 'Completed must be true or false.');
  }
  return {
    list(userId) {
      return db.prepare(`SELECT ${fields} FROM personal_todos WHERE user_id = ? ORDER BY completed, created_at DESC, id DESC`).all(userId).map(view);
    },
    create(userId, input) {
      validate(input);
      if (input.title === undefined) throw new AuthError(400, 'Title is required.');
      const id = randomUUID();
      db.prepare('INSERT INTO personal_todos (id, user_id, title, completed) VALUES (?, ?, ?, ?)').run(id, userId, input.title.trim(), input.completed ? 1 : 0);
      return get(userId, id);
    },
    update(userId, id, input) {
      const current = get(userId, id);
      validate(input);
      db.prepare('UPDATE personal_todos SET title = ?, completed = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND id = ?')
        .run(input.title === undefined ? current.title : input.title.trim(), (input.completed ?? current.completed) ? 1 : 0, userId, id);
      return get(userId, id);
    },
    delete(userId, id) {
      if (!db.prepare('DELETE FROM personal_todos WHERE user_id = ? AND id = ?').run(userId, id).changes) throw new AuthError(404, 'To-do not found.');
    },
  };
}
