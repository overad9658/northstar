import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDatabase } from './database.mjs';
import { createSsoSettings } from './sso-settings.mjs';
import { startServer, stopServer } from './support/server-fixture.mjs';

const cert = readFileSync(new URL('./support/fixtures/sso-test-cert.pem', import.meta.url), 'utf8');
const key = readFileSync(new URL('./support/fixtures/sso-test-key.pem', import.meta.url), 'utf8');
const oidc = { id: 'okta', name: 'Okta', type: 'oidc', issuer: 'https://idp.example', clientId: 'northstar', clientSecret: 'do-not-return-this-secret' };
const saml = { id: 'saml', type: 'saml', entryPoint: 'https://idp.example/sso', idpIssuer: 'https://idp.example', entityId: 'northstar-sp', idpCert: cert, privateKey: key, publicCert: cert };

test('SSO settings redact secrets, preserve them on edits and reject invalid configuration atomically', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'northstar-settings-'));
  const path = join(directory, 'settings.db');
  let db = openDatabase(path);
  try {
    const settings = createSsoSettings(db);
    settings.save({ revision: 0, publicUrl: 'https://app.example', providers: [oidc, saml] });
    const view = settings.view();
    assert.equal(view.source, 'saved'); assert.equal(view.revision, 1);
    assert.equal(view.providers[0].hasClientSecret, true); assert.equal(view.providers[1].hasPrivateKey, true);
    assert.equal(JSON.stringify(view).includes(oidc.clientSecret), false); assert.equal(JSON.stringify(view).includes(key), false);
    settings.save({ ...view, providers: view.providers.map((p) => ({ ...p, name: 'Renamed', clientSecret: '', privateKey: '' })) });
    assert.equal(settings.load().providers[0].clientSecret, oidc.clientSecret);
    assert.equal(settings.load().providers[1].privateKey, key);
    assert.throws(() => settings.save({ ...view, providers: [] }), /another window/);
    const current = settings.view();
    for (const providers of [[{ ...oidc, issuer: 'http://untrusted.example' }], [{ ...saml, idpCert: 'invalid certificate' }], [{ ...saml, publicCert: 'invalid certificate' }], [{ ...saml, wantAuthnResponseSigned: 'false' }], [oidc, oidc]]) {
      assert.throws(() => settings.save({ ...current, providers }));
      assert.equal(settings.view().revision, current.revision);
    }
    // Browser input must never resolve environment variables or filesystem paths.
    settings.save({ ...current, providers: [{ ...current.providers[0], issuer: 'https://new.example', clientSecretEnv: 'NOT_ALLOWED', idpCertFile: '/etc/passwd', clearClientSecret: true, tokenEndpointAuthMethod: 'none' }, { ...current.providers[1], clearPrivateKey: true }] });
    const loaded = settings.load();
    assert.equal(loaded.providers[0].clientSecret, undefined); assert.equal(loaded.providers[0].clientSecretEnv, undefined);
    assert.equal(loaded.providers[0].idpCertFile, undefined); assert.equal(loaded.providers[1].privateKey, undefined); assert.equal(loaded.providers[1].publicCert, undefined);
    db.close(); db = openDatabase(path);
    assert.equal(createSsoSettings(db).view().revision, 3);
    assert.equal(createSsoSettings(db).load().providers[0].issuer, 'https://new.example');
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

test('hamburger SSO settings require admin access and update sign-in options immediately and across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'northstar-settings-http-'));
  const port = 36000 + (process.pid % 1000), base = `http://127.0.0.1:${port}`;
  const env = { AUTH_DISABLED: 'false', PUBLIC_URL: '', SSO_CONFIG_FILE: '', SSO_PROVIDERS: '[]' };
  let server = await startServer(directory, port, env);
  const send = (path, body, cookie, method = 'POST') => fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const session = (res) => res.headers.get('set-cookie').split(';')[0];
  try {
    const home = await fetch(`${base}/`).then((res) => res.text());
    assert.match(home, /data-admin href="\/sso.html"/);
    assert.equal((await fetch(`${base}/sso.html`)).status, 200);
    assert.equal((await fetch(`${base}/api/admin/sso`)).status, 401);
    assert.equal((await send('/api/admin/sso', {}, '', 'PUT')).status, 401);
    const admin = session(await send('/api/auth/setup', { username: 'owner', password: 'correct horse battery staple' }));
    await send('/api/users', { username: 'viewer', password: 'read only password', role: 'read_only' }, admin);
    const viewer = session(await send('/api/auth/login', { username: 'viewer', password: 'read only password' }));
    assert.equal((await fetch(`${base}/api/admin/sso`, { headers: { cookie: viewer } })).status, 403);
    assert.equal((await send('/api/admin/sso', {}, viewer, 'PUT')).status, 403);
    const saved = await send('/api/admin/sso', { revision: 0, publicUrl: 'https://app.example', providers: [oidc, saml] }, admin, 'PUT');
    assert.equal(saved.status, 200); assert.equal(saved.headers.get('cache-control'), 'no-store');
    const view = await saved.json(); assert.equal(JSON.stringify(view).includes(oidc.clientSecret), false); assert.equal(JSON.stringify(view).includes(key), false);
    const status = await fetch(`${base}/api/auth/status`).then((res) => res.json());
    assert.deepEqual(status.ssoProviders.map((p) => p.id), ['okta', 'saml']);
    const login = await fetch(`${base}/api/auth/sso/saml/login`, { redirect: 'manual' }); assert.equal(login.status, 303);
    const relay = new URL(login.headers.get('location')).searchParams.get('RelayState');
    const pendingCookie = session(login);
    const edited = await send('/api/admin/sso', { ...view, providers: view.providers.map((p) => ({ ...p, name: 'Company' })) }, admin, 'PUT'); assert.equal(edited.status, 200);
    const callback = await fetch(`${base}/api/auth/sso/saml/callback`, { method: 'POST', headers: { cookie: pendingCookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ RelayState: relay, SAMLResponse: 'invalid' }).toString(), redirect: 'manual' });
    assert.equal(callback.headers.get('location'), '/login.html?ssoError=1');
    assert.equal((await send('/api/admin/sso', { ...view, providers: [] }, admin, 'PUT')).status, 409);
    const latest = await edited.json();
    const invalid = await send('/api/admin/sso', { ...latest, publicUrl: 'http://app.example' }, admin, 'PUT'); assert.equal(invalid.status, 400);
    await stopServer(server); server = await startServer(directory, port, env);
    const persisted = await fetch(`${base}/api/admin/sso`, { headers: { cookie: admin } }).then((res) => res.json());
    assert.equal(persisted.revision, 2); assert.equal(persisted.providers[0].name, 'Company'); assert.equal(persisted.providers[0].hasClientSecret, true);
    const removed = await send('/api/admin/sso', { ...persisted, providers: [] }, admin, 'PUT'); assert.equal(removed.status, 200);
    assert.deepEqual((await fetch(`${base}/api/auth/status`).then((res) => res.json())).ssoProviders, []);
    assert.equal((await fetch(`${base}/api/auth/sso/saml/login`, { redirect: 'manual' })).status, 404);
    // Local recovery sign-in still works after removing every provider.
    assert.equal((await send('/api/auth/login', { username: 'owner', password: 'correct horse battery staple' })).status, 200);
  } finally { await stopServer(server); await rm(directory, { recursive: true, force: true }); }
});
