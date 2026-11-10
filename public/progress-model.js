// The Progress page's rules, with no DOM: summaries, the headline, "because" lines and chart geometry.
// docs/progress-page.md explains why each rule is the way it is.

export const BANDS = Object.freeze([
  { id: 'momentum', name: 'Momentum', hint: 'What the team moved forward' },
  { id: 'health', name: 'Health', hint: 'Whether the system is well' },
  { id: 'trust', name: 'Trust', hint: 'Whether people can rely on it' },
]);

const DAY_MS = 86_400_000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const dayNumber = (date) => Date.parse(`${date}T00:00:00Z`) / DAY_MS;
export const daysBetween = (from, to) => Math.round(dayNumber(to) - dayNumber(from));
export function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}
const parts = (date) => { const value = new Date(`${date}T00:00:00Z`); return { month: value.getUTCMonth(), day: value.getUTCDate(), year: value.getUTCFullYear(), weekday: value.getUTCDay() }; };
export const shortDate = (date) => { const { month, day } = parts(date); return `${MONTHS[month].slice(0, 3)} ${day}`; };
export const longDate = (date) => { const { month, day, year, weekday } = parts(date); return `${WEEKDAYS[weekday]}, ${MONTHS[month]} ${day}, ${year}`; };
export const plural = (count, one, many = `${one}s`) => `${formatNumber(count)} ${count === 1 ? one : many}`;

export function formatNumber(value, unit = '') {
  if (value === null || value === undefined) return '';
  const abs = Math.abs(value);
  const digits = abs !== 0 && abs < 10 && !Number.isInteger(value) ? 2 : abs < 100 && !Number.isInteger(value) ? 1 : 0;
  const text = value.toLocaleString('en-US', { maximumFractionDigits: digits });
  if (!unit) return text;
  return unit === '%' ? `${text}%` : `${text} ${unit}`;
}

// Labels start a sentence or follow a verb; keep acronyms ("CI checks") as they are.
const sentenceCase = (label) => (/^[A-Z]{2}/.test(label) ? label : label.charAt(0).toUpperCase() + label.slice(1));
const midSentence = (label) => (/^[A-Z]{2}/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1));

// Readings for one metric, oldest first.
export function seriesFor(metrics, key) {
  return metrics.filter((item) => item.key === key).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// good / bad / neutral by the metric's direction, never by the sign alone.
export function toneOf(direction, change) {
  if (!change || direction === 'neutral') return 'neutral';
  const better = direction === 'up_good' ? change > 0 : change < 0;
  return better ? 'good' : 'bad';
}

export function summarize(def, series) {
  const measured = series.filter((item) => item.value !== null);
  const latest = measured.at(-1) ?? null;
  const previous = measured.length > 1 ? measured.at(-2) : null;
  const change = latest && previous ? latest.value - previous.value : null;
  return {
    key: def.key, def, series, measured: Boolean(latest), latest, previous, change,
    tone: change === null ? 'neutral' : toneOf(def.direction, change),
  };
}

// The chip under a tile's number: "+3" or "−2"; nothing when there is no change. The words go in its accessible name.
export function signedChange(summary) {
  const { change, previous, def } = summary;
  if (!previous || !change) return '';
  return `${change > 0 ? '+' : '−'}${formatNumber(Math.abs(change), def.unit === '%' ? '%' : '')}`;
}

// "Up 3 since yesterday", "Down 2 since Oct 30", "No change since yesterday", "First reading".
export function changeText(summary) {
  const { latest, previous, change, def } = summary;
  if (!latest) return '';
  if (!previous) return 'First reading';
  const since = daysBetween(previous.date, latest.date) === 1 ? 'since yesterday' : `since ${shortDate(previous.date)}`;
  if (!change) return `No change ${since}`;
  return `${change > 0 ? 'Up' : 'Down'} ${formatNumber(Math.abs(change), def.unit)} ${since}`;
}

// A move's size: the change relative to the previous reading, negative when it is in the wrong direction.
function moveScore(summary) {
  if (summary.change === null || summary.def.direction === 'neutral' || !summary.change) return 0;
  const relative = Math.abs(summary.change) / Math.max(Math.abs(summary.previous.value), 1);
  return summary.tone === 'good' ? relative : -relative;
}

// The headline says only what the tiles cannot: what is waiting on the reader, and the cause of the
// day's worst move when one is known. With nothing waiting, there is no headline.
// needs is { configured, count } from the board column; because(summary) gives a tile's cause.
export function headline({ summaries, latestDate, needs = { configured: false, count: 0 }, because = () => '' }) {
  if (!needs.configured || !needs.count) return { text: '', sentences: [], attention: false, worst: null };
  const worst = summaries.filter((item) => item.latest?.date === latestDate)
    .map((item) => ({ item, score: moveScore(item) })).filter((entry) => entry.score < 0)
    .sort((a, b) => a.score - b.score)[0]?.item ?? null;
  const cause = worst ? because(worst) : '';
  const ask = `${plural(needs.count, 'item')} ${needs.count === 1 ? 'is' : 'are'} waiting on you.`;
  const sentences = [...(cause ? [/[.?]$/.test(cause) ? cause : `${cause}.`] : []), ask];
  return { text: sentences.join(' '), sentences, attention: true, worst };
}

// The one line that explains a tile's change, only from sources tied to this metric: the reading's
// note, a report line that names the metric, or a milestone that day with this metric's key.
// A milestone without a key belongs to every chart, so it is a flag, never a cause.
export function becauseFor(summary, { bullets = [], milestones = [] } = {}) {
  if (!summary.latest) return '';
  if (summary.latest.note) return summary.latest.note;
  const line = bullets.find((item) => item.metric_key === summary.key);
  if (line) return line.text;
  const milestone = milestones.find((item) => item.date === summary.latest.date && item.metricKey === summary.key);
  return milestone ? milestone.label : '';
}

// Readings within the last `days` days up to `latestDate`; all of them when days is null.
export function windowed(series, days, latestDate) {
  if (!days || !latestDate) return series;
  const from = addDays(latestDate, -(days - 1));
  return series.filter((item) => item.date >= from && item.date <= latestDate);
}

// Rounded axis ticks covering [min, max].
export function niceTicks(min, max, count = 4) {
  if (min === max) { const pad = Math.abs(min) * 0.1 || 1; min -= pad; max += pad; }
  const raw = (max - min) / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((value) => value >= raw);
  const start = Math.floor(min / step) * step;
  const ticks = [];
  for (let value = start; ; value += step) {
    ticks.push(Number(value.toFixed(10)));
    if (value >= max - step * 1e-9) break;
  }
  return ticks;
}

// Positions for a line chart: x by date over [from, to], y by value; null readings break the line.
export function chartGeometry(series, { width, height, top = 8, right = 8, bottom = 8, left = 8, from, to, zero = false, ticks: tickCount = 4 }) {
  const values = series.filter((item) => item.value !== null).map((item) => item.value);
  const first = from ?? series[0]?.date;
  const last = to ?? series.at(-1)?.date;
  const span = first && last ? Math.max(daysBetween(first, last), 1) : 1;
  const low = values.length ? Math.min(...values, ...(zero ? [0] : [])) : 0;
  const high = values.length ? Math.max(...values) : 1;
  const ticks = niceTicks(low, high, tickCount);
  const min = ticks[0];
  const max = ticks.at(-1);
  const x = (date) => left + ((daysBetween(first, date) / span) * (width - left - right));
  const y = (value) => top + (1 - (value - min) / (max - min || 1)) * (height - top - bottom);
  const points = series.filter((item) => item.value !== null).map((item) => ({ ...item, x: x(item.date), y: y(item.value) }));
  const segments = [];
  let current = [];
  for (const item of series) {
    if (item.value === null) { if (current.length) segments.push(current); current = []; continue; }
    current.push({ x: x(item.date), y: y(item.value), rebuilt: Boolean(item.rebuilt) });
  }
  if (current.length) segments.push(current);
  const fmt = (value) => Number(value.toFixed(1));
  // A step touching a reading estimated from history goes in the dashed path; the rest is the solid line.
  const steps = { live: [], estimated: [] };
  for (const segment of segments) {
    if (segment.length === 1) { steps[segment[0].rebuilt ? 'estimated' : 'live'].push(`M${fmt(segment[0].x)} ${fmt(segment[0].y)} h0.01`); continue; }
    for (let index = 1; index < segment.length; index += 1) {
      const [a, b] = [segment[index - 1], segment[index]];
      steps[a.rebuilt || b.rebuilt ? 'estimated' : 'live'].push(`M${fmt(a.x)} ${fmt(a.y)} L${fmt(b.x)} ${fmt(b.y)}`);
    }
  }
  const line = steps.live.join(' ');
  const estimated = steps.estimated.join(' ');
  const base = height - bottom;
  const area = segments.filter((segment) => segment.length > 1)
    .map((segment) => `M${fmt(segment[0].x)} ${base} ${segment.map((point) => `L${fmt(point.x)} ${fmt(point.y)}`).join(' ')} L${fmt(segment.at(-1).x)} ${base} Z`).join(' ');
  return { x, y, points, line, estimated, area, ticks, min, max, from: first, to: last, base };
}

// The reading nearest to a horizontal position, for the crosshair.
export function nearestPoint(points, x) {
  let best = null;
  for (const point of points) if (!best || Math.abs(point.x - x) < Math.abs(best.x - x)) best = point;
  return best;
}
