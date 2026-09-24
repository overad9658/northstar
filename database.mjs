import { DatabaseSync } from 'node:sqlite';

const projectsTableSql = `
  CREATE TABLE projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL DEFAULT '',
    external_url TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
    description TEXT NOT NULL DEFAULT '',
    retrospective TEXT NOT NULL DEFAULT '',
    blocked_note TEXT NOT NULL DEFAULT '',
    archive_note TEXT NOT NULL DEFAULT '',
    restore_note TEXT NOT NULL DEFAULT '',
    team TEXT NOT NULL DEFAULT 'Platform',
    status TEXT NOT NULL DEFAULT 'Active' CHECK(status IN ('Scheduled', 'Active', 'On hold', 'Blocked', 'Complete')),
    schedule_stage TEXT NOT NULL DEFAULT 'To plan' CHECK(schedule_stage IN ('To plan', 'Planning')),
    capacity INTEGER NOT NULL DEFAULT 0 CHECK(capacity BETWEEN 0 AND 999),
    archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1)),
    impact INTEGER NOT NULL CHECK(impact BETWEEN 1 AND 10),
    urgency INTEGER NOT NULL CHECK(urgency BETWEEN 1 AND 10),
    confidence INTEGER NOT NULL CHECK(confidence BETWEEN 1 AND 10),
    effort INTEGER NOT NULL CHECK(effort BETWEEN 1 AND 10),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`;

const planningVotesTableSql = `
  CREATE TABLE planning_votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES planning_sessions(id) ON DELETE CASCADE,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    voter_token TEXT NOT NULL,
    voter_name TEXT NOT NULL,
    impact INTEGER NOT NULL CHECK(impact BETWEEN 1 AND 10),
    urgency INTEGER NOT NULL CHECK(urgency BETWEEN 1 AND 10),
    confidence INTEGER NOT NULL CHECK(confidence BETWEEN 1 AND 10),
    effort INTEGER NOT NULL CHECK(effort BETWEEN 1 AND 10),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(session_id, project_id, voter_token)
  )`;

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table));
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column);
}

function ensureColumn(db, table, column, definition) {
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function transaction(db, callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function migrateProjects(db) {
  if (!tableExists(db, 'projects')) db.exec(projectsTableSql);
  ensureColumn(db, 'projects', 'project_id', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'projects', 'capacity', 'INTEGER NOT NULL DEFAULT 0 CHECK(capacity BETWEEN 0 AND 999)');
  ensureColumn(db, 'projects', 'archived', 'INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1))');
  ensureColumn(db, 'projects', 'retrospective', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'projects', 'blocked_note', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'projects', 'archive_note', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'projects', 'restore_note', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'projects', 'external_url', "TEXT NOT NULL DEFAULT ''");
  if (!hasColumn(db, 'projects', 'schedule_stage')) {
    ensureColumn(db, 'projects', 'schedule_stage', "TEXT NOT NULL DEFAULT 'To plan' CHECK(schedule_stage IN ('To plan', 'Planning'))");
    db.exec("UPDATE projects SET schedule_stage = 'Planning' WHERE status IN ('Scheduled', 'Planned') AND capacity > 0");
  }

  const definition = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'projects'").get().sql;
  if (definition.includes("'Scheduled'") && definition.includes("'Blocked'")) return;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    transaction(db, () => db.exec(`
      ${projectsTableSql.replace('CREATE TABLE projects', 'CREATE TABLE projects_new')};
      INSERT INTO projects_new (id, project_id, external_url, name, description, retrospective, blocked_note, archive_note, restore_note, team, status, schedule_stage, capacity, archived, impact, urgency, confidence, effort, created_at, updated_at)
      SELECT id, project_id, external_url, name, description, retrospective, blocked_note, archive_note, restore_note, team,
        CASE WHEN status = 'Planned' THEN 'Scheduled' ELSE status END,
        schedule_stage, capacity, archived, impact, urgency, confidence, effort, created_at, updated_at
      FROM projects;
      DROP TABLE projects;
      ALTER TABLE projects_new RENAME TO projects;
    `));
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function createRelatedTables(db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
    CREATE INDEX IF NOT EXISTS idx_projects_priority ON projects(impact DESC, urgency DESC);
    CREATE TABLE IF NOT EXISTS portfolio_settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      total_capacity INTEGER NOT NULL DEFAULT 0 CHECK(total_capacity BETWEEN 0 AND 9999)
    );
    INSERT OR IGNORE INTO portfolio_settings (id, total_capacity) VALUES (1, 0);
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'read_only')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at);
    CREATE TABLE IF NOT EXISTS project_moves (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      from_impact INTEGER NOT NULL CHECK(from_impact BETWEEN 1 AND 10),
      from_urgency INTEGER NOT NULL CHECK(from_urgency BETWEEN 1 AND 10),
      to_impact INTEGER NOT NULL CHECK(to_impact BETWEEN 1 AND 10),
      to_urgency INTEGER NOT NULL CHECK(to_urgency BETWEEN 1 AND 10),
      source TEXT NOT NULL DEFAULT 'Project update',
      comment TEXT NOT NULL DEFAULT '',
      moved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS planning_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL UNIQUE,
      leader_key TEXT NOT NULL,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'Open' CHECK(status IN ('Open', 'Closed')),
      final_impact INTEGER, final_urgency INTEGER, final_confidence INTEGER, final_effort INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      decided_at TEXT
    );
    CREATE TABLE IF NOT EXISTS planning_session_projects (
      session_id INTEGER NOT NULL REFERENCES planning_sessions(id) ON DELETE CASCADE,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Open' CHECK(status IN ('Open', 'Decided')),
      revealed INTEGER NOT NULL DEFAULT 0 CHECK(revealed IN (0, 1)),
      final_impact INTEGER, final_urgency INTEGER, final_confidence INTEGER, final_effort INTEGER,
      move_comment TEXT NOT NULL DEFAULT '',
      decided_at TEXT,
      PRIMARY KEY(session_id, project_id)
    );
    CREATE INDEX IF NOT EXISTS idx_planning_sessions_project ON planning_sessions(project_id, created_at DESC);
  `);
  ensureColumn(db, 'portfolio_settings', 'api_token_hash', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'portfolio_settings', 'api_token_created_at', 'TEXT');
  ensureColumn(db, 'project_moves', 'comment', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'planning_session_projects', 'revealed', 'INTEGER NOT NULL DEFAULT 0 CHECK(revealed IN (0, 1))');
  ensureColumn(db, 'planning_session_projects', 'move_comment', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'planning_sessions', 'guest_access', 'INTEGER NOT NULL DEFAULT 1 CHECK(guest_access IN (0, 1))');
  ensureColumn(db, 'projects', 'hidden_from_read_only', 'INTEGER NOT NULL DEFAULT 0 CHECK(hidden_from_read_only IN (0, 1))');
  db.exec(`
    INSERT OR IGNORE INTO planning_session_projects
      (session_id, project_id, position, status, final_impact, final_urgency, final_confidence, final_effort, decided_at)
    SELECT id, project_id, 0, CASE WHEN status = 'Closed' THEN 'Decided' ELSE 'Open' END,
      final_impact, final_urgency, final_confidence, final_effort, decided_at
    FROM planning_sessions;
  `);
}

function migrateTeams(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK(length(name) BETWEEN 1 AND 50),
      capacity INTEGER NOT NULL DEFAULT 0 CHECK(capacity BETWEEN 0 AND 9999),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  if (db.prepare('SELECT 1 FROM teams LIMIT 1').get()) return;
  const legacyTotal = db.prepare('SELECT total_capacity AS total FROM portfolio_settings WHERE id = 1').get().total;
  const existingTeams = db.prepare(`
    SELECT team AS name, COALESCE(SUM(CASE WHEN archived = 0 AND status != 'Complete' THEN capacity ELSE 0 END), 0) AS occupied
    FROM projects GROUP BY team COLLATE NOCASE ORDER BY team COLLATE NOCASE
  `).all();
  const rows = existingTeams.length ? existingTeams : [{ name: 'Platform', occupied: 0 }];
  const occupied = rows.reduce((sum, team) => sum + team.occupied, 0);
  const remaining = Math.max(0, legacyTotal - occupied);
  const insert = db.prepare('INSERT INTO teams (name, capacity) VALUES (?, ?)');
  rows.forEach((team, index) => insert.run(team.name, team.occupied + (index === 0 ? remaining : 0)));
}

function migratePlanningVotes(db) {
  if (!tableExists(db, 'planning_votes')) return db.exec(planningVotesTableSql);
  if (hasColumn(db, 'planning_votes', 'project_id')) return;
  transaction(db, () => db.exec(`
    ALTER TABLE planning_votes RENAME TO planning_votes_legacy;
    ${planningVotesTableSql};
    INSERT INTO planning_votes (id, session_id, project_id, voter_token, voter_name, impact, urgency, confidence, effort, updated_at)
    SELECT v.id, v.session_id, s.project_id, v.voter_token, v.voter_name, v.impact, v.urgency, v.confidence, v.effort, v.updated_at
    FROM planning_votes_legacy v JOIN planning_sessions s ON s.id = v.session_id;
    DROP TABLE planning_votes_legacy;
  `));
}

export function openDatabase(filePath) {
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrateProjects(db);
  createRelatedTables(db);
  migrateTeams(db);
  migratePlanningVotes(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_planning_room_projects ON planning_session_projects(session_id, position);
    CREATE INDEX IF NOT EXISTS idx_planning_votes_session_project ON planning_votes(session_id, project_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_project_moves_project_date ON project_moves(project_id, moved_at DESC, id DESC);
    PRAGMA user_version = 6;
    PRAGMA optimize;
  `);
  return db;
}
