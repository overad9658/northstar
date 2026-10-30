// Tool definitions. Input schemas mirror the API's own validation so a bad call is refused
// before it is sent; the API remains the authority and its errors are returned as-is.

const id = { type: 'integer', minimum: 1 };
const score = { type: 'integer', minimum: 1, maximum: 10 };
const text = (maxLength, minLength = 0) => ({ type: 'string', minLength, maxLength });
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

export const tools = [
  {
    name: 'list_projects',
    description: 'List projects, optionally filtered by projectId or externalUrl.',
    inputSchema: object({ projectId: text(80, 1), externalUrl: text(2048, 1) }),
    run: (api, args) => api.request('GET', '/api/projects', { query: args }),
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
    description: "A team's kanban board: its columns and cards. Without teamId, the first team's board.",
    inputSchema: object({ teamId: id, archived: { type: 'string', enum: ['include', 'only'] } }),
    run: (api, query) => api.request('GET', '/api/kanban', { query }),
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
    description: 'Create a kanban card, or update the one whose key matches: its externalUrl (default) or, with key="key", its own card key. Repeating a call changes nothing.',
    inputSchema: object({ card: { type: 'object' }, key: { type: 'string', enum: ['externalUrl', 'key'] } }, ['card']),
    run: (api, { card, key }) => api.request('PUT', '/api/kanban/cards/upsert', { query: { key }, body: card }),
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
];

// Enough of JSON Schema for the shapes above: types, required, enums, lengths and ranges.
export function validate(schema, value, path = 'arguments') {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return `${path} must be an object.`;
    for (const name of schema.required || []) if (value[name] === undefined) return `${path}.${name} is required.`;
    for (const [name, item] of Object.entries(value)) {
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
  if (schema.type === 'string') {
    if (typeof value !== 'string') return `${path} must be text.`;
    if (schema.enum && !schema.enum.includes(value)) return `${path} must be one of: ${schema.enum.join(', ')}.`;
    if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) return `${path} must be ${schema.minLength ?? 0}–${schema.maxLength} characters.`;
    return null;
  }
  if (schema.type === 'integer') {
    if (!Number.isInteger(value)) return `${path} must be a whole number.`;
    if (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) return `${path} must be from ${schema.minimum} to ${schema.maximum}.`;
    return null;
  }
  return null;
}
