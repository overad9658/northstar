import { escapeHtml, requestJson, showToast } from './browser-utils.js';
import { liveUpdates } from './live-updates.js';
import { COLUMN_DRAG_TYPE, columnControls, dropTarget, moveTarget, reorderColumns } from './kanban-columns.js';
import { ALL_BOARDS, targetColumn } from './shared/kanban-boards.js';
import { cardMatches, requestedCard } from './shared/card-search.js';
import { compareCards, ranksForMove } from './shared/card-order.js';
import { compareByConstraint, RATING_LABELS } from './shared/constraints.js';

const board = document.querySelector('#kanban-board');
const dialog = document.querySelector('#card-dialog');
const form = document.querySelector('#card-form');
const columnForm = document.querySelector('#column-form');
const boardError = document.querySelector('#board-error');
const cardError = document.querySelector('#card-error');
const notesSection = document.querySelector('#card-notes');
const noteForm = document.querySelector('#note-form');
const noteList = document.querySelector('#note-list');
const noteError = document.querySelector('#note-error');
const historySection = document.querySelector('#card-history');
const historyList = document.querySelector('#history-list');
const tagFilter = document.querySelector('#tag-filter');
const projectFilter = document.querySelector('#project-filter');
const assigneeFilter = document.querySelector('#assignee-filter');
const decisionFilter = document.querySelector('#decision-filter');
const showArchived = document.querySelector('#show-archived');
const archiveButton = document.querySelector('#archive-card');
const assigneeOptions = document.querySelector('#assignee-options');
const teamBoard = document.querySelector('#team-board');
const teamFilter = document.querySelector('#team-filter');
const teamFilterField = document.querySelector('#team-filter-field');
const cardTeamField = document.querySelector('#card-team-field');
const exportButton = document.querySelector('#download-kanban-report');
const cardSearch = document.querySelector('#card-search');
const orderSelect = document.querySelector('#card-order');
let data = { columns: [], cards: [] };
let projects = [];
let canEdit = false;
let canManageColumns = false;
let currentUser;
let selectedTeamId;
let editingId = null;
let selectedTag = '';
let selectedProject = 'all';
let selectedAssignee = '';
let selectedDecision = '';
let selectedTeamFilter = '';
let searchText = '';
// Board order, or ?order=constraint: cards on the #1 constraint first, then by rating (see compareByConstraint).
let selectedOrder = new URLSearchParams(location.search).get('order') === 'constraint' ? 'constraint' : '';
let constraintsById = new Map();
let dragging = false;
let editingCard = null;

function boardPath() {
  return showArchived.checked ? '?archived=include' : '';
}

function api(path = '', options) {
  return requestJson(`/api/kanban${path}${path.includes('?') ? '&' : '?'}teamId=${selectedTeamId}`, options, 'The board could not be saved.');
}

// "All boards" shows every team's board at once (?teamId=all); columns merge by name.
const allMode = () => selectedTeamId === ALL_BOARDS;
const canEditTeam = (teamId) => currentUser.role === 'admin' || currentUser.teamIds.includes(teamId);

// One shape for both modes: every column has a key, every card the key of the column it shows in.
function normalize(board) {
  board.columns.forEach((column) => { column.key ??= String(column.id); });
  board.cards.forEach((card) => { card.columnKey ??= String(card.columnId); });
  return board;
}

// Each team keeps one badge tone for as long as the page shows the same teams.
function teamTone(teamId) {
  return `team-tone-${Math.max(0, (data.teams || []).findIndex((team) => team.id === teamId)) % 6}`;
}

function mutation(method, body) {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

// A blocker shows as #id with its title when it is on this board; a finished blocker (in a column named Done) is struck through.
function blockerLabel(id) {
  const blocker = data.cards.find((item) => item.id === id);
  if (!blocker) return `#${id}`;
  const done = /^done$/i.test(data.columns.find((column) => column.key === blocker.columnKey)?.name || '');
  return `<span class="${done ? 'kanban-blocker-done' : ''}" title="${escapeHtml(blocker.title)}">#${id} ${escapeHtml(blocker.title)}</span>`;
}

// The register, for the chips and the constraint order. A board without constraints shows neither.
async function loadConstraints() {
  try {
    const register = await requestJson('/api/constraints', { credentials: 'same-origin', cache: 'no-store' }, 'The constraints could not load.');
    constraintsById = new Map(register.constraints.map((item) => [item.id, item]));
  } catch { constraintsById = new Map(); }
}

const constraintRanks = () => new Map([...constraintsById.values()].filter((item) => item.rank !== null).map((item) => [item.id, item.rank]));
const cardOrder = () => (selectedOrder === 'constraint' ? compareByConstraint(constraintRanks(), compareCards) : compareCards);

// "#1 · Removes": the constraint's rank and the card's rating. A resolved constraint asks for a re-rating.
function constraintChip(card) {
  if (!card.constraintId && !card.constraintRating) return '';
  const linked = constraintsById.get(card.constraintId);
  const rating = card.constraintRating ? RATING_LABELS[card.constraintRating] : 'Not rated';
  const resolved = linked?.stage === 'resolved';
  const place = linked ? (resolved ? 'Resolved' : `#${linked.rank}`) : '';
  const title = linked ? `Constraint ${resolved ? '(resolved, re-rate this card)' : `#${linked.rank}`}: ${linked.name} · ${rating}` : `Constraint rating: ${rating}`;
  return `<span class="kanban-constraint-chip rating-${escapeHtml(card.constraintRating || 'none')}${resolved ? ' resolved' : ''}" title="${escapeHtml(title)}">${place ? `<b>${escapeHtml(place)}</b>` : ''}${escapeHtml(rating)}</span>`;
}

function render() {
  orderSelect.value = selectedOrder;
  orderSelect.closest('.field').hidden = !constraintsById.size && !selectedOrder;
  const tags = [...new Set(data.cards.flatMap((card) => card.tags || []))].sort((a, b) => a.localeCompare(b));
  if (selectedTag && !tags.includes(selectedTag)) selectedTag = '';
  tagFilter.innerHTML = '<option value="">All tags</option>' + tags.map((tag) => `<option value="${escapeHtml(tag)}">${escapeHtml(tag)}</option>`).join('');
  tagFilter.value = selectedTag;
  const assignees = [...new Set(data.cards.map((card) => card.assignee).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  if (selectedAssignee && selectedAssignee !== 'none' && !assignees.includes(selectedAssignee)) selectedAssignee = '';
  assigneeFilter.innerHTML = '<option value="">Everyone</option><option value="none">Unassigned</option>' + assignees.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
  assigneeFilter.value = selectedAssignee;
  assigneeOptions.innerHTML = assignees.map((name) => `<option value="${escapeHtml(name)}"></option>`).join('');
  if (!['all', 'none'].includes(selectedProject) && !projects.some((project) => String(project.id) === selectedProject)) selectedProject = 'all';
  projectFilter.innerHTML = '<option value="all">All projects</option><option value="none">General to dos</option>' + projects.map((project) => `<option value="${project.id}">${escapeHtml(project.projectId ? `${project.projectId} · ${project.name}` : project.name)}</option>`).join('');
  projectFilter.value = selectedProject;
  if (allMode()) {
    if (selectedTeamFilter && !data.teams.some((team) => String(team.id) === selectedTeamFilter)) selectedTeamFilter = '';
    teamFilter.innerHTML = '<option value="">All teams</option>' + data.teams.map((team) => `<option value="${team.id}">${escapeHtml(team.name)}</option>`).join('');
    teamFilter.value = selectedTeamFilter;
  }
  const filtering = searchText.trim() || selectedTag || selectedAssignee || selectedDecision || selectedProject !== 'all' || selectedTeamFilter;
  board.innerHTML = data.columns.length ? data.columns.map((column, columnIndex) => {
    const cards = data.cards.filter((card) => card.columnKey === column.key
      && (!selectedTeamFilter || String(card.teamId) === selectedTeamFilter)
      && cardMatches(card, searchText)
      && (!selectedTag || card.tags?.includes(selectedTag))
      && (!selectedAssignee || (selectedAssignee === 'none' ? !card.assignee : card.assignee === selectedAssignee))
      && (selectedDecision !== 'open' || (card.decision && !card.decision.decidedOption))
      && (selectedProject === 'all' || (selectedProject === 'none' ? card.projectId === null : String(card.projectId) === selectedProject))).sort(cardOrder());
    return `<section class="kanban-column" data-column-id="${escapeHtml(column.key)}" aria-label="${escapeHtml(column.name)}">
      <header class="kanban-column-head"${canManageColumns ? ' draggable="true" title="Drag to reorder"' : ''}><div><h2>${escapeHtml(column.name)}</h2><span>${cards.length}</span></div>${columnControls(column, columnIndex, data.columns.length, canManageColumns)}</header>
      <div class="kanban-card-list">${cards.map((card) => `<article class="kanban-card${card.archived ? ' archived' : ''}" data-card-id="${card.id}" ${canEdit && canEditTeam(card.teamId) ? 'draggable="true"' : ''} tabindex="0" role="button" aria-label="${escapeHtml(card.title)}${allMode() ? `, ${escapeHtml(card.teamName)}` : ''}">
        ${allMode() ? `<span class="kanban-team-tag ${teamTone(card.teamId)}" title="Team board">${escapeHtml(card.teamName)}</span>` : ''}${card.archived ? '<span class="kanban-archived-tag">Archived</span>' : ''}<span class="kanban-card-id" title="Card number">#${card.id}</span><h3>${escapeHtml(card.title)}</h3>${card.description ? `<p>${escapeHtml(card.description)}</p>` : ''}
        ${card.assignee ? `<span class="kanban-assignee" title="Assignee">${escapeHtml(card.assignee)}</span>` : ''}
        ${card.nextStep ? `<p class="kanban-next-step"><strong>Next</strong> ${escapeHtml(card.nextStep)}</p>` : ''}
        ${card.objective ? `<p class="kanban-objective"><strong>Objective</strong> ${escapeHtml(card.objective)}</p>` : ''}
        ${(card.blockedBy || []).length ? `<p class="kanban-blocked-by"><strong>Blocked by</strong> ${card.blockedBy.map((id) => blockerLabel(id)).join(', ')}</p>` : ''}
        ${card.rank === null || card.rank === undefined ? '' : `<span class="kanban-rank" title="Rank in the sequence">Rank ${card.rank}</span>`}
        ${constraintChip(card)}
        ${card.decision ? `<span class="kanban-decision-tag${card.decision.decidedOption ? ' decided' : ''}">${card.decision.decidedOption
    ? `Decided: ${escapeHtml(card.decision.decidedOption)}`
    : `Decision open${card.decision.recommendation ? ` · recommends ${escapeHtml(card.decision.recommendation)}${card.decision.confidence === null ? '' : ` (${card.decision.confidence}%)`}` : ''}`}</span>` : ''}
        ${card.externalUrl ? `<a class="kanban-card-link" href="${escapeHtml(card.externalUrl)}" target="_blank" rel="noopener noreferrer" draggable="false" title="${escapeHtml(card.externalUrl)}">↗ Link</a>` : ''}
        ${card.projectId ? `<span class="kanban-project-tag">${escapeHtml(card.projectCode || card.projectName || 'Project')}<span>${card.projectCode ? escapeHtml(card.projectName) : ''}</span></span>` : '<span class="kanban-general-tag">General to do</span>'}
        ${(card.tags || []).length ? `<div class="kanban-tags">${card.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div>` : ''}
        ${card.noteCount ? `<span class="kanban-note-count">${card.noteCount} ${card.noteCount === 1 ? 'note' : 'notes'}</span>` : ''}
      </article>`).join('') || `<p class="kanban-column-empty">${filtering ? 'No cards match these filters.' : 'Drop cards here or add one below.'}</p>`}</div>
      ${canEdit ? `<button type="button" class="kanban-add-card">+ Add card</button>` : ''}
    </section>`;
  }).join('') : allMode()
    ? '<div class="kanban-board-empty"><h2>No columns on any board yet</h2><p>Pick a team board to add its first column.</p></div>'
    : '<div class="kanban-board-empty"><h2>Your board starts with a column</h2><p>Add a column for the way you organize work, then fill it with cards.</p></div>';
}

function projectOptions(teamId) {
  const teamName = allMode() ? data.teams.find((team) => team.id === teamId)?.name?.toLocaleLowerCase() : null;
  const shown = teamName ? projects.filter((project) => project.team?.toLocaleLowerCase() === teamName) : projects;
  return '<option value="">No project — general to do</option>' + shown.map((project) => `<option value="${project.id}">${escapeHtml(project.projectId ? `${project.projectId} · ${project.name}` : project.name)}</option>`).join('');
}

function openCard(columnKey, card = null) {
  editingId = card?.id || null;
  editingCard = card;
  form.reset();
  archiveButton.hidden = !card;
  archiveButton.textContent = card?.archived ? 'Restore card' : 'Archive card';
  cardError.textContent = '';
  dialog.classList.toggle('editing', Boolean(card));
  document.querySelector('#card-dialog-kicker').textContent = card ? `Edit card · #${card.id}` : 'New card';
  document.querySelector('#card-dialog-title').textContent = card ? card.title : 'Add a card';
  form.elements.columnId.innerHTML = data.columns.map((column) => `<option value="${escapeHtml(column.key)}">${escapeHtml(column.name)}</option>`).join('');
  // On All boards a new card asks which team it belongs to; an existing card shows its team.
  cardTeamField.hidden = !allMode();
  if (allMode()) {
    const choices = card ? data.teams.filter((team) => team.id === card.teamId) : data.teams.filter((team) => canEditTeam(team.id));
    form.elements.teamId.innerHTML = choices.map((team) => `<option value="${team.id}">${escapeHtml(team.name)}</option>`).join('');
    const columnTeams = data.columns.find((column) => column.key === columnKey)?.columns.map((item) => item.teamId) || [];
    form.elements.teamId.value = String(card?.teamId || choices.find((team) => columnTeams.includes(team.id))?.id || choices[0]?.id || '');
  }
  form.elements.projectId.innerHTML = projectOptions(cardTeamId());
  form.elements.columnId.value = card?.columnKey || columnKey;
  form.elements.projectId.value = card?.projectId || '';
  form.elements.title.value = card?.title || '';
  form.elements.description.value = card?.description || '';
  form.elements.assignee.value = card?.assignee || '';
  form.elements.externalUrl.value = card?.externalUrl || '';
  form.elements.nextStep.value = card?.nextStep || '';
  fillDecision(card?.decision || null);
  form.elements.tags.value = card?.tags?.join(', ') || '';
  form.querySelectorAll('input, textarea, select').forEach((field) => { field.disabled = !canEdit || (card && !canEditTeam(card.teamId)); });
  form.elements.teamId.disabled = Boolean(card) || !canEdit;
  form.querySelector('.dialog-actions').hidden = !canEdit;
  notesSection.hidden = !card;
  historySection.hidden = !card;
  noteForm.hidden = !canEdit;
  noteList.innerHTML = '';
  historyList.innerHTML = '';
  noteError.textContent = '';
  dialog.showModal();
  if (card) { void loadNotes(card.id); void loadHistory(card.id); setCardParam(card.id); }
  if (canEdit) form.elements.title.focus();
}

function renderNotes(notes) {
  document.querySelector('#note-count').textContent = `${notes.length} ${notes.length === 1 ? 'note' : 'notes'}`;
  noteList.innerHTML = notes.length ? notes.map((note) => `<article class="kanban-note" data-note-id="${note.id}">
    <p>${escapeHtml(note.body)}</p><footer><time>${escapeHtml(note.createdAt)}</time>${canEdit ? `<button type="button" class="note-delete" aria-label="Delete note">Delete</button>` : ''}</footer>
  </article>`).join('') : '<p class="kanban-note-empty">No notes yet.</p>';
}

async function loadNotes(cardId) {
  try {
    const notes = await api(`/cards/${cardId}/notes`);
    if (editingId === cardId && dialog.open) renderNotes(notes);
  } catch (error) { if (editingId === cardId) noteList.textContent = error.message; }
}

function formatDuration(seconds) {
  if (seconds < 60) return `${Math.round(seconds)} sec`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr ${Math.floor(seconds % 3600 / 60)} min`;
  return `${Math.floor(seconds / 86400)} d ${Math.floor(seconds % 86400 / 3600)} hr`;
}

async function loadHistory(cardId) {
  try {
    const { entries } = await api(`/cards/${cardId}/history`);
    if (editingId !== cardId || !dialog.open) return;
    historyList.innerHTML = entries.length ? entries.map((entry) => `<article class="kanban-history-entry">
      <div><strong>${escapeHtml(entry.columnName)}</strong><span>${entry.isCurrent ? 'Current' : formatDuration(entry.durationSeconds)}</span></div>
      <p>${escapeHtml(entry.enteredAt)} → ${entry.exitedAt ? escapeHtml(entry.exitedAt) : 'Now'} · ${formatDuration(entry.durationSeconds)}</p>
    </article>`).join('') : '<p class="kanban-note-empty">No column history yet.</p>';
  } catch (error) { if (editingId === cardId) historyList.textContent = error.message; }
}

function csvCell(value) {
  const text = String(value ?? '');
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

document.querySelector('#download-kanban-report').addEventListener('click', async () => {
  boardError.textContent = '';
  try {
    const { asOf, rows } = await api('/report');
    const headings = ['Card ID', 'Card', 'Project ID', 'Project', 'Column ID', 'Column', 'Entered at', 'Exited at', 'Current', 'Duration seconds', 'Duration hours', 'As of'];
    const values = rows.map((row) => [row.cardId, row.cardTitle, row.projectCode, row.projectName, row.columnId, row.columnName, row.enteredAt, row.exitedAt, row.isCurrent ? 'Yes' : 'No', row.durationSeconds, (row.durationSeconds / 3600).toFixed(3), asOf]);
    const csv = [headings, ...values].map((line) => line.map(csvCell).join(',')).join('\r\n') + '\r\n';
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `northstar-kanban-time-${asOf.slice(0, 10)}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { boardError.textContent = error.message; }
});

// The team a card in the dialog belongs to: its own, the one picked on All boards, or this board's.
function cardTeamId() {
  if (editingCard) return editingCard.teamId;
  return allMode() ? Number(form.elements.teamId.value) : selectedTeamId;
}

async function reload() {
  [data] = await Promise.all([api(boardPath()).then(normalize), loadConstraints()]);
  render();
}

function decisionOptions() {
  return [...new Set(form.elements.decisionOptions.value.split('\n').map((line) => line.trim()).filter(Boolean))];
}

function setDecisionChoices(options, decided = '') {
  const choices = options.map((option) => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`).join('');
  document.querySelector('#decision-option-list').innerHTML = choices;
  form.elements.decidedOption.innerHTML = '<option value="">Not decided yet</option>' + choices;
  form.elements.decidedOption.value = options.includes(decided) ? decided : '';
}

function fillDecision(decision) {
  form.elements.decisionOptions.value = decision?.options?.join('\n') || '';
  form.elements.decisionRecommendation.value = decision?.recommendation || '';
  form.elements.decisionConfidence.value = decision?.confidence ?? '';
  setDecisionChoices(decision?.options || [], decision?.decidedOption || '');
}

function readDecision() {
  const options = decisionOptions();
  if (!options.length) return null;
  const confidence = form.elements.decisionConfidence.value;
  return {
    options,
    recommendation: form.elements.decisionRecommendation.value,
    confidence: confidence === '' ? null : Number(confidence),
    decidedOption: form.elements.decidedOption.value,
  };
}

async function saveCard(event) {
  event.preventDefault();
  cardError.textContent = '';
  const payload = {
    title: form.elements.title.value,
    description: form.elements.description.value,
    assignee: form.elements.assignee.value,
    externalUrl: form.elements.externalUrl.value,
    nextStep: form.elements.nextStep.value,
    decision: readDecision(),
    columnId: null,
    projectId: form.elements.projectId.value ? Number(form.elements.projectId.value) : null,
    tags: form.elements.tags.value.split(',').map((tag) => tag.trim()).filter(Boolean),
  };
  const column = data.columns.find((item) => item.key === form.elements.columnId.value);
  payload.columnId = allMode() ? targetColumn(column, cardTeamId()) : column?.id;
  if (!payload.columnId) {
    cardError.textContent = `The ${data.teams.find((team) => team.id === cardTeamId())?.name || 'chosen'} board has no “${column?.name || ''}” column.`;
    return;
  }
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    const wasEditing = Boolean(editingId);
    const saved = await api(`/cards${editingId ? `/${editingId}` : ''}`, mutation(editingId ? 'PUT' : 'POST', payload));
    await reload();
    dialog.close();
    const fresh = data.cards.find((item) => item.id === saved.id);
    if (!wasEditing) openCard(fresh?.columnKey || String(saved.columnId), fresh || saved);
    showToast(wasEditing ? 'Card updated' : 'Card added');
  } catch (error) { cardError.textContent = error.message; }
  finally { button.disabled = false; }
}

columnForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  boardError.textContent = '';
  const button = columnForm.querySelector('button');
  button.disabled = true;
  try {
    await api('/columns', mutation('POST', { name: columnForm.elements.name.value }));
    columnForm.reset();
    await reload();
    showToast('Column added');
  } catch (error) { boardError.textContent = error.message; }
  finally { button.disabled = false; }
});
tagFilter.addEventListener('change', () => { selectedTag = tagFilter.value; render(); });
projectFilter.addEventListener('change', () => { selectedProject = projectFilter.value; render(); });
assigneeFilter.addEventListener('change', () => { selectedAssignee = assigneeFilter.value; render(); });
decisionFilter.addEventListener('change', () => { selectedDecision = decisionFilter.value; render(); });
orderSelect.addEventListener('change', () => {
  selectedOrder = orderSelect.value;
  const params = new URLSearchParams(location.search);
  if (selectedOrder) params.set('order', selectedOrder); else params.delete('order');
  history.replaceState(null, '', `?${params}`);
  render();
});
teamFilter.addEventListener('change', () => { selectedTeamFilter = teamFilter.value; render(); });
cardSearch.addEventListener('input', () => { searchText = cardSearch.value; render(); });
form.elements.teamId.addEventListener('change', () => { form.elements.projectId.innerHTML = projectOptions(cardTeamId()); });
showArchived.addEventListener('change', () => { reload().catch((error) => { boardError.textContent = error.message; }); });
archiveButton.addEventListener('click', async () => {
  if (!editingCard) return;
  const archived = !editingCard.archived;
  try { await api(`/cards/${editingCard.id}`, mutation('PUT', { archived })); dialog.close(); await reload(); showToast(archived ? 'Card archived' : 'Card restored'); }
  catch (error) { cardError.textContent = error.message; }
});
form.elements.decisionOptions.addEventListener('input', () => setDecisionChoices(decisionOptions(), form.elements.decidedOption.value));

async function moveColumn(columnId, position, focusClass) {
  if (position === null) return;
  boardError.textContent = '';
  const before = data.columns;
  data = { ...data, columns: reorderColumns(before, columnId, position) };
  render();
  if (focusClass) {
    const head = board.querySelector(`[data-column-id="${columnId}"]`);
    const button = head?.querySelector(`.${focusClass}`);
    (button && !button.disabled ? button : head?.querySelector('.column-move-left:not([disabled]), .column-move-right:not([disabled])'))?.focus();
  }
  try { await api(`/columns/${columnId}`, mutation('PUT', { position })); showToast('Column moved'); }
  catch (error) { data = { ...data, columns: before }; render(); boardError.textContent = error.message; }
}

board.addEventListener('click', async (event) => {
  if (event.target.closest('.kanban-card-link')) return;
  const columnElement = event.target.closest('[data-column-id]');
  if (!columnElement) return;
  const column = data.columns.find((item) => item.key === columnElement.dataset.columnId);
  const columnId = column?.id;
  const cardElement = event.target.closest('[data-card-id]');
  if (canManageColumns && event.target.closest('.column-move-left, .column-move-right')) {
    const left = Boolean(event.target.closest('.column-move-left'));
    await moveColumn(columnId, moveTarget(data.columns, columnId, left ? -1 : 1), left ? 'column-move-left' : 'column-move-right');
  } else if (canManageColumns && event.target.closest('.column-rename')) {
    const name = prompt('Column name', column.name);
    if (name === null || name.trim() === column.name) return;
    try { await api(`/columns/${columnId}`, mutation('PUT', { name })); await reload(); showToast('Column renamed'); }
    catch (error) { boardError.textContent = error.message; }
  } else if (canManageColumns && event.target.closest('.column-delete')) {
    const count = data.cards.filter((card) => card.columnId === columnId).length;
    if (!confirm(`Delete “${column.name}”${count ? ` and its ${count} card${count === 1 ? '' : 's'}` : ''}?`)) return;
    try { await api(`/columns/${columnId}`, { method: 'DELETE' }); await reload(); showToast('Column deleted'); }
    catch (error) { boardError.textContent = error.message; }
  } else if (canEdit && event.target.closest('.kanban-add-card')) openCard(column.key);
  else if (cardElement) openCard(column.key, data.cards.find((card) => card.id === Number(cardElement.dataset.cardId)));
});

board.addEventListener('keydown', (event) => {
  if (!['Enter', ' '].includes(event.key) || event.target.closest('.kanban-card-link')) return;
  const cardElement = event.target.closest('[data-card-id]');
  if (!cardElement) return;
  event.preventDefault();
  const card = data.cards.find((item) => item.id === Number(cardElement.dataset.cardId));
  openCard(card.columnKey, card);
});

board.addEventListener('dragstart', (event) => {
  const head = event.target.closest?.('.kanban-column-head');
  if (head) {
    if (!canManageColumns) return;
    dragging = true;
    event.dataTransfer.setData(COLUMN_DRAG_TYPE, head.closest('[data-column-id]').dataset.columnId);
    event.dataTransfer.effectAllowed = 'move';
    return;
  }
  if (!canEdit) return;
  const cardElement = event.target.closest('[data-card-id]');
  if (!cardElement) return;
  dragging = true;
  draggedCardId = Number(cardElement.dataset.cardId);
  event.dataTransfer.setData('text/plain', cardElement.dataset.cardId);
  event.dataTransfer.effectAllowed = 'move';
});
// Where a dragged card would land in a column: before the first card whose middle is below the pointer.
function dropBefore(columnElement, clientY, draggedId) {
  return [...columnElement.querySelectorAll('[data-card-id]')]
    .find((element) => Number(element.dataset.cardId) !== draggedId && clientY < element.getBoundingClientRect().top + element.getBoundingClientRect().height / 2) || null;
}

function clearDropMarks() {
  board.querySelectorAll('.drop-target, .drop-before').forEach((element) => element.classList.remove('drop-target', 'drop-before'));
}

let draggedCardId = null;

// Dragging a card within its column sets its rank between its new neighbours (see ranksForMove).
// In constraint order the column is not in rank order, so a drop there sets nothing.
async function reorderCard(card, columnElement, clientY) {
  if (selectedOrder === 'constraint') { showToast('Switch to board order to reorder cards'); return; }
  const column = data.cards.filter((item) => item.columnKey === card.columnKey).sort(compareCards);
  const others = column.filter((item) => item.id !== card.id);
  const before = dropBefore(columnElement, clientY, card.id);
  // With filters on, a drop after the last shown card lands right after that card, not at the column's end.
  const shown = [...columnElement.querySelectorAll('[data-card-id]')].map((element) => Number(element.dataset.cardId)).filter((id) => id !== card.id);
  const index = before ? others.findIndex((item) => item.id === Number(before.dataset.cardId))
    : shown.length ? others.findIndex((item) => item.id === shown.at(-1)) + 1 : others.length;
  const ranks = ranksForMove(column, card.id, index);
  if (!ranks.length) return;
  boardError.textContent = '';
  try { await requestJson('/api/kanban/cards/ranks', mutation('PUT', { ranks }), 'The order could not be saved.'); await reload(); showToast('Card reordered'); }
  catch (error) { boardError.textContent = error.message; }
}

board.addEventListener('dragover', (event) => {
  if (canManageColumns && event.dataTransfer.types.includes(COLUMN_DRAG_TYPE)) {
    const columnElement = event.target.closest('[data-column-id]');
    if (!columnElement) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    board.querySelectorAll('.drop-target').forEach((element) => element.classList.remove('drop-target'));
    columnElement.classList.add('drop-target');
    return;
  }
  if (!canEdit || !event.dataTransfer.types.includes('text/plain')) return;
  const columnElement = event.target.closest('[data-column-id]');
  if (!columnElement) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  clearDropMarks();
  const card = data.cards.find((item) => item.id === draggedCardId);
  if (card && card.columnKey === columnElement.dataset.columnId) dropBefore(columnElement, event.clientY, card.id)?.classList.add('drop-before');
  else columnElement.classList.add('drop-target');
});
board.addEventListener('dragleave', (event) => {
  const columnElement = event.target.closest('[data-column-id]');
  if (columnElement && !columnElement.contains(event.relatedTarget)) columnElement.classList.remove('drop-target');
});
board.addEventListener('drop', async (event) => {
  const columnElement = event.target.closest('[data-column-id]');
  clearDropMarks();
  if (canManageColumns && columnElement && event.dataTransfer.types.includes(COLUMN_DRAG_TYPE)) {
    event.preventDefault();
    const draggedId = Number(event.dataTransfer.getData(COLUMN_DRAG_TYPE));
    dragging = false;
    await moveColumn(draggedId, dropTarget(data.columns, draggedId, Number(columnElement.dataset.columnId)));
    return;
  }
  if (!canEdit || !columnElement) return;
  event.preventDefault();
  const cardId = Number(event.dataTransfer.getData('text/plain'));
  const card = data.cards.find((item) => item.id === cardId);
  const column = data.columns.find((item) => item.key === columnElement.dataset.columnId);
  if (!card || !column) return;
  if (card.columnKey === column.key) { if (canEditTeam(card.teamId)) await reorderCard(card, columnElement, event.clientY); return; }
  // On All boards a card moves to the same-named column on its own team; it never changes team.
  const columnId = allMode() ? targetColumn(column, card.teamId) : column.id;
  if (!columnId) {
    boardError.textContent = `“${card.title}” stays put: the ${card.teamName} board has no “${column.name}” column.`;
    showToast(`The ${card.teamName} board has no “${column.name}” column`);
    return;
  }
  boardError.textContent = '';
  try { await api(`/cards/${cardId}`, mutation('PUT', { columnId })); await reload(); showToast('Card moved'); }
  catch (error) { boardError.textContent = error.message; }
});
board.addEventListener('dragend', () => { dragging = false; draggedCardId = null; });
board.addEventListener('dragend', clearDropMarks);

form.addEventListener('submit', saveCard);
noteForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!canEdit || !editingId) return;
  noteError.textContent = '';
  const cardId = editingId;
  const button = noteForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api(`/cards/${cardId}/notes`, mutation('POST', { body: noteForm.elements.body.value }));
    noteForm.reset();
    await Promise.all([loadNotes(cardId), reload()]);
    showToast('Note added');
  } catch (error) { noteError.textContent = error.message; }
  finally { button.disabled = false; }
});
noteList.addEventListener('click', async (event) => {
  if (!canEdit || !editingId || !event.target.closest('.note-delete')) return;
  const noteId = Number(event.target.closest('[data-note-id]').dataset.noteId);
  if (!confirm('Delete this note?')) return;
  noteError.textContent = '';
  const cardId = editingId;
  try {
    await api(`/cards/${cardId}/notes/${noteId}`, { method: 'DELETE' });
    await Promise.all([loadNotes(cardId), reload()]);
    showToast('Note deleted');
  } catch (error) { noteError.textContent = error.message; }
});
document.querySelector('#delete-card').addEventListener('click', async () => {
  if (!editingId || !confirm('Delete this card?')) return;
  try { await api(`/cards/${editingId}`, { method: 'DELETE' }); dialog.close(); await reload(); showToast('Card deleted'); }
  catch (error) { cardError.textContent = error.message; }
});
document.querySelector('#close-card-dialog').addEventListener('click', () => dialog.close());
// While a card is open the address names it (?card=<id>), so the link can be shared.
dialog.addEventListener('close', () => setCardParam(null));
document.querySelector('#cancel-card').addEventListener('click', () => dialog.close());

async function selectTeam(teamId) {
  selectedTeamId = teamId;
  // Columns belong to one team, so rename, delete, reorder and add column stay on team boards.
  canEdit = allMode() ? currentUser.role === 'admin' || currentUser.teamIds.length > 0 : canEditTeam(teamId);
  canManageColumns = !allMode() && (currentUser.role === 'admin' || (currentUser.role === 'team_manager' && currentUser.teamIds.includes(teamId)));
  columnForm.hidden = !canManageColumns;
  exportButton.hidden = allMode();
  teamFilterField.hidden = !allMode();
  const [board, boardProjects] = await Promise.all([api(boardPath()), api('/projects'), loadConstraints()]);
  data = normalize(board);
  projects = boardProjects;
  selectedProject = 'all'; selectedTag = ''; selectedTeamFilter = '';
  render();
  history.replaceState(null, '', `?teamId=${teamId}${selectedOrder ? '&order=constraint' : ''}`);
}

function setCardParam(cardId) {
  const params = new URLSearchParams(location.search);
  if (cardId) params.set('card', cardId); else params.delete('card');
  history.replaceState(null, '', `?${params}`);
}

// ?card=<id> opens that card: on its own team's board, with archived cards shown if it is archived.
async function openRequestedCard(cardId) {
  let card;
  try { card = await requestJson(`/api/kanban/cards/${cardId}`); } catch { boardError.textContent = `Card #${cardId} was not found.`; return; }
  if (card.archived && !showArchived.checked) showArchived.checked = true;
  if (!allMode() && selectedTeamId !== card.teamId) { teamBoard.value = String(card.teamId); await selectTeam(card.teamId); }
  else if (card.archived) await reload();
  const shown = data.cards.find((item) => item.id === cardId);
  if (!shown) { boardError.textContent = `Card #${cardId} is not on this board.`; return; }
  openCard(shown.columnKey, shown);
}
teamBoard.addEventListener('change', () => { void selectTeam(teamBoard.value === ALL_BOARDS ? ALL_BOARDS : Number(teamBoard.value)).catch((error) => { boardError.textContent = error.message; }); });
try {
  currentUser = await requestJson('/api/auth/me');
  const teams = await requestJson('/api/teams');
  teamBoard.replaceChildren(...teams.map((team) => new Option(team.name, team.id)), ...(teams.length > 1 ? [new Option('All boards', ALL_BOARDS)] : []));
  // Read before selectTeam rewrites the address.
  const deepLink = requestedCard(location.search);
  const requestedParam = new URLSearchParams(location.search).get('teamId');
  const requested = Number(requestedParam);
  const initial = teams.find((team) => team.id === requested) || teams.find((team) => currentUser.teamIds.includes(team.id)) || teams[0];
  if (requestedParam === ALL_BOARDS && teams.length > 1) { teamBoard.value = ALL_BOARDS; await selectTeam(ALL_BOARDS); }
  else if (initial) { teamBoard.value = String(initial.id); await selectTeam(initial.id); }
  if (deepLink) await openRequestedCard(deepLink);
  liveUpdates(['kanban', 'projects', 'constraints'], async (kinds) => {
    if (!selectedTeamId) return;
    if (kinds.includes('constraints')) await loadConstraints();
    // Column lists scroll on their own; keep each where the viewer left it.
    const scrolls = new Map([...board.querySelectorAll('[data-column-id]')].map((element) => [element.dataset.columnId, element.querySelector('.kanban-card-list')?.scrollTop || 0]));
    const [nextData, nextProjects] = await Promise.all([
      kinds.includes('kanban') || kinds.includes('projects') ? api(boardPath()) : data,
      kinds.includes('projects') ? api('/projects') : projects,
    ]);
    data = nextData === data ? data : normalize(nextData);
    projects = nextProjects;
    render();
    board.querySelectorAll('[data-column-id]').forEach((element) => {
      const list = element.querySelector('.kanban-card-list');
      if (list) list.scrollTop = scrolls.get(element.dataset.columnId) || 0;
    });
  }, { busy: () => dragging });
} catch (error) { boardError.textContent = error.message; }
