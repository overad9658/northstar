import { escapeHtml, requestJson, showToast } from './browser-utils.js';
import { liveUpdates } from './live-updates.js';

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
let dragging = false;
let editingCard = null;

function boardPath() {
  return showArchived.checked ? '?archived=include' : '';
}

function api(path = '', options) {
  return requestJson(`/api/kanban${path}${path.includes('?') ? '&' : '?'}teamId=${selectedTeamId}`, options, 'The board could not be saved.');
}

function mutation(method, body) {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function render() {
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
  board.innerHTML = data.columns.length ? data.columns.map((column) => {
    const cards = data.cards.filter((card) => card.columnId === column.id
      && (!selectedTag || card.tags?.includes(selectedTag))
      && (!selectedAssignee || (selectedAssignee === 'none' ? !card.assignee : card.assignee === selectedAssignee))
      && (selectedDecision !== 'open' || (card.decision && !card.decision.decidedOption))
      && (selectedProject === 'all' || (selectedProject === 'none' ? card.projectId === null : String(card.projectId) === selectedProject)));
    return `<section class="kanban-column" data-column-id="${column.id}" aria-label="${escapeHtml(column.name)}">
      <header class="kanban-column-head"><div><h2>${escapeHtml(column.name)}</h2><span>${cards.length}</span></div>${canManageColumns ? `<div class="kanban-column-actions"><button type="button" class="column-rename" aria-label="Rename ${escapeHtml(column.name)}" title="Rename column">✎</button><button type="button" class="column-delete" aria-label="Delete ${escapeHtml(column.name)}" title="Delete column">×</button></div>` : ''}</header>
      <div class="kanban-card-list">${cards.map((card) => `<article class="kanban-card${card.archived ? ' archived' : ''}" data-card-id="${card.id}" ${canEdit ? 'draggable="true"' : ''} tabindex="0" role="button" aria-label="${escapeHtml(card.title)}">
        ${card.archived ? '<span class="kanban-archived-tag">Archived</span>' : ''}<h3>${escapeHtml(card.title)}</h3>${card.description ? `<p>${escapeHtml(card.description)}</p>` : ''}
        ${card.assignee ? `<span class="kanban-assignee" title="Assignee">${escapeHtml(card.assignee)}</span>` : ''}
        ${card.nextStep ? `<p class="kanban-next-step"><strong>Next</strong> ${escapeHtml(card.nextStep)}</p>` : ''}
        ${card.decision ? `<span class="kanban-decision-tag${card.decision.decidedOption ? ' decided' : ''}">${card.decision.decidedOption
    ? `Decided: ${escapeHtml(card.decision.decidedOption)}`
    : `Decision open${card.decision.recommendation ? ` · recommends ${escapeHtml(card.decision.recommendation)}${card.decision.confidence === null ? '' : ` (${card.decision.confidence}%)`}` : ''}`}</span>` : ''}
        ${card.externalUrl ? `<a class="kanban-card-link" href="${escapeHtml(card.externalUrl)}" target="_blank" rel="noopener noreferrer" draggable="false" title="${escapeHtml(card.externalUrl)}">↗ Link</a>` : ''}
        ${card.projectId ? `<span class="kanban-project-tag">${escapeHtml(card.projectCode || card.projectName || 'Project')}<span>${card.projectCode ? escapeHtml(card.projectName) : ''}</span></span>` : '<span class="kanban-general-tag">General to do</span>'}
        ${(card.tags || []).length ? `<div class="kanban-tags">${card.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div>` : ''}
        ${card.noteCount ? `<span class="kanban-note-count">${card.noteCount} ${card.noteCount === 1 ? 'note' : 'notes'}</span>` : ''}
      </article>`).join('') || `<p class="kanban-column-empty">${selectedTag || selectedAssignee || selectedDecision || selectedProject !== 'all' ? 'No cards match these filters.' : 'Drop cards here or add one below.'}</p>`}</div>
      ${canEdit ? `<button type="button" class="kanban-add-card">+ Add card</button>` : ''}
    </section>`;
  }).join('') : '<div class="kanban-board-empty"><h2>Your board starts with a column</h2><p>Add a column for the way you organize work, then fill it with cards.</p></div>';
}

function openCard(columnId, card = null) {
  editingId = card?.id || null;
  editingCard = card;
  form.reset();
  archiveButton.hidden = !card;
  archiveButton.textContent = card?.archived ? 'Restore card' : 'Archive card';
  cardError.textContent = '';
  dialog.classList.toggle('editing', Boolean(card));
  document.querySelector('#card-dialog-kicker').textContent = card ? 'Edit card' : 'New card';
  document.querySelector('#card-dialog-title').textContent = card ? card.title : 'Add a card';
  form.elements.columnId.innerHTML = data.columns.map((column) => `<option value="${column.id}">${escapeHtml(column.name)}</option>`).join('');
  form.elements.projectId.innerHTML = '<option value="">No project — general to do</option>' + projects.map((project) => `<option value="${project.id}">${escapeHtml(project.projectId ? `${project.projectId} · ${project.name}` : project.name)}</option>`).join('');
  form.elements.columnId.value = card?.columnId || columnId;
  form.elements.projectId.value = card?.projectId || '';
  form.elements.title.value = card?.title || '';
  form.elements.description.value = card?.description || '';
  form.elements.assignee.value = card?.assignee || '';
  form.elements.externalUrl.value = card?.externalUrl || '';
  form.elements.nextStep.value = card?.nextStep || '';
  fillDecision(card?.decision || null);
  form.elements.tags.value = card?.tags?.join(', ') || '';
  form.querySelectorAll('input, textarea, select').forEach((field) => { field.disabled = !canEdit; });
  form.querySelector('.dialog-actions').hidden = !canEdit;
  notesSection.hidden = !card;
  historySection.hidden = !card;
  noteForm.hidden = !canEdit;
  noteList.innerHTML = '';
  historyList.innerHTML = '';
  noteError.textContent = '';
  dialog.showModal();
  if (card) { void loadNotes(card.id); void loadHistory(card.id); }
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

async function reload() {
  data = await api(boardPath());
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
    columnId: Number(form.elements.columnId.value),
    projectId: form.elements.projectId.value ? Number(form.elements.projectId.value) : null,
    tags: form.elements.tags.value.split(',').map((tag) => tag.trim()).filter(Boolean),
  };
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    const wasEditing = Boolean(editingId);
    const saved = await api(`/cards${editingId ? `/${editingId}` : ''}`, mutation(editingId ? 'PUT' : 'POST', payload));
    await reload();
    dialog.close();
    if (!wasEditing) openCard(saved.columnId, saved);
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
showArchived.addEventListener('change', () => { reload().catch((error) => { boardError.textContent = error.message; }); });
archiveButton.addEventListener('click', async () => {
  if (!editingCard) return;
  const archived = !editingCard.archived;
  try { await api(`/cards/${editingCard.id}`, mutation('PUT', { archived })); dialog.close(); await reload(); showToast(archived ? 'Card archived' : 'Card restored'); }
  catch (error) { cardError.textContent = error.message; }
});
form.elements.decisionOptions.addEventListener('input', () => setDecisionChoices(decisionOptions(), form.elements.decidedOption.value));

board.addEventListener('click', async (event) => {
  if (event.target.closest('.kanban-card-link')) return;
  const columnElement = event.target.closest('[data-column-id]');
  if (!columnElement) return;
  const columnId = Number(columnElement.dataset.columnId);
  const column = data.columns.find((item) => item.id === columnId);
  const cardElement = event.target.closest('[data-card-id]');
  if (canManageColumns && event.target.closest('.column-rename')) {
    const name = prompt('Column name', column.name);
    if (name === null || name.trim() === column.name) return;
    try { await api(`/columns/${columnId}`, mutation('PUT', { name })); await reload(); showToast('Column renamed'); }
    catch (error) { boardError.textContent = error.message; }
  } else if (canManageColumns && event.target.closest('.column-delete')) {
    const count = data.cards.filter((card) => card.columnId === columnId).length;
    if (!confirm(`Delete “${column.name}”${count ? ` and its ${count} card${count === 1 ? '' : 's'}` : ''}?`)) return;
    try { await api(`/columns/${columnId}`, { method: 'DELETE' }); await reload(); showToast('Column deleted'); }
    catch (error) { boardError.textContent = error.message; }
  } else if (canEdit && event.target.closest('.kanban-add-card')) openCard(columnId);
  else if (cardElement) openCard(columnId, data.cards.find((card) => card.id === Number(cardElement.dataset.cardId)));
});

board.addEventListener('keydown', (event) => {
  if (!['Enter', ' '].includes(event.key) || event.target.closest('.kanban-card-link')) return;
  const cardElement = event.target.closest('[data-card-id]');
  if (!cardElement) return;
  event.preventDefault();
  const card = data.cards.find((item) => item.id === Number(cardElement.dataset.cardId));
  openCard(card.columnId, card);
});

board.addEventListener('dragstart', (event) => {
  if (!canEdit) return;
  const cardElement = event.target.closest('[data-card-id]');
  if (!cardElement) return;
  dragging = true;
  event.dataTransfer.setData('text/plain', cardElement.dataset.cardId);
  event.dataTransfer.effectAllowed = 'move';
});
board.addEventListener('dragover', (event) => {
  if (!canEdit || !event.dataTransfer.types.includes('text/plain')) return;
  const columnElement = event.target.closest('[data-column-id]');
  if (!columnElement) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  board.querySelectorAll('.drop-target').forEach((element) => element.classList.remove('drop-target'));
  columnElement.classList.add('drop-target');
});
board.addEventListener('dragleave', (event) => {
  const columnElement = event.target.closest('[data-column-id]');
  if (columnElement && !columnElement.contains(event.relatedTarget)) columnElement.classList.remove('drop-target');
});
board.addEventListener('drop', async (event) => {
  const columnElement = event.target.closest('[data-column-id]');
  board.querySelectorAll('.drop-target').forEach((element) => element.classList.remove('drop-target'));
  if (!canEdit || !columnElement) return;
  event.preventDefault();
  const cardId = Number(event.dataTransfer.getData('text/plain'));
  const card = data.cards.find((item) => item.id === cardId);
  const columnId = Number(columnElement.dataset.columnId);
  if (!card || card.columnId === columnId) return;
  try { await api(`/cards/${cardId}`, mutation('PUT', { columnId })); await reload(); showToast('Card moved'); }
  catch (error) { boardError.textContent = error.message; }
});
board.addEventListener('dragend', () => dragging = false);
board.addEventListener('dragend', () => board.querySelectorAll('.drop-target').forEach((element) => element.classList.remove('drop-target')));

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
document.querySelector('#cancel-card').addEventListener('click', () => dialog.close());

async function selectTeam(teamId) {
  selectedTeamId = teamId;
  canEdit = currentUser.role === 'admin' || currentUser.teamIds.includes(teamId);
  canManageColumns = currentUser.role === 'admin' || (currentUser.role === 'team_manager' && currentUser.teamIds.includes(teamId));
  columnForm.hidden = !canManageColumns;
  [data, projects] = await Promise.all([api(boardPath()), api('/projects')]);
  selectedProject = 'all'; selectedTag = '';
  render();
  history.replaceState(null, '', `?teamId=${teamId}`);
}
teamBoard.addEventListener('change', () => { void selectTeam(Number(teamBoard.value)).catch((error) => { boardError.textContent = error.message; }); });
try {
  currentUser = await requestJson('/api/auth/me');
  const teams = await requestJson('/api/teams');
  teamBoard.replaceChildren(...teams.map((team) => new Option(team.name, team.id)));
  const requested = Number(new URLSearchParams(location.search).get('teamId'));
  const initial = teams.find((team) => team.id === requested) || teams.find((team) => currentUser.teamIds.includes(team.id)) || teams[0];
  if (initial) { teamBoard.value = String(initial.id); await selectTeam(initial.id); }
  liveUpdates(['kanban', 'projects'], async (kinds) => {
    if (!selectedTeamId) return;
    // Column lists scroll on their own; keep each where the viewer left it.
    const scrolls = new Map([...board.querySelectorAll('[data-column-id]')].map((element) => [element.dataset.columnId, element.querySelector('.kanban-card-list')?.scrollTop || 0]));
    const [nextData, nextProjects] = await Promise.all([
      kinds.includes('kanban') || kinds.includes('projects') ? api(boardPath()) : data,
      kinds.includes('projects') ? api('/projects') : projects,
    ]);
    data = nextData;
    projects = nextProjects;
    render();
    board.querySelectorAll('[data-column-id]').forEach((element) => {
      const list = element.querySelector('.kanban-card-list');
      if (list) list.scrollTop = scrolls.get(element.dataset.columnId) || 0;
    });
  }, { busy: () => dragging });
} catch (error) { boardError.textContent = error.message; }
