import assert from 'node:assert/strict';
import test from 'node:test';
import { contrastRows, ratio } from '../support/progress-contrast.mjs';

test('the contrast check computes WCAG ratios', () => {
  assert.equal(Math.round(ratio('#000000', '#ffffff') * 10) / 10, 21);
  assert.equal(ratio('#777777', '#777777'), 1);
});

test('every Progress page color pair meets AA in light and dark', () => {
  const rows = contrastRows();
  assert.equal(rows.length % 2, 0);
  assert.deepEqual(new Set(rows.map((row) => row.theme)), new Set(['light', 'dark']));
  const failing = rows.filter((row) => !row.pass).map((row) => `${row.what} (${row.theme}): ${row.ratio}:1, needs ${row.min}:1`);
  assert.deepEqual(failing, []);
});
