import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { cardMatches, requestedCard } from './public/shared/card-search.js';

const card = { id: 12, title: 'Review the release notes', key: 'sync:T-7' };

test('a card is found by its number, with or without #', () => {
  assert.equal(cardMatches(card, '#12'), true);
  assert.equal(cardMatches(card, '12'), true);
  assert.equal(cardMatches(card, ' #12 '), true);
  assert.equal(cardMatches(card, '#1'), false, 'a number matches the whole id, not a prefix');
  assert.equal(cardMatches(card, '#120'), false);
  assert.equal(cardMatches({ ...card, title: 'Fix 12 links' }, '#13'), false, '#n never falls back to the title');
  assert.equal(cardMatches({ ...card, id: 5, title: 'Fix 12 links' }, '12'), true, 'a bare number also matches title text');
});

test('a card is found by title or key text, ignoring case; an empty search matches everything', () => {
  assert.equal(cardMatches(card, 'release'), true);
  assert.equal(cardMatches(card, 'RELEASE NOTES'), true);
  assert.equal(cardMatches(card, 't-7'), true);
  assert.equal(cardMatches(card, 'deploy'), false);
  assert.equal(cardMatches(card, ''), true);
  assert.equal(cardMatches(card, '   '), true);
  assert.equal(cardMatches({ id: 3, title: 'No key' }, 'key'), true);
  assert.equal(cardMatches({ id: 3, title: 'Plain' }, 'sync'), false);
});

test('?card=<id> names one positive card id, anything else names none', () => {
  assert.equal(requestedCard('?card=12'), 12);
  assert.equal(requestedCard('?teamId=2&card=7'), 7);
  for (const search of ['', '?card=', '?card=0', '?card=-3', '?card=1.5', '?card=abc', '?card=12abc', '?teamId=2']) assert.equal(requestedCard(search), null, search);
});

test('the kanban page has the search box and shows card numbers', async () => {
  const [html, script] = await Promise.all([readFile(new URL('./public/kanban.html', import.meta.url), 'utf8'), readFile(new URL('./public/kanban.js', import.meta.url), 'utf8')]);
  assert.match(html, /id="card-search"/);
  assert.match(script, /class="kanban-card-id"[^>]*>#\$\{card\.id\}/);
  assert.match(script, /Edit card · #\$\{card\.id\}/);
  assert.match(script, /requestedCard\(location\.search\)/);
});
