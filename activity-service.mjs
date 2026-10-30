export class ActivityError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

// CURRENT_TIMESTAMP columns hold "YYYY-MM-DD HH:MM:SS" (UTC); Kanban history holds ISO strings.
function isoTimestamp(value) {
  const text = String(value || '');
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? `${text.replace(' ', 'T')}.000Z` : text;
}

export function createActivityService(db) {
  function parseQuery({ since, limit } = {}) {
    let sinceIso = '';
    if (since !== undefined && since !== null && since !== '') {
      const parsed = Date.parse(since);
      if (Number.isNaN(parsed)) throw new ActivityError(400, 'since must be an ISO 8601 timestamp.');
      // Whole seconds: most timestamps are stored to the second, so a finer cut could drop events.
      sinceIso = new Date(Math.floor(parsed / 1000) * 1000).toISOString();
    }
    const count = limit === undefined || limit === null || limit === '' ? DEFAULT_LIMIT : Number(limit);
    if (!Number.isInteger(count) || count < 1 || count > MAX_LIMIT) throw new ActivityError(400, `limit must be a whole number from 1 to ${MAX_LIMIT}.`);
    return { sinceIso, sinceSql: sinceIso ? sinceIso.slice(0, 19).replace('T', ' ') : '', count };
  }

  return {
    // Newest first. `since` is inclusive, so a poller re-reads its newest event; dedupe by `id`.
    list(query, { includeHidden = false } = {}) {
      const { sinceIso, sinceSql, count } = parseQuery(query);
      const visible = includeHidden ? '' : 'AND (p.id IS NULL OR p.hidden_from_read_only = 0)';
      const select = (sql, since, ...params) => db.prepare(sql).all(...(since ? [since] : []), ...params, count);
      const after = (column, since) => (since ? `AND ${column} >= ?` : '');

      const projects = select(`
        SELECT p.id, p.id AS projectRef, p.project_id AS projectCode, p.name AS projectName, p.created_at AS at
        FROM projects p WHERE 1 = 1 ${after('p.created_at', sinceSql)} ${visible}
        ORDER BY p.created_at DESC, p.id DESC LIMIT ?
      `, sinceSql).map((row) => ({
        id: `project.created:${row.id}`, type: 'project.created', at: isoTimestamp(row.at),
        projectId: row.projectRef, projectCode: row.projectCode, projectName: row.projectName,
      }));

      const moves = select(`
        SELECT m.id, m.project_id AS projectRef, p.project_id AS projectCode, p.name AS projectName,
          m.from_impact AS fromImpact, m.from_urgency AS fromUrgency, m.to_impact AS toImpact, m.to_urgency AS toUrgency,
          m.source, m.comment, m.moved_at AS at
        FROM project_moves m JOIN projects p ON p.id = m.project_id
        WHERE 1 = 1 ${after('m.moved_at', sinceSql)} ${visible}
        ORDER BY m.moved_at DESC, m.id DESC LIMIT ?
      `, sinceSql).map((row) => ({
        id: `project.moved:${row.id}`, type: 'project.moved', at: isoTimestamp(row.at),
        projectId: row.projectRef, projectCode: row.projectCode, projectName: row.projectName,
        from: { impact: row.fromImpact, urgency: row.fromUrgency }, to: { impact: row.toImpact, urgency: row.toUrgency },
        source: row.source, comment: row.comment,
      }));

      const decisions = select(`
        SELECT sp.session_id AS sessionId, sp.project_id AS projectRef, p.project_id AS projectCode, p.name AS projectName,
          sp.final_impact AS impact, sp.final_urgency AS urgency, sp.final_confidence AS confidence, sp.final_effort AS effort,
          sp.move_comment AS comment, sp.decided_at AS at
        FROM planning_session_projects sp JOIN projects p ON p.id = sp.project_id
        WHERE sp.status = 'Decided' AND sp.decided_at IS NOT NULL ${after('sp.decided_at', sinceSql)} ${visible}
        ORDER BY sp.decided_at DESC, sp.session_id DESC LIMIT ?
      `, sinceSql).map((row) => ({
        id: `planning.decided:${row.sessionId}:${row.projectRef}`, type: 'planning.decided', at: isoTimestamp(row.at),
        projectId: row.projectRef, projectCode: row.projectCode, projectName: row.projectName,
        scores: { impact: row.impact, urgency: row.urgency, confidence: row.confidence, effort: row.effort }, comment: row.comment,
      }));

      const cardMoves = select(`
        SELECT h.id, h.card_id AS cardId, c.title, c.project_id AS projectRef, h.column_id AS columnId, h.column_name AS columnName, h.entered_at AS at,
          EXISTS (SELECT 1 FROM kanban_card_history e WHERE e.card_id = h.card_id AND (e.entered_at < h.entered_at OR (e.entered_at = h.entered_at AND e.id < h.id))) AS moved
        FROM kanban_card_history h JOIN kanban_cards c ON c.id = h.card_id LEFT JOIN projects p ON p.id = c.project_id
        WHERE 1 = 1 ${after('h.entered_at', sinceIso)} ${visible}
        ORDER BY h.entered_at DESC, h.id DESC LIMIT ?
      `, sinceIso).map((row) => {
        const type = row.moved ? 'card.moved' : 'card.created';
        return {
          id: `${type}:${row.id}`, type, at: isoTimestamp(row.at), cardId: row.cardId, title: row.title,
          projectId: row.projectRef ?? null, columnId: row.columnId, columnName: row.columnName,
        };
      });

      const notes = select(`
        SELECT n.id, n.card_id AS cardId, c.title, c.project_id AS projectRef, n.body, n.created_at AS at
        FROM kanban_card_notes n JOIN kanban_cards c ON c.id = n.card_id LEFT JOIN projects p ON p.id = c.project_id
        WHERE 1 = 1 ${after('n.created_at', sinceSql)} ${visible}
        ORDER BY n.created_at DESC, n.id DESC LIMIT ?
      `, sinceSql).map((row) => ({
        id: `card.note:${row.id}`, type: 'card.note', at: isoTimestamp(row.at), cardId: row.cardId, title: row.title,
        projectId: row.projectRef ?? null, body: row.body,
      }));

      const changes = select(`
        SELECT ch.id, ch.project_id AS projectRef, p.project_id AS projectCode, p.name AS projectName,
          ch.field, ch.from_value AS fromValue, ch.to_value AS toValue, ch.note, ch.actor, ch.changed_at AS at
        FROM project_changes ch JOIN projects p ON p.id = ch.project_id
        WHERE 1 = 1 ${after('ch.changed_at', sinceSql)} ${visible}
        ORDER BY ch.changed_at DESC, ch.id DESC LIMIT ?
      `, sinceSql).map((row) => {
        const type = row.field === 'archived' ? (row.toValue === '1' ? 'project.archived' : 'project.restored') : `project.${row.field}`;
        const values = row.field === 'capacity' ? { from: Number(row.fromValue), to: Number(row.toValue) }
          : row.field === 'archived' ? {} : { from: row.fromValue, to: row.toValue };
        return {
          id: `${type}:${row.id}`, type, at: isoTimestamp(row.at),
          projectId: row.projectRef, projectCode: row.projectCode, projectName: row.projectName,
          ...values, note: row.note, actor: row.actor,
        };
      });

      const cardChanges = select(`
        SELECT ch.id, ch.card_id AS cardId, c.title, c.project_id AS projectRef, ch.kind, ch.detail, ch.actor, ch.changed_at AS at
        FROM card_changes ch JOIN kanban_cards c ON c.id = ch.card_id LEFT JOIN projects p ON p.id = c.project_id
        WHERE 1 = 1 ${after('ch.changed_at', sinceSql)} ${visible}
        ORDER BY ch.changed_at DESC, ch.id DESC LIMIT ?
      `, sinceSql).map((row) => {
        const detail = JSON.parse(row.detail || '{}');
        const type = `card.${row.kind}`;
        const fields = row.kind === 'updated' ? { fields: detail.fields }
          : row.kind === 'decided' ? { option: detail.option, by: row.actor }
          : row.kind === 'assigned' ? { from: detail.from, to: detail.to } : {};
        return {
          id: `${type}:${row.id}`, type, at: isoTimestamp(row.at), cardId: row.cardId, title: row.title,
          projectId: row.projectRef ?? null, ...fields, actor: row.actor,
        };
      });

      const items = [...projects, ...moves, ...decisions, ...cardMoves, ...notes, ...changes, ...cardChanges]
        .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.id.localeCompare(a.id)))
        .slice(0, count);
      return { items };
    },
  };
}
