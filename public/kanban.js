import { escapeHtml, requestJson, showToast } from './browser-utils.js';

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
let data = { columns: [], cards: [] };
let projects = [];
let canEdit = false;
let editingId = null;

function api(path = '', options) {
  return requestJson(`/api/kanban${path}`, options, 'The board could not be saved.');
}

function mutation(method, body) {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function render() {
  board.innerHTML = data.columns.length ? data.columns.map((column) => {
    const cards = data.cards.filter((card) => card.columnId === column.id);
    return `<section class="kanban-column" data-column-id="${column.id}" aria-label="${escapeHtml(column.name)}">
      <header class="kanban-column-head"><div><h2>${escapeHtml(column.name)}</h2><span>${cards.length}</span></div>${canEdit ? `<div class="kanban-column-actions"><button type="button" class="column-rename" aria-label="Rename ${escapeHtml(column.name)}" title="Rename column">✎</button><button type="button" class="column-delete" aria-label="Delete ${escapeHtml(column.name)}" title="Delete column">×</button></div>` : ''}</header>
      <div class="kanban-card-list">${cards.map((card) => `<article class="kanban-card" data-card-id="${card.id}" ${canEdit ? 'draggable="true"' : ''} tabindex="0" role="button" aria-label="${escapeHtml(card.title)}">
        <h3>${escapeHtml(card.title)}</h3>${card.description ? `<p>${escapeHtml(card.description)}</p>` : ''}
        ${card.projectId ? `<span class="kanban-project-tag">${escapeHtml(card.projectCode || card.projectName || 'Project')}<span>${card.projectCode ? escapeHtml(card.projectName) : ''}</span></span>` : '<span class="kanban-general-tag">General to do</span>'}
        ${card.noteCount ? `<span class="kanban-note-count">${card.noteCount} ${card.noteCount === 1 ? 'note' : 'notes'}</span>` : ''}
      </article>`).join('') || '<p class="kanban-column-empty">Drop cards here or add one below.</p>'}</div>
      ${canEdit ? `<button type="button" class="kanban-add-card">+ Add card</button>` : ''}
    </section>`;
  }).join('') : '<div class="kanban-board-empty"><h2>Your board starts with a column</h2><p>Add a column for the way you organize work, then fill it with cards.</p></div>';
}

function openCard(columnId, card = null) {
  editingId = card?.id || null;
  form.reset();
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
  form.querySelectorAll('input, textarea, select').forEach((field) => { field.disabled = !canEdit; });
  form.querySelector('.dialog-actions').hidden = !canEdit;
  notesSection.hidden = !card;
  noteForm.hidden = !canEdit;
  noteList.innerHTML = '';
  noteError.textContent = '';
  dialog.showModal();
  if (card) void loadNotes(card.id);
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

async function reload() {
  data = await api();
  render();
}

async function saveCard(event) {
  event.preventDefault();
  cardError.textContent = '';
  const payload = {
    title: form.elements.title.value,
    description: form.elements.description.value,
    columnId: Number(form.elements.columnId.value),
    projectId: form.elements.projectId.value ? Number(form.elements.projectId.value) : null,
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

board.addEventListener('click', async (event) => {
  const columnElement = event.target.closest('[data-column-id]');
  if (!columnElement) return;
  const columnId = Number(columnElement.dataset.columnId);
  const column = data.columns.find((item) => item.id === columnId);
  const cardElement = event.target.closest('[data-card-id]');
  if (canEdit && event.target.closest('.column-rename')) {
    const name = prompt('Column name', column.name);
    if (name === null || name.trim() === column.name) return;
    try { await api(`/columns/${columnId}`, mutation('PUT', { name })); await reload(); showToast('Column renamed'); }
    catch (error) { boardError.textContent = error.message; }
  } else if (canEdit && event.target.closest('.column-delete')) {
    const count = data.cards.filter((card) => card.columnId === columnId).length;
    if (!confirm(`Delete “${column.name}”${count ? ` and its ${count} card${count === 1 ? '' : 's'}` : ''}?`)) return;
    try { await api(`/columns/${columnId}`, { method: 'DELETE' }); await reload(); showToast('Column deleted'); }
    catch (error) { boardError.textContent = error.message; }
  } else if (canEdit && event.target.closest('.kanban-add-card')) openCard(columnId);
  else if (cardElement) openCard(columnId, data.cards.find((card) => card.id === Number(cardElement.dataset.cardId)));
});

board.addEventListener('keydown', (event) => {
  if (!['Enter', ' '].includes(event.key)) return;
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

try {
  const user = await requestJson('/api/auth/me');
  canEdit = user.role === 'admin';
  columnForm.hidden = !canEdit;
  [data, projects] = await Promise.all([api(), requestJson('/api/projects')]);
  render();
} catch (error) { boardError.textContent = error.message; }
