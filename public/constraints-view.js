// Constraints page rendering. Pure DOM building from the /api/constraints payload (no innerHTML),
// so the tests can render into a minimal fake document. docs/constraints-page.md explains the layout.
import { addDays, changeText, formatNumber, shortDate, summarize } from './progress-model.js';
import { el, sparkline } from './progress-view.js';
import { CONSTRAINT_RATINGS, CONSTRAINT_STAGES, RATING_LABELS } from './shared/constraints.js';

const STAGE_LABELS = { identify: 'Identify', exploit: 'Exploit', subordinate: 'Subordinate', elevate: 'Elevate', resolved: 'Resolved' };
const cardHref = (id) => `/kanban.html?card=${id}`;
const day = (at) => (at ? shortDate(String(at).slice(0, 10)) : '');

// The five steps, the current one marked; earlier steps read as done.
export function stageSteps(doc, stage) {
  const current = CONSTRAINT_STAGES.indexOf(stage);
  return el(doc, 'ol', { class: 'toc-steps', 'aria-label': `Stage: ${STAGE_LABELS[stage] ?? stage}` },
    ...CONSTRAINT_STAGES.map((step, index) => el(doc, 'li', {
      class: `toc-step${index < current ? ' is-done' : ''}${index === current ? ' is-current' : ''}`,
      'aria-current': index === current ? 'step' : undefined,
    }, STAGE_LABELS[step])));
}

// The measure: its words, and when it names a metric, the latest reading, the change and a 30-day line.
export function measure(doc, item) {
  const trend = item.trend;
  const words = item.measure ? el(doc, 'p', { class: 'toc-measure-text' }, item.measure) : null;
  if (!trend) return el(doc, 'div', { class: 'toc-measure' }, words ?? el(doc, 'p', { class: 'toc-quiet' }, 'No measure yet.'));
  const summary = summarize(trend, trend.readings);
  const last = trend.readings.at(-1)?.date;
  const value = summary.latest ? formatNumber(summary.latest.value, trend.unit) : '—';
  const change = summary.latest ? changeText(summary) : 'Not measured yet';
  return el(doc, 'div', { class: 'toc-measure' },
    words,
    el(doc, 'div', { class: `toc-trend tone-${summary.tone}`, title: `${trend.label}: ${value}${change ? `. ${change}` : ''}` },
      el(doc, 'span', { class: 'toc-trend-label' }, trend.label),
      el(doc, 'strong', { class: 'toc-trend-value' }, value),
      sparkline(doc, summary, { series: trend.readings, from: last ? addDays(last, -29) : undefined, to: last, width: 160, height: 36 }),
      change ? el(doc, 'span', { class: 'toc-trend-change' }, change) : null));
}

// "2 removes · 1 adds load · 3 not rated": open linked cards by rating; zero counts are left out.
export function ratingCounts(doc, counts) {
  const parts = [...CONSTRAINT_RATINGS, 'unrated'].filter((rating) => counts[rating])
    .map((rating) => el(doc, 'span', { class: `toc-count rating-${rating}` }, `${counts[rating]} ${rating === 'unrated' ? 'not rated' : RATING_LABELS[rating].toLowerCase()}`));
  return parts.length ? el(doc, 'p', { class: 'toc-counts' }, ...parts) : el(doc, 'p', { class: 'toc-counts toc-quiet' }, 'No cards linked yet.');
}

function cardList(doc, cards) {
  if (!cards.length) return null;
  return el(doc, 'ul', { class: 'toc-cards' }, ...cards.map((card) => el(doc, 'li', { class: `toc-card${card.open ? '' : ' is-done'}` },
    el(doc, 'span', { class: `toc-rating rating-${card.rating ?? 'unrated'}` }, card.rating ? RATING_LABELS[card.rating] : 'Not rated'),
    el(doc, 'a', { href: cardHref(card.id), title: [card.teamName, card.columnName].filter(Boolean).join(' · ') || undefined }, `#${card.id} ${card.title}`),
    card.assignee ? el(doc, 'span', { class: 'toc-card-owner' }, card.assignee) : null)));
}

// "Identify Nov 1 → Exploit Nov 3": each stage move with its date; the note on hover.
export function history(doc, entries) {
  if (!entries.length) return null;
  return el(doc, 'p', { class: 'toc-history' }, ...entries.flatMap((entry, index) => [
    index ? el(doc, 'span', { class: 'toc-arrow', 'aria-hidden': 'true' }, ' → ') : null,
    el(doc, 'span', { title: [entry.note, entry.actor ? `by ${entry.actor}` : ''].filter(Boolean).join(' · ') || undefined }, `${STAGE_LABELS[entry.to] ?? entry.to} ${day(entry.at)}`),
  ]));
}

// One open constraint. The #1 is drawn larger: it is the one everything else subordinates to.
export function constraintRow(doc, item) {
  const first = item.rank === 1;
  return el(doc, 'li', { class: `toc-row${first ? ' is-first' : ''}`, 'data-constraint': item.id },
    el(doc, 'div', { class: 'toc-head' },
      el(doc, 'span', { class: 'toc-rank', 'aria-label': `Rank ${item.rank}` }, `#${item.rank}`),
      el(doc, 'div', { class: 'toc-name' },
        el(doc, 'h2', {}, item.name),
        item.owner ? el(doc, 'span', { class: 'toc-owner' }, item.owner) : null),
      stageSteps(doc, item.stage)),
    el(doc, 'div', { class: 'toc-body' },
      measure(doc, item),
      el(doc, 'div', { class: 'toc-work' },
        ratingCounts(doc, item.counts),
        cardList(doc, item.cards))),
    item.evidence ? el(doc, 'details', { class: 'toc-evidence', open: first ? '' : undefined }, el(doc, 'summary', {}, 'Evidence'), el(doc, 'p', {}, item.evidence)) : null,
    history(doc, item.history));
}

export function resolvedRow(doc, item) {
  const resolvedAt = [...item.history].reverse().find((entry) => entry.to === 'resolved')?.at;
  return el(doc, 'li', { class: 'toc-resolved-row' },
    el(doc, 'span', { class: 'toc-resolved-name' }, item.name),
    el(doc, 'span', { class: 'toc-quiet' }, resolvedAt ? `Resolved ${day(resolvedAt)}` : 'Resolved'),
    item.counts.unrated + CONSTRAINT_RATINGS.reduce((sum, rating) => sum + item.counts[rating], 0)
      ? el(doc, 'a', { class: 'toc-rerate', href: '/kanban.html?order=constraint' }, `${CONSTRAINT_RATINGS.reduce((sum, rating) => sum + item.counts[rating], 0) + item.counts.unrated} open cards to re-rate`)
      : null);
}

// The line under the title: what the board still owes the register.
export function summaryLine(doc, data) {
  const parts = [];
  if (data.unrated) parts.push(`${data.unrated} open ${data.unrated === 1 ? 'card is' : 'cards are'} not rated`);
  if (data.needsRerating) parts.push(`${data.needsRerating} ${data.needsRerating === 1 ? 'card needs' : 'cards need'} re-rating`);
  if (!parts.length) return null;
  return el(doc, 'a', { class: 'toc-summary', href: '/kanban.html?order=constraint' }, parts.join(' · '));
}
