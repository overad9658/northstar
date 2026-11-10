// WCAG contrast ratios for the Progress page, computed from the CSS color tokens in both themes.
// Text needs 4.5:1 (AA); lines, dots and other graphics need 3:1. `node support/progress-contrast.mjs`
// prints the table; tests/progress-contrast.test.mjs fails when a pair drops below its minimum.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// The `--name:#hex` tokens declared inside the first block that starts with `selector`.
function tokens(css, selector) {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`No ${selector} block.`);
  const block = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{3,6})\b/gi)].map(([, name, value]) => [name, value]));
}

export function themes() {
  const foundation = read('public/styles/foundation.css');
  const theme = read('public/styles/theme.css');
  const progress = read('public/progress.css');
  const light = { ...tokens(foundation, ':root'), ...tokens(progress, ':root') };
  const dark = { ...light, ...tokens(theme, '[data-theme="dark"]'), ...tokens(progress, '[data-theme="dark"]') };
  return { light, dark };
}

function luminance(hex) {
  const value = hex.length === 4 ? hex.slice(1).split('').map((c) => c + c).join('') : hex.slice(1);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function ratio(a, b) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

// [what, foreground token, background token, minimum]
export const PAIRS = Object.freeze([
  ['Tile label and number', 'ink', 'tile', 4.5],
  ['Hovered tile text', 'ink', 'tile-hover', 4.5],
  ['Because line, unit, chart labels', 'muted', 'tile', 4.5],
  ['Headline', 'ink', 'paper', 4.5],
  ['Date, unmeasured label', 'muted', 'paper', 4.5],
  ['Chip, right direction', 'good-ink', 'good-bg', 4.5],
  ['Chip, wrong direction', 'bad-ink', 'bad-bg', 4.5],
  ['Chip, neither', 'flat-ink', 'flat-bg', 4.5],
  ['"See all on the board" link', 'accent', 'tile', 4.5],
  ['Line', 'series', 'tile', 3],
  ['Line estimated from history', 'estimated', 'tile', 3],
  ['Unmeasured baseline', 'estimated', 'paper', 3],
  ['Milestone flag', 'flag', 'tile', 3],
  ['Status dot', 'accent', 'paper', 3],
  ['Waiting on you rule', 'accent', 'tile', 3],
]);

export function contrastRows() {
  const palettes = themes();
  return PAIRS.flatMap(([what, fg, bg, min]) => Object.entries(palettes).map(([name, palette]) => {
    if (!palette[fg] || !palette[bg]) throw new Error(`Missing token ${palette[fg] ? bg : fg} in ${name}.`);
    const value = ratio(palette[fg], palette[bg]);
    return { what, theme: name, fg: palette[fg], bg: palette[bg], ratio: Math.round(value * 100) / 100, min, pass: value >= min };
  }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rows = contrastRows();
  console.log('| Pair | Theme | Colors | Ratio | Needs | Result |\n| --- | --- | --- | --- | --- | --- |');
  for (const row of rows) console.log(`| ${row.what} | ${row.theme} | \`${row.fg}\` on \`${row.bg}\` | ${row.ratio.toFixed(2)}:1 | ${row.min}:1 | ${row.pass ? 'pass' : 'FAIL'} |`);
  if (rows.some((row) => !row.pass)) process.exit(1);
}
