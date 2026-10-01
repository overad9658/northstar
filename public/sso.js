import { escapeHtml, requestJson, showToast } from './browser-utils.js';

const form = document.querySelector('#sso-form'), list = document.querySelector('#provider-list');
const error = document.querySelector('#sso-error'), publicUrl = document.querySelector('#public-url');
let settings, providers = [], savedIds = new Set();
const presets = {
  cognito: { name: 'AWS Cognito', type: 'oidc', issuer: '', clientId: '', tokenEndpointAuthMethod: 'client_secret_basic', scopes: 'profile email' },
  okta: { name: 'Okta', type: 'oidc', issuer: '', clientId: '', tokenEndpointAuthMethod: 'client_secret_basic', scopes: 'profile email' },
  pingone: { name: 'PingOne', type: 'oidc', issuer: '', clientId: '', tokenEndpointAuthMethod: 'client_secret_basic', scopes: 'profile email' },
  oidc: { name: 'Company sign-in', type: 'oidc', issuer: '', clientId: '', tokenEndpointAuthMethod: 'client_secret_basic', scopes: 'profile email' },
  saml: { name: 'Company sign-in', type: 'saml', entryPoint: '', idpIssuer: '', entityId: '', idpCert: '', identifierFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent' },
};
function field(p, name, label, { type = 'text', required = false, placeholder = '', textarea = false, wide = false, secret = false } = {}) {
  const value = Array.isArray(p[name]) ? p[name].join('\n\n') : p[name] || '';
  const hasSaved = p[`has${name[0].toUpperCase()}${name.slice(1)}`];
  const attributes = `name="${name}" ${required ? 'required' : ''} placeholder="${escapeHtml(secret && hasSaved ? 'Saved — leave blank to keep' : placeholder)}" ${secret ? 'autocomplete="new-password"' : ''}`;
  const control = textarea ? `<textarea ${attributes} ${secret ? 'spellcheck="false"' : ''}>${escapeHtml(value)}</textarea>` : `<input type="${type}" ${attributes} value="${escapeHtml(value)}" ${name === 'id' && savedIds.has(p.id) ? 'readonly' : ''}>`;
  return `<label class="field ${wide ? 'wide' : ''}"><span>${label}</span>${control}${secret && hasSaved ? '<small>A value is saved. Enter a replacement or leave blank to keep it.</small>' : ''}</label>`;
}
function endpointMarkup(p) {
  const base = publicUrl.value.trim().replace(/\/$/, '');
  if (!base || !p.id) return '<p>Enter the public URL and provider ID to see the callback address.</p>';
  const path = `/api/auth/sso/${encodeURIComponent(p.id)}`;
  let html = `<p>${p.type === 'saml' ? 'ACS / single sign-on URL' : 'Sign-in redirect URI'} — register this in your provider</p><code>${escapeHtml(base + path + '/callback')}</code>`;
  if (p.type === 'saml') {
    html += `<p>SP metadata URL — available after saving</p><code>${escapeHtml(base + path + '/metadata')}</code>`;
    if (savedIds.has(p.id)) html += `<a href="${path}/metadata" target="_blank" rel="noopener">Open SAML metadata</a>`;
  }
  return html;
}
function render() {
  list.innerHTML = providers.length ? providers.map((p, index) => {
    const common = field(p, 'name', 'Button label', { required: true }) + field(p, 'id', 'Provider ID', { required: true, placeholder: 'company' });
    const protocol = p.type === 'oidc' ?
      field(p, 'issuer', 'Issuer URL', { required: true, type: 'url', placeholder: 'https://your-provider.example.com' }) +
      field(p, 'clientId', 'Client ID', { required: true }) +
      field(p, 'clientSecret', 'Client secret', { type: 'password', secret: true }) +
      `<label class="field"><span>Client authentication</span><select name="tokenEndpointAuthMethod">${[['client_secret_basic', 'Client secret · Basic'], ['client_secret_post', 'Client secret · POST'], ['none', 'Public client · PKCE']].map(([value, label]) => `<option value="${value}" ${p.tokenEndpointAuthMethod === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>` +
      field(p, 'scopes', 'Additional scopes', { placeholder: 'profile email' }) +
      `<label class="sso-checkbox"><input name="clearClientSecret" type="checkbox" ${p.clearClientSecret ? 'checked' : ''}>Remove saved client secret</label>` :
      field(p, 'entryPoint', 'Identity provider SSO URL', { type: 'url', required: true }) +
      field(p, 'idpIssuer', 'Identity provider issuer / entity ID', { required: true }) +
      field(p, 'entityId', 'Northstar SP entity ID / audience', { required: true }) +
      field(p, 'identifierFormat', 'NameID format') +
      field(p, 'idpCert', 'Identity provider signing certificate(s) · PEM', { required: true, textarea: true, wide: true }) +
      `<label class="sso-checkbox wide"><input name="wantAuthnResponseSigned" type="checkbox" ${p.wantAuthnResponseSigned ? 'checked' : ''}>Require signed responses as well as signed assertions</label>` +
      `<details class="wide"><summary>Optional: sign requests to the provider</summary><div class="sso-provider-grid">${field(p, 'privateKey', 'SP private signing key · PEM', { textarea: true, secret: true, wide: true })}${field(p, 'publicCert', 'SP public signing certificate · PEM', { textarea: true, wide: true })}<label class="sso-checkbox wide"><input name="clearPrivateKey" type="checkbox" ${p.clearPrivateKey ? 'checked' : ''}>Remove saved SP private key</label></div></details>`;
    return `<section class="sso-provider" data-index="${index}"><header><h3>${escapeHtml(p.name || p.id)} · ${p.type === 'oidc' ? 'OIDC' : 'SAML 2.0'}</h3><button class="text-danger" data-remove="${index}" type="button">Remove provider</button></header><div class="sso-provider-grid">${common}${protocol}</div><div class="sso-endpoints">${endpointMarkup(p)}</div></section>`;
  }).join('') : '<div class="settings-empty"><h3>No identity providers</h3><p>Add a provider to offer single sign-on on the sign-in page.</p></div>';
  for (const input of list.querySelectorAll('input[name="id"]')) { input.pattern = '[a-z][a-z0-9-]{0,31}'; input.maxLength = 32; }
}
function collect() {
  for (const card of list.querySelectorAll('[data-index]')) {
    const p = providers[Number(card.dataset.index)];
    for (const input of card.querySelectorAll('[name]')) {
      p[input.name] = input.type === 'checkbox' ? input.checked : input.value;
      if (input.name === 'idpCert') {
        const certs = input.value.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
        if (certs?.length > 1) p.idpCert = certs;
      }
    }
  }
}
function accept(value) {
  settings = value; providers = value.providers; savedIds = new Set(providers.map((p) => p.id)); publicUrl.value = value.publicUrl;
  document.querySelector('#sso-source').textContent = value.source === 'environment' ? 'Saving here stores settings in Northstar and replaces the environment configuration.' : 'Settings are saved in Northstar and persist across restarts.';
  form.hidden = false; render();
}
document.querySelector('#add-provider').addEventListener('click', () => {
  collect(); const preset = document.querySelector('#provider-preset').value;
  let id = preset, number = 2; while (providers.some((p) => p.id === id)) id = `${preset}-${number++}`;
  providers.push({ ...presets[preset], id }); render(); list.lastElementChild.querySelector('input').focus();
});
list.addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove]'); if (!button) return;
  collect(); providers.splice(Number(button.dataset.remove), 1); render();
});
function updateEndpoints() {
  collect(); for (const card of list.querySelectorAll('[data-index]')) card.querySelector('.sso-endpoints').innerHTML = endpointMarkup(providers[Number(card.dataset.index)]);
}
publicUrl.addEventListener('input', updateEndpoints);
list.addEventListener('input', (event) => { if (event.target.name === 'id') updateEndpoints(); });
form.addEventListener('submit', async (event) => {
  event.preventDefault(); collect(); error.textContent = '';
  const button = form.querySelector('button[type="submit"]'); button.disabled = true;
  try {
    accept(await requestJson('/api/admin/sso', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: settings.revision, publicUrl: publicUrl.value, providers }) }));
    document.querySelector('#sso-status').textContent = 'SSO settings saved. Changes are active now.'; showToast('SSO settings saved');
  } catch (caught) { error.textContent = caught.message; error.scrollIntoView({ block: 'center' }); }
  finally { button.disabled = false; }
});
try { accept(await requestJson('/api/admin/sso')); }
catch (caught) { error.textContent = caught.message; }
