// DOM builders for the Progress page. They use createElement, setAttribute and textContent only,
// so report text, notes and labels are always shown as text. Each takes the document to build in.
import { changeText, chartGeometry, formatNumber, longDate, shortDate, signedChange } from './progress-model.js';

const SVG = 'http://www.w3.org/2000/svg';

export function el(doc, tag, attributes = {}, ...children) {
  const node = doc.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) if (value !== undefined && value !== null && value !== false) node.setAttribute(name, String(value));
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== '') node.appendChild(typeof child === 'string' ? doc.createTextNode(child) : child);
  return node;
}

export function svg(doc, tag, attributes = {}, ...children) {
  const node = doc.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) if (value !== undefined && value !== null && value !== '') node.setAttribute(name, String(value));
  for (const child of children.flat()) if (child) node.appendChild(child);
  return node;
}

const safeId = (key) => String(key).replace(/[^a-z0-9_-]/gi, '');

// The tile's accessible name says in words what the picture shows.
export function tileName(summary) {
  const { def, latest } = summary;
  const title = def.question || def.label;
  if (!latest) return `${title}. Not measured yet.${def.startsWhen ? ` Starts when ${def.startsWhen}.` : ''}`;
  const parts = [`${title} ${formatNumber(latest.value, def.unit)}.`];
  const change = changeText(summary);
  if (change) parts.push(`${change}.`);
  if (latest.rebuilt) parts.push('Estimated from history.');
  return parts.join(' ');
}

// A 30-day sparkline: gradient area, solid line for live readings, dashed for estimated ones.
export function sparkline(doc, summary, { series, from, to, width = 160, height = 40 }) {
  const id = `spark-${safeId(summary.key)}`;
  const box = { width, height, top: 4, bottom: 3, left: 1, right: 4, from, to, ticks: 2 };
  const root = svg(doc, 'svg', { class: 'spark', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false' });
  if (!summary.latest) {
    root.appendChild(svg(doc, 'line', { class: 'spark-empty', x1: 1, x2: width - 1, y1: height - 4, y2: height - 4 }));
    return root;
  }
  const geometry = chartGeometry(series, box);
  root.appendChild(svg(doc, 'defs', {}, svg(doc, 'linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 },
    svg(doc, 'stop', { class: 'stop-top', offset: '0' }), svg(doc, 'stop', { class: 'stop-bottom', offset: '1' }))));
  if (geometry.area) root.appendChild(svg(doc, 'path', { class: 'spark-area', d: geometry.area, fill: `url(#${id})` }));
  if (geometry.line) root.appendChild(svg(doc, 'path', { class: 'spark-line', d: geometry.line }));
  if (geometry.estimated) root.appendChild(svg(doc, 'path', { class: 'spark-line estimated', d: geometry.estimated }));
  root.appendChild(svg(doc, 'line', { class: 'crosshair', x1: 0, x2: 0, y1: 0, y2: height }));
  return root;
}

// One tile. The number sits in the same place in every tile; the chip under it is the change since
// the previous reading, tinted by the metric's direction. The tile shows a short label; its question
// is the hover title. A zero change shows no chip.
export function tile(doc, summary, { because = '', series, from, to, index = 0 } = {}) {
  const { def, latest } = summary;
  const measured = Boolean(latest);
  const node = el(doc, 'button', {
    type: 'button', class: `tile${measured ? '' : ' unmeasured'}`, 'data-key': def.key, 'data-index': index,
    'aria-label': tileName(summary), 'aria-pressed': 'false',
    title: [def.question || '', measured ? '' : `Not measured yet.${def.startsWhen ? ` Starts when ${def.startsWhen}.` : ''}`].filter(Boolean).join(' ') || undefined,
  });
  node.appendChild(el(doc, 'span', { class: 'tile-label' }, def.label));
  const value = el(doc, 'span', { class: 'tile-value' });
  if (measured) {
    value.appendChild(el(doc, 'span', { class: 'tile-number', 'data-value': latest.value, 'data-unit': def.unit }, formatNumber(latest.value)));
    if (def.unit && def.unit !== '%') value.appendChild(el(doc, 'span', { class: 'tile-unit' }, def.unit));
    if (def.unit === '%') value.appendChild(el(doc, 'span', { class: 'tile-unit' }, '%'));
  }
  node.appendChild(value);
  const chip = measured ? signedChange(summary) : '';
  node.appendChild(el(doc, 'span', { class: `tile-chip ${chip ? `tone-${summary.tone}` : 'empty'}`, 'aria-hidden': 'true' }, chip));
  node.appendChild(sparkline(doc, summary, { series, from, to }));
  node.appendChild(el(doc, 'span', { class: 'tile-because' }, because.replace(/\.$/, '')));
  return node;
}

// The ask, top left. Absent when nothing is waiting on the reader.
export function headlineNode(doc, model) {
  if (!model.text) return null;
  return el(doc, 'p', { class: 'headline', id: 'headline' }, el(doc, 'span', { class: 'status-dot', 'aria-hidden': 'true' }), model.text);
}

// "Waiting on you": the first three cards and a link to the column. The headline carries the count,
// so the panel repeats neither; its heading is for screen readers only.
export function needsPanel(doc, needs, { admin = false } = {}) {
  const panel = el(doc, 'section', { class: `needs${needs.count ? ' has-items' : ''}`, 'aria-labelledby': 'needs-title' });
  panel.appendChild(el(doc, 'h2', { id: 'needs-title', class: 'visually-hidden' }, 'Waiting on you'));
  if (!needs.configured) {
    panel.appendChild(el(doc, 'p', { class: 'needs-empty' }, admin ? 'Choose the board column that holds what needs you.' : 'An admin can choose the board column for this list.'));
    if (admin) panel.appendChild(el(doc, 'button', { type: 'button', class: 'button secondary needs-choose' }, 'Choose a column'));
    return panel;
  }
  if (!needs.count) {
    panel.appendChild(el(doc, 'p', { class: 'needs-empty' }, 'Nothing is waiting on you.'));
  } else {
    const list = el(doc, 'ol', { class: 'needs-list' });
    for (const item of needs.items) {
      const href = item.externalUrl || `/kanban.html?teamId=${encodeURIComponent(needs.teamId)}`;
      const external = Boolean(item.externalUrl);
      list.appendChild(el(doc, 'li', {},
        el(doc, 'a', { href, ...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {}) }, item.title),
        item.nextStep || item.assignee ? el(doc, 'span', { class: 'needs-meta' }, item.nextStep || item.assignee) : null));
    }
    panel.appendChild(list);
  }
  panel.appendChild(el(doc, 'a', { class: 'needs-board', href: `/kanban.html?teamId=${encodeURIComponent(needs.teamId)}`, title: `${needs.columnName} on the ${needs.teamName} board` }, 'See all on the board'));
  return panel;
}

// The big chart: gridlines, area, solid and dashed lines, milestone flags and a crosshair layer.
export function focusChart(doc, summary, { series, milestones = [], width, height, from, to }) {
  const box = { width, height, top: 16, right: 16, bottom: 28, left: 48, from, to, ticks: 4 };
  const geometry = chartGeometry(series, box);
  const id = `focus-${safeId(summary.key)}`;
  const root = svg(doc, 'svg', {
    class: 'focus-svg', viewBox: `0 0 ${width} ${height}`, width, height, tabindex: '0', role: 'img',
    'aria-label': `${summary.def.question || summary.def.label}, ${series.length ? `${longDate(geometry.from)} to ${longDate(geometry.to)}` : 'no readings'}. Use the arrow keys to read each day.`,
  });
  root.appendChild(svg(doc, 'defs', {}, svg(doc, 'linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 },
    svg(doc, 'stop', { class: 'stop-top', offset: '0' }), svg(doc, 'stop', { class: 'stop-bottom', offset: '1' }))));
  const grid = svg(doc, 'g', { class: 'grid' });
  for (const tick of geometry.ticks) {
    const y = geometry.y(tick);
    grid.appendChild(svg(doc, 'line', { x1: box.left, x2: width - box.right, y1: y, y2: y }));
    const label = svg(doc, 'text', { class: 'chart-label', x: box.left - 8, y: y + 4, 'text-anchor': 'end' });
    label.textContent = formatNumber(tick);
    grid.appendChild(label);
  }
  if (geometry.from && geometry.to) {
    const dates = geometry.from === geometry.to ? [geometry.from] : [geometry.from, geometry.to];
    dates.forEach((date, index) => {
      const label = svg(doc, 'text', { class: 'chart-label', x: geometry.x(date), y: height - 8, 'text-anchor': index ? 'end' : 'start' });
      label.textContent = shortDate(date);
      grid.appendChild(label);
    });
  }
  root.appendChild(grid);
  if (geometry.area) root.appendChild(svg(doc, 'path', { class: 'focus-area', d: geometry.area, fill: `url(#${id})` }));
  if (geometry.line) root.appendChild(svg(doc, 'path', { class: 'focus-line', d: geometry.line }));
  if (geometry.estimated) root.appendChild(svg(doc, 'path', { class: 'focus-line estimated', d: geometry.estimated }));
  // A flag sits on the line at its date; its label is in the tooltip and, in full, in the strip below.
  const flags = svg(doc, 'g', { class: 'flags' });
  for (const milestone of milestones) {
    if (milestone.date < geometry.from || milestone.date > geometry.to) continue;
    const at = geometry.points.reduce((best, point) => (!best || Math.abs(point.x - geometry.x(milestone.date)) < Math.abs(best.x - geometry.x(milestone.date)) ? point : best), null);
    const x = geometry.x(milestone.date);
    const y = at ? at.y : geometry.base;
    const flag = svg(doc, 'g', { class: 'flag', 'data-milestone': milestone.id, transform: `translate(${Number(x.toFixed(1))} ${Number(y.toFixed(1))})` },
      svg(doc, 'line', { class: 'flag-pole', x1: 0, x2: 0, y1: 0, y2: -18 }),
      svg(doc, 'path', { class: 'flag-cloth', d: 'M0 -18 L9 -14.5 L0 -11 Z' }),
      svg(doc, 'circle', { class: 'flag-hit', cx: 3, cy: -12, r: 10 }));
    const title = svg(doc, 'title');
    title.textContent = `${shortDate(milestone.date)}: ${milestone.label}`;
    flag.appendChild(title);
    flags.appendChild(flag);
  }
  root.appendChild(flags);
  root.appendChild(svg(doc, 'line', { class: 'crosshair', x1: 0, x2: 0, y1: box.top, y2: geometry.base }));
  root.appendChild(svg(doc, 'circle', { class: 'crosshair-dot', cx: 0, cy: 0, r: 4 }));
  return { node: root, geometry };
}

// Milestones in the chart's range, in date order, each in full.
export function milestoneStrip(doc, milestones, { from, to }) {
  const items = milestones.filter((item) => (!from || item.date >= from) && (!to || item.date <= to));
  if (!items.length) return null;
  const list = el(doc, 'ol', { class: 'strip', 'aria-label': 'Milestones' });
  for (const item of items) {
    list.appendChild(el(doc, 'li', { class: 'strip-item', 'data-milestone': item.id, tabindex: '0' },
      el(doc, 'time', { datetime: item.date }, shortDate(item.date)), el(doc, 'span', {}, item.label)));
  }
  return list;
}

// The same numbers as the chart, for anyone who would rather read them.
export function dataTable(doc, summary, series) {
  const table = el(doc, 'table', {},
    el(doc, 'thead', {}, el(doc, 'tr', {}, el(doc, 'th', { scope: 'col' }, 'Date'), el(doc, 'th', { scope: 'col' }, summary.def.unit ? `Value (${summary.def.unit})` : 'Value'), el(doc, 'th', { scope: 'col' }, 'Note'))));
  const body = el(doc, 'tbody');
  for (const item of [...series].reverse()) {
    const note = [item.rebuilt ? 'Estimated from history.' : '', item.note].filter(Boolean).join(' ');
    body.appendChild(el(doc, 'tr', {}, el(doc, 'td', {}, el(doc, 'time', { datetime: item.date }, shortDate(item.date))),
      el(doc, 'td', { class: 'num' }, item.value === null ? 'No reading' : formatNumber(item.value)), el(doc, 'td', {}, note)));
  }
  table.appendChild(body);
  return table;
}

// One day in the report timeline: a button that opens the day in place.
export function reportItem(doc, report, { open = false } = {}) {
  const panelId = `report-${report.date}`;
  const item = el(doc, 'li', { class: `report${open ? ' open' : ''}`, 'data-date': report.date });
  item.appendChild(el(doc, 'button', { type: 'button', class: 'report-toggle', 'aria-expanded': String(open), 'aria-controls': panelId },
    el(doc, 'time', { datetime: report.date }, longDate(report.date)), el(doc, 'span', { class: 'report-title' }, report.title)));
  const panel = el(doc, 'div', { class: 'report-panel', id: panelId, role: 'region', 'aria-label': `Report for ${longDate(report.date)}` });
  const inner = el(doc, 'div', { class: 'report-inner' });
  if (report.bullets?.length) {
    const list = el(doc, 'ul', { class: 'bullets' });
    for (const bullet of report.bullets) list.appendChild(el(doc, 'li', { 'data-key': bullet.metric_key, tabindex: bullet.metric_key ? '0' : undefined }, bullet.text));
    inner.appendChild(list);
  }
  inner.appendChild(el(doc, 'div', { class: 'report-body docs-body' }));
  panel.appendChild(inner);
  item.appendChild(panel);
  return item;
}
