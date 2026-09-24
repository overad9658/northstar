export const SCORE_FIELDS = Object.freeze(['impact', 'urgency', 'confidence', 'effort']);
export const PROJECT_STATUSES = Object.freeze(['Scheduled', 'Active', 'On hold', 'Blocked', 'Complete']);
export const SCHEDULE_STAGES = Object.freeze(['To plan', 'Planning']);
export const FOCUS_MIN_SCORE = 6;

export function isFocusProject(project) {
  return !project.archived
    && project.status !== 'Complete'
    && project.impact >= FOCUS_MIN_SCORE
    && project.urgency >= FOCUS_MIN_SCORE;
}
