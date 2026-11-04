// Tool definitions. Input schemas mirror the API's own validation so a bad call is refused
// before it is sent; the API remains the authority and its errors are returned as-is.
import { auditBoard, exportBoard, isIdea, resolveColumn, resolveTeam, withStatusLine } from './board.mjs';

const id = { type: 'integer', minimum: 1 };
const score = { type: 'integer', minimum: 1, maximum: 10 };
const text = (maxLength, minLength = 0) => ({ type: 'string', minLength, maxLength });
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const names = (maxItems) => ({ type: 'array', items: text(80, 1), minItems: 1, maxItems });
const fail = (status, message) => Object.assign(new Error(message), { status });
const lower = (value) => String(value ?? '').trim().toLocaleLowerCase();
const day = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', minLength: 10, maxLength: 10 };
const slug = { type: 'string', pattern: '^[a-z0-9]+(?:[_-][a-z0-9]+)*$', minLength: 1, maxLength: 64 };
const reading = object({ key: slug, value: { type: ['number', 'null'] }, note: text(500), rebuilt: { type: 'boolean' } }, ['key', 'value']);
const bullet = object({ text: text(300, 1), metric_key: slug }, ['text']);

// Every team's board, archived cards included: [{ team, columns, cards }].
async function boards(api) {
  const teams = await api.request('GET', '/api/teams');
  return { teams, boards: await Promise.all(teams.map(async (team) => ({ team, ...(await api.request('GET', '/api/kanban', { query: { teamId: team.id, archived: 'include' } })) }))) };
}

// One card by id, key or externalUrl (exactly one of them), on any team, archived or not.
async function findCard(api, { id: cardId, key, externalUrl }) {
  const given = [cardId, key, externalUrl].filter((value) => value !== undefined).length;
  if (given !== 1) throw fail(400, 'Name the card by exactly one of id, key or externalUrl.');
  if (cardId !== undefined) return api.request('GET', `/api/kanban/cards/${cardId}`);
  const found = await api.request('GET', '/api/kanban/cards', { query: { ...(key ? { key } : { externalUrl }), archived: 'include' } });
  if (found.length > 1) throw fail(409, `More than one card has this ${key ? 'key' : 'externalUrl'}; name it by id.`);
  if (!found.length) throw fail(404, 'Card not found.');
  return found[0];
}

export const tools = [
  {
    name: 'list_projects',
    description: 'List projects, optionally filtered by projectId, externalUrl or the Scheduled stage (stage "Idea" lists the ideas).',
    inputSchema: object({ projectId: text(80, 1), externalUrl: text(2048, 1), stage: { type: 'string', enum: ['Idea', 'To plan', 'Planning'] } }),
    run: (api, { stage, ...query }) => api.request('GET', '/api/projects', { query: stage ? { ...query, 'f.stage': stage } : query }),
  },
  {
    name: 'get_project',
    description: 'Get one project by its numeric id.',
    inputSchema: object({ id }, ['id']),
    async run(api, { id: projectId }) {
      const project = (await api.request('GET', '/api/projects')).find((item) => item.id === projectId);
      if (!project) throw Object.assign(new Error('Project not found.'), { status: 404 });
      return project;
    },
  },
  {
    name: 'list_cards',
    description: 'List kanban cards across team boards, filtered by key, externalUrl, projectId, teamId, assignee, tag, source or decision="open". Archived cards are left out unless archived is "include" or "only".',
    inputSchema: object({
      key: text(120, 1), externalUrl: text(2048, 1), projectId: id, teamId: id, assignee: text(80), tag: text(40, 1), source: text(80),
      decision: { type: 'string', enum: ['open'] }, archived: { type: 'string', enum: ['include', 'only'] },
    }),
    async run(api, { assignee, teamId, ...query }) {
      const cards = await api.request('GET', '/api/kanban/cards', { query });
      return cards.filter((card) => (assignee === undefined || card.assignee === assignee) && (teamId === undefined || card.teamId === teamId));
    },
  },
  {
    name: 'get_card_by_key',
    description: 'Get one kanban card by its own stable key (archived cards included).',
    inputSchema: object({ key: text(120, 1) }, ['key']),
    async run(api, { key }) {
      const [card] = await api.request('GET', '/api/kanban/cards', { query: { key, archived: 'include' } });
      if (!card) throw Object.assign(new Error('Card not found.'), { status: 404 });
      return card;
    },
  },
  {
    name: 'get_board',
    description: "A team's kanban board: its columns and cards. Without teamId, the first team's board. team \"all\" returns every board at once: columns merged by name, each card with its teamId and teamName.",
    inputSchema: object({ teamId: id, team: { type: 'string', enum: ['all'] }, archived: { type: 'string', enum: ['include', 'only'] } }),
    run: (api, { team, ...query }) => api.request('GET', '/api/kanban', { query: team === 'all' ? { ...query, teamId: 'all' } : query }),
  },
  {
    name: 'get_activity',
    description: 'Recent project and card events, newest first. since is an ISO 8601 time; limit is 1–500.',
    inputSchema: object({ since: text(64, 1), limit: { type: 'integer', minimum: 1, maximum: 500 } }),
    run: (api, args) => api.request('GET', '/api/activity', { query: args }),
  },
  {
    name: 'list_teams',
    description: 'List teams with capacity, people assigned and project counts.',
    inputSchema: object({}),
    run: (api) => api.request('GET', '/api/teams'),
  },
  {
    name: 'status_export',
    description: 'The project status export as CSV text.',
    inputSchema: object({}),
    run: (api) => api.request('GET', '/api/status-export'),
  },
  {
    name: 'list_views',
    description: "Saved views of the projects table that belong to this token's user: each has a name and the table parameters (search, sort, columns, filters).",
    inputSchema: object({}),
    run: (api) => api.request('GET', '/api/views'),
  },
  {
    name: 'apply_view',
    description: 'The projects a saved view shows, in its order. Name the view by id or by name (any case).',
    inputSchema: object({ id, name: text(80, 1) }),
    async run(api, { id: viewId, name }) {
      if (viewId === undefined && name === undefined) throw Object.assign(new Error('Give the view id or name.'), { status: 400 });
      const view = (await api.request('GET', '/api/views')).find((item) => (viewId !== undefined ? item.id === viewId : item.name.toLocaleLowerCase() === name.toLocaleLowerCase()));
      if (!view) throw Object.assign(new Error('View not found.'), { status: 404 });
      // The stored query string goes on the path as is: repeated filters (f.team=A&f.team=B) must survive.
      const projects = await api.request('GET', `/api/projects${view.params ? `?${view.params}` : ''}`);
      return { view: { id: view.id, name: view.name, params: view.params }, projects };
    },
  },
  {
    name: 'audit_board',
    description: 'Problems across every board, as a list: a Scheduled project (not an idea) with cards in an active column; a project with active cards and no "Status YYYY-MM-DD:" line; a card whose assignee is a known variant (assigneeVariants {"from": "to"}); cards sharing an externalUrl (archived ones included). activeColumns names the columns that count as active.',
    inputSchema: object({ activeColumns: names(20), assigneeVariants: { type: 'object', additionalProperties: text(80) } }, ['activeColumns']),
    async run(api, { activeColumns, assigneeVariants }) {
      const [{ boards: all }, projects] = await Promise.all([boards(api), api.request('GET', '/api/projects')]);
      const problems = auditBoard({ boards: all, projects, activeColumns, assigneeVariants });
      return { problems, count: problems.length };
    },
  },
  {
    name: 'export_board',
    description: 'Every team, column, project and card (archived included) as one JSON document, each list in id order with keys sorted, so two exports diff cleanly in git.',
    inputSchema: object({}),
    async run(api) {
      const [{ teams, boards: all }, projects] = await Promise.all([boards(api), api.request('GET', '/api/projects')]);
      return exportBoard({ teams, boards: all, projects });
    },
  },
  {
    name: 'upsert_project',
    write: true,
    description: 'Create a project, or update the one whose key (projectId or externalUrl) matches. Repeating a call changes nothing.',
    inputSchema: object({ key: { type: 'string', enum: ['projectId', 'externalUrl'] }, project: { type: 'object' } }, ['key', 'project']),
    run: (api, { key, project }) => api.request('PUT', '/api/projects/upsert', { query: { key }, body: project }),
  },
  {
    name: 'move_project',
    write: true,
    description: 'Move a project on the matrix to new impact and urgency scores (1–10), with an optional comment.',
    inputSchema: object({ id, impact: score, urgency: score, comment: text(500) }, ['id', 'impact', 'urgency']),
    run: (api, { id: projectId, impact, urgency, comment }) => api.request('PUT', `/api/projects/${projectId}`, {
      body: { impact, urgency, moveSource: 'MCP', ...(comment === undefined ? {} : { moveComment: comment }) },
    }),
  },
  {
    name: 'upsert_card',
    write: true,
    description: 'Create a kanban card, or update the one whose key matches: its externalUrl (default) or, with key="key", its own card key. Repeating a call changes nothing. Place it with team (name or id) and column (name), or a raw card.columnId; a new card needs both team and column, and a column the team lacks is an error. An existing card stays on its own team.',
    inputSchema: object({ card: { type: 'object' }, key: { type: 'string', enum: ['externalUrl', 'key'] }, team: text(50, 1), column: text(80, 1) }, ['card']),
    async run(api, { card, key, team, column }) {
      if (team === undefined && column === undefined) return api.request('PUT', '/api/kanban/cards/upsert', { query: { key }, body: card });
      if (card.columnId !== undefined) throw fail(400, 'Give the column by name or card.columnId, not both.');
      const value = card[key === 'key' ? 'key' : 'externalUrl'];
      const [existing] = value ? await api.request('GET', '/api/kanban/cards', { query: { [key === 'key' ? 'key' : 'externalUrl']: value, archived: 'include' } }) : [];
      const teams = await api.request('GET', '/api/teams');
      const target = team !== undefined ? resolveTeam(teams, team) : teams.find((item) => item.id === existing?.teamId);
      if (!target) throw fail(400, 'Name the team for a new card.');
      if (existing && existing.teamId !== target.id) {
        throw fail(400, `That card is on ${teams.find((item) => item.id === existing.teamId)?.name ?? 'another team'}'s board; a card stays on its own team.`);
      }
      if (column === undefined) {
        if (!existing) throw fail(400, 'Name the column for a new card.');
        return api.request('PUT', '/api/kanban/cards/upsert', { query: { key }, body: card });
      }
      const { columns } = await api.request('GET', '/api/kanban', { query: { teamId: target.id } });
      const columnId = resolveColumn(columns, column, target.name).id;
      return api.request('PUT', '/api/kanban/cards/upsert', { query: { key }, body: { ...card, columnId } });
    },
  },
  {
    name: 'move_card',
    write: true,
    description: 'Move a card (by id, key or externalUrl) to a column on its own board, by name. With projectStatus, its project gets a dated "Status YYYY-MM-DD: text" line in its description (replacing an older one). A Scheduled project goes Active when the column is not a backlog column (backlogColumns, default ["Backlog"]); an idea stays an idea. project (a projectId) names the project when the card links none or links another.',
    inputSchema: object({
      id, key: text(120, 1), externalUrl: text(2048, 1), column: text(80, 1), projectStatus: text(300, 1), project: text(16, 1),
      backlogColumns: names(20),
    }, ['column']),
    async run(api, { id: cardId, key, externalUrl, column, projectStatus, project, backlogColumns = ['Backlog'] }) {
      const card = await findCard(api, { id: cardId, key, externalUrl });
      const team = (await api.request('GET', '/api/teams')).find((item) => item.id === card.teamId) ?? { id: card.teamId, name: `team ${card.teamId}` };
      const { columns } = await api.request('GET', '/api/kanban', { query: { teamId: card.teamId } });
      const target = resolveColumn(columns, column, team.name);
      let linked = null;
      if (project !== undefined) {
        [linked] = await api.request('GET', '/api/projects', { query: { projectId: project } });
        if (!linked) throw fail(404, `No project with projectId "${project}".`);
      } else if (card.projectId) {
        linked = (await api.request('GET', '/api/projects')).find((item) => item.id === card.projectId) ?? null;
      }
      if (projectStatus !== undefined && !linked) throw fail(400, 'This card links no project; name one with project to record its status.');
      // Everything is checked before anything is written.
      const changes = {};
      if (linked && projectStatus !== undefined) changes.description = withStatusLine(linked.description, projectStatus);
      const working = !backlogColumns.some((name) => lower(name) === lower(target.name));
      if (linked && working && linked.status === 'Scheduled' && !isIdea(linked)) changes.status = 'Active';
      const moved = target.id === card.columnId ? card : await api.request('PUT', `/api/kanban/cards/${card.id}`, { body: { columnId: target.id } });
      if (!linked || !Object.keys(changes).length) return { card: moved, project: linked, projectChanged: [] };
      try {
        const updated = await api.request('PUT', `/api/projects/${linked.id}`, { body: changes });
        return { card: moved, project: updated, projectChanged: Object.keys(changes) };
      } catch (error) {
        throw fail(error.status ?? 0, `The card is in ${target.name}, but its project was not updated: ${error.message}`);
      }
    },
  },
  {
    name: 'archive_card',
    write: true,
    description: 'Archive a kanban card: it leaves the board but keeps its history and can be restored.',
    inputSchema: object({ id }, ['id']),
    run: (api, { id: cardId }) => api.request('PUT', `/api/kanban/cards/${cardId}`, { body: { archived: true } }),
  },
  {
    name: 'restore_card',
    write: true,
    description: 'Restore an archived kanban card to its board.',
    inputSchema: object({ id }, ['id']),
    run: (api, { id: cardId }) => api.request('PUT', `/api/kanban/cards/${cardId}`, { body: { archived: false } }),
  },
  {
    name: 'add_card_note',
    write: true,
    description: 'Add a note to a kanban card.',
    inputSchema: object({ cardId: id, body: text(2000, 1) }, ['cardId', 'body']),
    run: (api, { cardId, body }) => api.request('POST', `/api/kanban/cards/${cardId}/notes`, { body: { body } }),
  },
  {
    name: 'decide_card',
    write: true,
    description: "Record the decided option on a card's decision. The option must be one of the decision's options.",
    inputSchema: object({ id, option: text(200, 1) }, ['id', 'option']),
    async run(api, { id: cardId, option }) {
      const card = await api.request('GET', `/api/kanban/cards/${cardId}`);
      if (!card.decision) throw Object.assign(new Error('This card has no decision to make.'), { status: 409 });
      return api.request('PUT', `/api/kanban/cards/${cardId}`, { body: { decision: { ...card.decision, decidedOption: option } } });
    },
  },
  {
    name: 'set_team',
    write: true,
    description: "Create a team, or set an existing team's capacity (0–9999).",
    inputSchema: object({ name: text(50, 1), capacity: { type: 'integer', minimum: 0, maximum: 9999 } }, ['name', 'capacity']),
    async run(api, { name, capacity }) {
      const team = (await api.request('GET', '/api/teams')).find((item) => item.name.toLowerCase() === name.trim().toLowerCase());
      return team ? api.request('PUT', `/api/teams/${team.id}`, { body: { capacity } }) : api.request('POST', '/api/teams', { body: { name, capacity } });
    },
  },
  {
    name: 'record_metrics',
    write: true,
    description: 'Record one day of metric readings: date (YYYY-MM-DD) and a list of {key, value, note?, rebuilt?}. value is a number, or null when there is no reading. rebuilt=true marks a value worked out later, not read live that day. Each entry replaces the stored one for that date and key; repeating a call changes nothing.',
    inputSchema: object({ date: day, metrics: { type: 'array', items: reading, minItems: 1, maxItems: 1000 } }, ['date', 'metrics']),
    run: (api, body) => api.request('PUT', '/api/progress/metrics', { body }),
  },
  {
    name: 'define_metric',
    write: true,
    description: 'Create or update a metric definition by key. band (momentum, health or trust) places its tile; question is the one line the tile answers; direction (up_good, down_good, neutral) colors its change; startsWhen says when an unmeasured metric starts. Fields left out keep their values.',
    inputSchema: object({
      key: slug, label: text(80, 1), unit: text(20), direction: { type: 'string', enum: ['up_good', 'down_good', 'neutral'] },
      band: { type: 'string', enum: ['momentum', 'health', 'trust'] }, question: text(120), startsWhen: text(120),
      position: { type: 'integer', minimum: 0, maximum: 9999 }, description: text(500),
    }, ['key']),
    run: (api, { key, ...def }) => api.request('PUT', `/api/progress/metric-defs/${encodeURIComponent(key)}`, { body: def }),
  },
  {
    name: 'get_metrics',
    description: 'Metric definitions and readings, filtered by keys and an inclusive from/to date range (YYYY-MM-DD). Readings are sorted by key, then date.',
    inputSchema: object({ keys: { type: 'array', items: slug, minItems: 1, maxItems: 100 }, from: day, to: day }),
    async run(api, { keys, from, to }) {
      const [defs, metrics] = await Promise.all([
        api.request('GET', '/api/progress/metric-defs'),
        api.request('GET', '/api/progress/metrics', { query: { keys: keys?.join(','), from, to } }),
      ]);
      return { defs: keys ? defs.filter((def) => keys.includes(def.key)) : defs, metrics };
    },
  },
  {
    name: 'upsert_report',
    write: true,
    description: "Create or replace the report for a date (YYYY-MM-DD) as Markdown. bullets [{text, metric_key?}] are the day's short explanations; a bullet that names a metric links to its tile. Bullets left out keep the stored ones. Repeating a call changes nothing.",
    inputSchema: object({ date: day, markdown: text(200000, 1), bullets: { type: 'array', items: bullet, maxItems: 50 } }, ['date', 'markdown']),
    run: (api, { date, ...body }) => api.request('PUT', `/api/progress/reports/${date}`, { body }),
  },
  {
    name: 'get_report',
    description: 'The report for one date (YYYY-MM-DD): its Markdown and bullets.',
    inputSchema: object({ date: day }, ['date']),
    run: (api, { date }) => api.request('GET', `/api/progress/reports/${date}`),
  },
  {
    name: 'list_reports',
    description: 'Report dates, newest first, with each title and bullets, in an inclusive from/to range (YYYY-MM-DD).',
    inputSchema: object({ from: day, to: day }),
    run: (api, query) => api.request('GET', '/api/progress/reports', { query }),
  },
  {
    name: 'add_milestone',
    write: true,
    description: 'Mark a milestone on the progress timeline: date (YYYY-MM-DD), label, and optionally the metricKey it belongs to (without one it shows on every chart). A milestone is named by its date and label; repeating a call changes nothing.',
    inputSchema: object({ date: day, label: text(120, 1), metricKey: slug }, ['date', 'label']),
    run: (api, body) => api.request('PUT', '/api/progress/milestones', { body }),
  },
  {
    name: 'list_milestones',
    description: 'Milestones in date order, in an inclusive from/to range (YYYY-MM-DD), optionally only those of one metricKey.',
    inputSchema: object({ from: day, to: day, metricKey: slug }),
    run: (api, query) => api.request('GET', '/api/progress/milestones', { query }),
  },
  {
    name: 'set_needs_you',
    write: true,
    description: 'Choose the board column whose cards the progress page lists under "Needs you": team (name or id) and column (name).',
    inputSchema: object({ team: text(50, 1), column: text(80, 1) }, ['team', 'column']),
    async run(api, { team, column }) {
      const target = resolveTeam(await api.request('GET', '/api/teams'), team);
      const { columns } = await api.request('GET', '/api/kanban', { query: { teamId: target.id } });
      const columnId = resolveColumn(columns, column, target.name).id;
      return api.request('PUT', '/api/progress/settings', { body: { needsYou: { teamId: target.id, columnId } } });
    },
  },
  {
    name: 'get_needs_you',
    description: 'What needs the reader: the count and first three cards of the column set with set_needs_you.',
    inputSchema: object({}),
    run: (api) => api.request('GET', '/api/progress/needs-you'),
  },
  {
    name: 'export_progress',
    description: 'Every metric definition, reading, milestone and report as one JSON document in a stable order with sorted keys, so two exports diff cleanly.',
    inputSchema: object({}),
    run: (api) => api.request('GET', '/api/progress/export'),
  },
];

// Enough of JSON Schema for the shapes above: types (one, or a list such as ["number", "null"]),
// required, enums, patterns, lengths and ranges.
export function validate(schema, value, path = 'arguments') {
  if (Array.isArray(schema.type)) {
    if (value === null && schema.type.includes('null')) return null;
    const errors = schema.type.filter((type) => type !== 'null').map((type) => validate({ ...schema, type }, value, path));
    return errors.includes(null) ? null : errors[0] ?? `${path} must not be null.`;
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return `${path} must be an object.`;
    for (const name of schema.required || []) if (value[name] === undefined) return `${path}.${name} is required.`;
    for (const [name, item] of Object.entries(value)) {
      if (typeof schema.additionalProperties === 'object') {
        const error = validate(schema.properties?.[name] ?? schema.additionalProperties, item, `${path}.${name}`);
        if (error) return error;
        continue;
      }
      if (!schema.properties) continue;
      const property = schema.properties[name];
      if (!property) {
        if (schema.additionalProperties === false) return `${path}.${name} is not a known field.`;
        continue;
      }
      const error = validate(property, item, `${path}.${name}`);
      if (error) return error;
    }
    return null;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return `${path} must be a list.`;
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) return `${path} must have ${schema.minItems ?? 0}–${schema.maxItems} items.`;
    for (const [index, item] of value.entries()) {
      const error = validate(schema.items, item, `${path}[${index}]`);
      if (error) return error;
    }
    return null;
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') return `${path} must be text.`;
    if (schema.enum && !schema.enum.includes(value)) return `${path} must be one of: ${schema.enum.join(', ')}.`;
    if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) return `${path} must be ${schema.minLength ?? 0}–${schema.maxLength} characters.`;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return `${path} does not have the expected form (${schema.pattern}).`;
    return null;
  }
  if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return `${path} must be a number.`;
    return null;
  }
  if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') return `${path} must be true or false.`;
    return null;
  }
  if (schema.type === 'integer') {
    if (!Number.isInteger(value)) return `${path} must be a whole number.`;
    if (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) return `${path} must be from ${schema.minimum} to ${schema.maximum}.`;
    return null;
  }
  return null;
}
