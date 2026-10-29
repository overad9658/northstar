import { transaction } from './database.mjs';
import { ProjectError } from './project-service.mjs';

function validateName(value) {
  const name = String(value || '').trim();
  if (!name || name.length > 50) throw new ProjectError(400, 'Team name must be between 1 and 50 characters.');
  return name;
}

function validateCapacity(value) {
  const capacity = Number(value);
  if (!Number.isInteger(capacity) || capacity < 0 || capacity > 9999) {
    throw new ProjectError(400, 'Team capacity must be a whole number from 0 to 9999.');
  }
  return capacity;
}

export function createTeamService(db) {
  function list({ includeHidden = true } = {}) {
    const visible = includeHidden ? '1 = 1' : 'p.hidden_from_read_only = 0';
    return db.prepare(`
      SELECT t.id, t.name, t.capacity,
        COALESCE(SUM(CASE WHEN ${visible} AND p.archived = 0 AND p.status != 'Complete' THEN p.capacity ELSE 0 END), 0) AS occupied,
        COUNT(CASE WHEN ${visible} THEN p.id END) AS projectCount,
        (SELECT COUNT(*) FROM kanban_cards c WHERE c.team_id = t.id) AS cardCount,
        (SELECT COUNT(*) FROM team_members m WHERE m.team_id = t.id) AS memberCount,
        t.capacity - COALESCE(SUM(CASE WHEN ${visible} AND p.archived = 0 AND p.status != 'Complete' THEN p.capacity ELSE 0 END), 0) AS available
      FROM teams t LEFT JOIN projects p ON p.team = t.name COLLATE NOCASE
      GROUP BY t.id ORDER BY t.name COLLATE NOCASE
    `).all();
  }

  function find(id) {
    return list().find((team) => team.id === id);
  }

  return {
    list,
    members(id) {
      if (!db.prepare('SELECT 1 FROM teams WHERE id = ?').get(id)) throw new ProjectError(404, 'Team not found.');
      return db.prepare('SELECT u.id, u.username, u.role FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ? ORDER BY u.username COLLATE NOCASE').all(id);
    },
    addMember(id, userId) {
      if (!db.prepare('SELECT 1 FROM teams WHERE id = ?').get(id)) throw new ProjectError(404, 'Team not found.');
      const user = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(userId);
      if (!user) throw new ProjectError(404, 'User not found.');
      db.prepare('INSERT OR IGNORE INTO team_members (team_id, user_id) VALUES (?, ?)').run(id, userId);
      return user;
    },
    removeMember(id, userId) {
      if (!db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(id, userId).changes) throw new ProjectError(404, 'Team member not found.');
    },

    create(input) {
      const name = validateName(input.name);
      const capacity = validateCapacity(input.capacity ?? 0);
      try {
        const result = db.prepare('INSERT INTO teams (name, capacity) VALUES (?, ?)').run(name, capacity);
        const id = Number(result.lastInsertRowid);
        return find(id);
      } catch (error) {
        if (String(error.message).includes('UNIQUE')) throw new ProjectError(409, 'A team with that name already exists.');
        throw error;
      }
    },

    update(id, input) {
      const current = db.prepare('SELECT * FROM teams WHERE id = ?').get(id);
      if (!current) throw new ProjectError(404, 'Team not found.');
      const name = input.name === undefined ? current.name : validateName(input.name);
      const capacity = input.capacity === undefined ? current.capacity : validateCapacity(input.capacity);
      const occupied = db.prepare("SELECT COALESCE(SUM(capacity), 0) AS occupied FROM projects WHERE team = ? COLLATE NOCASE AND archived = 0 AND status != 'Complete'").get(current.name).occupied;
      if (capacity < occupied) throw new ProjectError(409, `${current.name} capacity cannot be lower than the ${occupied} people currently assigned.`);
      try {
        transaction(db, () => {
          db.prepare('UPDATE teams SET name = ?, capacity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(name, capacity, id);
          if (name !== current.name) db.prepare('UPDATE projects SET team = ?, updated_at = CURRENT_TIMESTAMP WHERE team = ? COLLATE NOCASE').run(name, current.name);
        });
      } catch (error) {
        if (String(error.message).includes('UNIQUE')) throw new ProjectError(409, 'A team with that name already exists.');
        throw error;
      }
      return find(id);
    },

    delete(id) {
      const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(id);
      if (!team) throw new ProjectError(404, 'Team not found.');
      const projects = db.prepare('SELECT COUNT(*) AS count FROM projects WHERE team = ? COLLATE NOCASE').get(team.name).count;
      if (projects) throw new ProjectError(409, `${team.name} cannot be deleted while it has projects.`);
      if (db.prepare('SELECT COUNT(*) AS count FROM kanban_cards WHERE team_id = ?').get(id).count) throw new ProjectError(409, 'Delete this team’s kanban cards before deleting the team.');
      if (db.prepare('SELECT COUNT(*) AS count FROM teams').get().count === 1) throw new ProjectError(409, 'At least one team must remain configured.');
      db.prepare('DELETE FROM teams WHERE id = ?').run(id);
    },
  };
}
