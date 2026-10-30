import { $, requestJson, showToast } from './browser-utils.js';

// Built with createElement and textContent only: token names are user input, and the page runs under a strict CSP.
const list = $('#token-list');
const form = $('#create-token-form');
const created = $('#token-created');
const createdValue = $('#token-created-value');
const copyStatus = $('#copy-status');

function element(tag, { className, text } = {}, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  node.append(...children);
  return node;
}

// SQLite timestamps are UTC without a zone marker.
function formatTime(value) {
  if (!value) return '—';
  const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${String(value).replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function actions(token) {
  const cell = element('div', { className: 'token-actions' });
  if (token.revokedAt) {
    cell.append(element('span', { text: `Revoked ${formatTime(token.revokedAt)}` }));
    return cell;
  }
  const revoke = element('button', { className: 'text-danger', text: 'Revoke' });
  revoke.type = 'button';
  revoke.addEventListener('click', () => {
    const prompt = element('span', { text: `Revoke “${token.name}”? Clients using it stop working.` });
    const confirmButton = element('button', { className: 'text-danger', text: 'Revoke token' });
    const cancel = element('button', { className: 'button secondary', text: 'Cancel' });
    confirmButton.type = 'button';
    cancel.type = 'button';
    cancel.addEventListener('click', () => cell.replaceChildren(revoke));
    confirmButton.addEventListener('click', async () => {
      confirmButton.disabled = true;
      try {
        await requestJson(`/api/api-tokens/${token.id}`, { method: 'DELETE' }, 'The token could not be revoked.');
        showToast('Token revoked');
        await load();
      } catch (error) {
        $('#token-list-error').textContent = error.message;
        confirmButton.disabled = false;
      }
    });
    cell.replaceChildren(prompt, confirmButton, cancel);
    confirmButton.focus();
  });
  cell.append(element('span', { text: 'Active' }), revoke);
  return cell;
}

function render(tokens) {
  list.replaceChildren(...tokens.map((token) => {
    const row = element('tr', { className: token.revokedAt ? 'revoked' : '' },
      element('td', { text: token.name }),
      element('td', {}, element('span', { className: 'token-scope', text: token.scope })),
      element('td', { text: token.createdBy?.username || '—' }),
      element('td', { text: formatTime(token.createdAt) }),
      element('td', { text: formatTime(token.lastUsedAt) }),
      element('td', {}, actions(token)));
    row.dataset.id = String(token.id);
    return row;
  }));
  $('#token-empty').hidden = tokens.length > 0;
}

async function load() {
  $('#token-list-error').textContent = '';
  try {
    render(await requestJson('/api/api-tokens', undefined, 'Tokens could not be loaded.'));
  } catch (error) {
    $('#token-list-error').textContent = error.message;
  }
}

// Clipboard access stays inside the click; without it, select the text so the user can copy it.
async function copyToken() {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(createdValue.value);
    copyStatus.textContent = 'Copied.';
  } catch {
    createdValue.focus();
    createdValue.select();
    copyStatus.textContent = 'Selected. Press Ctrl+C (⌘C) to copy.';
  }
}

function hideCreated() {
  created.hidden = true;
  createdValue.value = '';
  copyStatus.textContent = '';
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#create-token-error').textContent = '';
  const data = Object.fromEntries(new FormData(form));
  try {
    const token = await requestJson('/api/api-tokens', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: data.name, scope: data.scope }),
    }, 'The token could not be created.');
    form.reset();
    $('#token-created-label').textContent = `New ${token.scope} token “${token.name}”`;
    createdValue.value = token.token;
    copyStatus.textContent = '';
    created.hidden = false;
    createdValue.focus();
    createdValue.select();
    await load();
  } catch (error) {
    $('#create-token-error').textContent = error.message;
  }
});
$('#copy-token').addEventListener('click', copyToken);
$('#dismiss-token').addEventListener('click', hideCreated);

const user = await requestJson('/api/auth/me').catch(() => null);
if (user?.role === 'admin') {
  $('#tokens-card').hidden = false;
  await load();
} else if (user) {
  $('#tokens-denied').hidden = false;
}
