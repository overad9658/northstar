// Projects table model shared by the browser and the API: the columns, how each one is read,
// and multi-column sorting. Pure functions only, so the same rules apply on both sides.

export const COLUMNS = [
  { id: 'id', label: 'ID', type: 'text', value: (p) => p.projectId || '' },
  { id: 'name', label: 'Name', type: 'text', value: (p) => p.name || '' },
  { id: 'team', label: 'Team', type: 'enum', value: (p) => p.team || '' },
  { id: 'status', label: 'Status', type: 'enum', value: (p) => p.status || '' },
  // A Scheduled project's stage (Idea, To plan, Planning); empty for every other status.
  { id: 'stage', label: 'Stage', type: 'enum', value: (p) => (p.status === 'Scheduled' ? p.scheduleStage || '' : '') },
  { id: 'impact', label: 'Impact', type: 'number', value: (p) => p.impact },
  { id: 'urgency', label: 'Urgency', type: 'number', value: (p) => p.urgency },
  { id: 'confidence', label: 'Confidence', type: 'number', value: (p) => p.confidence },
  { id: 'effort', label: 'Effort', type: 'number', value: (p) => p.effort },
  { id: 'people', label: 'People', type: 'number', value: (p) => p.capacity },
  { id: 'score', label: 'Score', type: 'number', value: (p) => p.score },
  { id: 'cards', label: 'Cards', type: 'number', value: (p) => p.cardCount || 0 },
  { id: 'decisions', label: 'Open decisions', type: 'number', value: (p) => p.openDecisionCount || 0 },
  { id: 'updated', label: 'Updated', type: 'date', value: (p) => p.updatedAt || '' },
];

export const COLUMN_IDS = COLUMNS.map((column) => column.id);
const byId = new Map(COLUMNS.map((column) => [column.id, column]));

export function column(id) {
  return byId.get(id);
}

// Highest priority first, as the list has always been ordered.
export const DEFAULT_SORT = [{ column: 'score', direction: 'desc' }, { column: 'updated', direction: 'desc' }];
// Stage is off by default (the status badge already shows it); it is there to filter and sort by.
export const DEFAULT_COLUMNS = COLUMN_IDS.filter((id) => id !== 'stage');
// Narrow screens start with what fits: name, status and score.
export const MOBILE_COLUMNS = ['name', 'status', 'score'];

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const isEmpty = (value) => value === '' || value === null || value === undefined;

function compareValues(type, a, b) {
  if (type === 'number') return Number(a) - Number(b);
  if (type === 'date') return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
  return collator.compare(String(a), String(b));
}

// sorts: [{ column, direction: 'asc' | 'desc' }], first entry first. Empty values sort last in
// either direction; ties fall back to the project id so the order is stable.
export function sortProjects(projects, sorts = DEFAULT_SORT) {
  const keys = normalizeSorts(sorts).map((sort) => ({ ...sort, def: byId.get(sort.column) }));
  return projects
    .map((project) => ({ project, values: keys.map((key) => key.def.value(project)) }))
    .sort((a, b) => {
      for (let index = 0; index < keys.length; index += 1) {
        const va = a.values[index];
        const vb = b.values[index];
        if (isEmpty(va) || isEmpty(vb)) {
          if (isEmpty(va) !== isEmpty(vb)) return isEmpty(va) ? 1 : -1;
          continue;
        }
        const order = compareValues(keys[index].def.type, va, vb);
        if (order) return keys[index].direction === 'desc' ? -order : order;
      }
      return (a.project.id || 0) - (b.project.id || 0);
    })
    .map((entry) => entry.project);
}

export function normalizeSorts(sorts) {
  const seen = new Set();
  return (Array.isArray(sorts) ? sorts : []).filter((sort) => {
    if (!sort || !byId.has(sort.column) || seen.has(sort.column)) return false;
    seen.add(sort.column);
    return true;
  }).map((sort) => ({ column: sort.column, direction: sort.direction === 'desc' ? 'desc' : 'asc' }));
}

// A header click. Plain click: sort by that column alone, flipping asc/desc if it already leads.
// Shift-click: add it as the next key, flip it if present, keep the rest.
export function toggleSort(sorts, columnId, { add = false } = {}) {
  const current = normalizeSorts(sorts);
  const existing = current.find((sort) => sort.column === columnId);
  const firstDirection = byId.get(columnId)?.type === 'text' || byId.get(columnId)?.type === 'enum' ? 'asc' : 'desc';
  if (!add) {
    if (current.length && current[0].column === columnId) return [{ column: columnId, direction: current[0].direction === 'asc' ? 'desc' : 'asc' }];
    return [{ column: columnId, direction: firstDirection }];
  }
  if (existing) return current.map((sort) => (sort.column === columnId ? { ...sort, direction: sort.direction === 'asc' ? 'desc' : 'asc' } : sort));
  return [...current, { column: columnId, direction: firstDirection }];
}

// "score:desc,name:asc" <-> [{ column, direction }]
export function parseSort(text) {
  if (!text) return [];
  return normalizeSorts(String(text).split(',').map((part) => {
    const [columnId, direction = 'asc'] = part.trim().split(':');
    return { column: columnId, direction };
  }));
}

export function formatSort(sorts) {
  return normalizeSorts(sorts).map((sort) => `${sort.column}:${sort.direction}`).join(',');
}

export function ariaSort(sorts, columnId) {
  const sort = normalizeSorts(sorts).find((item) => item.column === columnId);
  return sort ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none';
}

export function visibleColumns(ids) {
  const wanted = new Set((ids || []).filter((id) => byId.has(id)));
  if (!wanted.size) return COLUMNS.filter((item) => DEFAULT_COLUMNS.includes(item.id));
  return COLUMNS.filter((item) => wanted.has(item.id));
}

// Column filters: { [column]: { contains } | { in: [values] } | { min, max } }. Text columns match
// "contains" (any case), Team and Status match any of the chosen values, numbers and dates keep
// values within min..max (either end optional; dates compare by their YYYY-MM-DD prefix).
export function filterKind(type) {
  return type === 'enum' ? 'in' : type === 'number' || type === 'date' ? 'range' : 'contains';
}

function rangeValue(type, value) {
  if (value === '' || value === null || value === undefined) return null;
  if (type === 'number') { const number = Number(value); return Number.isFinite(number) ? number : null; }
  return String(value).slice(0, 10);
}

export function normalizeFilters(filters) {
  const out = {};
  for (const [columnId, filter] of Object.entries(filters || {})) {
    const def = byId.get(columnId);
    if (!def || !filter || typeof filter !== 'object') continue;
    const kind = filterKind(def.type);
    if (kind === 'contains') {
      const text = String(filter.contains ?? '').trim();
      if (text) out[columnId] = { contains: text };
    } else if (kind === 'in') {
      const values = [...new Set((Array.isArray(filter.in) ? filter.in : []).map((value) => String(value)).filter(Boolean))];
      if (values.length) out[columnId] = { in: values };
    } else {
      const min = rangeValue(def.type, filter.min);
      const max = rangeValue(def.type, filter.max);
      if (min !== null || max !== null) out[columnId] = { ...(min !== null ? { min } : {}), ...(max !== null ? { max } : {}) };
    }
  }
  return out;
}

export function matchesQuery(project, query) {
  const text = String(query || '').trim().toLocaleLowerCase();
  return !text || `${project.projectId || ''} ${project.name || ''} ${project.team || ''} ${project.description || ''} ${project.externalUrl || ''}`.toLocaleLowerCase().includes(text);
}

export function applyFilters(projects, filters, query = '') {
  const active = Object.entries(normalizeFilters(filters)).map(([columnId, filter]) => ({ def: byId.get(columnId), filter }));
  return projects.filter((project) => matchesQuery(project, query) && active.every(({ def, filter }) => {
    const value = def.value(project);
    if (filter.contains !== undefined) return String(value ?? '').toLocaleLowerCase().includes(filter.contains.toLocaleLowerCase());
    if (filter.in) return filter.in.includes(String(value ?? ''));
    const comparable = rangeValue(def.type, value);
    if (comparable === null) return false;
    return (filter.min === undefined || comparable >= filter.min) && (filter.max === undefined || comparable <= filter.max);
  }));
}

// The filter a click on one cell value applies: that exact value.
export function drillFilter(columnId, project) {
  const def = byId.get(columnId);
  if (!def) return null;
  const value = def.value(project);
  if (value === '' || value === null || value === undefined) return null;
  const kind = filterKind(def.type);
  if (kind === 'in') return { in: [String(value)] };
  if (kind === 'range') { const exact = rangeValue(def.type, value); return { min: exact, max: exact }; }
  return { contains: String(value) };
}

// Table state <-> query string, shared by the page URL, saved views and GET /api/projects:
// q=text, sort=score:desc,name:asc, cols=name,score, f.<column>=text | value (repeated) | min..max
export function stateToParams({ query = '', sort = [], columns = [], filters = {} } = {}) {
  const params = new URLSearchParams();
  if (String(query).trim()) params.set('q', String(query).trim());
  const sortText = formatSort(sort);
  if (sortText) params.set('sort', sortText);
  const cols = (columns || []).filter((id) => byId.has(id));
  if (cols.length) params.set('cols', cols.join(','));
  for (const [columnId, filter] of Object.entries(normalizeFilters(filters))) {
    if (filter.contains !== undefined) params.set(`f.${columnId}`, filter.contains);
    else if (filter.in) filter.in.forEach((value) => params.append(`f.${columnId}`, value));
    else params.set(`f.${columnId}`, `${filter.min ?? ''}..${filter.max ?? ''}`);
  }
  return params;
}

export function paramsToState(input) {
  const params = input instanceof URLSearchParams ? input : new URLSearchParams(input || '');
  const filters = {};
  for (const def of COLUMNS) {
    const values = params.getAll(`f.${def.id}`);
    if (!values.length) continue;
    const kind = filterKind(def.type);
    if (kind === 'in') filters[def.id] = { in: values };
    else if (kind === 'contains') filters[def.id] = { contains: values[0] };
    else {
      const [min = '', max = ''] = values[0].includes('..') ? values[0].split('..') : [values[0], values[0]];
      filters[def.id] = { min, max };
    }
  }
  return {
    query: params.get('q') || '',
    sort: parseSort(params.get('sort')),
    columns: (params.get('cols') || '').split(',').filter((id) => byId.has(id)),
    filters: normalizeFilters(filters),
  };
}

// True when the query string carries any table parameter (so the API knows to apply them).
export function hasTableParams(input) {
  const params = input instanceof URLSearchParams ? input : new URLSearchParams(input || '');
  return [...params.keys()].some((key) => key === 'q' || key === 'sort' || key.startsWith('f.'));
}
