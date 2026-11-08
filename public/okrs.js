import { escapeHtml, requestJson, showToast } from './browser-utils.js';

const list = document.querySelector('#okr-list');
const pageError = document.querySelector('#okr-error');
const objectiveDialog = document.querySelector('#objective-dialog');
const resultDialog = document.querySelector('#result-dialog');
const objectiveForm = document.querySelector('#objective-form');
const resultForm = document.querySelector('#result-form');
let objectives = [];
let options = { projects: [], tasks: [] };
let user;
let editingObjective = null;
let editingResult = null;
let parentObjective = null;

const canEdit = () => user && user.role !== 'read_only';
const canLink = (teamId) => user.role === 'admin' || user.teamIds.includes(teamId);
const api = (path = '', method = 'GET', data) => requestJson(`/api/okrs${path}`, { method, ...(data === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }) }, 'OKRs could not be saved.');
const progress = (current, target) => Math.min(100, Math.round(current / target * 100));

function render() {
  if (!objectives.length) {
    list.innerHTML = `<div class="okr-empty"><span aria-hidden="true">◎</span><h2>No objectives yet</h2><p>Start with a clear outcome, then add measurable key results and the work behind them.</p>${canEdit() ? '<button class="button primary" data-action="new-objective" type="button">Add your first objective</button>' : ''}</div>`;
    return;
  }
  list.innerHTML = objectives.map((objective) => {
    const average = objective.keyResults.length ? Math.round(objective.keyResults.reduce((sum, kr) => sum + progress(kr.current, kr.target), 0) / objective.keyResults.length) : 0;
    return `<article class="okr-objective" data-objective-id="${objective.id}">
      <header class="okr-objective-head"><div><span class="okr-period">${escapeHtml(objective.period || 'Objective')}</span><h2>${escapeHtml(objective.title)}</h2>${objective.description ? `<p>${escapeHtml(objective.description)}</p>` : ''}</div><div class="okr-objective-actions"><strong>${average}%</strong><span>overall progress</span>${canEdit() ? `<button class="okr-text-button" data-action="edit-objective" type="button">Edit objective</button>` : ''}</div></header>
      <div class="okr-results">${objective.keyResults.length ? objective.keyResults.map((kr) => renderResult(kr)).join('') : '<p class="okr-no-results">Add a key result to measure this objective.</p>'}</div>
      ${canEdit() ? '<footer class="okr-objective-foot"><button class="button secondary" data-action="new-result" type="button">+ Add key result</button></footer>' : ''}
    </article>`;
  }).join('');
}

function renderResult(kr) {
  const percent = progress(kr.current, kr.target);
  const projectChoices = options.projects.filter((p) => canLink(p.teamId) && !kr.projects.some((linked) => linked.id === p.id));
  const taskChoices = options.tasks.filter((task) => canLink(task.teamId) && !kr.tasks.some((linked) => linked.id === task.id));
  return `<section class="okr-result" data-result-id="${kr.id}">
    <div class="okr-result-head"><div><h3>${escapeHtml(kr.title)}</h3><span>${kr.current.toLocaleString()} of ${kr.target.toLocaleString()} · ${percent}%</span></div>${canEdit() ? '<button class="okr-text-button" data-action="edit-result" type="button">Update result</button>' : ''}</div>
    <progress class="okr-progress" aria-label="${escapeHtml(kr.title)}" value="${percent}" max="100">${percent}%</progress>
    <div class="okr-work-grid"><div class="okr-work"><h4>Projects <span>${kr.projects.length}</span></h4><ul>${kr.projects.map((p) => `<li><a href="/">${escapeHtml(p.code ? `${p.code} · ${p.name}` : p.name)}</a>${canEdit() ? `<button data-action="unlink-project" data-id="${p.id}" type="button" aria-label="Remove ${escapeHtml(p.name)} from key result">×</button>` : ''}</li>`).join('') || '<li class="okr-muted">No projects linked</li>'}</ul>${canEdit() ? `<form class="okr-link-form" data-type="projects"><select name="id" aria-label="Choose project" required><option value="">Choose project</option>${projectChoices.map((p) => `<option value="${p.id}">${escapeHtml(p.code ? `${p.code} · ${p.name}` : p.name)}</option>`).join('')}</select><button class="button secondary" type="submit" ${projectChoices.length ? '' : 'disabled'}>Add</button></form><a class="okr-create-link" href="/">Create a project ↗</a>` : ''}</div>
    <div class="okr-work"><h4>Tasks <span>${kr.tasks.length}</span></h4><ul>${kr.tasks.map((task) => `<li><a href="/kanban.html?teamId=${task.teamId}">${escapeHtml(task.title)}</a>${canEdit() ? `<button data-action="unlink-task" data-id="${task.id}" type="button" aria-label="Remove ${escapeHtml(task.title)} from key result">×</button>` : ''}</li>`).join('') || '<li class="okr-muted">No tasks linked</li>'}</ul>${canEdit() ? `<form class="okr-link-form" data-type="tasks"><select name="id" aria-label="Choose task" required><option value="">Choose task</option>${taskChoices.map((task) => `<option value="${task.id}">${escapeHtml(task.title)}</option>`).join('')}</select><button class="button secondary" type="submit" ${taskChoices.length ? '' : 'disabled'}>Add</button></form><a class="okr-create-link" href="/kanban.html">Create a task ↗</a>` : ''}</div></div>
  </section>`;
}

async function reload() {
  [objectives, options] = await Promise.all([api(), api('/options')]);
  render();
}

function openObjective(objective) {
  editingObjective = objective || null;
  objectiveForm.reset();
  objectiveForm.elements.title.value = objective?.title || '';
  objectiveForm.elements.period.value = objective?.period || '';
  objectiveForm.elements.description.value = objective?.description || '';
  objectiveDialog.querySelector('h2').textContent = objective ? 'Edit objective' : 'Add objective';
  objectiveForm.querySelector('[data-delete]').hidden = !objective;
  objectiveForm.querySelector('.form-error').textContent = '';
  objectiveDialog.showModal();
  objectiveForm.elements.title.focus();
}

function openResult(objectiveId, kr) {
  parentObjective = objectiveId;
  editingResult = kr || null;
  resultForm.reset();
  resultForm.elements.title.value = kr?.title || '';
  resultForm.elements.current.value = kr?.current ?? 0;
  resultForm.elements.target.value = kr?.target ?? 100;
  resultDialog.querySelector('h2').textContent = kr ? 'Update key result' : 'Add key result';
  resultForm.querySelector('[data-delete]').hidden = !kr;
  resultForm.querySelector('.form-error').textContent = '';
  resultDialog.showModal();
  resultForm.elements.title.focus();
}

document.querySelector('#add-objective').addEventListener('click', () => openObjective());
for (const dialog of [objectiveDialog, resultDialog]) dialog.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => dialog.close()));

objectiveForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = objectiveForm.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    await api(editingObjective ? `/${editingObjective.id}` : '', editingObjective ? 'PUT' : 'POST', Object.fromEntries(new FormData(objectiveForm)));
    objectiveDialog.close(); await reload(); showToast(editingObjective ? 'Objective updated' : 'Objective added');
  } catch (error) { objectiveForm.querySelector('.form-error').textContent = error.message; }
  finally { button.disabled = false; }
});
resultForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = resultForm.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    const values = Object.fromEntries(new FormData(resultForm));
    await api(editingResult ? `/${parentObjective}/key-results/${editingResult.id}` : `/${parentObjective}/key-results`, editingResult ? 'PUT' : 'POST', values);
    resultDialog.close(); await reload(); showToast(editingResult ? 'Key result updated' : 'Key result added');
  } catch (error) { resultForm.querySelector('.form-error').textContent = error.message; }
  finally { button.disabled = false; }
});

objectiveForm.querySelector('[data-delete]').addEventListener('click', async () => {
  if (!confirm('Delete this objective and all its key results? Linked projects and tasks will stay in Northstar.')) return;
  try { await api(`/${editingObjective.id}`, 'DELETE'); objectiveDialog.close(); await reload(); showToast('Objective deleted'); }
  catch (error) { objectiveForm.querySelector('.form-error').textContent = error.message; }
});
resultForm.querySelector('[data-delete]').addEventListener('click', async () => {
  if (!confirm('Delete this key result? Linked projects and tasks will stay in Northstar.')) return;
  try { await api(`/${parentObjective}/key-results/${editingResult.id}`, 'DELETE'); resultDialog.close(); await reload(); showToast('Key result deleted'); }
  catch (error) { resultForm.querySelector('.form-error').textContent = error.message; }
});

list.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'new-objective') return openObjective();
  const objective = objectives.find((item) => item.id === Number(button.closest('[data-objective-id]')?.dataset.objectiveId));
  if (!objective) return;
  const kr = objective.keyResults.find((item) => item.id === Number(button.closest('[data-result-id]')?.dataset.resultId));
  if (action === 'edit-objective') return openObjective(objective);
  if (action === 'new-result') return openResult(objective.id);
  if (action === 'edit-result') return openResult(objective.id, kr);
  if (!kr) return;
  if (action === 'unlink-project' || action === 'unlink-task') {
    button.disabled = true;
    try { await api(`/${objective.id}/key-results/${kr.id}/${action === 'unlink-project' ? 'projects' : 'tasks'}/${button.dataset.id}`, 'DELETE'); await reload(); showToast('Link removed'); }
    catch (error) { pageError.textContent = error.message; button.disabled = false; }
  }
});

list.addEventListener('submit', async (event) => {
  const form = event.target.closest('.okr-link-form');
  if (!form) return;
  event.preventDefault();
  const objectiveId = form.closest('[data-objective-id]').dataset.objectiveId;
  const resultId = form.closest('[data-result-id]').dataset.resultId;
  const button = form.querySelector('button');
  button.disabled = true;
  pageError.textContent = '';
  try { await api(`/${objectiveId}/key-results/${resultId}/${form.dataset.type}`, 'POST', { id: Number(form.elements.id.value) }); await reload(); showToast(form.dataset.type === 'projects' ? 'Project linked' : 'Task linked'); }
  catch (error) { pageError.textContent = error.message; button.disabled = false; }
});

async function load() {
  try {
    user = await requestJson('/api/auth/me');
    document.querySelector('#add-objective').hidden = !canEdit();
    await reload();
  } catch (error) { pageError.textContent = error.message; }
}
load();
