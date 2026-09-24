import { requestJson } from './browser-utils.js';
const form = document.querySelector('#auth-form');
const status = await requestJson('/api/auth/status');
if (status.authenticated) location.replace('/');
const setup = status.setupRequired;
if (setup) {
  document.querySelector('#auth-kicker').textContent = 'First-run setup';
  document.querySelector('#auth-title').textContent = 'Create the first admin';
  document.querySelector('#auth-copy').textContent = 'This account can manage users, edit projects, and control visibility.';
  document.querySelector('#auth-submit').textContent = 'Create admin account';
  form.elements.password.autocomplete = 'new-password';
}
form.addEventListener('submit', async (event) => {
  event.preventDefault(); const error = document.querySelector('#auth-error'); error.textContent = ''; const button = document.querySelector('#auth-submit'); button.disabled = true;
  try {
    await requestJson(setup ? '/api/auth/setup' : '/api/auth/login', { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(Object.fromEntries(new FormData(form))) });
    const target = new URLSearchParams(location.search).get('returnTo'); location.replace(target?.startsWith('/') && !target.startsWith('//') ? target : '/');
  } catch (caught) { error.textContent = caught.message; button.disabled = false; }
});
