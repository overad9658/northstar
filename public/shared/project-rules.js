export const SCORE_FIELDS = Object.freeze(['impact', 'urgency', 'confidence', 'effort']);
export const PROJECT_STATUSES = Object.freeze(['Scheduled', 'Active', 'On hold', 'Blocked', 'Complete']);
export const SCHEDULE_STAGES = Object.freeze(['Idea', 'To plan', 'Planning']);
// Ideas may leave their scores out; these are provisional until the idea is promoted.
export const IDEA_DEFAULT_SCORE = 5;
export const FOCUS_MIN_SCORE = 6;

// A proposal that is not a plan yet: off the matrix and out of Focus Now unless asked for.
export function isIdea(project) {
  return project.status === 'Scheduled' && (project.scheduleStage ?? project.schedule_stage) === 'Idea';
}

export function isFocusProject(project) {
  return !project.archived
    && !isIdea(project)
    && project.status !== 'Complete'
    && project.impact >= FOCUS_MIN_SCORE
    && project.urgency >= FOCUS_MIN_SCORE;
}
