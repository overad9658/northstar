import { requestJson } from './browser-utils.js';
import { liveUpdates } from './live-updates.js';
import { constraintRow, resolvedRow, summaryLine } from './constraints-view.js';

const app = document.getElementById('constraints-app');
const rows = document.getElementById('constraints-rows');
const resolved = document.getElementById('constraints-resolved');
const errorNode = document.getElementById('constraints-error');

function render(data) {
  const open = data.constraints.filter((item) => item.stage !== 'resolved');
  const done = data.constraints.filter((item) => item.stage === 'resolved');
  document.getElementById('constraints-summary').replaceChildren(...[summaryLine(document, data)].filter(Boolean));
  rows.replaceChildren(...open.map((item) => constraintRow(document, item)));
  rows.hidden = !open.length;
  document.getElementById('constraints-empty').hidden = data.constraints.length > 0;
  document.getElementById('constraints-resolved-rows').replaceChildren(...done.map((item) => resolvedRow(document, item)));
  resolved.hidden = !done.length;
  app.setAttribute('aria-busy', 'false');
}

async function refresh() {
  try {
    render(await requestJson('/api/constraints', { credentials: 'same-origin', cache: 'no-store' }, 'The constraints could not load.'));
    errorNode.textContent = '';
  } catch (error) { errorNode.textContent = error.message; app.setAttribute('aria-busy', 'false'); }
}

await refresh();
liveUpdates(['constraints', 'kanban'], refresh);
