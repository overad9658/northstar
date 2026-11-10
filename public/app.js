import {
  $, capacityForTeams, escapeHtml, isFocusProject, needsBlockedNote, requestJson, scoresFromPoint, showToast, syncRangeOutputs,
} from './browser-utils.js';
import { layoutProjectDots } from './matrix-geometry.js';
import { isIdea } from './shared/project-rules.js';
import { liveUpdates } from './live-updates.js';
import { apiTokenDialogState } from './api-token-dialog.js';
import { createDismissGroup } from './dismiss.js';
import {
  emptyTeamBoards,
  findFocusNowOccupant,
  projectLabel,
  projectStatusClass,
  projectStatusLabel,
  selectPortfolioProjects,
} from './portfolio-model.js';
import {
  applyFilters, ariaSort, column as tableColumn, DEFAULT_COLUMNS, DEFAULT_SORT, drillFilter, filterKind, hasTableParams, MOBILE_COLUMNS,
  normalizeFilters, paramsToState, sortProjects, stateToParams, toggleSort, visibleColumns,
} from './shared/project-table.js';

const state = { views: [], sort: DEFAULT_SORT, columns: null, filters: {}, expanded: new Set(), cards: new Map(), user: null, projects: [], teams: [], selectedTeams: [], status: 'All', query: '', showCompleted: false, showIdeas: false, showArchived: false, dragged: null, pendingMove: null, pendingBlockedSave: null, pendingArchiveSave: null };
const matrix = $('#matrix');
const dialog = $('#project-dialog');
const planningSetupDialog = $('#planning-setup-dialog');
const shareDialog = $('#share-dialog');
const historyDialog = $('#history-dialog');
const moveCommentDialog = $('#move-comment-dialog');
const dataDialog = $('#data-dialog');
const apiTokenDialog = $('#api-token-dialog');
const blockedNoteDialog = $('#blocked-note-dialog');
const blockedNoteForm = $('#blocked-note-form');
const archiveNoteDialog = $('#archive-note-dialog');
const archiveNoteForm = $('#archive-note-form');
const form = $('#project-form');
const appMenu = $('#app-menu');
// Every dropdown on the page shares one dismiss behaviour (outside click, Esc, one open at a time).
const menus = createDismissGroup();
['#app-menu', '#team-filter', '#views-menu', '#column-menu'].forEach((selector) => menus.details($(selector)));
const filterMenu = menus.add({
  isOpen: () => !$('#filter-popover').hidden,
  close: () => closeFilterPopover(),
  toggle: () => filterAnchor && $(`[data-filter-open="${filterAnchor}"]`),
  contains: (node) => $('#filter-popover').contains(node) || Boolean(node.closest?.('[data-filter-open]')),
});
const matrixCard = $('#priority-matrix-card');
const projectPreview = $('#project-preview');
let previewHideTimer;
function canEditProject(project) {
  return state.user?.role === 'admin' || (state.user?.role === 'team_manager' && state.teams.some((team) => team.name === project.team && state.user.teamIds.includes(team.id)));
}
function syncTeamFilter() {
  const teams = state.teams.map((team) => team.name);
  state.selectedTeams = state.selectedTeams.filter((team) => teams.includes(team));
  $('#team-filter-label').textContent = !state.selectedTeams.length ? 'All teams' : state.selectedTeams.length === 1 ? state.selectedTeams[0] : `${state.selectedTeams.length} teams`;
  $('#team-filter-menu').innerHTML = `
    <label><input type="checkbox" value="All" ${state.selectedTeams.length ? '' : 'checked'}> All teams</label>
    ${teams.map((team) => `<label><input type="checkbox" value="${escapeHtml(team)}" ${state.selectedTeams.includes(team) ? 'checked' : ''}> ${escapeHtml(team)}</label>`).join('')}`;
  const teamSelect = form.elements.team;
  const currentTeam = teamSelect.value;
  const editableTeams = state.user?.role === 'admin' ? teams : state.teams.filter((team) => state.user?.teamIds?.includes(team.id)).map((team) => team.name);
  const signature = editableTeams.join('\u0000');
  if (teamSelect.dataset.teams !== signature) {
    teamSelect.replaceChildren(...editableTeams.map((team) => new Option(team, team)));
    teamSelect.dataset.teams = signature;
    if (editableTeams.includes(currentTeam)) teamSelect.value = currentTeam;
  }
}

function placeProjectDots(dots) {
  const width = matrix.clientWidth;
  const height = matrix.clientHeight;
  if (!width || !height) return;
  const positions = layoutProjectDots(dots.map(({ dot, project }) => ({
    impact: project.impact,
    urgency: project.urgency,
    width: dot.offsetWidth,
    height: dot.offsetHeight,
  })), width, height);
  dots.forEach(({ dot }, index) => {
    const position = positions[index];
    dot.style.left = `${position.x}px`;
    dot.style.bottom = `${position.y}px`;
  });
}

function positionProjectPreview(dot) {
  const gap = 12;
  const edge = 12;
  const dotRect = dot.getBoundingClientRect();
  const previewRect = projectPreview.getBoundingClientRect();
  let left = dotRect.right + gap;
  if (left + previewRect.width > window.innerWidth - edge) left = dotRect.left - previewRect.width - gap;
  left = Math.max(edge, Math.min(window.innerWidth - previewRect.width - edge, left));
  const top = Math.max(edge, Math.min(window.innerHeight - previewRect.height - edge, dotRect.top + dotRect.height / 2 - previewRect.height / 2));
  projectPreview.style.left = `${left}px`;
  projectPreview.style.top = `${top}px`;
}

function showProjectPreview(project, dot) {
  clearTimeout(previewHideTimer);
  $('#project-preview-title').textContent = project.name;
  $('#project-preview-team').textContent = `Team: ${project.team}`;
  $('#project-preview-meta').textContent = `${project.projectId || projectLabel(project)} · ${projectStatusLabel(project)}`;
  $('#project-preview-cards').textContent = `${project.cardCount || 0} linked ${(project.cardCount || 0) === 1 ? 'card' : 'cards'}`;
  $('#project-preview-context').textContent = project.description || 'No additional context has been added yet.';
  $('#project-preview-scores').textContent = `Impact ${project.impact} · Urgency ${project.urgency} · Score ${project.score}`;
  const source = $('#project-preview-source');
  source.hidden = !project.externalUrl;
  $('#project-preview-no-source').hidden = Boolean(project.externalUrl);
  if (project.externalUrl) source.href = project.externalUrl;
  else source.removeAttribute('href');
  projectPreview.hidden = false;
  projectPreview.dataset.projectId = project.id;
  dot.setAttribute('aria-describedby', 'project-preview');
  requestAnimationFrame(() => positionProjectPreview(dot));
}

function hideProjectPreview(immediate = false) {
  clearTimeout(previewHideTimer);
  const hide = () => {
    projectPreview.hidden = true;
    projectPreview.removeAttribute('data-project-id');
    matrix.querySelector('[aria-describedby="project-preview"]')?.removeAttribute('aria-describedby');
  };
  if (immediate) hide();
  else previewHideTimer = setTimeout(hide, 160);
}

function setSaving(saving) {
  const el = $('#save-status');
  el.classList.toggle('saving', saving);
  el.lastChild.textContent = saving ? ' Saving changes…' : ' All changes saved';
}

function toast(message) {
  showToast(message);
}

function showPlacementError(error) {
  if (error.message.includes('Focus Now')) toast(error.message);
}

async function request(path = '', options) {
  return requestJson(`/api/projects${path}`, options);
}

async function promoteProject(project) {
  try {
    const promoted = await request(`/${project.id}/promote`, { method: 'POST' });
    state.projects = state.projects.map((item) => (item.id === promoted.id ? { ...item, ...promoted } : item));
    render();
    toast(`${project.name} is now a plan`);
  } catch (error) { toast(error.message); }
}

async function load() {
  try {
    state.user = await requestJson('/api/auth/me');
    $('#personal-todos-link').hidden = !state.user.id;
    document.body.classList.toggle('read-only', state.user.role === 'read_only');
    $('#current-user').textContent = `${state.user.username} · ${state.user.role === 'admin' ? 'Admin' : state.user.role === 'team_manager' ? 'Team manager' : 'Team member'}`;
    document.querySelectorAll('[data-admin]').forEach((element) => { element.hidden = state.user.role !== 'admin'; });
    [state.projects, state.teams] = await Promise.all([request(), requestJson('/api/teams')]);
    const teamParam = new URLSearchParams(location.search).get('team');
    if (teamParam && state.teams.some((team) => team.name === teamParam)) state.selectedTeams = [teamParam];
    document.querySelectorAll('[data-project-editor]').forEach((element) => { element.hidden = state.user.role !== 'admin' && !(state.user.role === 'team_manager' && state.user.teamIds.length); });
    $('#empty-add').hidden = state.user.role !== 'admin' && !(state.user.role === 'team_manager' && state.user.teamIds.length);
    loadTablePrefs();
    renderColumnMenu();
    render();
    loadViews();
  } catch (error) {
    toast(error.message);
  }
}

function boardNotice(boards) {
  return boards.map((board) => {
    const cards = `${board.cardCount} ${board.cardCount === 1 ? 'card' : 'cards'}`;
    const subject = boards.length === 1 ? 'This team' : escapeHtml(board.name);
    return `<span class="board-notice">${subject} has ${cards} on its board. <a href="/kanban.html?teamId=${encodeURIComponent(board.id)}">Open the board</a></span>`;
  }).join(' ');
}

function renderSummary(allPortfolioProjects, portfolioProjects, matrixProjects, active) {
  const { total, available } = capacityForTeams(state.teams, allPortfolioProjects, state.selectedTeams);
  $('#active-count').textContent = active.length;
  $('#focus-count').textContent = portfolioProjects.filter(isFocusProject).length;
  $('#team-count').textContent = state.teams.length;
  $('#available-capacity').textContent = available;
  $('#available-capacity').classList.toggle('over-capacity', available < 0);
  $('#selected-capacity').textContent = total;
  $('#empty-state').classList.toggle('hidden', matrixProjects.length > 0);
  const hasAnyProjects = allPortfolioProjects.length > 0;
  $('#matrix-empty-title').textContent = hasAnyProjects ? 'No projects to show' : 'Map your first project';
  $('#matrix-empty-copy').textContent = hasAnyProjects
    ? (portfolioProjects.some((project) => project.status === 'Complete') && !state.showCompleted ? 'Completed projects are hidden. Use “Show completed” above to include them.'
      : portfolioProjects.some(isIdea) && !state.showIdeas ? 'Ideas are hidden. Use “Show ideas” above to include them.' : 'No projects match the current filters.')
    : 'Add current work, score it, and let the trade-offs become visible.';
  $('#empty-add').hidden = hasAnyProjects;
  const boards = emptyTeamBoards(portfolioProjects, state.teams, state.selectedTeams);
  if (boards.length) {
    $('#matrix-empty-title').textContent = 'No projects yet';
    $('#matrix-empty-copy').innerHTML = boardNotice(boards);
  }
}

function renderMatrix(matrixProjects) {
  hideProjectPreview(true);
  matrix.querySelectorAll('.project-dot').forEach((element) => element.remove());
  const dots = matrixProjects.map((project) => {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = `project-dot status-${projectStatusClass(project)}${isIdea(project) ? ' provisional' : ''}`;
    const label = projectLabel(project);
    if (label.length > 2) dot.classList.add('wide-id');
    dot.dataset.id = project.id;
    dot.setAttribute('aria-label', `${label}, ${project.name}. Team: ${project.team}. Impact ${project.impact}, urgency ${project.urgency}. Drag to re-score or press Enter to edit.`);
    dot.title = `${project.team} team`;
    dot.innerHTML = `<b>${escapeHtml(label)}</b><span>${escapeHtml(project.name)}</span>`;
    dot.addEventListener('pointerenter', () => showProjectPreview(project, dot));
    dot.addEventListener('pointerleave', () => hideProjectPreview());
    dot.addEventListener('focus', () => showProjectPreview(project, dot));
    dot.addEventListener('blur', () => hideProjectPreview());
    if (canEditProject(project)) {
      dot.addEventListener('pointerdown', beginDrag);
      dot.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') openDialog(project); });
    }
    matrix.append(dot);
    return { dot, project };
  });
  placeProjectDots(dots);
}

function renderRanking(activeProjects) {
  const ranked = activeProjects.slice().sort((a, b) => b.score - a.score).slice(0, 3);
  $('#ranking').innerHTML = ranked.map((project, index) => `
    <article data-id="${project.id}" tabindex="0" aria-label="Edit ${escapeHtml(project.name)}">
      <div class="rank">${String(index + 1).padStart(2, '0')}</div>
      <div><h3>${escapeHtml(project.name)}</h3><p>${escapeHtml(project.projectId || projectLabel(project))} · ${escapeHtml(project.team)} · Impact ${project.impact}</p></div>
      <strong>${project.score}</strong>
    </article>`).join('');
  $('#ranking-empty').classList.toggle('hidden', ranked.length > 0);
}

const TABLE_PREFS_KEY = 'northstar.projectTable';
const TABLE_PARAMS = ['q', 'sort', 'cols'];

// The URL wins (a shared link or a saved view), then this browser's last table, then defaults.
function loadTablePrefs() {
  const params = new URLSearchParams(location.search);
  if (hasTableParams(params) || params.has('cols')) {
    const fromUrl = paramsToState(params);
    state.query = fromUrl.query;
    $('#search').value = fromUrl.query;
    if (fromUrl.sort.length) state.sort = fromUrl.sort;
    if (fromUrl.columns.length) state.columns = fromUrl.columns;
    state.filters = fromUrl.filters;
  } else {
    try {
      const saved = JSON.parse(localStorage.getItem(TABLE_PREFS_KEY) || '{}');
      if (Array.isArray(saved.sort) && saved.sort.length) state.sort = saved.sort;
      if (Array.isArray(saved.columns) && saved.columns.length) state.columns = saved.columns;
    } catch { /* storage blocked or corrupt: defaults */ }
  }
  if (!state.columns) state.columns = matchMedia('(max-width: 620px)').matches ? MOBILE_COLUMNS : DEFAULT_COLUMNS;
}

function tableState() {
  return { query: state.query, sort: state.sort, columns: state.columns, filters: state.filters };
}

// Mirrors the table in the address bar so the view can be shared; other parameters (team) stay.
function syncTableUrl() {
  const params = new URLSearchParams(location.search);
  [...params.keys()].filter((key) => TABLE_PARAMS.includes(key) || key.startsWith('f.')).forEach((key) => params.delete(key));
  stateToParams(tableState()).forEach((value, key) => params.append(key, value));
  const search = params.toString();
  history.replaceState(null, '', `${location.pathname}${search ? `?${search}` : ''}${location.hash}`);
}

function saveTablePrefs() {
  try { localStorage.setItem(TABLE_PREFS_KEY, JSON.stringify({ sort: state.sort, columns: state.columns })); } catch { /* not persisted */ }
  syncTableUrl();
}

function formatUpdated(value) {
  if (!value) return { iso: '', text: '' };
  const text = String(value);
  const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return { iso: '', text };
  return { iso: date.toISOString(), text: date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) };
}

// A cell value is a button: selecting it filters the table on that value.
function drill(column, html, label) {
  return `<button type="button" class="drill" data-drill="${column.id}" title="Show only ${escapeHtml(label)}">${html}</button>`;
}

function projectCell(project, column) {
  const value = column.value(project);
  switch (column.id) {
    case 'id': return project.projectId ? drill(column, `<small class="project-id">${escapeHtml(project.projectId)}</small>`, project.projectId) : '';
    case 'name': return `${drill(column, `<span class="project-name">${escapeHtml(project.name)}</span>`, project.name)}${project.externalUrl ? `<a class="source-link" data-external-link href="${escapeHtml(project.externalUrl)}" target="_blank" rel="noopener noreferrer" aria-label="Open external source for ${escapeHtml(project.name)}" title="Open external source">↗ Source</a>` : ''}${project.archived ? '<small class="archive-tag">Archived</small>' : ''}${project.status === 'Complete' && project.retrospective ? '<small class="retro-tag">Retrospective</small>' : ''}${project.description ? `<span class="description">${escapeHtml(project.description)}</span>` : ''}`;
    case 'status': return drill(column, `<span class="badge ${projectStatusClass(project)}">${escapeHtml(projectStatusLabel(project))}</span>`, project.status);
    case 'score': return drill(column, `<span class="score${isIdea(project) ? ' provisional' : ''}" title="${isIdea(project) ? 'Provisional score: this is an idea' : 'Priority score'}">${project.score}</span>`, `score ${project.score}`);
    case 'impact': case 'urgency': case 'confidence': case 'effort': return isIdea(project) ? drill(column, `<span class="provisional" title="Provisional: this is an idea">${escapeHtml(String(value))}</span>`, `${column.label} ${value}`) : drill(column, escapeHtml(String(value)), `${column.label} ${value}`);
    case 'updated': { const { iso, text } = formatUpdated(project.updatedAt); return iso ? drill(column, `<time datetime="${iso}">${escapeHtml(text)}</time>`, text) : escapeHtml(text); }
    default: return value === '' || value === null || value === undefined ? '' : drill(column, escapeHtml(String(value)), `${column.label} ${value}`);
  }
}

function renderViews() {
  $('#views-list').innerHTML = state.views.length ? state.views.map((view) => `
    <li><button type="button" class="text-button" data-apply-view="${view.id}">${escapeHtml(view.name)}</button><button type="button" class="icon-button" data-delete-view="${view.id}" aria-label="Delete view ${escapeHtml(view.name)}">×</button></li>`).join('')
    : '<li class="views-empty">No saved views yet.</li>';
}

async function loadViews() {
  try {
    state.views = await requestJson('/api/views');
    $('#views-menu').hidden = false;
    renderViews();
  } catch { $('#views-menu').hidden = true; /* no user to keep views for (development mode) */ }
}

function applyView(view) {
  const next = paramsToState(view.params);
  state.query = next.query;
  $('#search').value = next.query;
  state.sort = next.sort.length ? next.sort : DEFAULT_SORT;
  state.columns = next.columns.length ? next.columns : (matchMedia('(max-width: 620px)').matches ? MOBILE_COLUMNS : DEFAULT_COLUMNS);
  state.filters = next.filters;
  state.expanded.clear();
  saveTablePrefs();
  renderColumnMenu();
  refreshFilterPopover();
  render();
  menus.closeAll();
  toast(`Showing “${view.name}”`);
}

async function saveView(name) {
  const params = stateToParams(tableState()).toString();
  const existing = state.views.find((view) => view.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  const saved = existing
    ? await requestJson(`/api/views/${existing.id}`, { method: 'PUT', body: JSON.stringify({ params }), headers: { 'content-type': 'application/json' } })
    : await requestJson('/api/views', { method: 'POST', body: JSON.stringify({ name, params }), headers: { 'content-type': 'application/json' } });
  state.views = [...state.views.filter((view) => view.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name));
  renderViews();
  toast(existing ? `Updated “${saved.name}”` : `Saved “${saved.name}”`);
}

function renderColumnMenu() {
  const shown = new Set(state.columns);
  $('#column-menu-panel').innerHTML = `<legend>Show columns</legend>${visibleColumns().map((column) => `
    <label><input type="checkbox" value="${column.id}" ${shown.has(column.id) ? 'checked' : ''}> ${escapeHtml(column.label)}</label>`).join('')}
    <button class="text-button" type="button" data-reset-columns>Reset columns</button>`;
}

function filterChoices(column) {
  if (column.id === 'status') return ['Scheduled', 'Active', 'On hold', 'Blocked', 'Complete'];
  return [...new Set([...state.teams.map((team) => team.name), ...state.projects.map((project) => project.team)].filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

// Column filters live in one popover, opened from the filter button in each header.
const filterPopover = $('#filter-popover');
let filterAnchor = null;

function filterControl(column) {
  const filter = state.filters[column.id] || {};
  const kind = filterKind(column.type);
  const label = escapeHtml(column.label);
  const head = `<p class="filter-popover-title" id="filter-popover-title">Filter ${label}</p>`;
  if (kind === 'contains') return `${head}<label class="filter-field"><span>Contains</span><input type="search" data-filter="${column.id}" value="${escapeHtml(filter.contains || '')}" placeholder="Any text"></label>`;
  if (kind === 'in') {
    const chosen = new Set(filter.in || []);
    return `${head}<fieldset class="filter-options"><legend class="sr-only">${label}</legend>
      <div class="filter-bulk"><button type="button" class="text-button" data-filter-all>All</button><button type="button" class="text-button" data-filter-none>None</button></div>
      ${filterChoices(column).map((value) => `<label class="filter-option"><input type="checkbox" data-filter="${column.id}" value="${escapeHtml(value)}" ${chosen.has(value) ? 'checked' : ''}><span>${escapeHtml(value)}</span></label>`).join('')}
      <p class="filter-hint">Nothing checked shows every value.</p></fieldset>`;
  }
  const type = column.type === 'date' ? 'date' : 'number';
  return `${head}<div class="filter-range"><label class="filter-field"><span>Min</span><input type="${type}" data-filter="${column.id}" data-bound="min" value="${escapeHtml(filter.min ?? '')}"></label><span aria-hidden="true">–</span><label class="filter-field"><span>Max</span><input type="${type}" data-filter="${column.id}" data-bound="max" value="${escapeHtml(filter.max ?? '')}"></label></div>`;
}

function positionFilterPopover() {
  const button = filterAnchor && $(`[data-filter-open="${filterAnchor}"]`);
  if (filterPopover.hidden || !button) return;
  const list = $('.project-list').getBoundingClientRect();
  const anchor = button.getBoundingClientRect();
  const width = filterPopover.offsetWidth;
  filterPopover.style.left = `${Math.max(8, Math.min(anchor.right - list.left - width, list.width - width - 8))}px`;
  filterPopover.style.top = `${anchor.bottom - list.top + 6}px`;
}

function openFilterPopover(columnId) {
  filterAnchor = columnId;
  filterPopover.innerHTML = `${filterControl(tableColumn(columnId))}<div class="filter-popover-actions"><button type="button" class="text-button" data-filter-clear>Clear</button><button type="button" class="button secondary" data-filter-done>Done</button></div>`;
  filterPopover.hidden = false;
  menus.opened(filterMenu);
  syncFilterToggles();
  positionFilterPopover();
  filterPopover.querySelector('input')?.focus();
}

function closeFilterPopover() {
  filterPopover.hidden = true;
  syncFilterToggles();
}

// Rebuilds the open popover after its filter changes from elsewhere (a view, a cell, a chip).
function refreshFilterPopover() {
  if (filterPopover.hidden || !filterAnchor) return;
  if (!state.columns.includes(filterAnchor)) { closeFilterPopover(); return; }
  openFilterPopover(filterAnchor);
}

function syncFilterToggles() {
  document.querySelectorAll('[data-filter-open]').forEach((button) => {
    button.setAttribute('aria-expanded', String(!filterPopover.hidden && button.dataset.filterOpen === filterAnchor));
  });
}

function filterSummary(column, filter) {
  if (filter.contains !== undefined) return `${column.label} contains “${filter.contains}”`;
  if (filter.in) return `${column.label}: ${filter.in.join(', ')}`;
  if (filter.min !== undefined && filter.max !== undefined) return filter.min === filter.max ? `${column.label} = ${filter.min}` : `${column.label} ${filter.min}–${filter.max}`;
  return filter.min !== undefined ? `${column.label} ≥ ${filter.min}` : `${column.label} ≤ ${filter.max}`;
}

function renderFilterChips(active) {
  const entries = Object.entries(active);
  $('#filter-chips').hidden = !entries.length;
  $('#filter-chip-list').innerHTML = entries.map(([columnId, filter]) => {
    const text = filterSummary(tableColumn(columnId), filter);
    return `<li><button type="button" class="filter-chip" data-clear-filter="${columnId}" aria-label="Remove filter: ${escapeHtml(text)}" title="${escapeHtml(text)}"><span>${escapeHtml(text)}</span><span aria-hidden="true">×</span></button></li>`;
  }).join('');
}

function setColumnFilter(columnId, filter) {
  state.filters = normalizeFilters({ ...state.filters, [columnId]: filter });
  saveTablePrefs();
  render();
}

function renderCards(project) {
  const cards = state.cards.get(project.id);
  if (!cards) return '<p class="detail-note">Loading linked cards…</p>';
  if (cards.error) return `<p class="detail-note">${escapeHtml(cards.error)}</p>`;
  if (!cards.length) return '<p class="detail-note">No linked cards.</p>';
  return `<ul class="linked-cards">${cards.map((card) => {
    const open = card.decision && !card.decision.decidedOption;
    return `<li><a href="/kanban.html?teamId=${encodeURIComponent(card.teamId)}">${escapeHtml(card.title)}</a>
      <span class="card-meta">${escapeHtml(card.columnName || '')}${card.assignee ? ` · ${escapeHtml(card.assignee)}` : ''}</span>
      ${open ? `<span class="badge blocked">Decision open: ${escapeHtml(card.decision.options.join(' / '))}${card.decision.recommendation ? ` (recommend ${escapeHtml(card.decision.recommendation)})` : ''}</span>` : ''}</li>`;
  }).join('')}</ul>`;
}

async function loadCards(project) {
  try {
    const cards = await requestJson(`/api/kanban/cards?projectId=${project.id}`);
    state.cards.set(project.id, cards);
  } catch (error) {
    state.cards.set(project.id, { error: error.message });
  }
  if (state.expanded.has(project.id)) render();
}

function toggleExpanded(project) {
  if (state.expanded.has(project.id)) state.expanded.delete(project.id);
  else {
    state.expanded.add(project.id);
    if (!state.cards.has(project.id)) loadCards(project);
  }
  render();
  document.querySelector(`.project-row[data-id="${project.id}"]`)?.focus();
}

function renderProjectList(projects, boards = []) {
  $('#project-list-title').textContent = !state.selectedTeams.length ? 'All projects' : `${state.selectedTeams.join(', ')} projects`;
  const columns = visibleColumns(state.columns);
  const shown = sortProjects(applyFilters(projects, state.filters), state.sort);
  const activeFilters = normalizeFilters(state.filters);
  const filtered = Object.keys(activeFilters).length;
  $('#list-count').textContent = `${shown.length} ${shown.length === 1 ? 'project' : 'projects'}${filtered ? ` of ${projects.length}` : ''}`;
  renderFilterChips(activeFilters);
  $('#project-table-head').innerHTML = `${columns.map((column) => {
    const order = state.sort.findIndex((sort) => sort.column === column.id);
    const sort = ariaSort(state.sort, column.id);
    const mark = sort === 'none' ? '' : `<span class="sort-mark" aria-hidden="true">${sort === 'ascending' ? '▲' : '▼'}${state.sort.length > 1 ? `<sub>${order + 1}</sub>` : ''}</span>`;
    const active = Boolean(activeFilters[column.id]);
    const open = !filterPopover.hidden && filterAnchor === column.id;
    return `<th scope="col" class="col-${column.id} ${column.type === 'number' ? 'numeric' : ''}" aria-sort="${sort}"><div class="th-inner"><button type="button" data-sort-column="${column.id}">${escapeHtml(column.label)}${mark}</button><button type="button" class="filter-toggle${active ? ' active' : ''}" data-filter-open="${column.id}" aria-haspopup="dialog" aria-controls="filter-popover" aria-expanded="${open}" aria-label="Filter ${escapeHtml(column.label)}${active ? ' (filtered)' : ''}" title="Filter ${escapeHtml(column.label)}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11l-4.25 5v4l-2.5 1.25V8.5z"></path></svg></button></div></th>`;
  }).join('')}<th scope="col" class="col-actions"><span class="sr-only">Actions</span></th>`;
  $('#project-table-body').innerHTML = shown.map((project) => {
    const expanded = state.expanded.has(project.id);
    return `
    <tr class="project-row ${project.archived ? 'archived' : ''}" data-id="${project.id}" tabindex="0" aria-expanded="${expanded}">
      ${columns.map((column) => `<td class="col-${column.id} ${column.type === 'number' ? 'numeric' : ''}">${projectCell(project, column)}</td>`).join('')}
      <td class="col-actions">${canEditProject(project) ? `${isIdea(project) ? `<button type="button" class="button" data-promote-project aria-label="Promote ${escapeHtml(project.name)} to plan">Promote to plan</button>` : ''}<button type="button" class="button" data-edit-project aria-label="Edit ${escapeHtml(project.name)}">Edit</button>` : ''}</td>
    </tr>${expanded ? `<tr class="project-detail" data-detail-for="${project.id}"><td colspan="${columns.length + 1}">${renderCards(project)}</td></tr>` : ''}`;
  }).join('');
  $('#project-table').hidden = !shown.length && !filtered;
  $('#project-table-empty').hidden = shown.length > 0;
  positionFilterPopover();
  if (boards.length) $('#project-table-empty').innerHTML = boardNotice(boards);
  else $('#project-table-empty').textContent = 'No projects match this view.';
}

function render() {
  syncTeamFilter();
  const teamView = state.selectedTeams.length === 1 ? state.selectedTeams[0] : null;
  $('.intro .eyebrow').textContent = teamView ? `${teamView} team view` : 'Portfolio view';
  $('.matrix-head h2').textContent = teamView ? `${teamView} priority matrix` : 'Priority matrix';
  const {
    visible: projects,
    portfolio: allPortfolioProjects,
    selectedPortfolio: portfolioProjects,
    matrix: matrixProjects,
    active,
  } = selectPortfolioProjects(state.projects, state);
  renderSummary(allPortfolioProjects, portfolioProjects, matrixProjects, active);
  renderMatrix(matrixProjects);
  renderRanking(active);
  renderProjectList(projects, emptyTeamBoards(portfolioProjects, state.teams, state.selectedTeams));
}
function projectFromTarget(target) {
  const row = target.closest('[data-id]');
  return row && state.projects.find((project) => project.id === Number(row.dataset.id));
}

function openDialog(project = null) {
  if (project && !canEditProject(project)) return;
  if (!project && state.user?.role !== 'admin' && !state.user?.teamIds?.length) { toast('Join a team before creating a project.'); return; }
  if (!project && !state.teams.length) {
    toast('Add a team before creating a project.');
    location.href = '/teams.html';
    return;
  }
  form.reset();
  form.classList.toggle('editing', Boolean(project));
  form.classList.toggle('archived-project', Boolean(project?.archived));
  $('#dialog-kicker').textContent = project ? 'Edit project' : 'New project';
  $('#dialog-title').textContent = project ? project.name : 'Add to the matrix';
  $('#project-dialog-card-count').hidden = !project;
  $('#project-dialog-card-count').textContent = project ? `${project.cardCount || 0} linked ${(project.cardCount || 0) === 1 ? 'card' : 'cards'} on the kanban board` : '';
  $('#form-error').textContent = '';
  form.elements.id.value = project?.id || '';
  form.elements.moveComment.value = '';
  if (project) {
    for (const key of ['projectId', 'externalUrl', 'name', 'team', 'status', 'scheduleStage', 'capacity', 'description', 'retrospective', 'impact', 'urgency', 'confidence', 'effort']) form.elements[key].value = project[key] ?? '';
    form.elements.hiddenFromReadOnly.checked = Boolean(project.hiddenFromReadOnly);
    $('#archive-project').textContent = project.archived ? 'Restore project' : 'Archive project';
    $('#start-planning').disabled = Boolean(project.archived) || project.status === 'Complete';
  } else {
    Object.assign(form.elements, {});
    const editable = state.teams.filter((team) => state.user.role === 'admin' || state.user.teamIds.includes(team.id));
    form.elements.team.value = editable.some((team) => team.name === state.selectedTeams[0]) ? state.selectedTeams[0] : editable[0]?.name || '';
    form.elements.status.value = 'Active';
    form.elements.scheduleStage.value = 'To plan';
    form.elements.capacity.value = 0;
    form.elements.retrospective.value = '';
    form.elements.hiddenFromReadOnly.checked = false;
    form.elements.impact.value = 7;
    form.elements.urgency.value = 7;
    form.elements.confidence.value = 7;
    form.elements.effort.value = 5;
  }
  syncOutputs();
  syncProjectFields();
  $('#start-planning').hidden = state.user.role !== 'admin';
  dialog.showModal();
  requestAnimationFrame(() => form.elements.name.focus());
}

function syncOutputs() {
  syncRangeOutputs(form);
}

function syncProjectFields() {
  $('#retrospective-field').hidden = form.elements.status.value !== 'Complete';
  const isScheduled = form.elements.status.value === 'Scheduled';
  $('#scheduled-stage-field').hidden = !isScheduled;
  const capacityLocked = isScheduled && form.elements.scheduleStage.value !== 'Planning';
  form.elements.capacity.readOnly = capacityLocked;
  form.elements.capacity.setAttribute('aria-disabled', String(capacityLocked));
  $('#capacity-field').classList.toggle('capacity-locked', capacityLocked);
  $('#capacity-help').textContent = capacityLocked ? 'Available once this project reaches Planning' : 'Counts against team capacity';
  if (capacityLocked) form.elements.capacity.value = 0;
}

async function saveProject(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  data.hiddenFromReadOnly = form.elements.hiddenFromReadOnly.checked;
  const id = data.id;
  delete data.id;
  data.moveSource = 'Project edit';
  for (const key of ['impact', 'urgency', 'confidence', 'effort', 'capacity']) data[key] = Number(data[key]);
  const current = state.projects.find((project) => project.id === Number(id));
  if (needsBlockedNote(current?.status, data.status)) {
    state.pendingBlockedSave = { data, id };
    blockedNoteForm.reset();
    $('#blocked-note-error').textContent = '';
    blockedNoteDialog.showModal();
    requestAnimationFrame(() => $('#blocked-note-input').focus());
    return;
  }
  await persistProject(data, id);
}

async function persistProject(data, id) {
  setSaving(true);
  try {
    const saved = await request(id ? `/${id}` : '', { method: id ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
    const index = state.projects.findIndex((project) => project.id === saved.id);
    if (index >= 0) state.projects[index] = saved; else state.projects.push(saved);
    state.projects.sort((a, b) => b.score - a.score);
    render();
    dialog.close();
    toast(id ? 'Project updated' : 'Project added');
  } catch (error) { $('#form-error').textContent = error.message; showPlacementError(error); }
  finally { setSaving(false); }
}

async function saveBlockedProject(event) {
  event.preventDefault();
  const pending = state.pendingBlockedSave;
  if (!pending) return blockedNoteDialog.close();
  const blockedNote = $('#blocked-note-input').value.trim();
  if (!blockedNote) { $('#blocked-note-error').textContent = 'Add a note before moving this project to Blocked.'; return; }
  state.pendingBlockedSave = null;
  blockedNoteDialog.close();
  await persistProject({ ...pending.data, blockedNote }, pending.id);
}

function cancelBlockedSave() {
  state.pendingBlockedSave = null;
  blockedNoteDialog.close();
}

function formatMoveDate(value) {
  const date = new Date(`${String(value).replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle:'medium', timeStyle:'short' }).format(date);
}

async function viewHistory() {
  const id = Number(form.elements.id.value);
  const project = state.projects.find((item) => item.id === id);
  if (!project) return;
  $('#history-title').textContent = `${project.name} moves`;
  $('#history-copy').textContent = 'Impact and urgency changes are listed newest first.';
  $('#move-history').innerHTML = '<p class="move-empty">Loading move history…</p>';
  dialog.close();
  historyDialog.showModal();
  try {
    const moves = await request(`/${id}/moves`);
    $('#move-history').innerHTML = moves.length ? moves.map((move) => `
      <article class="move-entry">
        <header><strong>I ${move.fromImpact} · U ${move.fromUrgency} → I ${move.toImpact} · U ${move.toUrgency}</strong><time datetime="${escapeHtml(move.movedAt)}">${escapeHtml(formatMoveDate(move.movedAt))}</time></header>
        <p>${escapeHtml(move.source)}</p>
        ${move.comment ? `<p class="move-comment">${escapeHtml(move.comment)}</p>` : ''}
      </article>`).join('') : '<p class="move-empty">No position changes have been recorded for this project yet.</p>';
  } catch (error) { $('#move-history').innerHTML = `<p class="move-empty">${escapeHtml(error.message)}</p>`; }
}

async function deleteProject() {
  const id = Number(form.elements.id.value);
  const project = state.projects.find((item) => item.id === id);
  if (!project || !confirm(`Are you sure you want to permanently delete “${project.name}”? Its planning-room history will also be removed. This cannot be undone.`)) return;
  setSaving(true);
  try {
    await request(`/${id}`, { method: 'DELETE' });
    state.projects = state.projects.filter((item) => item.id !== id);
    render(); dialog.close(); toast('Project deleted');
  } catch (error) { $('#form-error').textContent = error.message; }
  finally { setSaving(false); }
}

async function toggleArchiveProject() {
  const id = Number(form.elements.id.value);
  const project = state.projects.find((item) => item.id === id);
  if (!project) return;
  const restoring = Boolean(project.archived);
  state.pendingArchiveSave = { id, project, archived: !restoring };
  archiveNoteForm.reset();
  $('#archive-note-kicker').textContent = restoring ? 'Restore project' : 'Archive project';
  $('#archive-note-title').textContent = restoring ? 'Why is this project being restored?' : 'Why is this project being archived?';
  $('#archive-note-copy').textContent = restoring
    ? 'Add a note explaining why this project is returning to the active portfolio.'
    : 'Add a note explaining why this project is leaving the active portfolio.';
  $('#archive-note-project').textContent = `${project.name} · Team: ${project.team}`;
  $('#archive-note-label').textContent = restoring ? 'Restore note' : 'Archive note';
  $('#archive-note-input').placeholder = restoring ? 'Describe why work is resuming' : 'Describe why this project is being archived';
  $('#archive-note-submit').textContent = restoring ? 'Restore project' : 'Archive project';
  $('#archive-note-error').textContent = '';
  archiveNoteDialog.showModal();
  requestAnimationFrame(() => $('#archive-note-input').focus());
}

async function saveArchiveProject(event) {
  event.preventDefault();
  const pending = state.pendingArchiveSave;
  if (!pending) return archiveNoteDialog.close();
  const note = $('#archive-note-input').value.trim();
  const action = pending.archived ? 'archiving' : 'restoring';
  if (!note) { $('#archive-note-error').textContent = `Add a note before ${action} this project.`; return; }
  setSaving(true);
  try {
    const noteField = pending.archived ? 'archiveNote' : 'restoreNote';
    const saved = await request(`/${pending.id}`, { method:'PUT', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ archived:pending.archived, [noteField]:note }) });
    state.projects[state.projects.findIndex((item) => item.id === pending.id)] = saved;
    state.pendingArchiveSave = null;
    render(); archiveNoteDialog.close(); dialog.close(); toast(saved.archived ? 'Project archived' : 'Project restored');
  } catch (error) { $('#archive-note-error').textContent = error.message; }
  finally { setSaving(false); }
}

function cancelArchiveSave() {
  state.pendingArchiveSave = null;
  archiveNoteDialog.close();
}

function openPlanningSetup(currentProjectId = null) {
  const eligible = state.projects.filter((project) => !project.archived && project.status !== 'Complete');
  if (!eligible.length) {
    toast('Add an active project before starting a planning room.');
    return;
  }
  $('#planning-projects').innerHTML = eligible.map((project) => `
    <label class="planning-project-option">
      <input type="checkbox" name="projectId" value="${project.id}" ${project.id === currentProjectId ? 'checked' : ''}>
      <span><b>${project.projectId ? `${escapeHtml(project.projectId)} · ` : ''}${escapeHtml(project.name)}</b><small>${escapeHtml(projectStatusLabel(project))} · Impact ${project.impact} · Urgency ${project.urgency}</small></span>
    </label>`).join('');
  $('#planning-error').textContent = '';
  dialog.close();
  planningSetupDialog.showModal();
}

function startPlanningRoom() {
  const currentProjectId = Number(form.elements.id.value);
  if (currentProjectId) openPlanningSetup(currentProjectId);
}

async function createPlanningRoom(event) {
  event.preventDefault();
  const projectIds = new FormData(event.currentTarget).getAll('projectId').map(Number);
  const guestAccess = event.currentTarget.elements.guestAccess.checked;
  if (!projectIds.length) { $('#planning-error').textContent = 'Choose at least one project.'; return; }
  const submit = event.currentTarget.querySelector('button[type="submit"]');
  submit.disabled = true;
  setSaving(true);
  try {
    const room = await requestJson('/api/planning-sessions', { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ projectIds, guestAccess }) }, 'The planning room could not be created.');
    const participantUrl = `${location.origin}/session.html?room=${encodeURIComponent(room.token)}`;
    const leaderUrl = `${participantUrl}&leader=${encodeURIComponent(room.leaderKey)}`;
    $('#share-link').value = participantUrl;
    $('#share-link-label').textContent = room.guestAccess ? 'Guest participant link · no login required' : 'Participant link · sign-in required';
    $('#share-access-copy').textContent = room.guestAccess
      ? 'Anyone with this link can join and score the selected projects without a Northstar account.'
      : 'Only signed-in Northstar users can open this participant link.';
    $('#open-leader-room').href = leaderUrl;
    planningSetupDialog.close();
    shareDialog.showModal();
  } catch (error) { $('#planning-error').textContent = error.message; }
  finally { setSaving(false); submit.disabled = false; }
}

async function copyShareLink() {
  const input = $('#share-link');
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    input.select();
    document.execCommand('copy');
  }
  toast('Participant link copied');
}

async function copyText(input, message) {
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    input.select();
    document.execCommand('copy');
  }
  toast(message);
}

function applyApiTokenState(state) {
  for (const [name, visible] of Object.entries(state.buttons)) $(`#${name}-api-token`).hidden = !visible;
  if (state.generateLabel) $('#generate-api-token').textContent = state.generateLabel;
  $('#api-token-explanation').textContent = state.explanation;
  $('#api-token-explanation').hidden = !state.explanation;
  $('#api-token-result').hidden = !state.buttons.copy;
}

async function openApiTokenDialog() {
  $('#api-token-value').value = '';
  $('#api-token-error').textContent = '';
  $('#api-token-status').textContent = 'Checking token status…';
  applyApiTokenState(apiTokenDialogState());
  apiTokenDialog.showModal();
  try {
    const status = await requestJson('/api/api-token', undefined, 'Token status could not be loaded.');
    $('#api-token-status').textContent = status.configured
      ? status.managed ? 'A UI-generated token is active.' : 'An environment-configured token is active.'
      : 'No API token is active.';
    applyApiTokenState(apiTokenDialogState({ configured: status.configured }));
  } catch (error) { $('#api-token-error').textContent = error.message; }
}

async function generateApiToken() {
  const button = $('#generate-api-token');
  button.disabled = true;
  $('#api-token-error').textContent = '';
  try {
    const result = await requestJson('/api/api-token', { method:'POST' }, 'The API token could not be generated.');
    $('#api-token-value').value = result.token;
    const state = apiTokenDialogState({ created: true });
    applyApiTokenState(state);
    $('#api-token-status').textContent = state.status;
    requestAnimationFrame(() => { $('#copy-api-token').focus(); $('#api-token-value').select(); });
  } catch (error) { $('#api-token-error').textContent = error.message; }
  finally { button.disabled = false; }
}

function syncRestoreButton() {
  $('#restore-backup').disabled = !$('#backup-file').files.length || !$('#restore-confirm').checked;
}

function openDataDialog() {
  $('#restore-form').reset();
  $('#restore-error').textContent = '';
  syncRestoreButton();
  dataDialog.showModal();
}

async function restoreData(event) {
  event.preventDefault();
  const file = $('#backup-file').files[0];
  if (!file || !$('#restore-confirm').checked) return;
  const submit = $('#restore-backup');
  submit.disabled = true;
  setSaving(true);
  $('#restore-error').textContent = '';
  try {
    const result = await requestJson('/api/backup', { method:'POST', headers:{ 'content-type':'application/json' }, body:await file.text() }, 'The backup could not be restored.');
    state.status = 'All'; state.selectedTeams = []; state.query = ''; state.showCompleted = false; state.showArchived = false;
    $('#search').value = ''; $('#show-completed').checked = false; $('#show-archived').checked = false;
    document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.status === 'All'));
    await load();
    dataDialog.close();
    toast(`Restored ${result.restored.projects} ${result.restored.projects === 1 ? 'project' : 'projects'}`);
  } catch (error) { $('#restore-error').textContent = error.message; }
  finally { setSaving(false); syncRestoreButton(); }
}

function beginDrag(event) {
  hideProjectPreview(true);
  const dot = event.currentTarget;
  const project = state.projects.find((item) => item.id === Number(dot.dataset.id));
  state.dragged = { dot, project, startX: event.clientX, startY: event.clientY, moved: false };
  dot.setPointerCapture(event.pointerId);
  dot.addEventListener('pointermove', moveDrag);
  dot.addEventListener('pointerup', endDrag, { once: true });
  dot.addEventListener('pointercancel', cancelDrag, { once: true });
}

function moveDrag(event) {
  if (!state.dragged) return;
  const rect = matrix.getBoundingClientRect();
  const x = Math.max(0.05, Math.min(0.95, (event.clientX - rect.left) / rect.width));
  const y = Math.max(0.05, Math.min(0.95, (rect.bottom - event.clientY) / rect.height));
  state.dragged.moved ||= Math.hypot(event.clientX - state.dragged.startX, event.clientY - state.dragged.startY) > 5;
  if (state.dragged.moved) {
    state.dragged.dot.classList.add('dragging');
    state.dragged.dot.style.left = `${x * 100}%`;
    state.dragged.dot.style.bottom = `${y * 100}%`;
  }
}

async function endDrag(event) {
  const dragged = state.dragged;
  if (!dragged) return;
  dragged.dot.removeEventListener('pointermove', moveDrag);
  dragged.dot.classList.remove('dragging');
  state.dragged = null;
  if (!dragged.moved) return openDialog(dragged.project);
  const rect = matrix.getBoundingClientRect();
  const { urgency, impact } = scoresFromPoint(rect, event.clientX, event.clientY);
  if (impact === dragged.project.impact && urgency === dragged.project.urgency) return render();
  const focusProject = findFocusNowOccupant(state.projects, dragged.project, impact, urgency);
  if (focusProject) {
    render();
    toast(`${dragged.project.team} already has ${focusProject.name} in Focus Now. Move it out first.`);
    return;
  }
  state.pendingMove = { project: dragged.project, impact, urgency };
  $('#move-comment-title').textContent = `Move ${dragged.project.name}`;
  $('#move-comment-copy').textContent = `Impact ${dragged.project.impact} → ${impact} · Urgency ${dragged.project.urgency} → ${urgency}`;
  $('#move-comment-input').value = '';
  $('#move-comment-error').textContent = '';
  moveCommentDialog.showModal();
  requestAnimationFrame(() => $('#move-comment-input').focus());
}

function cancelPendingMove() {
  state.pendingMove = null;
  moveCommentDialog.close();
  render();
}

async function savePendingMove(event) {
  event.preventDefault();
  const pending = state.pendingMove;
  if (!pending) return cancelPendingMove();
  const moveComment = $('#move-comment-input').value.trim();
  const submit = event.currentTarget.querySelector('button[type="submit"]');
  submit.disabled = true;
  setSaving(true);
  try {
    const updated = await request(`/${pending.project.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ impact:pending.impact, urgency:pending.urgency, moveSource:'Matrix drag', moveComment }) });
    state.projects[state.projects.findIndex((p) => p.id === updated.id)] = updated;
    state.projects.sort((a, b) => b.score - a.score);
    state.pendingMove = null;
    moveCommentDialog.close();
    render(); toast(`Moved to impact ${pending.impact}, urgency ${pending.urgency}`);
  } catch (error) { $('#move-comment-error').textContent = error.message; showPlacementError(error); }
  finally { setSaving(false); submit.disabled = false; }
}

function cancelDrag() { if (state.dragged) { state.dragged.dot.classList.remove('dragging'); state.dragged = null; render(); } }

function setMatrixPresentation(active) {
  const button = $('#toggle-matrix-presentation');
  matrixCard.classList.toggle('presenting', active);
  document.body.classList.toggle('matrix-presenting', active);
  button.setAttribute('aria-pressed', String(active));
  button.setAttribute('aria-label', active ? 'Exit priority matrix presentation' : 'Expand priority matrix for presentation');
  button.querySelector('span').textContent = active ? 'Exit presentation' : 'Present';
  requestAnimationFrame(render);
}

$('#add-project').addEventListener('click', () => {
  appMenu.open = false;
  openDialog();
});
$('#sign-out').addEventListener('click', async () => {
  await requestJson('/api/auth/logout', { method:'POST' });
  location.replace('/login.html');
});
$('#open-data').addEventListener('click', () => {
  appMenu.open = false;
  openDataDialog();
});
$('#open-api-token').addEventListener('click', () => {
  appMenu.open = false;
  openApiTokenDialog();
});
$('#open-planning').addEventListener('click', () => {
  appMenu.open = false;
  openPlanningSetup();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && matrixCard.classList.contains('presenting')) {
    setMatrixPresentation(false);
    $('#toggle-matrix-presentation').focus();
  }
});
$('#toggle-matrix-presentation').addEventListener('click', () => {
  setMatrixPresentation(!matrixCard.classList.contains('presenting'));
});
projectPreview.addEventListener('pointerenter', () => clearTimeout(previewHideTimer));
projectPreview.addEventListener('pointerleave', () => hideProjectPreview());
$('#empty-add').addEventListener('click', () => openDialog());
$('#list-add-project').addEventListener('click', () => openDialog());
$('#close-dialog').addEventListener('click', () => dialog.close());
$('#cancel-dialog').addEventListener('click', () => dialog.close());
$('#delete-project').addEventListener('click', deleteProject);
$('#archive-project').addEventListener('click', toggleArchiveProject);
$('#view-history').addEventListener('click', viewHistory);
$('#start-planning').addEventListener('click', startPlanningRoom);
$('#planning-setup-form').addEventListener('submit', createPlanningRoom);
$('#close-planning-setup').addEventListener('click', () => planningSetupDialog.close());
$('#cancel-planning-setup').addEventListener('click', () => planningSetupDialog.close());
$('#copy-link').addEventListener('click', copyShareLink);
$('#close-share').addEventListener('click', () => shareDialog.close());
$('#close-share-footer').addEventListener('click', () => shareDialog.close());
$('#move-comment-form').addEventListener('submit', savePendingMove);
$('#close-move-comment').addEventListener('click', cancelPendingMove);
$('#cancel-move-comment').addEventListener('click', cancelPendingMove);
$('#restore-form').addEventListener('submit', restoreData);
$('#backup-file').addEventListener('change', syncRestoreButton);
$('#restore-confirm').addEventListener('change', syncRestoreButton);
$('#close-data').addEventListener('click', () => dataDialog.close());
$('#cancel-data').addEventListener('click', () => dataDialog.close());
$('#generate-api-token').addEventListener('click', generateApiToken);
$('#copy-api-token').addEventListener('click', () => copyText($('#api-token-value'), 'API token copied'));
$('#close-api-token').addEventListener('click', () => apiTokenDialog.close());
$('#cancel-api-token').addEventListener('click', () => apiTokenDialog.close());
$('#done-api-token').addEventListener('click', () => apiTokenDialog.close());
apiTokenDialog.addEventListener('close', () => { $('#api-token-value').value = ''; });
blockedNoteForm.addEventListener('submit', saveBlockedProject);
$('#close-blocked-note').addEventListener('click', cancelBlockedSave);
$('#cancel-blocked-note').addEventListener('click', cancelBlockedSave);
archiveNoteForm.addEventListener('submit', saveArchiveProject);
$('#close-archive-note').addEventListener('click', cancelArchiveSave);
$('#cancel-archive-note').addEventListener('click', cancelArchiveSave);
form.addEventListener('submit', saveProject);
form.addEventListener('input', (event) => { if (event.target.type === 'range') syncOutputs(); });
form.addEventListener('change', (event) => { if (event.target.name === 'status' || event.target.name === 'scheduleStage') syncProjectFields(); });
document.addEventListener('click', (event) => { const project = projectFromTarget(event.target); if (project && canEditProject(project) && !event.target.closest('.project-dot,[data-external-link],.project-table')) openDialog(project); });
document.addEventListener('keydown', (event) => { const project = projectFromTarget(event.target); if (project && canEditProject(project) && (event.key === 'Enter' || event.key === ' ') && event.target.matches('.ranking article')) openDialog(project); });
document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
  state.status = tab.dataset.status;
  state.showCompleted = state.status === 'Complete';
  $('#show-completed').checked = state.showCompleted;
  document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item === tab));
  render();
}));
$('#project-table-head').addEventListener('click', (event) => {
  const toggle = event.target.closest('[data-filter-open]');
  if (toggle) {
    if (!filterPopover.hidden && filterAnchor === toggle.dataset.filterOpen) closeFilterPopover();
    else openFilterPopover(toggle.dataset.filterOpen);
    return;
  }
  const button = event.target.closest('[data-sort-column]');
  if (!button) return;
  state.sort = toggleSort(state.sort, button.dataset.sortColumn, { add: event.shiftKey });
  saveTablePrefs();
  render();
  $(`[data-sort-column="${button.dataset.sortColumn}"]`)?.focus();
});
$('#project-table-body').addEventListener('click', (event) => {
  const project = projectFromTarget(event.target);
  if (!project || event.target.closest('[data-external-link]')) return;
  if (event.target.closest('[data-promote-project]')) { void promoteProject(project); return; }
  if (event.target.closest('[data-edit-project]')) { openDialog(project); return; }
  const cell = event.target.closest('[data-drill]');
  if (cell) {
    const filter = drillFilter(cell.dataset.drill, project);
    if (!filter) return;
    state.filters = { ...state.filters, [cell.dataset.drill]: filter };
    saveTablePrefs();
    refreshFilterPopover();
    render();
    return;
  }
  if (event.target.closest('.project-row') && !event.target.closest('a,button')) toggleExpanded(project);
});
$('#project-table-body').addEventListener('keydown', (event) => {
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('.project-row')) {
    event.preventDefault();
    toggleExpanded(projectFromTarget(event.target));
  }
});
function readFilter(columnId) {
  const inputs = [...filterPopover.querySelectorAll(`[data-filter="${columnId}"]`)];
  const kind = filterKind(tableColumn(columnId).type);
  if (kind === 'contains') return { contains: inputs[0]?.value || '' };
  if (kind === 'in') return { in: inputs.filter((input) => input.checked).map((input) => input.value) };
  return Object.fromEntries(inputs.map((input) => [input.dataset.bound, input.value]));
}
let filterTimer;
filterPopover.addEventListener('input', (event) => {
  const columnId = event.target.dataset.filter;
  if (!columnId) return;
  state.filters = normalizeFilters({ ...state.filters, [columnId]: readFilter(columnId) });
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => { saveTablePrefs(); render(); }, 120);
});
filterPopover.addEventListener('click', (event) => {
  const columnId = filterAnchor;
  if (event.target.closest('[data-filter-all],[data-filter-none]')) {
    const all = Boolean(event.target.closest('[data-filter-all]'));
    filterPopover.querySelectorAll('input[type="checkbox"]').forEach((input) => { input.checked = all; });
    setColumnFilter(columnId, readFilter(columnId));
  } else if (event.target.closest('[data-filter-clear]')) {
    setColumnFilter(columnId, {});
    refreshFilterPopover();
  } else if (event.target.closest('[data-filter-done]')) {
    closeFilterPopover();
    $(`[data-filter-open="${columnId}"]`)?.focus();
  }
});
// Enter in a text or number box applies and closes, like Done.
filterPopover.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || !event.target.matches('input:not([type="checkbox"])')) return;
  event.preventDefault();
  closeFilterPopover();
  $(`[data-filter-open="${filterAnchor}"]`)?.focus();
});
$('#filter-chip-list').addEventListener('click', (event) => {
  const chip = event.target.closest('[data-clear-filter]');
  if (!chip) return;
  setColumnFilter(chip.dataset.clearFilter, {});
  refreshFilterPopover();
  ($('#filter-chip-list [data-clear-filter]') || $('#search'))?.focus();
});
$('#views-list').addEventListener('click', async (event) => {
  const apply = event.target.closest('[data-apply-view]');
  const remove = event.target.closest('[data-delete-view]');
  const view = state.views.find((item) => item.id === Number((apply || remove)?.dataset.applyView || (apply || remove)?.dataset.deleteView));
  if (!view) return;
  if (apply) { applyView(view); return; }
  if (!confirm(`Delete the view “${view.name}”?`)) return;
  try {
    await requestJson(`/api/views/${view.id}`, { method: 'DELETE' });
    state.views = state.views.filter((item) => item.id !== view.id);
    renderViews();
  } catch (error) { toast(error.message); }
});
$('#views-save').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = $('#view-name').value.trim();
  if (!name) return;
  try { await saveView(name); $('#view-name').value = ''; } catch (error) { toast(error.message); }
});
$('#clear-filters').addEventListener('click', () => {
  state.filters = {};
  saveTablePrefs();
  refreshFilterPopover();
  render();
});
$('#column-menu-panel').addEventListener('change', (event) => {
  const picked = [...$('#column-menu-panel').querySelectorAll('input:checked')].map((input) => input.value);
  if (!picked.length) { event.target.checked = true; return; }
  state.columns = picked;
  saveTablePrefs();
  refreshFilterPopover();
  render();
});
$('#column-menu-panel').addEventListener('click', (event) => {
  if (!event.target.closest('[data-reset-columns]')) return;
  state.columns = matchMedia('(max-width: 620px)').matches ? MOBILE_COLUMNS : DEFAULT_COLUMNS;
  saveTablePrefs();
  renderColumnMenu();
  render();
});
$('#search').addEventListener('input', (event) => { state.query = event.target.value.trim(); syncTableUrl(); render(); });
$('#team-filter-menu').addEventListener('change', (event) => {
  if (event.target.value === 'All') state.selectedTeams = [];
  else state.selectedTeams = [...$('#team-filter-menu').querySelectorAll('input:not([value="All"]):checked')].map((input) => input.value);
  render();
});
$('#show-completed').addEventListener('change', (event) => { state.showCompleted = event.target.checked; render(); });
$('#show-ideas').addEventListener('change', (event) => { state.showIdeas = event.target.checked; $('.idea-key').hidden = !state.showIdeas; render(); });
$('#show-archived').addEventListener('change', (event) => { state.showArchived = event.target.checked; render(); });
$('#show-all').addEventListener('click', () => { state.status = 'All'; state.selectedTeams = []; state.query = ''; $('#search').value = ''; document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.status === 'All')); render(); $('.project-list').scrollIntoView({ behavior: 'smooth' }); });
dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
planningSetupDialog.addEventListener('click', (event) => { if (event.target === planningSetupDialog) planningSetupDialog.close(); });
shareDialog.addEventListener('click', (event) => { if (event.target === shareDialog) shareDialog.close(); });
$('#close-history').addEventListener('click', () => historyDialog.close());
$('#close-history-footer').addEventListener('click', () => historyDialog.close());
historyDialog.addEventListener('click', (event) => { if (event.target === historyDialog) historyDialog.close(); });
moveCommentDialog.addEventListener('click', (event) => { if (event.target === moveCommentDialog) cancelPendingMove(); });
moveCommentDialog.addEventListener('cancel', (event) => { event.preventDefault(); cancelPendingMove(); });
dataDialog.addEventListener('click', (event) => { if (event.target === dataDialog) dataDialog.close(); });
apiTokenDialog.addEventListener('click', (event) => { if (event.target === apiTokenDialog) apiTokenDialog.close(); });
blockedNoteDialog.addEventListener('click', (event) => { if (event.target === blockedNoteDialog) cancelBlockedSave(); });
blockedNoteDialog.addEventListener('cancel', (event) => { event.preventDefault(); cancelBlockedSave(); });
archiveNoteDialog.addEventListener('click', (event) => { if (event.target === archiveNoteDialog) cancelArchiveSave(); });
archiveNoteDialog.addEventListener('cancel', (event) => { event.preventDefault(); cancelArchiveSave(); });

let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 100); });

load().then(() => {
  if (!state.user) return;
  const action = new URLSearchParams(location.search).get('menu');
  if (action) {
    const url = new URL(location.href);
    url.searchParams.delete('menu');
    history.replaceState(null, '', url);
    if (action === 'add-project' && !$('#add-project').hidden) openDialog();
    if (state.user.role === 'admin') {
      if (action === 'api-access') openApiTokenDialog();
      if (action === 'data') openDataDialog();
      if (action === 'planning') openPlanningSetup();
    }
  }
  liveUpdates(['projects', 'teams', 'kanban'], async (kinds) => {
    if (kinds.includes('kanban') || kinds.includes('projects')) {
      state.cards.clear();
      state.projects.filter((project) => state.expanded.has(project.id)).forEach(loadCards);
    }
    [state.projects, state.teams] = await Promise.all([
      kinds.includes('projects') ? request() : state.projects,
      kinds.includes('teams') || kinds.includes('kanban') ? requestJson('/api/teams') : state.teams,
    ]);
    render();
  }, { busy: () => Boolean(state.dragged || state.pendingMove || state.pendingBlockedSave || state.pendingArchiveSave) });
});
