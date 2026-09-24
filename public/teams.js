import { escapeHtml, requestJson, showToast } from './browser-utils.js';

const list = document.querySelector('#team-settings-list');
const addForm = document.querySelector('#add-team-form');
const errorMessage = document.querySelector('#team-form-error');
let teams = [];
let canEdit = false;

function teamRequest(path = '', options) {
  return requestJson(`/api/teams${path}`, options, 'Teams could not be saved.');
}

function render() {
  document.querySelector('#team-total').textContent = `${teams.reduce((sum, team) => sum + team.capacity, 0)} people total`;
  list.innerHTML = teams.length ? teams.map((team) => `
    <form class="team-settings-row" data-id="${team.id}">
      <label class="field"><span>Team</span><input name="name" maxlength="50" value="${escapeHtml(team.name)}" required ${canEdit ? '' : 'readonly'}></label>
      <label class="field"><span>People capacity</span><input name="capacity" type="number" min="${team.occupied}" max="9999" step="1" value="${team.capacity}" required ${canEdit ? '' : 'readonly'}></label>
      <div class="team-utilization"><span>Assigned</span><strong>${team.occupied} of ${team.capacity}</strong><small>${team.available} available · ${team.projectCount} ${team.projectCount === 1 ? 'project' : 'projects'}</small></div>
      <div class="team-row-actions" ${canEdit ? '' : 'hidden'}><button class="button secondary save-team" type="submit">Save</button><button class="text-danger delete-team" type="button" ${team.projectCount || teams.length === 1 ? `disabled title="${team.projectCount ? 'Move or delete this team’s projects first' : 'At least one team must remain'}"` : ''}>Delete</button></div>
      <p class="form-error" role="alert"></p>
    </form>`).join('') : '<div class="settings-empty"><h3>No teams configured</h3><p>Add a team above before creating projects.</p></div>';
}

async function load() {
  try {
    const user = await requestJson('/api/auth/me');
    canEdit = user.role === 'admin';
    addForm.hidden = !canEdit;
    teams = await teamRequest();
    render();
  } catch (error) {
    errorMessage.textContent = error.message;
  }
}

addForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorMessage.textContent = '';
  const data = Object.fromEntries(new FormData(addForm));
  data.capacity = Number(data.capacity);
  const button = addForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    teams.push(await teamRequest('', { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(data) }));
    teams.sort((a, b) => a.name.localeCompare(b.name));
    addForm.reset();
    render();
    showToast('Team added');
  } catch (error) {
    errorMessage.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

list.addEventListener('submit', async (event) => {
  event.preventDefault();
  const row = event.target.closest('.team-settings-row');
  const id = Number(row.dataset.id);
  const data = Object.fromEntries(new FormData(row));
  data.capacity = Number(data.capacity);
  const button = row.querySelector('.save-team');
  const rowError = row.querySelector('.form-error');
  button.disabled = true;
  rowError.textContent = '';
  try {
    const saved = await teamRequest(`/${id}`, { method:'PUT', headers:{ 'content-type':'application/json' }, body:JSON.stringify(data) });
    teams[teams.findIndex((team) => team.id === id)] = saved;
    teams.sort((a, b) => a.name.localeCompare(b.name));
    render();
    showToast('Team updated');
  } catch (error) {
    rowError.textContent = error.message;
    button.disabled = false;
  }
});

list.addEventListener('click', async (event) => {
  const button = event.target.closest('.delete-team');
  if (!button) return;
  const row = button.closest('.team-settings-row');
  const id = Number(row.dataset.id);
  const team = teams.find((item) => item.id === id);
  if (!team || !confirm(`Delete “${team.name}”?`)) return;
  button.disabled = true;
  try {
    await teamRequest(`/${id}`, { method:'DELETE' });
    teams = teams.filter((item) => item.id !== id);
    render();
    showToast('Team deleted');
  } catch (error) {
    row.querySelector('.form-error').textContent = error.message;
    button.disabled = false;
  }
});

load();
