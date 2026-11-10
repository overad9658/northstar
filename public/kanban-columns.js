// Column order on the kanban board: where a move lands and the header controls that move it.
// Pure functions, so the rules are tested without a browser.
import { escapeHtml } from './browser-utils.js';

export const COLUMN_DRAG_TYPE = 'application/x-northstar-column';

// The 0-based position a column moves to, or null when the move would not change the order.
export function moveTarget(columns, columnId, delta) {
  const index = columns.findIndex((column) => column.id === columnId);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= columns.length || target === index) return null;
  return target;
}

// Dropping a dragged column on another puts it at that column's place.
export function dropTarget(columns, draggedId, targetId) {
  const from = columns.findIndex((column) => column.id === draggedId);
  const to = columns.findIndex((column) => column.id === targetId);
  return from < 0 || to < 0 || from === to ? null : to;
}

// The board as it looks once the move is saved, so the page can show it straight away.
export function reorderColumns(columns, columnId, position) {
  const moving = columns.find((column) => column.id === columnId);
  if (!moving) return columns;
  const rest = columns.filter((column) => column.id !== columnId);
  rest.splice(Math.max(0, Math.min(position, rest.length)), 0, moving);
  return rest.map((column, index) => ({ ...column, position: index }));
}

export function columnControls(column, index, count, canManage) {
  if (!canManage) return '';
  const name = escapeHtml(column.name);
  return `<div class="kanban-column-actions">`
    + `<button type="button" class="column-move-left" aria-label="Move ${name} left" title="Move left" ${index === 0 ? 'disabled' : ''}>‹</button>`
    + `<button type="button" class="column-move-right" aria-label="Move ${name} right" title="Move right" ${index === count - 1 ? 'disabled' : ''}>›</button>`
    + `<button type="button" class="column-rename" aria-label="Rename ${name}" title="Rename column">✎</button>`
    + `<button type="button" class="column-delete" aria-label="Delete ${name}" title="Delete column">×</button></div>`;
}
