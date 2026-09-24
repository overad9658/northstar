export { matrixPosition, scoresFromPoint } from './matrix-geometry.js';
export { SCORE_FIELDS, isFocusProject } from './shared/project-rules.js';

export const $ = (selector, root = document) => root.querySelector(selector);

export function initials(name) {
  return name.split(/\s+/).map((word) => word[0]).join('').slice(0, 2).toUpperCase();
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

export function showToast(message, selector = '#toast') {
  const element = $(selector);
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(element.toastTimer);
  element.toastTimer = setTimeout(() => element.classList.remove('show'), 2200);
}

export function syncRangeOutputs(container) {
  container.querySelectorAll('input[type="range"]').forEach((input) => {
    input.closest('label').querySelector('output').value = input.value;
  });
}

export async function requestJson(url, options, fallbackMessage = 'Something went wrong.') {
  const response = await fetch(url, options);
  if (response.status === 401 && location.pathname !== '/login.html') {
    location.replace(`/login.html?returnTo=${encodeURIComponent(location.pathname + location.search)}`);
    throw new Error('Authentication is required.');
  }
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || fallbackMessage);
    error.data = body;
    throw error;
  }
  return body;
}

export function needsBlockedNote(previousStatus, nextStatus) {
  return nextStatus === 'Blocked' && previousStatus !== 'Blocked';
}

export function capacityForTeams(teams, projects, selectedTeamNames = []) {
  const selected = new Set(selectedTeamNames.map((name) => String(name).toLocaleLowerCase()));
  const includedTeams = selected.size
    ? teams.filter((team) => selected.has(String(team.name).toLocaleLowerCase()))
    : teams;
  const includedNames = new Set(includedTeams.map((team) => String(team.name).toLocaleLowerCase()));
  const total = includedTeams.reduce((sum, team) => sum + Number(team.capacity || 0), 0);
  const occupied = projects
    .filter((project) => !project.archived && project.status !== 'Complete' && includedNames.has(String(project.team).toLocaleLowerCase()))
    .reduce((sum, project) => sum + Number(project.capacity || 0), 0);
  return { total, occupied, available: total - occupied };
}
