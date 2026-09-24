import { transaction } from './database.mjs';
import {
  DEFAULT_PROJECT,
  FOCUS_MIN_SCORE,
  FOCUS_LIMIT_MESSAGE,
  isFocusProject,
  scheduledCapacityConflict,
  validateProject,
} from './project-domain.mjs';

const selectColumns = `
  id, project_id AS projectId, external_url AS externalUrl, name, description, retrospective, blocked_note AS blockedNote, archive_note AS archiveNote, restore_note AS restoreNote, team, status, schedule_stage AS scheduleStage, capacity, archived, hidden_from_read_only AS hiddenFromReadOnly, impact, urgency, confidence, effort,
  created_at AS createdAt, updated_at AS updatedAt,
  ROUND((impact * 0.4 + urgency * 0.4 + confidence * 0.2) * (1.15 - effort * 0.03), 1) AS score
`;

const BULK_LIMIT = 100;

export class ProjectError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createProjectService(db) {
  function validateBulkItems(items, label) {
    if (!Array.isArray(items) || items.length === 0) throw new ProjectError(400, `${label} must be a non-empty array.`);
    if (items.length > BULK_LIMIT) throw new ProjectError(400, `A bulk request can contain at most ${BULK_LIMIT} projects.`);
    return items;
  }

  function validateProjectIds(projectIds) {
    const ids = validateBulkItems(projectIds, 'projectIds').map(Number);
    if (ids.some((id) => !Number.isSafeInteger(id) || id < 1)) {
      throw new ProjectError(400, 'projectIds must contain positive integer project IDs.');
    }
    if (new Set(ids).size !== ids.length) throw new ProjectError(400, 'projectIds must not contain duplicates.');
    return ids;
  }

  function capacity({ includeHidden = true } = {}) {
    const total = db.prepare('SELECT COALESCE(SUM(capacity), 0) AS total FROM teams').get().total;
    const occupied = db.prepare(`SELECT COALESCE(SUM(capacity), 0) AS occupied FROM projects WHERE archived = 0 AND status != 'Complete' ${includeHidden ? '' : 'AND hidden_from_read_only = 0'}`).get().occupied;
    return { total, occupied, available: total - occupied };
  }

  function ensureTeam(name) {
    const existing = db.prepare('SELECT * FROM teams WHERE name = ? COLLATE NOCASE').get(name);
    if (existing) return existing;
    const result = db.prepare('INSERT INTO teams (name, capacity) VALUES (?, 0)').run(name);
    return db.prepare('SELECT * FROM teams WHERE id = ?').get(result.lastInsertRowid);
  }

  function validatePlacement(project, projectId = 0) {
    if (isFocusProject(project) && db.prepare(`
      SELECT 1 FROM projects
      WHERE id != ? AND archived = 0 AND status != 'Complete' AND impact >= ? AND urgency >= ?
        AND team = ? COLLATE NOCASE
      LIMIT 1
    `).get(projectId, FOCUS_MIN_SCORE, FOCUS_MIN_SCORE, project.team)) throw new ProjectError(409, FOCUS_LIMIT_MESSAGE);
    const scheduledError = scheduledCapacityConflict(project);
    if (scheduledError) throw new ProjectError(409, scheduledError);
    const contribution = project.archived || project.status === 'Complete' ? 0 : project.capacity;
    const total = db.prepare('SELECT capacity AS total FROM teams WHERE name = ? COLLATE NOCASE').get(project.team)?.total ?? 0;
    const occupiedByOthers = db.prepare("SELECT COALESCE(SUM(capacity), 0) AS occupied FROM projects WHERE id != ? AND team = ? COLLATE NOCASE AND archived = 0 AND status != 'Complete'").get(projectId, project.team).occupied;
    const requested = occupiedByOthers + contribution;
    if (requested > total) throw new ProjectError(409, `${project.team} capacity is ${total}, but this change would assign ${requested} people. Reduce a project allocation or increase the team’s capacity first.`);
  }

  function validateInput(input, partial = false) {
    const checked = validateProject(input, { partial });
    if (checked.error) throw new ProjectError(400, checked.error);
    return checked.value;
  }

  function create(input) {
    const project = { ...DEFAULT_PROJECT, ...validateInput(input) };
    project.team = ensureTeam(project.team).name;
    if (project.status !== 'Blocked') project.blockedNote = '';
    if (project.archived && !project.archiveNote) throw new ProjectError(400, 'An archive note is required when archiving a project.');
    validatePlacement(project);
    const hidden = input.hiddenFromReadOnly ? 1 : 0;
    const result = db.prepare('INSERT INTO projects (project_id, external_url, name, description, retrospective, blocked_note, archive_note, restore_note, team, status, schedule_stage, capacity, archived, hidden_from_read_only, impact, urgency, confidence, effort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(project.projectId, project.externalUrl, project.name, project.description, project.retrospective, project.blockedNote, project.archiveNote, project.restoreNote, project.team, project.status, project.scheduleStage, project.capacity, project.archived, hidden, project.impact, project.urgency, project.confidence, project.effort);
    return db.prepare(`SELECT ${selectColumns} FROM projects WHERE id = ?`).get(result.lastInsertRowid);
  }

  function deleteProject(id) {
    if (!db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes) throw new ProjectError(404, 'Project not found.');
  }

  return {
    capacity,

    setCapacity(input) {
      const total = Number(input.total);
      if (!Number.isInteger(total) || total < 0 || total > 9999) throw new ProjectError(400, 'Team capacity must be a whole number from 0 to 9999.');
      const occupied = capacity().occupied;
      if (total < occupied) throw new ProjectError(409, `Team capacity cannot be lower than the ${occupied} people currently assigned.`);
      const teams = db.prepare(`
        SELECT t.id, COALESCE(SUM(CASE WHEN p.archived = 0 AND p.status != 'Complete' THEN p.capacity ELSE 0 END), 0) AS occupied
        FROM teams t LEFT JOIN projects p ON p.team = t.name COLLATE NOCASE GROUP BY t.id ORDER BY t.name COLLATE NOCASE
      `).all();
      transaction(db, () => {
        teams.forEach((team, index) => db.prepare('UPDATE teams SET capacity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(team.occupied + (index === 0 ? total - occupied : 0), team.id));
        db.prepare('UPDATE portfolio_settings SET total_capacity = ? WHERE id = 1').run(total);
      });
      return capacity();
    },

    list({ includeHidden = true } = {}) {
      return db.prepare(`SELECT ${selectColumns} FROM projects ${includeHidden ? '' : 'WHERE hidden_from_read_only = 0'} ORDER BY score DESC, updated_at DESC`).all();
    },

    create,

    bulkCreate(inputs) {
      const projects = validateBulkItems(inputs, 'projects');
      if (projects.some((input) => !input || typeof input !== 'object' || Array.isArray(input))) {
        throw new ProjectError(400, 'projects must contain project objects.');
      }
      return transaction(db, () => projects.map(create));
    },

    update(id, input) {
      const current = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
      if (!current) throw new ProjectError(404, 'Project not found.');
      const project = { ...current, ...validateInput(input, true) };
      project.team = ensureTeam(project.team).name;
      project.blockedNote = project.status === 'Blocked' ? (project.blockedNote ?? project.blocked_note ?? '') : '';
      project.archiveNote = project.archiveNote ?? project.archive_note ?? '';
      project.restoreNote = project.restoreNote ?? project.restore_note ?? '';
      project.hiddenFromReadOnly = input.hiddenFromReadOnly === undefined ? current.hidden_from_read_only : (input.hiddenFromReadOnly ? 1 : 0);
      const submittedArchiveNote = String(input.archiveNote ?? input.archive_note ?? '').trim();
      const submittedRestoreNote = String(input.restoreNote ?? input.restore_note ?? '').trim();
      if (!current.archived && project.archived && !submittedArchiveNote) throw new ProjectError(400, 'An archive note is required when archiving a project.');
      if (current.archived && !project.archived && !submittedRestoreNote) throw new ProjectError(400, 'A restore note is required when restoring a project.');
      validatePlacement(project, id);
      const moveSource = String(input.moveSource || 'Project update').trim().slice(0, 40) || 'Project update';
      const moveComment = String(input.moveComment || '').trim().slice(0, 500);
      transaction(db, () => {
        db.prepare('UPDATE projects SET project_id = ?, external_url = ?, name = ?, description = ?, retrospective = ?, blocked_note = ?, archive_note = ?, restore_note = ?, team = ?, status = ?, schedule_stage = ?, capacity = ?, archived = ?, hidden_from_read_only = ?, impact = ?, urgency = ?, confidence = ?, effort = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(project.projectId ?? project.project_id ?? '', project.externalUrl ?? project.external_url ?? '', project.name, project.description, project.retrospective, project.blockedNote, project.archiveNote, project.restoreNote, project.team, project.status, project.scheduleStage ?? project.schedule_stage ?? 'To plan', project.capacity, project.archived, project.hiddenFromReadOnly, project.impact, project.urgency, project.confidence, project.effort, id);
        if (current.impact !== project.impact || current.urgency !== project.urgency) {
          db.prepare('INSERT INTO project_moves (project_id, from_impact, from_urgency, to_impact, to_urgency, source, comment) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(id, current.impact, current.urgency, project.impact, project.urgency, moveSource, moveComment);
        }
      });
      return db.prepare(`SELECT ${selectColumns} FROM projects WHERE id = ?`).get(id);
    },

    bulkArchive(projectIds) {
      const ids = validateProjectIds(projectIds);
      return transaction(db, () => {
        for (const id of ids) {
          if (!db.prepare('UPDATE projects SET archived = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id).changes) {
            throw new ProjectError(404, 'Project not found.');
          }
        }
        const select = db.prepare(`SELECT ${selectColumns} FROM projects WHERE id = ?`);
        return ids.map((id) => select.get(id));
      });
    },

    delete: deleteProject,

    bulkDelete(projectIds) {
      const ids = validateProjectIds(projectIds);
      transaction(db, () => ids.forEach(deleteProject));
      return ids;
    },

    moves(id) {
      if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id)) throw new ProjectError(404, 'Project not found.');
      return db.prepare(`
        SELECT id, from_impact AS fromImpact, from_urgency AS fromUrgency,
          to_impact AS toImpact, to_urgency AS toUrgency, source, comment, moved_at AS movedAt
        FROM project_moves WHERE project_id = ? ORDER BY moved_at DESC, id DESC
      `).all(id);
    },

    isHidden(id) {
      return Boolean(db.prepare('SELECT hidden_from_read_only AS hidden FROM projects WHERE id = ?').get(id)?.hidden);
    },

    statusExportRows() {
      return db.prepare(`
        SELECT project_id AS projectId, name, team, status, blocked_note AS blockedNote, capacity, impact, urgency,
          confidence, effort, external_url AS externalUrl, description, updated_at AS updatedAt
        FROM projects
        WHERE archived = 0 AND status IN ('Active', 'Blocked')
        ORDER BY CASE status WHEN 'Active' THEN 0 ELSE 1 END, team, name
      `).all();
    },
  };
}
