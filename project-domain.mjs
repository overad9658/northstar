import {
  PROJECT_STATUSES,
  SCHEDULE_STAGES,
  SCORE_FIELDS,
} from './public/shared/project-rules.js';

export {
  FOCUS_MIN_SCORE,
  isFocusProject,
  PROJECT_STATUSES,
  SCHEDULE_STAGES,
  SCORE_FIELDS,
} from './public/shared/project-rules.js';

export const DEFAULT_PROJECT = Object.freeze({
  projectId: '',
  externalUrl: '',
  description: '',
  retrospective: '',
  blockedNote: '',
  archiveNote: '',
  restoreNote: '',
  team: 'Platform',
  status: 'Active',
  scheduleStage: 'To plan',
  capacity: 0,
  archived: 0,
});

export const FOCUS_LIMIT_MESSAGE = 'This team already has a project in Focus Now. Each team can have one project there; move the team’s current project out first.';

function invalid(error) {
  return { error };
}

export function validateProject(input, { partial = false } = {}) {
  const output = {};
  const requiredFields = ['name', ...SCORE_FIELDS];
  if (!partial && requiredFields.some((key) => input[key] === undefined)) {
    return invalid('Name and all four scores are required.');
  }

  if (input.name !== undefined) {
    output.name = String(input.name).trim();
    if (!output.name || output.name.length > 120) return invalid('Name must be between 1 and 120 characters.');
  }

  const submittedProjectId = input.projectId ?? input.project_id;
  if (submittedProjectId !== undefined) output.projectId = String(submittedProjectId).trim().slice(0, 16);

  const submittedExternalUrl = input.externalUrl ?? input.external_url;
  if (submittedExternalUrl !== undefined) {
    output.externalUrl = String(submittedExternalUrl).trim().slice(0, 2048);
    if (output.externalUrl) {
      try {
        const parsed = new URL(output.externalUrl);
        if (!['http:', 'https:'].includes(parsed.protocol)) return invalid('Source link must be a valid HTTP or HTTPS URL.');
      } catch {
        return invalid('Source link must be a valid HTTP or HTTPS URL.');
      }
    }
  }

  for (const key of SCORE_FIELDS) {
    if (input[key] === undefined) continue;
    output[key] = Number(input[key]);
    if (!Number.isInteger(output[key]) || output[key] < 1 || output[key] > 10) {
      return invalid(`${key} must be a whole number from 1 to 10.`);
    }
  }

  if (input.description !== undefined) output.description = String(input.description).trim().slice(0, 1000);
  if (input.retrospective !== undefined) output.retrospective = String(input.retrospective).trim().slice(0, 5000);
  const submittedBlockedNote = input.blockedNote ?? input.blocked_note;
  if (submittedBlockedNote !== undefined) output.blockedNote = String(submittedBlockedNote).trim().slice(0, 2000);
  const submittedArchiveNote = input.archiveNote ?? input.archive_note;
  if (submittedArchiveNote !== undefined) output.archiveNote = String(submittedArchiveNote).trim().slice(0, 2000);
  const submittedRestoreNote = input.restoreNote ?? input.restore_note;
  if (submittedRestoreNote !== undefined) output.restoreNote = String(submittedRestoreNote).trim().slice(0, 2000);
  if (input.team !== undefined) output.team = String(input.team).trim().slice(0, 50) || DEFAULT_PROJECT.team;
  if (input.capacity !== undefined) {
    output.capacity = Number(input.capacity);
    if (!Number.isInteger(output.capacity) || output.capacity < 0 || output.capacity > 999) {
      return invalid('Capacity must be a whole number from 0 to 999.');
    }
  }
  if (input.archived !== undefined) output.archived = input.archived === true || input.archived === 1 || input.archived === '1' ? 1 : 0;
  if (input.status !== undefined) {
    if (!PROJECT_STATUSES.includes(input.status)) return invalid('Invalid status.');
    output.status = input.status;
  }

  const submittedScheduleStage = input.scheduleStage ?? input.schedule_stage;
  if (submittedScheduleStage !== undefined) {
    if (!SCHEDULE_STAGES.includes(submittedScheduleStage)) return invalid('Invalid Scheduled stage.');
    output.scheduleStage = submittedScheduleStage;
  }
  return { value: output };
}

export function validateScores(input) {
  const result = validateProject(input, { partial: true });
  if (result.error) throw new Error(result.error);
  for (const key of SCORE_FIELDS) {
    if (result.value[key] === undefined) throw new Error(`${key} must be a whole number from 1 to 10.`);
  }
  return Object.fromEntries(SCORE_FIELDS.map((key) => [key, result.value[key]]));
}

export function scheduledCapacityConflict(project) {
  const scheduleStage = project.scheduleStage ?? project.schedule_stage ?? DEFAULT_PROJECT.scheduleStage;
  return project.status === 'Scheduled' && scheduleStage !== 'Planning' && project.capacity > 0
    ? 'People can only be assigned to a Scheduled project when its stage is Planning.'
    : '';
}
