import { randomBytes } from 'node:crypto';
import { transaction } from './database.mjs';
import { isFocusProject, validateScores } from './project-domain.mjs';

const adjectives = ['Bright', 'Calm', 'Clever', 'Curious', 'Kind', 'Nimble', 'Quiet', 'Swift'];
const nouns = ['Badger', 'Falcon', 'Fox', 'Otter', 'Panda', 'Raven', 'Tiger', 'Wolf'];

export class PlanningError extends Error {
  constructor(status, message, data = {}) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

function randomName() {
  const bytes = randomBytes(3);
  return `${adjectives[bytes[0] % adjectives.length]} ${nouns[bytes[1] % nouns.length]} ${10 + (bytes[2] % 90)}`;
}

function requireLeader(session, leaderKey) {
  if (!leaderKey || leaderKey !== session.leader_key) throw new PlanningError(403, 'Leader access is required.');
  if (session.status !== 'Open') throw new PlanningError(409, 'This room has already been closed.');
}

function requireOpenProject(db, sessionId, projectId, { revealed = false, closedMessage = 'A decision has already been recorded for this project.' } = {}) {
  const project = db.prepare('SELECT status, revealed FROM planning_session_projects WHERE session_id = ? AND project_id = ?').get(sessionId, projectId);
  if (!project) throw new PlanningError(404, 'Project is not part of this planning room.');
  if (project.status !== 'Open') throw new PlanningError(409, closedMessage);
  if (revealed && !project.revealed) throw new PlanningError(409, 'Reveal the votes before recording a decision.');
  return project;
}

export function createPlanningService(db) {
  function payload(token, voterToken = '') {
    const session = db.prepare(`
      SELECT id, token, status, created_at AS createdAt, decided_at AS decidedAt
      FROM planning_sessions WHERE token = ?
    `).get(token);
    if (!session) return null;
    session.projects = db.prepare(`
      SELECT p.id, p.project_id AS projectCode, p.name, p.description, p.status AS projectStatus,
        p.impact, p.urgency, p.confidence, p.effort, sp.position, sp.status, sp.revealed,
        sp.final_impact AS finalImpact, sp.final_urgency AS finalUrgency,
        sp.final_confidence AS finalConfidence, sp.final_effort AS finalEffort, sp.decided_at AS decidedAt
      FROM planning_session_projects sp JOIN projects p ON p.id = sp.project_id
      WHERE sp.session_id = ? ORDER BY sp.position, p.id
    `).all(session.id);
    session.votes = db.prepare(`
      SELECT v.id, v.project_id AS projectId, v.voter_name AS voterName,
        CASE WHEN sp.revealed = 1 OR v.voter_token = ? THEN v.impact END AS impact,
        CASE WHEN sp.revealed = 1 OR v.voter_token = ? THEN v.urgency END AS urgency,
        CASE WHEN sp.revealed = 1 OR v.voter_token = ? THEN v.confidence END AS confidence,
        CASE WHEN sp.revealed = 1 OR v.voter_token = ? THEN v.effort END AS effort,
        CASE WHEN v.voter_token = ? THEN 1 ELSE 0 END AS isMine, v.updated_at AS updatedAt
      FROM planning_votes v
      JOIN planning_session_projects sp ON sp.session_id = v.session_id AND sp.project_id = v.project_id
      WHERE v.session_id = ? ORDER BY v.updated_at, v.id
    `).all(voterToken, voterToken, voterToken, voterToken, voterToken, session.id);
    session.participantCount = db.prepare('SELECT COUNT(DISTINCT voter_token) AS count FROM planning_votes WHERE session_id = ?').get(session.id).count;
    return session;
  }

  function create(projectIds, { guestAccess = true } = {}) {
    const ids = [...new Set(projectIds.map(Number).filter(Number.isInteger))];
    if (!ids.length || ids.length > 50) throw new PlanningError(400, 'Choose between 1 and 50 projects.');
    const placeholders = ids.map(() => '?').join(',');
    const found = db.prepare(`SELECT id FROM projects WHERE archived = 0 AND id IN (${placeholders})`).all(...ids);
    if (found.length !== ids.length) throw new PlanningError(404, 'One or more projects could not be found.');
    const token = randomBytes(9).toString('base64url');
    const leaderKey = randomBytes(18).toString('base64url');
    transaction(db, () => {
      const session = db.prepare('INSERT INTO planning_sessions (token, leader_key, project_id, guest_access) VALUES (?, ?, ?, ?)').run(token, leaderKey, ids[0], guestAccess ? 1 : 0);
      const insertProject = db.prepare('INSERT INTO planning_session_projects (session_id, project_id, position) VALUES (?, ?, ?)');
      ids.forEach((projectId, position) => insertProject.run(session.lastInsertRowid, projectId, position));
    });
    return { token, leaderKey, guestAccess:Boolean(guestAccess) };
  }

  function find(token) {
    return db.prepare('SELECT * FROM planning_sessions WHERE token = ?').get(token);
  }

  function vote(session, token, input) {
    if (session.status !== 'Open') throw new PlanningError(409, 'Voting has closed for this room.');
    const projectId = Number(input.projectId);
    requireOpenProject(db, session.id, projectId, { closedMessage: 'Voting has closed for this project.' });
    const scores = validateScores(input);
    const voterToken = String(input.voterToken || randomBytes(12).toString('base64url')).slice(0, 80);
    const existing = db.prepare('SELECT voter_name AS voterName FROM planning_votes WHERE session_id = ? AND voter_token = ? LIMIT 1').get(session.id, voterToken);
    const voterName = String(input.voterName || '').trim().slice(0, 50) || existing?.voterName || randomName();
    db.prepare(`
      INSERT INTO planning_votes (session_id, project_id, voter_token, voter_name, impact, urgency, confidence, effort)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, project_id, voter_token) DO UPDATE SET voter_name = excluded.voter_name,
        impact = excluded.impact, urgency = excluded.urgency, confidence = excluded.confidence,
        effort = excluded.effort, updated_at = CURRENT_TIMESTAMP
    `).run(session.id, projectId, voterToken, voterName, scores.impact, scores.urgency, scores.confidence, scores.effort);
    return { voterToken, voterName, room: payload(token, voterToken) };
  }

  function reveal(session, token, input) {
    requireLeader(session, input.leaderKey);
    const projectId = Number(input.projectId);
    requireOpenProject(db, session.id, projectId);
    db.prepare('UPDATE planning_session_projects SET revealed = 1 WHERE session_id = ? AND project_id = ?').run(session.id, projectId);
    return payload(token);
  }

  function decide(session, token, input) {
    requireLeader(session, input.leaderKey);
    const projectId = Number(input.projectId);
    requireOpenProject(db, session.id, projectId, { revealed: true });
    const keepCurrent = input.keepCurrent === true;
    const scores = keepCurrent
      ? db.prepare('SELECT impact, urgency, confidence, effort FROM projects WHERE id = ?').get(projectId)
      : validateScores(input);
    const moveComment = keepCurrent ? '' : String(input.moveComment || '').trim().slice(0, 500);
    const conflictProjectIds = transaction(db, () => {
      db.prepare(`UPDATE planning_session_projects SET status = 'Decided', final_impact = ?, final_urgency = ?, final_confidence = ?, final_effort = ?, move_comment = ?, decided_at = CURRENT_TIMESTAMP WHERE session_id = ? AND project_id = ?`)
        .run(scores.impact, scores.urgency, scores.confidence, scores.effort, moveComment, session.id, projectId);
      const remaining = db.prepare("SELECT COUNT(*) AS count FROM planning_session_projects WHERE session_id = ? AND status = 'Open'").get(session.id).count;
      if (remaining) return [];

      const roomProjects = db.prepare(`
        SELECT p.id, p.team, p.status AS projectStatus, p.archived, p.impact, p.urgency,
          sp.final_impact AS finalImpact, sp.final_urgency AS finalUrgency,
          sp.final_confidence AS finalConfidence, sp.final_effort AS finalEffort,
          sp.move_comment AS moveComment
        FROM planning_session_projects sp JOIN projects p ON p.id = sp.project_id
        WHERE sp.session_id = ? ORDER BY sp.position, p.id
      `).all(session.id);
      const roomScores = new Map(roomProjects.map((project) => [project.id, project]));
      const focusProjects = db.prepare("SELECT id, team, status, archived, impact, urgency FROM projects WHERE archived = 0 AND status != 'Complete'").all()
        .filter((project) => {
          const planned = roomScores.get(project.id);
          return isFocusProject({ ...project, impact: planned?.finalImpact ?? project.impact, urgency: planned?.finalUrgency ?? project.urgency });
        });
      const focusTeams = new Map();
      for (const project of focusProjects) {
        const team = project.team.trim().toLocaleLowerCase();
        if (!focusTeams.has(team)) focusTeams.set(team, []);
        focusTeams.get(team).push(project.id);
      }
      const duplicateTeamIds = [...focusTeams.values()].filter((ids) => ids.length > 1).flat();
      if (duplicateTeamIds.length) {
        const conflicts = duplicateTeamIds.filter((id) => roomScores.has(id));
        if (conflicts.length) {
          const placeholders = conflicts.map(() => '?').join(',');
          db.prepare(`UPDATE planning_session_projects SET status = 'Open', decided_at = NULL WHERE session_id = ? AND project_id IN (${placeholders})`).run(session.id, ...conflicts);
        }
        return conflicts;
      }

      const updateProject = db.prepare('UPDATE projects SET impact = ?, urgency = ?, confidence = ?, effort = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
      const insertMove = db.prepare('INSERT INTO project_moves (project_id, from_impact, from_urgency, to_impact, to_urgency, source, comment) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const project of roomProjects) {
        updateProject.run(project.finalImpact, project.finalUrgency, project.finalConfidence, project.finalEffort, project.id);
        if (project.impact !== project.finalImpact || project.urgency !== project.finalUrgency) {
          insertMove.run(project.id, project.impact, project.urgency, project.finalImpact, project.finalUrgency, 'Planning room', project.moveComment);
        }
      }
      db.prepare("UPDATE planning_sessions SET status = 'Closed', decided_at = CURRENT_TIMESTAMP WHERE id = ?").run(session.id);
      return [];
    });

    const room = payload(token);
    if (conflictProjectIds.length) {
      throw new PlanningError(409, 'Two projects for the same team cannot be placed in Focus Now. Review the highlighted projects and adjust one before completing the room.', { conflictProjectIds, room });
    }
    return room;
  }

  return { create, decide, find, payload, reveal, vote };
}
