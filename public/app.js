import {
  $, capacityForTeams, escapeHtml, isFocusProject, needsBlockedNote, requestJson, scoresFromPoint, showToast, syncRangeOutputs,
} from './browser-utils.js';
import { layoutProjectDots } from './matrix-geometry.js';
import {
  findFocusNowOccupant,
  projectLabel,
  projectStatusClass,
  projectStatusLabel,
  selectPortfolioProjects,
} from './portfolio-model.js';

const state = { user: null, projects: [], teams: [], selectedTeams: [], status: 'All', query: '', showCompleted: false, showArchived: false, dragged: null, pendingMove: null, pendingBlockedSave: null, pendingArchiveSave: null };
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
const matrixCard = $('#priority-matrix-card');
const projectPreview = $('#project-preview');
let previewHideTimer;
function syncTeamFilter() {
  const teams = state.teams.map((team) => team.name);
  state.selectedTeams = state.selectedTeams.filter((team) => teams.includes(team));
  $('#team-filter-label').textContent = !state.selectedTeams.length ? 'All teams' : state.selectedTeams.length === 1 ? state.selectedTeams[0] : `${state.selectedTeams.length} teams`;
  $('#team-filter-menu').innerHTML = `
    <label><input type="checkbox" value="All" ${state.selectedTeams.length ? '' : 'checked'}> All teams</label>
    ${teams.map((team) => `<label><input type="checkbox" value="${escapeHtml(team)}" ${state.selectedTeams.includes(team) ? 'checked' : ''}> ${escapeHtml(team)}</label>`).join('')}`;
  const teamSelect = form.elements.team;
  const currentTeam = teamSelect.value;
  const signature = teams.join('\u0000');
  if (teamSelect.dataset.teams !== signature) {
    teamSelect.replaceChildren(...teams.map((team) => new Option(team, team)));
    teamSelect.dataset.teams = signature;
    if (teams.includes(currentTeam)) teamSelect.value = currentTeam;
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

async function load() {
  try {
    state.user = await requestJson('/api/auth/me');
    document.body.classList.toggle('read-only', state.user.role !== 'admin');
    $('#current-user').textContent = `${state.user.username} · ${state.user.role === 'admin' ? 'Admin' : 'Read only'}`;
    document.querySelectorAll('[data-admin]').forEach((element) => { element.hidden = state.user.role !== 'admin'; });
    [state.projects, state.teams] = await Promise.all([request(), requestJson('/api/teams')]);
    render();
  } catch (error) {
    toast(error.message);
  }
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
    ? (portfolioProjects.some((project) => project.status === 'Complete') && !state.showCompleted ? 'Completed projects are hidden. Use “Show completed” above to include them.' : 'No projects match the current filters.')
    : 'Add current work, score it, and let the trade-offs become visible.';
  $('#empty-add').hidden = hasAnyProjects;
}

function renderMatrix(matrixProjects) {
  hideProjectPreview(true);
  matrix.querySelectorAll('.project-dot').forEach((element) => element.remove());
  const dots = matrixProjects.map((project) => {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = `project-dot status-${projectStatusClass(project)}`;
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
    if (state.user.role === 'admin') {
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

function renderProjectList(projects) {
  $('#project-list-title').textContent = !state.selectedTeams.length ? 'All projects' : `${state.selectedTeams.join(', ')} projects`;
  $('#list-count').textContent = `${projects.length} ${projects.length === 1 ? 'project' : 'projects'}`;
  $('#project-rows').innerHTML = projects.length ? projects.map((project) => `
    <article class="project-row ${project.archived ? 'archived' : ''}" data-id="${project.id}" tabindex="0" aria-label="Edit ${escapeHtml(project.name)}">
      <div><h3>${project.projectId ? `<small class="project-id">${escapeHtml(project.projectId)}</small>` : ''}${escapeHtml(project.name)}${project.externalUrl ? `<a class="source-link" data-external-link href="${escapeHtml(project.externalUrl)}" target="_blank" rel="noopener noreferrer" aria-label="Open external source for ${escapeHtml(project.name)}" title="Open external source">↗ Source</a>` : ''}${project.archived ? '<small class="archive-tag">Archived</small>' : ''}${project.status === 'Complete' && project.retrospective ? '<small class="retro-tag">Retrospective</small>' : ''}</h3><p class="description">${escapeHtml(project.description || 'No context added')}</p></div>
      <span class="meta team">${escapeHtml(project.team)}</span>
      <span class="badge ${projectStatusClass(project)}">${escapeHtml(projectStatusLabel(project))}</span>
      <span class="meta">I ${project.impact} · U ${project.urgency} · C ${project.confidence} · E ${project.effort} · ${project.capacity} ${project.capacity === 1 ? 'person' : 'people'}</span>
      <span class="score" title="Priority score">${project.score}</span>
    </article>`).join('') : '<p class="no-results">No projects match this view.</p>';
}

function render() {
  syncTeamFilter();
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
  renderProjectList(projects);
}
function projectFromTarget(target) {
  const row = target.closest('[data-id]');
  return row && state.projects.find((project) => project.id === Number(row.dataset.id));
}

function openDialog(project = null) {
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
    form.elements.team.value = state.selectedTeams[0] || state.teams[0]?.name || '';
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

async function openApiTokenDialog() {
  $('#api-token-result').hidden = true;
  $('#api-token-value').value = '';
  $('#api-token-error').textContent = '';
  $('#api-token-status').textContent = 'Checking token status…';
  $('#generate-api-token').textContent = 'Generate token';
  apiTokenDialog.showModal();
  try {
    const status = await requestJson('/api/api-token', undefined, 'Token status could not be loaded.');
    $('#api-token-status').textContent = status.configured
      ? status.managed ? 'A UI-generated token is active.' : 'An environment-configured token is active.'
      : 'No API token is active.';
    $('#generate-api-token').textContent = status.configured ? 'Replace token' : 'Generate token';
  } catch (error) { $('#api-token-error').textContent = error.message; }
}

async function generateApiToken() {
  const button = $('#generate-api-token');
  button.disabled = true;
  $('#api-token-error').textContent = '';
  try {
    const result = await requestJson('/api/api-token', { method:'POST' }, 'The API token could not be generated.');
    $('#api-token-value').value = result.token;
    $('#api-token-result').hidden = false;
    $('#api-token-status').textContent = 'Your new token is active.';
    button.textContent = 'Replace token';
    requestAnimationFrame(() => $('#api-token-value').select());
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
appMenu.addEventListener('toggle', () => {
  appMenu.querySelector('summary').setAttribute('aria-expanded', String(appMenu.open));
});
document.addEventListener('click', (event) => {
  if (appMenu.open && !appMenu.contains(event.target)) appMenu.open = false;
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && appMenu.open) {
    appMenu.open = false;
    appMenu.querySelector('summary').focus();
  }
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
blockedNoteForm.addEventListener('submit', saveBlockedProject);
$('#close-blocked-note').addEventListener('click', cancelBlockedSave);
$('#cancel-blocked-note').addEventListener('click', cancelBlockedSave);
archiveNoteForm.addEventListener('submit', saveArchiveProject);
$('#close-archive-note').addEventListener('click', cancelArchiveSave);
$('#cancel-archive-note').addEventListener('click', cancelArchiveSave);
form.addEventListener('submit', saveProject);
form.addEventListener('input', (event) => { if (event.target.type === 'range') syncOutputs(); });
form.addEventListener('change', (event) => { if (event.target.name === 'status' || event.target.name === 'scheduleStage') syncProjectFields(); });
document.addEventListener('click', (event) => { const project = projectFromTarget(event.target); if (state.user?.role === 'admin' && project && !event.target.closest('.project-dot,[data-external-link]')) openDialog(project); });
document.addEventListener('keydown', (event) => { if (state.user?.role === 'admin' && (event.key === 'Enter' || event.key === ' ') && event.target.matches('.project-row, .ranking article')) openDialog(projectFromTarget(event.target)); });
document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
  state.status = tab.dataset.status;
  state.showCompleted = state.status === 'Complete';
  $('#show-completed').checked = state.showCompleted;
  document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item === tab));
  render();
}));
$('#search').addEventListener('input', (event) => { state.query = event.target.value.trim(); render(); });
$('#team-filter-menu').addEventListener('change', (event) => {
  if (event.target.value === 'All') state.selectedTeams = [];
  else state.selectedTeams = [...$('#team-filter-menu').querySelectorAll('input:not([value="All"]):checked')].map((input) => input.value);
  render();
});
$('#show-completed').addEventListener('change', (event) => { state.showCompleted = event.target.checked; render(); });
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

load();
