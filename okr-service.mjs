export class OkrError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const idOf = (value) => {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new OkrError(400, 'Invalid ID.');
  return id;
};
const text = (value, label, max, required = false) => {
  const result = String(value ?? '').trim();
  if (result.length > max || (required && !result)) throw new OkrError(400, `${label} must be ${required ? '1–' : 'at most '}${max} characters.`);
  return result;
};
const count = (value, label, minimum) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > 1_000_000_000) throw new OkrError(400, `${label} must be a whole number between ${minimum} and 1,000,000,000.`);
  return number;
};

export function createOkrService(db) {
  const objective = (id) => {
    const row = db.prepare('SELECT id FROM okr_objectives WHERE id = ?').get(idOf(id));
    if (!row) throw new OkrError(404, 'Objective not found.');
    return row;
  };
  const result = (id) => {
    const row = db.prepare('SELECT id, objective_id AS objectiveId FROM okr_key_results WHERE id = ?').get(idOf(id));
    if (!row) throw new OkrError(404, 'Key result not found.');
    return row;
  };
  const canSeeProject = (project, user) => user.role === 'admin' || !project.hidden || (user.role === 'team_manager' && user.teamIds.includes(project.teamId));
  const canLink = (teamId, user) => user.role === 'admin' || (user.role === 'team_manager' && user.teamIds.includes(teamId));

  return {
    list(user) {
      const objectives = db.prepare('SELECT id, title, description, period, created_at AS createdAt, updated_at AS updatedAt FROM okr_objectives ORDER BY id DESC').all();
      const results = db.prepare('SELECT id, objective_id AS objectiveId, title, target, current, position FROM okr_key_results ORDER BY objective_id, position, id').all();
      const projects = db.prepare('SELECT l.key_result_id AS keyResultId, p.id, p.project_id AS code, p.name, p.status, p.archived, p.hidden_from_read_only AS hidden, t.id AS teamId FROM okr_project_links l JOIN projects p ON p.id = l.project_id JOIN teams t ON t.name = p.team COLLATE NOCASE ORDER BY p.name').all().filter((p) => canSeeProject(p, user));
      const tasks = db.prepare('SELECT l.key_result_id AS keyResultId, c.id, c.title, c.archived, c.project_id AS projectId, c.team_id AS teamId, p.hidden_from_read_only AS hidden, t.id AS projectTeamId FROM okr_task_links l JOIN kanban_cards c ON c.id = l.card_id LEFT JOIN projects p ON p.id = c.project_id LEFT JOIN teams t ON t.name = p.team COLLATE NOCASE ORDER BY c.title').all().filter((task) => !task.hidden || user.role === 'admin' || (user.role === 'team_manager' && user.teamIds.includes(task.projectTeamId)));
      return objectives.map((item) => ({ ...item, keyResults: results.filter((kr) => kr.objectiveId === item.id).map((kr) => ({ ...kr, projects: projects.filter((p) => p.keyResultId === kr.id), tasks: tasks.filter((task) => task.keyResultId === kr.id) })) }));
    },
    options(user) {
      const projects = db.prepare('SELECT p.id, p.project_id AS code, p.name, p.hidden_from_read_only AS hidden, t.id AS teamId FROM projects p JOIN teams t ON t.name = p.team COLLATE NOCASE ORDER BY p.name').all().filter((p) => canSeeProject(p, user));
      const tasks = db.prepare('SELECT c.id, c.title, c.team_id AS teamId, c.project_id AS projectId, p.hidden_from_read_only AS hidden, t.id AS projectTeamId FROM kanban_cards c LEFT JOIN projects p ON p.id = c.project_id LEFT JOIN teams t ON t.name = p.team COLLATE NOCASE WHERE c.archived = 0 ORDER BY c.title').all().filter((task) => !task.hidden || user.role === 'admin' || (user.role === 'team_manager' && user.teamIds.includes(task.projectTeamId)));
      return { projects, tasks };
    },
    createObjective(input) {
      const title = text(input?.title, 'Objective title', 200, true);
      const description = text(input?.description, 'Description', 2000);
      const period = text(input?.period, 'Period', 80);
      const inserted = db.prepare('INSERT INTO okr_objectives (title, description, period) VALUES (?, ?, ?)').run(title, description, period);
      return inserted.lastInsertRowid;
    },
    updateObjective(id, input) {
      objective(id);
      db.prepare('UPDATE okr_objectives SET title = ?, description = ?, period = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(text(input?.title, 'Objective title', 200, true), text(input?.description, 'Description', 2000), text(input?.period, 'Period', 80), id);
    },
    deleteObjective(id) { objective(id); db.prepare('DELETE FROM okr_objectives WHERE id = ?').run(id); },
    createResult(objectiveId, input) {
      objective(objectiveId);
      const title = text(input?.title, 'Key result title', 200, true);
      const target = count(input?.target, 'Target', 1);
      const current = count(input?.current ?? 0, 'Current value', 0);
      return db.prepare('INSERT INTO okr_key_results (objective_id, title, target, current, position) VALUES (?, ?, ?, ?, (SELECT COUNT(*) FROM okr_key_results WHERE objective_id = ?))').run(objectiveId, title, target, current, objectiveId).lastInsertRowid;
    },
    updateResult(objectiveId, id, input) {
      if (result(id).objectiveId !== idOf(objectiveId)) throw new OkrError(404, 'Key result not found.');
      db.prepare('UPDATE okr_key_results SET title = ?, target = ?, current = ? WHERE id = ?').run(text(input?.title, 'Key result title', 200, true), count(input?.target, 'Target', 1), count(input?.current, 'Current value', 0), id);
    },
    deleteResult(objectiveId, id) { if (result(id).objectiveId !== idOf(objectiveId)) throw new OkrError(404, 'Key result not found.'); db.prepare('DELETE FROM okr_key_results WHERE id = ?').run(id); },
    link(objectiveId, id, type, linkedId, user) {
      if (result(id).objectiveId !== idOf(objectiveId)) throw new OkrError(404, 'Key result not found.');
      const linked = idOf(linkedId);
      if (type === 'projects') {
        const project = db.prepare('SELECT p.hidden_from_read_only AS hidden, t.id AS teamId FROM projects p JOIN teams t ON t.name = p.team COLLATE NOCASE WHERE p.id = ?').get(linked);
        if (!project || !canSeeProject(project, user) || !canLink(project.teamId, user)) throw new OkrError(404, 'Project not found.');
        db.prepare('INSERT OR IGNORE INTO okr_project_links (key_result_id, project_id) VALUES (?, ?)').run(id, linked);
      } else {
        const task = db.prepare('SELECT c.team_id AS teamId, p.hidden_from_read_only AS hidden, t.id AS projectTeamId FROM kanban_cards c LEFT JOIN projects p ON p.id = c.project_id LEFT JOIN teams t ON t.name = p.team COLLATE NOCASE WHERE c.id = ?').get(linked);
        if (!task || !canLink(task.teamId, user) || (task.hidden && !canSeeProject({ hidden: task.hidden, teamId: task.projectTeamId }, user))) throw new OkrError(404, 'Task not found.');
        db.prepare('INSERT OR IGNORE INTO okr_task_links (key_result_id, card_id) VALUES (?, ?)').run(id, linked);
      }
    },
    unlink(objectiveId, id, type, linkedId, user) {
      if (result(id).objectiveId !== idOf(objectiveId)) throw new OkrError(404, 'Key result not found.');
      const linked = idOf(linkedId);
      const row = type === 'projects'
        ? db.prepare('SELECT t.id AS teamId FROM projects p JOIN teams t ON t.name = p.team COLLATE NOCASE WHERE p.id = ?').get(linked)
        : db.prepare('SELECT team_id AS teamId FROM kanban_cards WHERE id = ?').get(linked);
      if (row && !canLink(row.teamId, user)) throw new OkrError(403, 'You cannot unlink work from another team.');
      db.prepare(`DELETE FROM ${type === 'projects' ? 'okr_project_links' : 'okr_task_links'} WHERE key_result_id = ? AND ${type === 'projects' ? 'project_id' : 'card_id'} = ?`).run(id, linked);
    },
  };
}
