import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { apiTokenDialogState } from './public/api-token-dialog.js';

const visible = (state) => Object.entries(state.buttons).filter(([, shown]) => shown).map(([name]) => name).sort();

test('API access dialog: before shows Replace and Cancel, after a token is created shows only Copy and Done', () => {
  const fresh = apiTokenDialogState();
  assert.deepEqual(visible(fresh), ['cancel', 'generate']);
  assert.equal(fresh.generateLabel, 'Generate token');

  const replace = apiTokenDialogState({ configured: true });
  assert.deepEqual(visible(replace), ['cancel', 'generate']);
  assert.equal(replace.generateLabel, 'Replace token');
  assert.match(replace.explanation, /Replacing revokes the current token immediately/);

  const created = apiTokenDialogState({ created: true, configured: true });
  assert.deepEqual(visible(created), ['copy', 'done']);
  assert.equal(created.generateLabel, undefined);
  assert.equal(created.explanation, '');
  assert.match(created.status, /cannot be shown again/);
});

test('API access dialog markup and wiring match the two states', async () => {
  const html = await readFile('public/index.html', 'utf8');
  const dialog = html.slice(html.indexOf('<dialog id="api-token-dialog"'), html.indexOf('</dialog>', html.indexOf('<dialog id="api-token-dialog"')));
  const footer = dialog.slice(dialog.indexOf('<footer'));
  assert.match(footer, /id="cancel-api-token"[^>]*>Cancel</);
  assert.match(footer, /class="button primary" id="generate-api-token"/);
  assert.match(footer, /id="done-api-token" type="button" hidden>Done</);
  assert.match(footer, /class="button primary" id="copy-api-token" type="button" hidden>Copy</);
  assert.equal(dialog.match(/id="copy-api-token"/g).length, 1);
  assert.match(dialog, /Need several tokens with scopes\? Use <a href="\/tokens\.html">API tokens<\/a>/);

  const app = await readFile('public/app.js', 'utf8');
  assert.match(app, /applyApiTokenState\(apiTokenDialogState\(\{ created: true \}\)\)|const state = apiTokenDialogState\(\{ created: true \}\);\n    applyApiTokenState\(state\)/);
  assert.match(app, /\$\('#done-api-token'\)\.addEventListener\('click', \(\) => apiTokenDialog\.close\(\)\)/);
  assert.match(app, /\$\('#copy-api-token'\)\.addEventListener\('click', \(\) => copyText\(/);
});
