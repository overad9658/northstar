import { escapeHtml, requestJson, showToast } from './browser-utils.js';

const list = document.querySelector('#team-settings-list');
const addForm = document.querySelector('#add-team-form');
const errorMessage = document.querySelector('#team-form-error');
let teams = [];
let canEdit = false;
let currentUser;
let users = [];
let membersByTeam = new Map();
const canManage = (team) => currentUser?.role === 'admin' || (currentUser?.role === 'team_manager' && currentUser.teamIds.includes(team.id));

function teamRequest(path = '', options) {
  return requestJson(`/api/teams${path}`, options, 'Teams could not be saved.');
}

function render() {
  document.querySelector('#team-total').textContent = `${teams.reduce((sum, team) => sum + team.capacity, 0)} people total`;
  list.innerHTML = teams.length ? teams.map((team) => `
    <form class="team-settings-row" data-id="${team.id}">
      <label class="field"><span>Team</span><input name="name" maxlength="50" value="${escapeHtml(team.name)}" required ${canEdit ? '' : 'readonly'}></label>
      <label class="field"><span>People capacity</span><input name="capacity" type="number" min="${team.occupied}" max="9999" step="1" value="${team.capacity}" required ${canManage(team) ? '' : 'readonly'}></label>
      <div class="team-utilization"><span>Assigned</span><strong>${team.occupied} of ${team.capacity}</strong><small>${team.available} available · ${team.projectCount} ${team.projectCount === 1 ? 'project' : 'projects'}</small></div>
      <div class="team-row-actions"><a class="button secondary button-link" href="/?team=${encodeURIComponent(team.name)}">Matrix</a><a class="button secondary button-link" href="/kanban.html?teamId=${team.id}">Board</a>${canManage(team) ? '<button class="button secondary save-team" type="submit">Save</button>' : ''}${canEdit ? `<button class="text-danger delete-team" type="button" ${team.projectCount || team.cardCount || teams.length === 1 ? `disabled title="${team.projectCount || team.cardCount ? 'Move or delete this team’s projects and cards first' : 'At least one team must remain'}"` : ''}>Delete</button>` : ''}</div>
      <p class="form-error" role="alert"></p>
    </form>
    <div class="team-members" data-team-id="${team.id}"><strong>Members (${team.memberCount})</strong><div>${(membersByTeam.get(team.id) || []).map((member) => `<span class="team-member">${escapeHtml(member.username)}${canManage(team) ? ` <button class="remove-member" type="button" data-user-id="${member.id}" aria-label="Remove ${escapeHtml(member.username)} from ${escapeHtml(team.name)}">×</button>` : ''}</span>`).join('') || '<span>No members yet</span>'}</div>${canManage(team) ? `<form class="add-member-form"><select name="userId" aria-label="Add a team member" required><option value="">Choose a user</option>${users.filter((user) => !(membersByTeam.get(team.id) || []).some((member) => member.id === user.id)).map((user) => `<option value="${user.id}">${escapeHtml(user.username)} · ${user.role === 'team_manager' ? 'Team manager' : user.role === 'admin' ? 'Admin' : 'Member'}</option>`).join('')}</select><button class="button secondary" type="submit">Add member</button></form>` : ''}<p class="form-error"></p></div>`).join('') : '<div class="settings-empty"><h3>No teams configured</h3><p>Add a team above before creating projects.</p></div>';
}

async function load() {
  try {
    currentUser = await requestJson('/api/auth/me');
    canEdit = currentUser.role === 'admin';
    addForm.hidden = !canEdit;
    teams = await teamRequest();
    users = currentUser.role === 'admin' || currentUser.role === 'team_manager' ? await requestJson('/api/users') : [];
    membersByTeam = new Map(await Promise.all(teams.map(async (team) => [team.id, await teamRequest(`/${team.id}/members`)])));
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
    membersByTeam.set(teams.at(-1).id, []);
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
  if (!event.target.matches('.team-settings-row')) return;
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
  const removeMember = event.target.closest('.remove-member');
  if (removeMember) {
    const container = removeMember.closest('[data-team-id]');
    const teamId = Number(container.dataset.teamId), userId = Number(removeMember.dataset.userId);
    try { await teamRequest(`/${teamId}/members/${userId}`, { method:'DELETE' }); await load(); showToast('Member removed'); }
    catch (error) { container.querySelector('.form-error').textContent = error.message; }
    return;
  }
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

list.addEventListener('submit', async (event) => {
  if (!event.target.matches('.add-member-form')) return;
  event.preventDefault();
  const container = event.target.closest('[data-team-id]');
  const teamId = Number(container.dataset.teamId), userId = Number(event.target.elements.userId.value);
  try { await teamRequest(`/${teamId}/members`, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ userId }) }); await load(); showToast('Member added'); }
  catch (error) { container.querySelector('.form-error').textContent = error.message; }
});

load();
