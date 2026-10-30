import { DatabaseSync } from 'node:sqlite';
import { openPostgresDatabase } from './postgres-database.mjs';

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
  if (db.dialect === 'postgres') return Boolean(db.prepare('SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?').get(table));
  return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table));
}

function hasColumn(db, table, column) {
  if (db.dialect === 'postgres') return Boolean(db.prepare('SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? AND column_name = ?').get(table, column));
  return db.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column);
}

function ensureColumn(db, table, column, definition) {
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

const openTransactions = new WeakSet();

// A nested call joins the outer transaction. lockKey serializes writers across PostgreSQL connections;
// SQLite's BEGIN IMMEDIATE already serializes them.
export function transaction(db, callback, { lockKey } = {}) {
  if (openTransactions.has(db)) return callback();
  db.exec('BEGIN IMMEDIATE');
  openTransactions.add(db);
  try {
    if (lockKey && db.dialect === 'postgres') db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(lockKey);
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    openTransactions.delete(db);
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
      role TEXT NOT NULL CHECK(role IN ('admin', 'team_manager', 'read_only')),
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
    CREATE TABLE IF NOT EXISTS auth_identities (
      provider_id TEXT NOT NULL,
      issuer TEXT NOT NULL,
      subject TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (provider_id, issuer, subject)
    );
    CREATE TABLE IF NOT EXISTS auth_sso_requests (
      state TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      browser_hash TEXT NOT NULL,
      payload TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auth_sso_requests_expiry ON auth_sso_requests(expires_at);
    CREATE TABLE IF NOT EXISTS auth_sso_settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      config TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1
    );
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
    CREATE TABLE IF NOT EXISTS kanban_columns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS kanban_cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      column_id INTEGER NOT NULL REFERENCES kanban_columns(id) ON DELETE CASCADE,
      project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
      description TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_kanban_cards_column_position ON kanban_cards(column_id, position, id);
    CREATE INDEX IF NOT EXISTS idx_kanban_cards_project ON kanban_cards(project_id);
    CREATE TABLE IF NOT EXISTS kanban_card_tags (
      card_id INTEGER NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 40),
      PRIMARY KEY (card_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_kanban_card_tags_name ON kanban_card_tags(name, card_id);
    CREATE TABLE IF NOT EXISTS kanban_card_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id INTEGER NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
      body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 2000),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_kanban_card_notes_card ON kanban_card_notes(card_id, created_at, id);
    CREATE TABLE IF NOT EXISTS kanban_card_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id INTEGER NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
      column_id INTEGER NOT NULL,
      column_name TEXT NOT NULL,
      entered_at TEXT NOT NULL,
      exited_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_kanban_card_history_card ON kanban_card_history(card_id, entered_at, id);
    CREATE TABLE IF NOT EXISTS card_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id INTEGER NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('updated', 'decided', 'assigned', 'archived', 'restored')),
      detail TEXT NOT NULL DEFAULT '{}',
      actor TEXT NOT NULL DEFAULT '',
      changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_card_changes_changed ON card_changes(changed_at, id);
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
    CREATE TABLE IF NOT EXISTS project_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      field TEXT NOT NULL CHECK(field IN ('status', 'archived', 'team', 'capacity')),
      from_value TEXT NOT NULL,
      to_value TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      actor TEXT NOT NULL DEFAULT '',
      changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_project_changes_changed ON project_changes(changed_at, id);
    CREATE TABLE IF NOT EXISTS api_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      scope TEXT NOT NULL CHECK(scope IN ('read', 'write')),
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_used_at TEXT,
      revoked_at TEXT
    );
  `);
  ensureColumn(db, 'portfolio_settings', 'api_token_hash', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'portfolio_settings', 'api_token_created_at', 'TEXT');
  ensureColumn(db, 'project_moves', 'comment', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'planning_session_projects', 'revealed', 'INTEGER NOT NULL DEFAULT 0 CHECK(revealed IN (0, 1))');
  ensureColumn(db, 'planning_session_projects', 'move_comment', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'planning_sessions', 'guest_access', 'INTEGER NOT NULL DEFAULT 1 CHECK(guest_access IN (0, 1))');
  ensureColumn(db, 'kanban_cards', 'assignee', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'kanban_cards', 'external_url', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'kanban_cards', 'next_step', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'kanban_cards', 'decision', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'kanban_cards', 'card_key', 'TEXT');
  ensureColumn(db, 'kanban_cards', 'archived', 'INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1))');
  ensureColumn(db, 'kanban_cards', 'archived_at', 'TEXT');
  ensureColumn(db, 'kanban_cards', 'source', "TEXT NOT NULL DEFAULT ''");
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_kanban_cards_key ON kanban_cards(card_key) WHERE card_key IS NOT NULL');
  ensureColumn(db, 'projects', 'hidden_from_read_only', 'INTEGER NOT NULL DEFAULT 0 CHECK(hidden_from_read_only IN (0, 1))');
  db.exec(`
    INSERT OR IGNORE INTO planning_session_projects
      (session_id, project_id, position, status, final_impact, final_urgency, final_confidence, final_effort, decided_at)
    SELECT id, project_id, 0, CASE WHEN status = 'Closed' THEN 'Decided' ELSE 'Open' END,
      final_impact, final_urgency, final_confidence, final_effort, decided_at
    FROM planning_sessions;
  `);
}

export function backfillKanbanHistory(db) {
  db.exec(`
    INSERT INTO kanban_card_history (card_id, column_id, column_name, entered_at)
    SELECT c.id, c.column_id, k.name, c.created_at
    FROM kanban_cards c JOIN kanban_columns k ON k.id = c.column_id
    WHERE NOT EXISTS (SELECT 1 FROM kanban_card_history h WHERE h.card_id = c.id);
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

function migrateTeamWorkspace(db) {
  ensureColumn(db, 'kanban_columns', 'team_id', 'INTEGER REFERENCES teams(id) ON DELETE CASCADE');
  ensureColumn(db, 'kanban_cards', 'team_id', 'INTEGER REFERENCES teams(id) ON DELETE CASCADE');
  db.exec(`CREATE TABLE IF NOT EXISTS team_members (
    team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (team_id, user_id)
  )`);
  const first = db.prepare('SELECT id FROM teams ORDER BY id LIMIT 1').get();
  if (!first) return;
  db.prepare('UPDATE kanban_columns SET team_id = ? WHERE team_id IS NULL').run(first.id);
  db.exec(`UPDATE kanban_cards SET team_id = (
    SELECT t.id FROM projects p JOIN teams t ON t.name = p.team COLLATE NOCASE WHERE p.id = kanban_cards.project_id
  ) WHERE team_id IS NULL AND project_id IS NOT NULL`);
  db.prepare('UPDATE kanban_cards SET team_id = ? WHERE team_id IS NULL').run(first.id);
  // Linked legacy cards must point to a column on their project's team board.
  const misplaced = db.prepare('SELECT c.id, c.team_id AS teamId, k.name FROM kanban_cards c JOIN kanban_columns k ON k.id = c.column_id WHERE c.team_id != k.team_id').all();
  for (const card of misplaced) {
    const target = db.prepare('SELECT id FROM kanban_columns WHERE team_id = ? AND name = ? ORDER BY id LIMIT 1').get(card.teamId, card.name)
      || { id: db.prepare('INSERT INTO kanban_columns (name, position, team_id) VALUES (?, 0, ?)').run(card.name, card.teamId).lastInsertRowid };
    db.prepare('UPDATE kanban_cards SET column_id = ? WHERE id = ?').run(target.id, card.id);
  }
}

function migrateTeamManagerRole(db) {
  if (db.dialect === 'postgres') {
    db.exec('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check');
    db.exec("ALTER TABLE users ADD CONSTRAINT users_role_check CHECK(role IN ('admin', 'team_manager', 'read_only'))");
    return;
  }
  const definition = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'users'").get().sql;
  if (definition.includes("'team_manager'")) return;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    transaction(db, () => db.exec(`
      CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin', 'team_manager', 'read_only')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO users_new SELECT * FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
    `));
  } finally { db.exec('PRAGMA foreign_keys = ON'); }
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

export function databaseConfig(env = process.env) {
  const client = (env.DATABASE_CLIENT || 'sqlite').trim().toLowerCase();
  if (!['sqlite', 'postgres'].includes(client)) throw new Error('DATABASE_CLIENT must be sqlite or postgres.');
  if (client === 'postgres' && !/^postgres(?:ql)?:\/\//.test(env.DATABASE_URL || '')) {
    throw new Error('DATABASE_URL must be a PostgreSQL connection URL when DATABASE_CLIENT=postgres.');
  }
  return { client, connectionString: client === 'postgres' ? env.DATABASE_URL : undefined };
}

export function openDatabase(filePath, { client = 'sqlite', connectionString } = {}) {
  if (client === 'postgres') {
    const db = openPostgresDatabase(connectionString);
    try {
      transaction(db, () => {
        db.exec('CREATE EXTENSION IF NOT EXISTS citext');
        db.exec(projectsTableSql.replace('CREATE TABLE projects', 'CREATE TABLE IF NOT EXISTS projects'));
        createRelatedTables(db);
        backfillKanbanHistory(db);
        migrateTeams(db);
        migrateTeamWorkspace(db);
        migrateTeamManagerRole(db);
        migratePlanningVotes(db);
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_planning_room_projects ON planning_session_projects(session_id, position);
          CREATE INDEX IF NOT EXISTS idx_planning_votes_session_project ON planning_votes(session_id, project_id, updated_at);
          CREATE INDEX IF NOT EXISTS idx_project_moves_project_date ON project_moves(project_id, moved_at DESC, id DESC);
        `);
      }, { lockKey: 'northstar:migrate' });
      return db;
    } catch (error) { db.close(); throw error; }
  }
  if (client !== 'sqlite') throw new Error('Unsupported database client.');
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrateProjects(db);
  createRelatedTables(db);
  backfillKanbanHistory(db);
  migrateTeams(db);
  migrateTeamWorkspace(db);
  migrateTeamManagerRole(db);
  migratePlanningVotes(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_planning_room_projects ON planning_session_projects(session_id, position);
    CREATE INDEX IF NOT EXISTS idx_planning_votes_session_project ON planning_votes(session_id, project_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_project_moves_project_date ON project_moves(project_id, moved_at DESC, id DESC);
    PRAGMA user_version = 7;
    PRAGMA optimize;
  `);
  return db;
}
