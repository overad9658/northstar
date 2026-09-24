import { transaction } from './database.mjs';
import { FOCUS_MIN_SCORE } from './public/shared/project-rules.js';

const BACKUP_FORMAT = 'northstar-priority-matrix';
const BACKUP_VERSION = 1;
const COLLECTION_LIMITS = Object.freeze({
  projects: 10_000,
  projectMoves: 100_000,
  planningSessions: 10_000,
  planningSessionProjects: 100_000,
  planningVotes: 250_000,
});

function validateBackupDocument(input) {
  if (!input || input.format !== BACKUP_FORMAT || input.version !== BACKUP_VERSION) {
    throw new Error('This is not a supported Northstar backup file.');
  }
  for (const [collection, limit] of Object.entries(COLLECTION_LIMITS)) {
    if (!Array.isArray(input[collection])) throw new Error('The backup file is incomplete.');
    if (input[collection].length > limit) throw new Error('The backup contains too many records.');
  }
  if (input.teams !== undefined && (!Array.isArray(input.teams) || input.teams.length > 10_000)) {
    throw new Error('The backup contains invalid team records.');
  }
  const totalCapacity = Number(input.settings?.totalCapacity);
  if (!Number.isInteger(totalCapacity) || totalCapacity < 0 || totalCapacity > 9999) {
    throw new Error('The backup contains an invalid team capacity.');
  }
  return { ...input, teams: input.teams || [], totalCapacity };
}

function prepareRestoreStatements(db) {
  return {
    team: db.prepare('INSERT INTO teams (id, name, capacity, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'),
    project: db.prepare(`
      INSERT INTO projects (id, project_id, external_url, name, description, retrospective, blocked_note, archive_note, restore_note, team, status, schedule_stage, capacity, archived, hidden_from_read_only, impact, urgency, confidence, effort, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    move: db.prepare(`
      INSERT INTO project_moves (id, project_id, from_impact, from_urgency, to_impact, to_urgency, source, comment, moved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    session: db.prepare(`
      INSERT INTO planning_sessions (id, token, leader_key, project_id, status, final_impact, final_urgency, final_confidence, final_effort, guest_access, created_at, decided_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    sessionProject: db.prepare(`
      INSERT INTO planning_session_projects (session_id, project_id, position, status, revealed, final_impact, final_urgency, final_confidence, final_effort, move_comment, decided_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    vote: db.prepare(`
      INSERT INTO planning_votes (id, session_id, project_id, voter_token, voter_name, impact, urgency, confidence, effort, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
  };
}

function insertBackupRows(db, backup) {
  const insert = prepareRestoreStatements(db);
  if (backup.teams.length) {
    for (const row of backup.teams) insert.team.run(row.id, row.name, row.capacity, row.created_at, row.updated_at);
  } else {
    const occupiedByTeam = new Map();
    for (const row of backup.projects) {
      const key = String(row.team || 'Platform').trim().toLocaleLowerCase();
      const current = occupiedByTeam.get(key) || { name: row.team || 'Platform', occupied: 0 };
      if (!row.archived && row.status !== 'Complete') current.occupied += Number(row.capacity || 0);
      occupiedByTeam.set(key, current);
    }
    const teams = [...occupiedByTeam.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (!teams.length) teams.push({ name: 'Platform', occupied: 0 });
    const occupied = teams.reduce((sum, team) => sum + team.occupied, 0);
    teams.forEach((team, index) => insert.team.run(null, team.name, team.occupied + (index === 0 ? Math.max(0, backup.totalCapacity - occupied) : 0), new Date().toISOString(), new Date().toISOString()));
  }
  for (const row of backup.projects) {
    const scheduleStage = row.schedule_stage ?? (row.status === 'Scheduled' && row.capacity > 0 ? 'Planning' : 'To plan');
    insert.project.run(row.id, row.project_id, row.external_url ?? '', row.name, row.description, row.retrospective, row.blocked_note ?? '', row.archive_note ?? '', row.restore_note ?? '', row.team, row.status, scheduleStage, row.capacity, row.archived, row.hidden_from_read_only ?? 0, row.impact, row.urgency, row.confidence, row.effort, row.created_at, row.updated_at);
  }
  for (const row of backup.projectMoves) insert.move.run(row.id, row.project_id, row.from_impact, row.from_urgency, row.to_impact, row.to_urgency, row.source, row.comment ?? '', row.moved_at);
  for (const row of backup.planningSessions) insert.session.run(row.id, row.token, row.leader_key, row.project_id, row.status, row.final_impact, row.final_urgency, row.final_confidence, row.final_effort, row.guest_access ?? 1, row.created_at, row.decided_at);
  for (const row of backup.planningSessionProjects) insert.sessionProject.run(row.session_id, row.project_id, row.position, row.status, row.revealed ?? 0, row.final_impact, row.final_urgency, row.final_confidence, row.final_effort, row.move_comment ?? '', row.decided_at);
  for (const row of backup.planningVotes) insert.vote.run(row.id, row.session_id, row.project_id, row.voter_token, row.voter_name, row.impact, row.urgency, row.confidence, row.effort, row.updated_at);
}

function verifyPortfolioConstraints(db) {
  const unknownTeam = db.prepare('SELECT p.team FROM projects p LEFT JOIN teams t ON p.team = t.name COLLATE NOCASE WHERE t.id IS NULL LIMIT 1').get();
  if (unknownTeam) throw new Error(`The backup references an unconfigured team: ${unknownTeam.team}.`);
  const duplicateFocusTeam = db.prepare(`
    SELECT team FROM projects
    WHERE archived = 0 AND status != 'Complete' AND impact >= ? AND urgency >= ?
    GROUP BY team COLLATE NOCASE HAVING COUNT(*) > 1 LIMIT 1
  `).get(FOCUS_MIN_SCORE, FOCUS_MIN_SCORE);
  if (duplicateFocusTeam) throw new Error(`The backup gives ${duplicateFocusTeam.team} more than one project in Focus Now.`);
  if (db.prepare("SELECT 1 FROM projects WHERE status = 'Scheduled' AND schedule_stage != 'Planning' AND capacity > 0 LIMIT 1").get()) {
    throw new Error('The backup assigns people to a Scheduled project that is not in Planning.');
  }
  const overCapacityTeam = db.prepare(`
    SELECT t.name FROM teams t LEFT JOIN projects p ON p.team = t.name COLLATE NOCASE
    GROUP BY t.id HAVING COALESCE(SUM(CASE WHEN p.archived = 0 AND p.status != 'Complete' THEN p.capacity ELSE 0 END), 0) > t.capacity LIMIT 1
  `).get();
  if (overCapacityTeam) throw new Error(`The backup assigns more people than ${overCapacityTeam.name} capacity.`);
}

export function createBackupService(db) {
  return {
    export() {
      return {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exportedAt: new Date().toISOString(),
        settings: { totalCapacity: db.prepare('SELECT COALESCE(SUM(capacity), 0) AS total FROM teams').get().total },
        teams: db.prepare('SELECT * FROM teams ORDER BY name COLLATE NOCASE').all(),
        projects: db.prepare('SELECT * FROM projects ORDER BY id').all(),
        projectMoves: db.prepare('SELECT * FROM project_moves ORDER BY id').all(),
        planningSessions: db.prepare('SELECT * FROM planning_sessions ORDER BY id').all(),
        planningSessionProjects: db.prepare('SELECT * FROM planning_session_projects ORDER BY session_id, position, project_id').all(),
        planningVotes: db.prepare('SELECT * FROM planning_votes ORDER BY id').all(),
      };
    },

    restore(input) {
      const backup = validateBackupDocument(input);
      try {
        transaction(db, () => {
          db.exec(`
            DELETE FROM planning_votes;
            DELETE FROM planning_session_projects;
            DELETE FROM planning_sessions;
            DELETE FROM project_moves;
            DELETE FROM projects;
            DELETE FROM teams;
            DELETE FROM sqlite_sequence WHERE name IN ('projects', 'teams', 'project_moves', 'planning_sessions', 'planning_votes');
          `);
          db.prepare('UPDATE portfolio_settings SET total_capacity = ? WHERE id = 1').run(backup.totalCapacity);
          insertBackupRows(db, backup);
          db.prepare('UPDATE portfolio_settings SET total_capacity = (SELECT COALESCE(SUM(capacity), 0) FROM teams) WHERE id = 1').run();
          verifyPortfolioConstraints(db);
        });
      } catch (error) {
        throw new Error(`Backup could not be restored: ${error instanceof Error ? error.message : 'invalid data'}`);
      }
      db.exec('PRAGMA optimize');
      return {
        projects: backup.projects.length,
        moves: backup.projectMoves.length,
        planningRooms: backup.planningSessions.length,
        votes: backup.planningVotes.length,
      };
    },
  };
}
