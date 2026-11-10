// Board helpers the tools share: resolving a team and a column by name, the dated status line a
// project's description carries, the board audit and the stable export. Pure functions over what
// the API returns, so they are tested without a server.

const fail = (status, message) => Object.assign(new Error(message), { status });
const same = (a, b) => String(a ?? '').trim().toLocaleLowerCase() === String(b ?? '').trim().toLocaleLowerCase();

// A team named by id (digits) or by name, any case.
export function resolveTeam(teams, team) {
  const wanted = String(team ?? '').trim();
  const found = /^\d+$/.test(wanted) ? teams.find((item) => item.id === Number(wanted)) : teams.find((item) => same(item.name, wanted));
  if (!found) throw fail(404, `No team "${wanted}". Teams: ${teams.map((item) => item.name).join(', ') || 'none'}.`);
  return found;
}

// A column on one team's board by name, any case. Never another team's, never a default.
export function resolveColumn(columns, name, teamName) {
  const found = columns.find((item) => same(item.name, name));
  if (!found) throw fail(404, `${teamName} has no column "${String(name).trim()}". Its columns: ${columns.map((item) => item.name).join(', ') || 'none'}.`);
  return found;
}

export const STATUS_LINE = /^Status \d{4}-\d{2}-\d{2}: .*$/m;
const isStatusLine = (line) => /^Status \d{4}-\d{2}-\d{2}: /.test(line);
export const DESCRIPTION_MAX = 1000;

// The description with one "Status YYYY-MM-DD: text" line: it takes the place of the first older
// one (any others go); without one it goes first, so the API's 1000-character cut never drops it.
export function withStatusLine(description, text, date = new Date()) {
  const line = `Status ${date.toISOString().slice(0, 10)}: ${String(text).replace(/\s+/g, ' ').trim()}`;
  const lines = String(description ?? '').split('\n');
  const first = lines.findIndex(isStatusLine);
  const out = first < 0
    ? [line, ...(lines.join('\n').trim() ? ['', ...lines] : [])].join('\n')
    : lines.flatMap((item, index) => (index === first ? [line] : isStatusLine(item) ? [] : [item])).join('\n');
  if (out.length > DESCRIPTION_MAX) throw fail(400, `The description would be ${out.length} characters with the status line; the limit is ${DESCRIPTION_MAX}. Shorten the status or the description.`);
  return out;
}

export const isIdea = (project) => project.status === 'Scheduled' && project.scheduleStage === 'Idea';

// Problems on the board, as a list. activeColumns names the columns that mean work is under way;
// assigneeVariants maps an assignee spelling to the one it should be ({ "from": "to" }).
// boards: [{ team: { id, name }, columns: [{ id, name }], cards: [...] }] with archived cards in.
export function auditBoard({ boards, projects, activeColumns, assigneeVariants = {} }) {
  const active = new Set(activeColumns.map((name) => String(name).trim().toLocaleLowerCase()));
  const problems = [];
  const cards = boards.flatMap(({ team, columns, cards: teamCards }) => {
    const names = new Map(columns.map((column) => [column.id, column.name]));
    return teamCards.map((card) => ({ ...card, teamId: team.id, teamName: team.name, columnName: names.get(card.columnId) }));
  });
  const live = cards.filter((card) => !card.archived);
  const activeCards = live.filter((card) => active.has(String(card.columnName ?? '').trim().toLocaleLowerCase()));
  const cardRef = (card) => ({ cardId: card.id, key: card.key || null, title: card.title, team: card.teamName, column: card.columnName });
  for (const project of [...projects].sort((a, b) => a.id - b.id)) {
    if (project.archived) continue;
    const working = activeCards.filter((card) => card.projectId === project.id);
    if (!working.length) continue;
    const ref = { projectId: project.id, project: project.projectId || null, name: project.name, cards: working.map(cardRef) };
    if (project.status === 'Scheduled' && !isIdea(project)) problems.push({ problem: 'scheduled_with_active_cards', ...ref, fix: 'Set the project Active, or move its cards out of the active columns.' });
    if (!STATUS_LINE.test(project.description || '')) problems.push({ problem: 'no_status_line', ...ref, fix: 'Add a "Status YYYY-MM-DD: …" line to the project description (move_card projectStatus does).' });
  }
  for (const card of live.sort((a, b) => a.id - b.id)) {
    const to = Object.hasOwn(assigneeVariants, card.assignee ?? '') ? assigneeVariants[card.assignee] : undefined;
    if (to !== undefined && to !== card.assignee) problems.push({ problem: 'assignee_variant', ...cardRef(card), from: card.assignee, to });
  }
  const byUrl = new Map();
  for (const card of cards) if (card.externalUrl) byUrl.set(card.externalUrl, [...(byUrl.get(card.externalUrl) || []), card]);
  for (const [url, dupes] of [...byUrl].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (dupes.length > 1) problems.push({ problem: 'duplicate_external_url', externalUrl: url, cards: dupes.sort((a, b) => a.id - b.id).map((card) => ({ ...cardRef(card), archived: Boolean(card.archived) })) });
  }
  return problems;
}

// Object keys sorted at every level, so the same board always serializes the same way.
export function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  return value;
}

// Teams, their columns, projects and cards (archived included), each list in id order, with no
// derived per-request fields, so a git diff of two exports shows only what changed.
export function exportBoard({ teams, boards, projects }) {
  const byId = (a, b) => a.id - b.id;
  const columns = boards.flatMap(({ team, columns: teamColumns }) => teamColumns.map(({ id, name, position }) => ({ id, teamId: team.id, name, position })));
  const cards = boards.flatMap(({ team, cards: teamCards }) => teamCards.map(({ columnKey, teamName, ...card }) => ({ ...card, teamId: team.id })));
  return sortKeys({
    teams: [...teams].sort(byId).map(({ id, name, capacity }) => ({ id, name, capacity })),
    columns: columns.sort((a, b) => a.teamId - b.teamId || a.position - b.position || a.id - b.id),
    projects: [...projects].sort(byId).map(({ openDecisionCount, score, ...project }) => project),
    cards: cards.sort(byId),
  });
}
