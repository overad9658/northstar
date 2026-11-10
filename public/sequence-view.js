// Sequence page rendering. Pure DOM building from the /api/sequence payload (no innerHTML), so the
// tests can render into a minimal fake document. docs/sequence-page.md explains the layout.
import { el } from './progress-view.js';

const SVG = 'http://www.w3.org/2000/svg';
export const MARKS = 6;
const cardHref = (id) => `/kanban.html?card=${id}`;

function svgNode(doc, tag, attributes = {}, ...children) {
  const node = doc.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  for (const child of children) if (child) node.appendChild(child);
  return node;
}

// Each objective keeps one mark (colour): its place in the alphabetical list of objectives.
export const markIndex = (objectives, objective) => {
  const index = objectives.indexOf(objective);
  return index < 0 ? -1 : index % MARKS;
};

// 18:42Z today, "4 Nov 18:42Z" on another day: the time of the last pass, in UTC.
export function runTime(at, now = new Date()) {
  const date = new Date(at);
  const time = `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}Z`;
  const sameDay = date.toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
  return sameDay ? time : `${date.getUTCDate()} ${date.toLocaleString('en', { month: 'short', timeZone: 'UTC' })} ${time}`;
}

export function runTitle(run) {
  const parts = Object.entries(run.scores || {}).map(([key, value]) => `${key} ${value}`);
  return `Last pass ${new Date(run.at).toISOString().replace('T', ' ').slice(0, 16)} UTC${run.skillVersion ? ` (${run.skillVersion})` : ''}${parts.length ? `: ${parts.join(', ')}` : ''}`;
}

export function moveLabel(moved) {
  return moved ? `${moved.direction === 'up' ? '↑' : '↓'}${moved.places}` : '';
}

function mark(doc, objectives, objective) {
  const index = markIndex(objectives, objective);
  return index < 0 ? null : el(doc, 'span', { class: `seq-mark mark-${index}`, 'aria-hidden': 'true' });
}

function target(doc) {
  return svgNode(doc, 'svg', { class: 'seq-target', width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
    svgNode(doc, 'circle', { cx: 8, cy: 8, r: 6.5, fill: 'none', 'stroke-width': 1.5 }),
    svgNode(doc, 'circle', { cx: 8, cy: 8, r: 2.5 }));
}

// "A · B → C": each card a link, levels joined by arrows.
function chain(doc, levels) {
  const parts = [];
  levels.forEach((level, levelIndex) => {
    if (levelIndex) parts.push(el(doc, 'span', { class: 'seq-arrow', 'aria-hidden': 'true' }, ' → '));
    level.forEach((item, index) => {
      if (index) parts.push(' · ');
      parts.push(el(doc, 'a', { href: cardHref(item.id), title: `#${item.id}` }, item.title));
    });
  });
  return parts;
}

export function row(doc, item, { objectives, now = new Date() }) {
  const hasThen = item.then.length > 0;
  const classes = ['seq-row', item.waiting ? 'is-waiting' : '', item.mine ? 'is-mine' : '', hasThen || item.reaches ? 'has-line' : '', item.reaches ? '' : 'no-reach'].filter(Boolean).join(' ');
  const waits = item.waiting ? ` · waits until ${new Date(item.waitUntil).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' })}` : '';
  const moved = item.moved
    ? el(doc, 'span', { class: `seq-move ${item.moved.direction}`, title: `${item.moved.direction === 'up' ? 'Up' : 'Down'} ${item.moved.places} since the last pass${item.reasonFull || item.rankReason ? `: ${item.reasonFull || item.rankReason}` : ''}` }, moveLabel(item.moved))
    : null;
  return el(doc, 'li', { class: classes, 'data-card': item.id },
    el(doc, 'div', { class: 'seq-why' },
      el(doc, 'span', { class: 'seq-place' }, String(item.place)),
      el(doc, 'span', { class: 'seq-why-text' },
        el(doc, 'span', { class: 'seq-reason', title: item.reasonFull || item.objective || undefined },
          mark(doc, objectives, item.objective),
          item.rankReason ? el(doc, 'span', { class: 'seq-reason-text' }, item.rankReason) : null),
        moved)),
    el(doc, 'a', { class: 'seq-now', href: cardHref(item.id), title: `#${item.id} · ${item.title}${waits}` },
      item.owner ? el(doc, 'strong', { class: 'seq-owner' }, item.mine ? 'You' : item.owner) : null,
      el(doc, 'span', { class: 'seq-step' }, item.now)),
    el(doc, 'span', { class: 'seq-then' }, hasThen ? el(doc, 'span', { class: 'seq-patch' }, ...chain(doc, item.then)) : null),
    el(doc, 'span', { class: 'seq-reaches' }, item.reaches ? el(doc, 'span', { class: 'seq-patch' }, target(doc), el(doc, 'span', {}, item.reaches)) : null));
}

// The people holding the queue: a bar per step, the viewer first in the accent colour.
export function queue(doc, people) {
  return people.slice(0, 5).map((person) => el(doc, 'span', { class: `seq-person${person.mine ? ' is-mine' : ''}`, title: `${person.mine ? 'You' : person.name}: ${person.count} ${person.count === 1 ? 'step' : 'steps'}` },
    el(doc, 'span', { class: 'seq-person-name' }, person.mine ? 'You' : person.name),
    el(doc, 'span', { class: 'seq-bars', 'aria-hidden': 'true' }, ...Array.from({ length: Math.min(person.count, 12) }, () => el(doc, 'i', {})))));
}

export function footer(doc, data) {
  const legend = data.objectives.map((objective) => el(doc, 'span', { class: 'seq-legend-item' }, mark(doc, data.objectives, objective), objective));
  const fyi = data.fyi.length
    ? el(doc, 'span', { class: 'seq-fyi' }, 'Not ours, for the owner: ', ...data.fyi.flatMap((item, index) => [index ? ' · ' : '', el(doc, 'a', { href: cardHref(item.id), title: item.title }, `#${item.id}`)]))
    : null;
  // Only an https link is drawn; the API refuses anything else, and the page checks again.
  const design = /^https:\/\//i.test(data.designUrl || '') ? el(doc, 'a', { class: 'seq-design', href: data.designUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Design') : null;
  return [el(doc, 'span', { class: 'seq-legend' }, ...legend), el(doc, 'span', { class: 'seq-foot-end' }, fyi, design)];
}

// Brackets in the gutter: centres are each visible row's middle (px). Overlapping spans take inner
// lanes so they do not draw over each other. Returns [{ from, to, y1, y2, lane }].
export function linkGeometry(links, centres) {
  const drawn = links.filter((link) => centres.has(link.from) && centres.has(link.to))
    .map((link) => ({ ...link, y1: centres.get(link.from), y2: centres.get(link.to) }))
    .sort((a, b) => Math.abs(a.y2 - a.y1) - Math.abs(b.y2 - b.y1) || Math.min(a.y1, a.y2) - Math.min(b.y1, b.y2));
  const placed = [];
  for (const link of drawn) {
    const top = Math.min(link.y1, link.y2);
    const bottom = Math.max(link.y1, link.y2);
    let lane = 0;
    while (placed.some((other) => other.lane === lane && Math.min(other.y1, other.y2) < bottom && Math.max(other.y1, other.y2) > top)) lane += 1;
    placed.push({ ...link, lane: Math.min(lane, 2) });
  }
  return placed;
}

// One SVG for every bracket: a rounded bracket from the blocker's row to the row it frees, an
// arrowhead at the freed row, and the pair on hover.
export function linkLayer(doc, geometry, { height, gutter, titles }) {
  const layer = svgNode(doc, 'svg', { class: 'seq-links', width: gutter, height, viewBox: `0 0 ${gutter} ${height}`, 'aria-hidden': 'true' });
  for (const link of geometry) {
    const x = 8 + link.lane * 5;
    const end = gutter - 6;
    const radius = Math.min(10, Math.abs(link.y2 - link.y1) / 2);
    const down = link.y2 > link.y1 ? 1 : -1;
    const d = `M ${gutter} ${link.y1} H ${x + radius} Q ${x} ${link.y1} ${x} ${link.y1 + down * radius} V ${link.y2 - down * radius} Q ${x} ${link.y2} ${x + radius} ${link.y2} H ${end}`;
    const group = svgNode(doc, 'g', { class: 'seq-link' },
      svgNode(doc, 'title', {}),
      svgNode(doc, 'path', { class: 'seq-link-hit', d }),
      svgNode(doc, 'path', { class: 'seq-link-line', d }),
      svgNode(doc, 'path', { class: 'seq-link-head', d: `M ${end} ${link.y2 - 4} L ${gutter} ${link.y2} L ${end} ${link.y2 + 4} Z` }));
    group.firstChild.textContent = titles(link);
    layer.appendChild(group);
  }
  return layer;
}
