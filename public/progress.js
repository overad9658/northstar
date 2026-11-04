import { requestJson, showToast } from './browser-utils.js';
import { renderMarkdown } from './markdown.js';
import { BANDS, addDays, becauseFor, chartGeometry, formatNumber, headline, longDate, nearestPoint, seriesFor, shortDate, summarize, windowed } from './progress-model.js';
import { dataTable, el, focusChart, headlineNode, milestoneStrip, needsPanel, reportItem, tile } from './progress-view.js';

const app = document.getElementById('progress-app');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const RANGES = [{ days: 30, label: '30 days' }, { days: 90, label: '90 days' }, { days: null, label: 'All' }];
const state = { defs: [], metrics: [], milestones: [], reports: [], needs: { configured: false, count: 0, items: [] }, user: null, summaries: [], latestDate: '', selected: null, range: 90, sparks: new Map() };
const bodies = new Map();
const get = (path) => requestJson(path, { credentials: 'same-origin', cache: 'no-store' }, 'This page could not load its data.');

function milestonesFor(key) {
  return state.milestones.filter((item) => !item.metricKey || item.metricKey === key);
}

function latestBullets() {
  const latest = state.reports.find((report) => report.date === state.latestDate);
  return latest?.bullets ?? [];
}

const because = (summary) => becauseFor(summary, { bullets: latestBullets(), milestones: state.milestones });

// A reading's tooltip lines: value, date, then "Estimated from history" and the note when there are any.
function readingLines(point, summary, date) {
  return [
    el(document, 'strong', {}, formatNumber(point.value, summary.def.unit)),
    el(document, 'span', {}, date),
    point.rebuilt ? el(document, 'span', { class: 'tip-note' }, 'Estimated from history') : null,
    point.note ? el(document, 'span', { class: 'tip-note' }, point.note) : null,
  ].filter(Boolean);
}

// The tooltip shared by every sparkline: date, value and note, or "Estimated from history".
const tip = document.getElementById('spark-tip');
function showTip(point, summary, clientX, clientY) {
  tip.replaceChildren(...readingLines(point, summary, shortDate(point.date)));
  tip.hidden = false;
  const { width, height } = tip.getBoundingClientRect();
  tip.style.left = `${Math.min(Math.max(8, clientX - width / 2), window.innerWidth - width - 8)}px`;
  tip.style.top = `${Math.max(8, clientY - height - 14)}px`;
}
const hideTip = () => { tip.hidden = true; };

function linkHighlight(key, on) {
  for (const node of document.querySelectorAll(`[data-key="${CSS.escape(key)}"]`)) node.classList.toggle('linked', on);
}

function renderTiles() {
  const bands = document.getElementById('progress-bands');
  state.sparks.clear();
  const from = state.latestDate ? addDays(state.latestDate, -29) : undefined;
  let index = 0;
  // One grid for every band, so a row of tiles lines up across the bands and every row is as tall
  // as its tallest tile. Each band is a column; its tiles take rows 1, 2, 3 in position order.
  const used = BANDS.filter((band) => state.summaries.some((summary) => (summary.def.band || 'momentum') === band.id));
  const columns = used.map((band, column) => {
    const summaries = state.summaries.filter((summary) => (summary.def.band || 'momentum') === band.id);
    const group = el(document, 'div', { class: `band band-${band.id}`, role: 'group', 'aria-label': `${band.name}: ${band.hint.toLowerCase()}` });
    for (const [row, summary] of summaries.entries()) {
      const series = windowed(summary.series, 30, state.latestDate);
      const node = tile(document, summary, { because: because(summary), series, from, to: state.latestDate, index });
      node.style.setProperty('--i', String(index));
      node.style.setProperty('--col', String(column + 1));
      node.style.setProperty('--row', String(row + 1));
      index += 1;
      group.appendChild(node);
      // The same box the view drew the sparkline with, so the crosshair lands on its points.
      const geometry = chartGeometry(series, { width: 160, height: 40, top: 4, bottom: 3, left: 1, right: 4, from, to: state.latestDate, ticks: 2 });
      state.sparks.set(summary.key, { summary, series, from, geometry });
    }
    return group;
  });
  bands.style.setProperty('--bands', String(used.length));
  bands.replaceChildren(...columns);
  bands.classList.toggle('reveal', !reducedMotion.matches);
  for (const node of bands.querySelectorAll('.tile')) wireTile(node);
  countUp(bands);
}

function wireTile(node) {
  const key = node.dataset.key;
  node.addEventListener('click', () => selectMetric(key, { scroll: true }));
  node.addEventListener('pointerenter', () => linkHighlight(key, true));
  node.addEventListener('pointerleave', () => { linkHighlight(key, false); hideTip(); });
  node.addEventListener('focus', () => linkHighlight(key, true));
  node.addEventListener('blur', () => linkHighlight(key, false));
  const spark = node.querySelector('.spark');
  const entry = state.sparks.get(key);
  if (!spark || !entry?.summary.latest) return;
  spark.addEventListener('pointermove', (event) => {
    const box = spark.getBoundingClientRect();
    const geometry = entry.geometry;
    const point = nearestPoint(geometry.points, ((event.clientX - box.left) / box.width) * 160);
    if (!point) return;
    const crosshair = spark.querySelector('.crosshair');
    crosshair.setAttribute('x1', point.x);
    crosshair.setAttribute('x2', point.x);
    spark.classList.add('tracking');
    showTip(point, entry.summary, box.left + (point.x / 160) * box.width, box.top);
  });
  spark.addEventListener('pointerleave', () => { spark.classList.remove('tracking'); hideTip(); });
}

// Numbers count up once, on load, in at most 600 ms.
function countUp(root) {
  if (reducedMotion.matches) return;
  const numbers = [...root.querySelectorAll('.tile-number')];
  const start = performance.now();
  const duration = 600;
  const frame = (now) => {
    const progress = Math.min(1, (now - start) / duration);
    const eased = 1 - (1 - progress) ** 3;
    for (const node of numbers) {
      const target = Number(node.dataset.value);
      node.textContent = formatNumber(progress === 1 ? target : Number.isInteger(target) ? Math.round(target * eased) : target * eased);
    }
    if (progress < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function renderHeadline() {
  const model = headline({ summaries: state.summaries, latestDate: state.latestDate, needs: state.needs, because });
  const node = headlineNode(document, model);
  document.getElementById('progress-headline').replaceChildren(...(node ? [node] : []));
}

function renderNeeds() {
  const admin = state.user?.role === 'admin';
  const panel = needsPanel(document, state.needs, { admin });
  panel.querySelector('.needs-choose')?.addEventListener('click', () => chooseColumn(panel));
  document.getElementById('progress-needs').replaceChildren(panel);
  // Choosing the column is setup, not reading: it lives behind the header's settings button.
  const settings = document.getElementById('progress-settings');
  settings.hidden = !admin;
  settings.onclick = () => chooseColumn(document.querySelector('#progress-needs .needs'));
}

async function chooseColumn(panel) {
  const teams = await get('/api/teams');
  const form = el(document, 'form', { class: 'needs-form' },
    el(document, 'label', { class: 'field' }, el(document, 'span', {}, 'Team'), el(document, 'select', { name: 'team' }, teams.map((team) => el(document, 'option', { value: team.id }, team.name)))),
    el(document, 'label', { class: 'field' }, el(document, 'span', {}, 'Column'), el(document, 'select', { name: 'column' })),
    el(document, 'div', { class: 'needs-form-actions' }, el(document, 'button', { type: 'submit', class: 'button primary' }, 'Save'), el(document, 'button', { type: 'button', class: 'button secondary needs-cancel' }, 'Cancel')));
  const loadColumns = async () => {
    const { columns } = await get(`/api/kanban?teamId=${encodeURIComponent(form.team.value)}`);
    form.column.replaceChildren(...columns.map((column) => el(document, 'option', { value: column.id }, column.name)));
    if (state.needs.columnId) form.column.value = String(state.needs.columnId);
  };
  if (state.needs.teamId) form.team.value = String(state.needs.teamId);
  form.team.addEventListener('change', loadColumns);
  form.querySelector('.needs-cancel').addEventListener('click', renderNeeds);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await requestJson('/api/progress/settings', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ needsYou: { teamId: Number(form.team.value), columnId: Number(form.column.value) } }) });
      state.needs = await get('/api/progress/needs-you');
      renderNeeds();
      renderHeadline();
      showToast('Column saved');
    } catch (error) { showToast(error.message); }
  });
  await loadColumns();
  panel.replaceChildren(panel.querySelector('h2'), form);
  form.team.focus();
}

// The focus chart: one metric's history with its milestones, the strip, and the numbers as a table.
function selectMetric(key, { scroll = false } = {}) {
  state.selected = key;
  for (const node of document.querySelectorAll('.tile')) node.setAttribute('aria-pressed', String(node.dataset.key === key));
  renderFocus();
  if (scroll) document.getElementById('progress-focus').scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'start' });
}

function renderFocus() {
  const section = document.getElementById('progress-focus');
  const summary = state.summaries.find((item) => item.key === state.selected);
  if (!summary) { section.hidden = true; return; }
  section.hidden = false;
  const series = windowed(summary.series, state.range, state.latestDate);
  const milestones = milestonesFor(summary.key);
  const rangeButtons = el(document, 'div', { class: 'range', role: 'group', 'aria-label': 'Time range' },
    RANGES.map((range) => {
      const button = el(document, 'button', { type: 'button', class: 'range-button', 'aria-pressed': String(state.range === range.days) }, range.label);
      button.addEventListener('click', () => { state.range = range.days; renderFocus(); section.querySelector('.focus-svg')?.focus(); });
      return button;
    }));
  const hasEstimates = series.some((item) => item.rebuilt);
  const legend = el(document, 'p', { class: 'focus-legend' },
    hasEstimates ? el(document, 'span', { class: 'legend-estimated' }, 'Estimated from history') : null,
    milestones.length ? el(document, 'span', { class: 'legend-flag' }, 'Milestone') : null);
  const plot = el(document, 'div', { class: 'focus-plot' });
  const head = el(document, 'header', { class: 'focus-head' },
    el(document, 'div', {}, el(document, 'h2', { id: 'focus-title' }, summary.def.label),
      summary.def.question ? el(document, 'p', { class: 'focus-description' }, summary.def.question) : null),
    rangeButtons);
  const details = el(document, 'details', { class: 'focus-table' }, el(document, 'summary', {}, 'Show the numbers'), el(document, 'div', { class: 'docs-table' }, dataTable(document, summary, series)));
  section.replaceChildren(head, legend, plot, details);
  const width = Math.max(280, Math.floor(plot.clientWidth || 640));
  const height = width < 520 ? 220 : 300;
  if (!summary.latest) {
    plot.appendChild(el(document, 'p', { class: 'focus-empty' }, `Not measured yet.${summary.def.startsWhen ? ` Starts when ${summary.def.startsWhen}.` : ''}`));
    return;
  }
  const from = state.range ? addDays(state.latestDate, -(state.range - 1)) : summary.series[0]?.date;
  const { node, geometry } = focusChart(document, summary, { series, milestones, width, height, from, to: state.latestDate });
  const readout = el(document, 'div', { class: 'focus-tip', hidden: 'hidden', 'aria-live': 'polite' });
  plot.append(node, readout);
  const strip = milestoneStrip(document, milestones, { from: geometry.from, to: geometry.to });
  if (strip) section.insertBefore(strip, details);
  wireFocus(node, readout, geometry, summary);
  wireStrip(section, node);
}

function wireFocus(chart, readout, geometry, summary) {
  const crosshair = chart.querySelector('.crosshair');
  const dot = chart.querySelector('.crosshair-dot');
  let index = geometry.points.length - 1;
  const show = (point) => {
    if (!point) return;
    index = geometry.points.indexOf(point);
    chart.classList.add('tracking');
    crosshair.setAttribute('x1', point.x); crosshair.setAttribute('x2', point.x);
    dot.setAttribute('cx', point.x); dot.setAttribute('cy', point.y);
    dot.classList.toggle('estimated', Boolean(point.rebuilt));
    const flags = state.milestones.filter((item) => item.date === point.date && (!item.metricKey || item.metricKey === summary.key));
    readout.replaceChildren(...readingLines(point, summary, longDate(point.date)), ...flags.map((item) => el(document, 'span', { class: 'tip-flag' }, item.label)));
    readout.hidden = false;
    const box = chart.getBoundingClientRect();
    const scale = box.width / Number(chart.getAttribute('width'));
    const left = point.x * scale;
    readout.style.left = `${Math.min(Math.max(0, left - readout.offsetWidth / 2), box.width - readout.offsetWidth)}px`;
    readout.style.top = `${Math.max(0, point.y * scale - readout.offsetHeight - 16)}px`;
  };
  const hide = () => { chart.classList.remove('tracking'); readout.hidden = true; };
  chart.addEventListener('pointermove', (event) => {
    const box = chart.getBoundingClientRect();
    show(nearestPoint(geometry.points, ((event.clientX - box.left) / box.width) * Number(chart.getAttribute('width'))));
  });
  chart.addEventListener('pointerleave', hide);
  chart.addEventListener('focus', () => show(geometry.points[index]));
  chart.addEventListener('blur', hide);
  chart.addEventListener('keydown', (event) => {
    const moves = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity };
    if (!(event.key in moves)) return;
    event.preventDefault();
    const next = Math.min(geometry.points.length - 1, Math.max(0, index + moves[event.key]));
    show(geometry.points[next]);
  });
}

function wireStrip(section, chart) {
  for (const item of section.querySelectorAll('.strip-item')) {
    const flag = chart.querySelector(`.flag[data-milestone="${item.dataset.milestone}"]`);
    const on = () => flag?.classList.add('active');
    const off = () => flag?.classList.remove('active');
    item.addEventListener('pointerenter', on); item.addEventListener('pointerleave', off);
    item.addEventListener('focus', on); item.addEventListener('blur', off);
  }
}

// The report timeline: newest first; a day opens in place, and its body loads the first time.
function renderReports() {
  const section = document.getElementById('progress-reports');
  section.hidden = !state.reports.length;
  const list = document.getElementById('report-list');
  list.replaceChildren(...state.reports.map((report, index) => reportItem(document, report, { open: index === 0 })));
  for (const item of list.querySelectorAll('.report')) {
    const button = item.querySelector('.report-toggle');
    button.addEventListener('click', () => toggleReport(item));
    for (const bullet of item.querySelectorAll('.bullets li[data-key]')) {
      const key = bullet.dataset.key;
      const on = () => linkHighlight(key, true);
      const off = () => linkHighlight(key, false);
      bullet.addEventListener('pointerenter', on); bullet.addEventListener('pointerleave', off);
      bullet.addEventListener('focus', on); bullet.addEventListener('blur', off);
      bullet.addEventListener('click', () => selectMetric(key, { scroll: true }));
      bullet.addEventListener('keydown', (event) => { if (event.key === 'Enter') selectMetric(key, { scroll: true }); });
    }
    if (item.classList.contains('open')) loadReport(item);
  }
}

const withoutTitle = (markdown) => markdown.replace(/^\s*#{1,6}\s+[^\n]*\n?/, '');

async function loadReport(item) {
  const date = item.dataset.date;
  const target = item.querySelector('.report-body');
  if (target.dataset.loaded) return;
  try {
    if (!bodies.has(date)) bodies.set(date, await get(`/api/progress/reports/${date}`));
    // The timeline already shows the report's first heading as its title.
    target.replaceChildren(renderMarkdown(withoutTitle(bodies.get(date).markdown)).fragment);
    target.dataset.loaded = 'true';
  } catch (error) { target.replaceChildren(el(document, 'p', {}, error.message)); }
}

function toggleReport(item) {
  const open = !item.classList.contains('open');
  item.classList.toggle('open', open);
  item.querySelector('.report-toggle').setAttribute('aria-expanded', String(open));
  if (open) loadReport(item);
}

function renderEmpty() {
  const bands = document.getElementById('progress-bands');
  bands.classList.remove('reveal');
  bands.replaceChildren(el(document, 'div', { class: 'progress-empty' },
    el(document, 'h2', {}, 'Nothing is tracked yet'),
    el(document, 'p', {}, 'This page will show a few numbers for each day, what moved them, and what is waiting on you.'),
    el(document, 'p', {}, 'To start, define the metrics you want to follow and record the first day. ',
      el(document, 'a', { href: '/docs.html?doc=api#progress' }, 'The API docs'), ' and ',
      el(document, 'a', { href: '/docs.html?doc=mcp#progress-tools' }, 'the MCP tools'), ' show how.')));
}

async function load() {
  try {
    const [defs, metrics, milestones, reports, needs, user] = await Promise.all([
      get('/api/progress/metric-defs'), get('/api/progress/metrics'), get('/api/progress/milestones'), get('/api/progress/reports'),
      get('/api/progress/needs-you'), get('/api/auth/me').catch(() => null),
    ]);
    Object.assign(state, { defs, metrics, milestones, reports, needs, user });
    state.latestDate = metrics.filter((item) => item.value !== null).map((item) => item.date).sort().at(-1) || '';
    state.summaries = defs.map((def) => summarize(def, seriesFor(metrics, def.key)));
    document.getElementById('progress-asof').textContent = state.latestDate ? longDate(state.latestDate) : '';
    renderHeadline();
    renderNeeds();
    if (!defs.length) renderEmpty();
    else {
      renderTiles();
      selectMetric(state.summaries.find((item) => item.measured)?.key ?? state.summaries[0].key);
    }
    renderReports();
  } catch (error) {
    document.getElementById('progress-bands').replaceChildren(el(document, 'p', { class: 'progress-empty' }, error.message));
  } finally {
    app.setAttribute('aria-busy', 'false');
  }
}

let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderFocus, 150); });
load();
