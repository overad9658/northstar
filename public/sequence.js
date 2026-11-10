import { requestJson } from './browser-utils.js';
import { liveUpdates } from './live-updates.js';
import { footer, linkGeometry, linkLayer, queue, row, runTime, runTitle } from './sequence-view.js';

const app = document.getElementById('sequence-app');
const rowsNode = document.getElementById('sequence-rows');
const board = document.getElementById('sequence-board');
const empty = document.getElementById('sequence-empty');
const mineButton = document.getElementById('sequence-mine');
const errorNode = document.getElementById('sequence-error');
const state = { data: null, mine: new URLSearchParams(location.search).get('mine') === '1' };

const load = () => requestJson('/api/sequence', { credentials: 'same-origin', cache: 'no-store' }, 'The sequence could not load.');

function drawLinks() {
  board.querySelector('.seq-links')?.remove();
  const { data } = state;
  if (!data?.links.length) return;
  const gutter = Number.parseFloat(getComputedStyle(board).paddingLeft) || 0;
  if (gutter < 12) return;
  const centres = new Map([...rowsNode.children].map((node) => [Number(node.dataset.card), node.offsetTop + node.offsetHeight / 2]));
  const byId = new Map(data.rows.map((item) => [item.id, item]));
  const geometry = linkGeometry(data.links, centres);
  if (!geometry.length) return;
  board.prepend(linkLayer(document, geometry, {
    height: board.scrollHeight, gutter,
    titles: (link) => `#${link.from} ${byId.get(link.from).title}, then #${link.to} ${byId.get(link.to).title}`,
  }));
}

function render() {
  const { data } = state;
  mineButton.setAttribute('aria-pressed', String(state.mine));
  document.getElementById('sequence-queue').replaceChildren(...queue(document, data.run ? data.queue : []));
  const run = document.getElementById('sequence-run');
  run.textContent = data.run ? runTime(data.run.at) : '';
  if (data.run) run.title = runTitle(data.run); else run.removeAttribute('title');
  // Before the first pass there is no order to show, even if cards were ranked on the board.
  const rows = !data.run ? [] : state.mine ? data.rows.filter((item) => item.mine) : data.rows;
  rowsNode.replaceChildren(...rows.map((item) => row(document, item, { objectives: data.objectives })));
  const message = !data.run ? 'No order yet. It appears after the first pass.'
    : !rows.length ? (state.mine ? 'None of these steps are yours.' : 'Nothing is in the order now.') : '';
  empty.textContent = message;
  empty.hidden = !message;
  board.hidden = !rows.length;
  mineButton.hidden = !rows.length && !state.mine;
  document.getElementById('sequence-foot').replaceChildren(...footer(document, data.run ? data : { ...data, objectives: [], fyi: [] }).filter(Boolean));
  drawLinks();
  app.setAttribute('aria-busy', 'false');
}

async function refresh() {
  try {
    state.data = await load();
    errorNode.textContent = '';
    render();
  } catch (error) { errorNode.textContent = error.message; app.setAttribute('aria-busy', 'false'); }
}

mineButton.addEventListener('click', () => {
  state.mine = !state.mine;
  const params = new URLSearchParams(location.search);
  if (state.mine) params.set('mine', '1'); else params.delete('mine');
  history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}`);
  render();
});
let resizeFrame = 0;
window.addEventListener('resize', () => { cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(drawLinks); });

await refresh();
liveUpdates(['sequence', 'kanban'], refresh);
