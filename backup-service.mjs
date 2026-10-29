import { backfillKanbanHistory, transaction } from './database.mjs';
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
  if (input.teamMembers !== undefined && (!Array.isArray(input.teamMembers) || input.teamMembers.length > 100_000)) throw new Error('The backup contains invalid team members.');
  if (input.kanbanColumns !== undefined && (!Array.isArray(input.kanbanColumns) || input.kanbanColumns.length > 10_000)) throw new Error('The backup contains invalid kanban columns.');
  if (input.kanbanCards !== undefined && (!Array.isArray(input.kanbanCards) || input.kanbanCards.length > 100_000)) throw new Error('The backup contains invalid kanban cards.');
  if (input.kanbanCardNotes !== undefined && (!Array.isArray(input.kanbanCardNotes) || input.kanbanCardNotes.length > 250_000)) throw new Error('The backup contains invalid kanban card notes.');
  if (input.kanbanCardHistory !== undefined && (!Array.isArray(input.kanbanCardHistory) || input.kanbanCardHistory.length > 500_000)) throw new Error('The backup contains invalid kanban card history.');
  if (input.kanbanCardTags !== undefined && (!Array.isArray(input.kanbanCardTags) || input.kanbanCardTags.length > 2_000_000)) throw new Error('The backup contains invalid kanban card tags.');
  const totalCapacity = Number(input.settings?.totalCapacity);
  if (!Number.isInteger(totalCapacity) || totalCapacity < 0 || totalCapacity > 9999) {
    throw new Error('The backup contains an invalid team capacity.');
  }
  return { ...input, teams: input.teams || [], teamMembers: input.teamMembers || [], kanbanColumns: input.kanbanColumns || [], kanbanCards: input.kanbanCards || [], kanbanCardNotes: input.kanbanCardNotes || [], kanbanCardHistory: input.kanbanCardHistory || [], kanbanCardTags: input.kanbanCardTags || [], totalCapacity };
}

function prepareRestoreStatements(db) {
  return {
    team: db.prepare('INSERT INTO teams (id, name, capacity, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'),
    member: db.prepare('INSERT INTO team_members (team_id, user_id) VALUES (?, ?)'),
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
    kanbanColumn: db.prepare('INSERT INTO kanban_columns (id, name, position, team_id, created_at) VALUES (?, ?, ?, ?, ?)'),
    kanbanCard: db.prepare('INSERT INTO kanban_cards (id, column_id, project_id, team_id, title, description, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    kanbanNote: db.prepare('INSERT INTO kanban_card_notes (id, card_id, body, created_at) VALUES (?, ?, ?, ?)'),
    kanbanHistory: db.prepare('INSERT INTO kanban_card_history (id, card_id, column_id, column_name, entered_at, exited_at) VALUES (?, ?, ?, ?, ?, ?)'),
    kanbanTag: db.prepare('INSERT INTO kanban_card_tags (card_id, name) VALUES (?, ?)'),
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
  for (const row of backup.teamMembers) {
    if (db.prepare('SELECT 1 FROM teams WHERE id = ?').get(row.team_id) && db.prepare('SELECT 1 FROM users WHERE id = ?').get(row.user_id)) insert.member.run(row.team_id, row.user_id);
  }
  for (const row of backup.projects) {
    const scheduleStage = row.schedule_stage ?? (row.status === 'Scheduled' && row.capacity > 0 ? 'Planning' : 'To plan');
    insert.project.run(row.id, row.project_id, row.external_url ?? '', row.name, row.description, row.retrospective, row.blocked_note ?? '', row.archive_note ?? '', row.restore_note ?? '', row.team, row.status, scheduleStage, row.capacity, row.archived, row.hidden_from_read_only ?? 0, row.impact, row.urgency, row.confidence, row.effort, row.created_at, row.updated_at);
  }
  const fallbackTeamId = db.prepare('SELECT id FROM teams ORDER BY id LIMIT 1').get()?.id;
  for (const row of backup.kanbanColumns) insert.kanbanColumn.run(row.id, row.name, row.position, row.team_id ?? fallbackTeamId, row.created_at);
  for (const row of backup.kanbanCards) {
    const columnTeamId = db.prepare('SELECT team_id AS teamId FROM kanban_columns WHERE id = ?').get(row.column_id)?.teamId;
    insert.kanbanCard.run(row.id, row.column_id, row.project_id ?? null, row.team_id ?? columnTeamId ?? fallbackTeamId, row.title, row.description ?? '', row.position, row.created_at, row.updated_at);
  }
  for (const row of backup.kanbanCardNotes) insert.kanbanNote.run(row.id, row.card_id, row.body, row.created_at);
  for (const row of backup.kanbanCardHistory) insert.kanbanHistory.run(row.id, row.card_id, row.column_id, row.column_name, row.entered_at, row.exited_at ?? null);
  for (const row of backup.kanbanCardTags) insert.kanbanTag.run(row.card_id, row.name);
  backfillKanbanHistory(db);
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
        teamMembers: db.prepare('SELECT * FROM team_members ORDER BY team_id, user_id').all(),
        projects: db.prepare('SELECT * FROM projects ORDER BY id').all(),
        projectMoves: db.prepare('SELECT * FROM project_moves ORDER BY id').all(),
        planningSessions: db.prepare('SELECT * FROM planning_sessions ORDER BY id').all(),
        planningSessionProjects: db.prepare('SELECT * FROM planning_session_projects ORDER BY session_id, position, project_id').all(),
        planningVotes: db.prepare('SELECT * FROM planning_votes ORDER BY id').all(),
        kanbanColumns: db.prepare('SELECT * FROM kanban_columns ORDER BY position, id').all(),
        kanbanCards: db.prepare('SELECT * FROM kanban_cards ORDER BY column_id, position, id').all(),
        kanbanCardNotes: db.prepare('SELECT * FROM kanban_card_notes ORDER BY card_id, created_at, id').all(),
        kanbanCardHistory: db.prepare('SELECT * FROM kanban_card_history ORDER BY card_id, entered_at, id').all(),
        kanbanCardTags: db.prepare('SELECT * FROM kanban_card_tags ORDER BY card_id, name').all(),
      };
    },

    restore(input) {
      const backup = validateBackupDocument(input);
      try {
        transaction(db, () => {
          db.exec(`
            DELETE FROM kanban_card_tags;
            DELETE FROM kanban_card_history;
            DELETE FROM kanban_card_notes;
            DELETE FROM kanban_cards;
            DELETE FROM kanban_columns;
            DELETE FROM planning_votes;
            DELETE FROM planning_session_projects;
            DELETE FROM planning_sessions;
            DELETE FROM project_moves;
            DELETE FROM projects;
            DELETE FROM teams;
          `);
          if (db.dialect !== 'postgres') db.exec("DELETE FROM sqlite_sequence WHERE name IN ('projects', 'teams', 'project_moves', 'planning_sessions', 'planning_votes', 'kanban_columns', 'kanban_cards', 'kanban_card_notes', 'kanban_card_history')");
          db.prepare('UPDATE portfolio_settings SET total_capacity = ? WHERE id = 1').run(backup.totalCapacity);
          insertBackupRows(db, backup);
          db.prepare('UPDATE portfolio_settings SET total_capacity = (SELECT COALESCE(SUM(capacity), 0) FROM teams) WHERE id = 1').run();
          verifyPortfolioConstraints(db);
          if (db.dialect === 'postgres') db.resetSequences();
        });
      } catch (error) {
        throw new Error(`Backup could not be restored: ${error instanceof Error ? error.message : 'invalid data'}`);
      }
      if (db.dialect !== 'postgres') db.exec('PRAGMA optimize');
      return {
        projects: backup.projects.length,
        moves: backup.projectMoves.length,
        planningRooms: backup.planningSessions.length,
        votes: backup.planningVotes.length,
      };
    },
  };
}
