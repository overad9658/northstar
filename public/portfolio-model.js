import { initials } from './browser-utils.js';
import { isFocusProject } from './shared/project-rules.js';

export function projectLabel(project) {
  return project.projectId?.trim() || initials(project.name);
}

export function projectStatusLabel(project) {
  return project.status === 'Scheduled' ? `Scheduled · ${project.scheduleStage}` : project.status;
}

export function projectStatusClass(project) {
  if (project.status === 'Scheduled') return `scheduled-${project.scheduleStage.toLowerCase().replace(' ', '-')}`;
  return project.status === 'On hold' ? 'hold' : project.status.toLowerCase();
}

export function filterProjects(projects, filters) {
  const query = filters.query.toLowerCase();
  return projects.filter((project) =>
    (filters.showArchived || !project.archived)
    && (filters.status === 'All' || project.status === filters.status)
    && (!filters.selectedTeams.length || filters.selectedTeams.includes(project.team))
    && (!query || `${project.projectId || ''} ${project.name} ${project.team} ${project.description} ${project.externalUrl || ''}`.toLowerCase().includes(query)));
}

export function selectPortfolioProjects(projects, filters) {
  const visible = filterProjects(projects, filters);
  const portfolio = projects.filter((project) => !project.archived);
  const selectedPortfolio = portfolio.filter((project) =>
    !filters.selectedTeams.length || filters.selectedTeams.includes(project.team));
  return {
    visible,
    portfolio,
    selectedPortfolio,
    matrix: visible.filter((project) => !project.archived && (filters.showCompleted || project.status !== 'Complete')),
    active: selectedPortfolio.filter((project) => project.status === 'Active'),
  };
}

export function findFocusNowOccupant(projects, project, impact, urgency) {
  if (!isFocusProject({ ...project, impact, urgency })) return null;
  const team = String(project.team || '').trim().toLocaleLowerCase();
  return projects.find((candidate) =>
    candidate.id !== project.id
    && String(candidate.team || '').trim().toLocaleLowerCase() === team
    && isFocusProject(candidate)) || null;
}
