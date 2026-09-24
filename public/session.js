import {
  $, SCORE_FIELDS, escapeHtml, initials, matrixPosition, requestJson, scoresFromPoint, showToast, syncRangeOutputs,
} from './browser-utils.js';

const params = new URLSearchParams(location.search);
const token = params.get('room');
const leaderKey = params.get('leader');
const isLeader = Boolean(leaderKey);
const scoreKeys = SCORE_FIELDS;
const palette = ['#567e9e', '#9a6d9d', '#b46e5c', '#438475', '#b18743', '#6270a6', '#8a6c57'];
const state = {
  room: null,
  activeProjectId: null,
  voterToken: localStorage.getItem(`northstar-voter-${token}`) || '',
  voterName: '',
  formProjectId: null,
  decisions: {},
  conflictProjectIds: [],
};
let roomRequestInFlight = false;

function activeProject() { return state.room?.projects.find((project) => project.id === state.activeProjectId); }
function activeVotes() { return (state.room?.votes || []).filter((vote) => vote.projectId === state.activeProjectId); }

async function request(path = '', options) {
  const query = !path && state.voterToken ? `?voterToken=${encodeURIComponent(state.voterToken)}` : '';
  return requestJson(`/api/sessions/${encodeURIComponent(token)}${path}${query}`, options, 'The room could not be updated.');
}

function decisionValues() {
  return Object.fromEntries(scoreKeys.map((key) => [key, Number($(`#decision-scores [name="${key}"]`).value)]));
}

function setDecision(scores, projectId = state.activeProjectId) {
  state.decisions[projectId] = Object.fromEntries(scoreKeys.map((key) => [key, Number(scores[key])]));
  if (projectId === state.activeProjectId) {
    scoreKeys.forEach((key) => { $(`#decision-scores [name="${key}"]`).value = scores[key]; });
    syncRangeOutputs($('#decision-scores'));
    renderPins();
  }
}

function initializeForms(force = false) {
  const project = activeProject();
  if (!project || (!force && state.formProjectId === project.id)) return;
  state.formProjectId = project.id;
  $('#decision-comment').value = '';
  const mine = activeVotes().find((vote) => vote.isMine);
  const startingScores = mine || project;
  scoreKeys.forEach((key) => { $(`#vote-form [name="${key}"]`).value = startingScores[key]; });
  if (mine) {
    state.voterName = mine.voterName;
    $('#voter-name').value = mine.voterName;
    $('#vote-message').textContent = 'You have already scored this project. Submit again to update it.';
  } else {
    $('#voter-name').value = state.voterName;
    $('#vote-message').textContent = '';
  }
  syncRangeOutputs($('#vote-form'));

  if (isLeader) {
    const finalScores = Number.isInteger(project.finalImpact)
      ? { impact:project.finalImpact, urgency:project.finalUrgency, confidence:project.finalConfidence, effort:project.finalEffort }
      : project;
    if (!state.decisions[project.id]) setDecision(finalScores, project.id);
    else setDecision(state.decisions[project.id], project.id);
  }
}

function renderPins() {
  const matrix = $('#room-matrix');
  matrix.querySelectorAll('.vote-pin,.current-project-pin').forEach((pin) => pin.remove());
  const project = activeProject();
  if (!project) return;
  const currentPin = document.createElement('div');
  currentPin.className = 'current-project-pin';
  const currentPosition = matrixPosition(project.impact, project.urgency);
  currentPin.style.left = `${currentPosition.left}%`;
  currentPin.style.bottom = `${currentPosition.bottom}%`;
  currentPin.innerHTML = '<span>Current position</span>';
  currentPin.title = `Current project position: impact ${project.impact}, urgency ${project.urgency}`;
  matrix.append(currentPin);
  const votes = activeVotes().filter((vote) => Number.isInteger(vote.impact));
  votes.forEach((vote, index) => {
    const pin = document.createElement('button');
    pin.type = 'button';
    pin.className = 'vote-pin';
    pin.style.setProperty('--pin', palette[index % palette.length]);
    const position = matrixPosition(vote.impact, vote.urgency);
    pin.style.left = `${position.left}%`;
    pin.style.bottom = `${position.bottom}%`;
    pin.innerHTML = `${escapeHtml(initials(vote.voterName))}<span>${escapeHtml(vote.voterName)}</span>`;
    pin.title = `${vote.voterName}: impact ${vote.impact}, urgency ${vote.urgency}, confidence ${vote.confidence}, effort ${vote.effort}`;
    if (isLeader && activeProject()?.status === 'Open' && activeProject().revealed) pin.addEventListener('click', (event) => { event.stopPropagation(); setDecision(vote); showToast(`Using ${vote.voterName}’s scores`); });
    matrix.append(pin);
  });
  if (isLeader && activeProject()?.revealed && state.decisions[state.activeProjectId]) {
    const scores = state.decisions[state.activeProjectId];
    const pin = document.createElement('div');
    pin.className = 'vote-pin decision-pin';
    const position = matrixPosition(scores.impact, scores.urgency);
    pin.style.left = `${position.left}%`;
    pin.style.bottom = `${position.bottom}%`;
    pin.textContent = '★';
    pin.title = 'Leader placement';
    matrix.append(pin);
  }
}

function selectProject(projectId) {
  if (!state.room?.projects.some((project) => project.id === projectId)) return;
  state.activeProjectId = projectId;
  state.formProjectId = null;
  render();
}

function renderRoomHeader(room, project, votes, visibleVotes) {
  const decidedCount = room.projects.filter((item) => item.status === 'Decided').length;
  document.title = `${project.name} — Northstar Planning Room`;
  $('#project-name').textContent = project.name;
  $('#project-description').textContent = project.description || 'Score the project independently, then compare perspectives with the team.';
  $('#room-code').textContent = `#${room.token.slice(0, 6).toUpperCase()}`;
  $('#participant-count').textContent = room.participantCount;
  $('#room-status-text').textContent = room.status === 'Open' ? `${decidedCount}/${room.projects.length} placed · updating live` : 'Room complete';
  $('.room-status').classList.toggle('closed', room.status === 'Closed');
  $('#closed-banner').hidden = project.status !== 'Decided';
  $('#room-empty').classList.toggle('hidden', visibleVotes.length > 0);
  $('#room-empty-title').textContent = votes.length ? 'Votes are locked' : 'Waiting for the first vote';
  $('#room-empty-copy').textContent = votes.length ? `${votes.length} ${votes.length === 1 ? 'response is' : 'responses are'} ready. The leader can reveal them together.` : 'Votes stay private until the leader reveals them.';
  $('#leader-card').hidden = !isLeader;
  $('#leader-hint').hidden = !isLeader || !project.revealed || project.status === 'Decided';
  document.body.classList.toggle('leader-mode', isLeader && project.revealed);
}

function renderProjectQueue(room, project) {
  $('#project-queue-tabs').innerHTML = room.projects.map((item, index) => {
    const count = room.votes.filter((vote) => vote.projectId === item.id).length;
    return `<button class="queue-tab ${item.id === project.id ? 'active' : ''} ${item.status === 'Decided' ? 'decided' : ''} ${state.conflictProjectIds.includes(item.id) ? 'conflict' : ''}" data-project="${item.id}" type="button">${index + 1}. ${escapeHtml(item.projectCode || item.name)}<span class="queue-count">${count}</span></button>`;
  }).join('');
}

function renderVoteList(project, votes) {
  $('#vote-list').innerHTML = votes.length ? votes.map((vote, index) => `
    <article class="vote-row ${Number.isInteger(vote.impact) ? '' : 'locked'}" data-vote="${vote.id}" style="border-left:3px solid ${palette[index % palette.length]}">
      <header><h3>${escapeHtml(vote.voterName)}${vote.isMine ? ' <small>(you)</small>' : ''}</h3><span>${Number.isInteger(vote.impact) ? `I ${vote.impact} · U ${vote.urgency}` : '🔒 Private'}</span></header>
      ${Number.isInteger(vote.impact) ? `<div class="vote-values"><span>Impact<strong>${vote.impact}</strong></span><span>Urgency<strong>${vote.urgency}</strong></span><span>Confidence<strong>${vote.confidence}</strong></span><span>Effort<strong>${vote.effort}</strong></span></div>` : '<p class="locked-vote">Vote locked in until the leader reveals the round.</p>'}
    </article>`).join('') : '<p class="no-votes">Responses for this project will appear here as people vote.</p>';
  if (isLeader && project.revealed && project.status === 'Open') {
    document.querySelectorAll('.vote-row:not(.locked)').forEach((row) => row.addEventListener('click', () => {
      const vote = votes.find((item) => item.id === Number(row.dataset.vote));
      setDecision(vote);
      showToast(`Using ${vote.voterName}’s scores`);
    }));
  }
}

function renderSpread(project, votes, visibleVotes) {
  if (!project.revealed && votes.length) {
    $('#spread-label').textContent = `${votes.length} locked ${votes.length === 1 ? 'response' : 'responses'}`;
  } else if (visibleVotes.length > 1) {
    const impactValues = visibleVotes.map((vote) => vote.impact);
    const urgencyValues = visibleVotes.map((vote) => vote.urgency);
    $('#spread-label').textContent = `Spread: impact ${Math.max(...impactValues) - Math.min(...impactValues)} · urgency ${Math.max(...urgencyValues) - Math.min(...urgencyValues)}`;
  } else {
    $('#spread-label').textContent = visibleVotes.length ? '1 response' : 'No responses yet';
  }
}

function render() {
  const room = state.room;
  if (!room) return;
  if (!state.activeProjectId || !room.projects.some((project) => project.id === state.activeProjectId)) {
    state.activeProjectId = (room.projects.find((project) => project.status === 'Open') || room.projects[0]).id;
  }
  const project = activeProject();
  const votes = activeVotes();
  const visibleVotes = votes.filter((vote) => Number.isInteger(vote.impact));
  renderRoomHeader(room, project, votes, visibleVotes);
  renderProjectQueue(room, project);
  initializeForms();
  renderPins();

  const disabled = project.status === 'Decided';
  $('#vote-form').querySelectorAll('input,button').forEach((control) => { control.disabled = disabled; });
  if (isLeader) {
    $('#leader-card').querySelectorAll('input,textarea,button').forEach((control) => { control.disabled = disabled || !project.revealed; });
    $('#reveal-votes').disabled = disabled || Boolean(project.revealed);
    $('#reveal-votes').textContent = project.revealed ? 'Votes revealed' : `Reveal votes${votes.length ? ` (${votes.length})` : ''}`;
  }
  renderVoteList(project, votes);
  renderSpread(project, votes, visibleVotes);
}
async function loadRoom(silent = false) {
  if (!token) { $('#project-name').textContent = 'Planning room not found'; return; }
  if (roomRequestInFlight) return;
  roomRequestInFlight = true;
  try {
    const previousProject = activeProject();
    const room = await request();
    const updatedProject = previousProject && room.projects.find((project) => project.id === previousProject.id);
    state.room = room;
    if (previousProject?.status === 'Open' && updatedProject?.status === 'Decided') {
      const next = room.projects.find((project) => project.status === 'Open');
      if (next) {
        state.activeProjectId = next.id;
        state.formProjectId = null;
        showToast('Placement saved · moving to the next project');
      }
    }
    render();
  }
  catch (error) { if (!silent) { $('#project-name').textContent = 'Unable to open this room'; $('#project-description').textContent = error.message; } }
  finally { roomRequestInFlight = false; }
}

async function submitVote(event) {
  event.preventDefault();
  const payload = { projectId:state.activeProjectId, voterToken:state.voterToken, voterName:$('#voter-name').value.trim() };
  scoreKeys.forEach((key) => { payload[key] = Number($(`#vote-form [name="${key}"]`).value); });
  const button = $('#vote-form button[type="submit"]'); button.disabled = true;
  try {
    const response = await request('/votes', { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(payload) });
    state.voterToken = response.voterToken;
    state.voterName = response.voterName;
    localStorage.setItem(`northstar-voter-${token}`, response.voterToken);
    $('#voter-name').value = response.voterName;
    state.room = response.room;
    $('#vote-message').textContent = `Vote saved as ${response.voterName}`;
    render();
  } catch (error) { $('#vote-message').textContent = error.message; $('#vote-message').classList.add('error'); }
  finally { button.disabled = activeProject()?.status === 'Decided'; }
}

function useAverage() {
  if (!activeProject()?.revealed) return showToast('Reveal the votes first');
  const votes = activeVotes().filter((vote) => Number.isInteger(vote.impact));
  if (!votes.length) return showToast('Waiting for at least one vote');
  const average = Object.fromEntries(scoreKeys.map((key) => [key, Math.round(votes.reduce((sum, vote) => sum + vote[key], 0) / votes.length)]));
  setDecision(average); showToast('Using the rounded group average');
}

async function revealVotes() {
  const button = $('#reveal-votes'); button.disabled = true;
  try {
    state.room = await request('/reveal', { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ leaderKey, projectId:state.activeProjectId }) });
    render(); showToast('Votes revealed');
  } catch (error) {
    $('#leader-message').textContent = error.message;
    $('#leader-message').classList.add('error');
    button.disabled = false;
  }
}

async function applyDecision({ keepCurrent = false } = {}) {
  const buttons = [$('#apply-decision'), $('#cancel-update')];
  buttons.forEach((button) => { button.disabled = true; });
  const decidedProjectId = state.activeProjectId;
  try {
    const decision = keepCurrent
      ? { leaderKey, projectId:decidedProjectId, keepCurrent:true }
      : { leaderKey, projectId:decidedProjectId, moveComment:$('#decision-comment').value.trim(), ...decisionValues() };
    state.room = await request('/decide', { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(decision) });
    state.conflictProjectIds = [];
    $('#leader-message').textContent = keepCurrent ? 'Project update canceled · current placement kept' : 'Project placement saved';
    $('#leader-message').classList.remove('error');
    const next = state.room.projects.find((project) => project.status === 'Open');
    if (next) { state.activeProjectId = next.id; state.formProjectId = null; }
    const savedMessage = keepCurrent ? 'Current placement kept' : 'Placement saved';
    render(); showToast(next ? `${savedMessage} · next project ready` : 'All project placements saved');
  } catch (error) {
    if (error.data?.room) {
      state.room = error.data.room;
      state.conflictProjectIds = error.data.conflictProjectIds || [];
      const conflictProjectId = error.data.conflictProjectIds?.[0];
      if (conflictProjectId) state.activeProjectId = conflictProjectId;
      state.formProjectId = null;
      render();
    }
    $('#leader-message').textContent = error.message;
    $('#leader-message').classList.add('error');
    showToast(error.message);
    buttons.forEach((button) => { button.disabled = false; });
  }
}

$('#vote-form').addEventListener('input', () => syncRangeOutputs($('#vote-form')));
$('#vote-form').addEventListener('submit', submitVote);
$('#decision-scores').addEventListener('input', () => { syncRangeOutputs($('#decision-scores')); state.decisions[state.activeProjectId] = decisionValues(); renderPins(); });
$('#reveal-votes').addEventListener('click', revealVotes);
$('#use-average').addEventListener('click', useAverage);
$('#apply-decision').addEventListener('click', () => applyDecision());
$('#cancel-update').addEventListener('click', () => applyDecision({ keepCurrent:true }));
$('#project-queue-tabs').addEventListener('click', (event) => {
  const tab = event.target.closest('.queue-tab');
  if (tab) selectProject(Number(tab.dataset.project));
});
$('#room-matrix').addEventListener('click', (event) => {
  if (!isLeader || !activeProject()?.revealed || activeProject()?.status !== 'Open' || event.target.closest('.vote-pin,.quadrant-info')) return;
  const rect = event.currentTarget.getBoundingClientRect();
  const scores = state.decisions[state.activeProjectId] || activeProject();
  setDecision({ ...scores, ...scoresFromPoint(rect, event.clientX, event.clientY) });
});

syncRangeOutputs($('#vote-form'));
syncRangeOutputs($('#decision-scores'));
loadRoom();
setInterval(() => { if (document.visibilityState === 'visible' && state.room?.status !== 'Closed') loadRoom(true); }, 2000);
