import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import test from 'node:test';
import * as oidc from 'openid-client';
import { SignedXml } from 'xml-crypto';
import { openDatabase } from './database.mjs';
import { createAuthService } from './auth-service.mjs';
import { createSsoService, loadSsoConfig, safeReturnTo } from './sso-service.mjs';
import { safeReturnTo as browserReturnTo } from './public/login-utils.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stopServer } from './support/server-fixture.mjs';

// Public test credentials, never used by the application or a real provider.
const privateKey = readFileSync(new URL('./support/fixtures/sso-test-key.pem', import.meta.url), 'utf8');
const certificate = readFileSync(new URL('./support/fixtures/sso-test-cert.pem', import.meta.url), 'utf8');
function response() {
  return { headers: {}, status: null, body: '', setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; },
    writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); }, end(body = '') { this.body = body; } };
}
function request(method = 'GET', cookie = '', body = '') {
  const req = Readable.from([Buffer.from(body)]);
  req.method = method; req.headers = { cookie, 'content-type': 'application/x-www-form-urlencoded' }; return req;
}
function setup(config, options) {
  const db = openDatabase(':memory:'); const auth = createAuthService(db, { disabled: false, signupAllowed: true, secureCookies: true });
  auth.setup({ username: 'owner', password: 'correct horse battery staple' }, request(), response());
  const service = createSsoService(db, auth, config, options);
  return { db, auth, service };
}
async function start(service, id, returnTo = '/') {
  const res = response(); await service.handle(request(), res, new URL(`https://app.example/api/auth/sso/${id}/login?returnTo=${encodeURIComponent(returnTo)}`));
  assert.equal(res.status, 303);
  return { res, url: new URL(res.headers.location), cookie: res.headers['set-cookie'].split(';')[0] };
}

test('SSO configuration requires trusted URLs and secrets, and exposes only provider labels', () => {
  assert.deepEqual(loadSsoConfig({}), { providers: [], publicUrl: null, signupAllowed: false });
  const p = { id: 'okta', type: 'oidc', issuer: 'https://id.example', clientId: 'northstar', clientSecretEnv: 'OKTA_SECRET' };
  const env = { PUBLIC_URL: 'https://app.example', SSO_PROVIDERS: JSON.stringify([p]), OKTA_SECRET: 'secret' };
  const config = loadSsoConfig(env);
  assert.equal(config.providers[0].clientSecret, 'secret');
  for (const overrides of [{ PUBLIC_URL: '' }, { PUBLIC_URL: 'http://app.example' }, { PUBLIC_URL: 'https://app.example/base' }, { OKTA_SECRET: '' }, { SSO_PROVIDERS: JSON.stringify([p, p]) }, { SSO_PROVIDERS: JSON.stringify([{ ...p, issuer: 'http://id.example' }]) }]) {
    assert.throws(() => loadSsoConfig({ ...env, ...overrides }));
  }
  const { db, service } = setup(config);
  try { assert.deepEqual(service.providers(), [{ id: 'okta', name: 'okta', type: 'oidc' }]); } finally { db.close(); }
});

test('return destinations reject external URLs and backslash redirects on server and browser', () => {
  for (const clean of [safeReturnTo, browserReturnTo]) {
    for (const unsafe of ['https://evil.example', '//evil.example', '/\\evil.example', '/\n/evil.example', ' /teams.html', null]) assert.equal(clean(unsafe), '/');
    assert.equal(clean('/teams.html?view=capacity#team'), '/teams.html?view=capacity#team');
  }
});

test('SSO HTTP routes expose safe provider details, metadata and redirects alongside local login', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'northstar-sso-'));
  const port = 35000 + (process.pid % 1000);
  const server = await startServer(dataDir, port, {
    AUTH_DISABLED: 'false', PUBLIC_URL: 'https://app.example', SSO_CONFIG_FILE: '',
    SSO_PROVIDERS: JSON.stringify([{ id: 'saml', name: 'Company sign-in', type: 'saml', entityId: 'northstar-sp', idpIssuer: 'https://idp.example', entryPoint: 'https://idp.example/sso', idpCert: certificate }]),
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    const status = await fetch(`${base}/api/auth/status`).then((res) => res.json());
    assert.equal(status.setupRequired, true);
    assert.deepEqual(status.ssoProviders, [{ id: 'saml', name: 'Company sign-in', type: 'saml' }]);
    assert.equal((await fetch(`${base}/api/auth/sso/saml/login`, { redirect: 'manual' })).status, 409);
    const metadata = await fetch(`${base}/api/auth/sso/saml/metadata`);
    assert.equal(metadata.status, 200); assert.match(await metadata.text(), /northstar-sp/);
    assert.equal((await fetch(`${base}/api/auth/sso/unknown/login`)).status, 404);
    const setup = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'correct horse battery staple' }) });
    assert.equal(setup.status, 201); assert.match(setup.headers.get('set-cookie'), /Secure/);
    const login = await fetch(`${base}/api/auth/sso/saml/login?returnTo=/teams.html`, { redirect: 'manual' });
    assert.equal(login.status, 303); assert.equal(new URL(login.headers.get('location')).origin, 'https://idp.example');
    assert.match(login.headers.get('set-cookie'), /SameSite=None.*Secure/);
    assert.equal(login.headers.get('cache-control'), 'no-store');
    const failure = await fetch(`${base}/api/auth/sso/saml/callback`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'SAMLResponse=invalid&RelayState=invalid', redirect: 'manual' });
    assert.equal(failure.status, 303); assert.equal(failure.headers.get('location'), '/login.html?ssoError=1');
    assert.equal((await fetch(`${base}/api/projects`)).status, 401);
  } finally { await stopServer(server); await rm(dataDir, { recursive: true, force: true }); }
});

test('OIDC validates signed ID tokens, PKCE, nonce, state, browser binding and one-time use', async () => {
  const key = createPrivateKey(privateKey); const jwk = createPublicKey(key).export({ format: 'jwk' });
  const grants = new Map(); let issuer, tokenRequests = 0;
  const idp = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/.well-known/openid-configuration') return res.end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_basic'] }));
    if (req.url === '/jwks') return res.end(JSON.stringify({ keys: [{ ...jwk, kid: 'test', use: 'sig', alg: 'RS256' }] }));
    if (req.url === '/token') {
      tokenRequests++;
      let body = ''; for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body), grant = grants.get(params.get('code'));
      assert.equal(req.headers.authorization, `Basic ${Buffer.from('northstar:secret').toString('base64')}`);
      assert.equal(params.get('redirect_uri'), 'https://app.example/api/auth/sso/oidc/callback');
      assert.equal(createHash('sha256').update(params.get('code_verifier')).digest('base64url'), grant.challenge);
      const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ iss: issuer, sub: 'stable-subject', aud: grant.audience || 'northstar', iat: now, exp: grant.expired ? now - 120 : now + 300, nonce: grant.badNonce ? 'wrong' : grant.nonce, email: 'owner', role: 'admin' })).toString('base64url');
      const unsigned = `${header}.${payload}`;
      let signature = sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url');
      if (grant.badSignature) signature = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
      return res.end(JSON.stringify({ access_token: 'test', token_type: 'Bearer', id_token: `${unsigned}.${signature}` }));
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((resolve) => idp.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${idp.address().port}`;
  const config = { publicUrl: 'https://app.example', providers: [{ id: 'oidc', type: 'oidc', issuer, clientId: 'northstar', clientSecret: 'secret', tokenEndpointAuthMethod: 'client_secret_basic' }] };
  const options = { discover: (server, clientId, metadata, authentication) => oidc.discovery(server, clientId, metadata, authentication, { execute: [oidc.allowInsecureRequests] }) };
  const { db, auth, service } = setup(config, options);
  async function finish(flow, code, cookie = flow.cookie, targetService = service) {
    const res = response();
    await targetService.handle(request('GET', cookie), res, new URL(`https://app.example/api/auth/sso/oidc/callback?code=${code}&state=${flow.url.searchParams.get('state')}`));
    return res;
  }
  function grant(flow, name, changes = {}) {
    assert.equal(flow.url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(flow.url.searchParams.get('response_mode'), 'query');
    grants.set(name, { challenge: flow.url.searchParams.get('code_challenge'), nonce: flow.url.searchParams.get('nonce'), ...changes });
  }
  try {
    const flow = await start(service, 'oidc', '/teams.html'); grant(flow, 'valid');
    assert.match(flow.res.headers['set-cookie'], /HttpOnly; SameSite=Lax/);
    const noCookie = await finish(flow, 'valid', ''); assert.equal(noCookie.headers.location, '/login.html?ssoError=1'); assert.equal(tokenRequests, 0);
    // Reconstruct the service to prove pending requests survive a restart.
    const signedIn = await finish(flow, 'valid', flow.cookie, createSsoService(db, auth, config, options));
    assert.equal(signedIn.headers.location, '/teams.html');
    const sessionCookie = signedIn.headers['set-cookie'].find((c) => c.startsWith('northstar_session=')).split(';')[0];
    const user = auth.userForRequest(request('GET', sessionCookie));
    assert.equal(user.role, 'read_only'); assert.equal(user.authType, 'sso'); assert.notEqual(user.username, 'owner');
    assert.throws(() => auth.updateUser(user.id, { password: 'password override' }, user), /identity provider/);
    assert.equal((await finish(flow, 'valid')).headers.location, '/login.html?ssoError=1');
    const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    auth.updateUser(user.id, { username: 'sso-reader', role: 'admin' }, { id: 1 });
    const again = await start(service, 'oidc'); grant(again, 'again'); assert.equal((await finish(again, 'again')).headers.location, '/');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, count);
    assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get(user.id).role, 'admin');
    for (const change of [{ badNonce: true }, { badSignature: true }, { audience: 'another-client' }, { expired: true }]) {
      const invalid = await start(service, 'oidc'); grant(invalid, 'invalid', change);
      assert.equal((await finish(invalid, 'invalid')).headers.location, '/login.html?ssoError=1', JSON.stringify(change));
    }
    const expired = await start(service, 'oidc'); grant(expired, 'expired');
    db.prepare('UPDATE auth_sso_requests SET expires_at = 0').run();
    assert.equal((await finish(expired, 'expired')).headers.location, '/login.html?ssoError=1');
  } finally { db.close(); await new Promise((resolve) => idp.close(resolve)); }
});

function samlResponse(requestId, changes = {}) {
  const now = Date.now(), issuer = changes.issuer || 'https://idp.example', recipient = changes.recipient || 'https://app.example/api/auth/sso/saml/callback';
  const expires = new Date(changes.expired ? now - 120_000 : now + 300_000).toISOString();
  const assertion = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_assertion${now}" Version="2.0" IssueInstant="${new Date(now).toISOString()}"><saml:Issuer>${issuer}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">person-123</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${requestId}" Recipient="${recipient}" NotOnOrAfter="${expires}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${new Date(now - 60_000).toISOString()}" NotOnOrAfter="${expires}"><saml:AudienceRestriction><saml:Audience>${changes.audience || 'northstar-sp'}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${new Date(now).toISOString()}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement></saml:Assertion>`;
  const signer = new SignedXml({ privateKey, publicCert: certificate, signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#' });
  signer.addReference({ xpath: "//*[local-name()='Assertion']", transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'], digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' });
  signer.computeSignature(assertion, { location: { reference: "//*[local-name()='Issuer']", action: 'after' } });
  let signed = changes.unsigned ? assertion : signer.getSignedXml();
  if (changes.tampered) signed = signed.replace('person-123', 'attacker');
  return Buffer.from(`<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_response${now}" Version="2.0" IssueInstant="${new Date(now).toISOString()}" Destination="${recipient}" InResponseTo="${requestId}"><saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${issuer}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${signed}</samlp:Response>`).toString('base64');
}

test('SAML accepts signed assertions and rejects replay, unsolicited, tampered and misdirected assertions', async () => {
  const config = loadSsoConfig({ PUBLIC_URL: 'https://app.example', SSO_PROVIDERS: JSON.stringify([{ id: 'saml', type: 'saml', entryPoint: 'https://idp.example/sso', idpIssuer: 'https://idp.example', entityId: 'northstar-sp', idpCert: certificate }]) });
  const { db, auth, service } = setup(config);
  async function finish(flow, changes = {}, browserCookie = flow.cookie, targetService = service) {
    const state = flow.url.searchParams.get('RelayState');
    const row = db.prepare('SELECT payload FROM auth_sso_requests WHERE state = ?').get(state);
    const requestId = changes.requestId || (row ? JSON.parse(row.payload).requestId : '_used');
    const body = new URLSearchParams({ SAMLResponse: samlResponse(requestId, changes), RelayState: state }).toString();
    const res = response(); await targetService.handle(request('POST', browserCookie, body), res, new URL('https://app.example/api/auth/sso/saml/callback')); return res;
  }
  try {
    const metadata = response(); await service.handle(request(), metadata, new URL('https://app.example/api/auth/sso/saml/metadata'));
    assert.match(metadata.body, /WantAssertionsSigned="true"/); assert.match(metadata.body, /northstar-sp/);
    const flow = await start(service, 'saml', '//evil.example');
    assert.match(flow.res.headers['set-cookie'], /SameSite=None.*Secure/);
    assert.equal((await finish(flow, {}, '')).headers.location, '/login.html?ssoError=1');
    const signedIn = await finish(flow, {}, flow.cookie, createSsoService(db, auth, config));
    assert.equal(signedIn.headers.location, '/');
    assert.ok(signedIn.headers['set-cookie'].some((c) => c.startsWith('northstar_session=')));
    assert.equal(db.prepare("SELECT role FROM users WHERE password_hash = ''").get().role, 'read_only');
    assert.equal((await finish(flow)).headers.location, '/login.html?ssoError=1');
    for (const change of [{ unsigned: true }, { tampered: true }, { audience: 'other-sp' }, { issuer: 'https://untrusted.example' }, { recipient: 'https://other.example/callback' }, { requestId: '_other' }, { expired: true }]) {
      const invalid = await start(service, 'saml');
      assert.equal((await finish(invalid, change)).headers.location, '/login.html?ssoError=1', JSON.stringify(change));
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM auth_identities').get().n, 1);
    const method = response(); await assert.rejects(service.handle(request('GET'), method, new URL('https://app.example/api/auth/sso/saml/callback')), /Method not allowed/);
    const freshDb = openDatabase(':memory:');
    try {
      const freshAuth = createAuthService(freshDb, { disabled: false });
      await assert.rejects(createSsoService(freshDb, freshAuth, config).handle(request(), response(), new URL('https://app.example/api/auth/sso/saml/login')), /first local admin/);
    } finally { freshDb.close(); }
  } finally { db.close(); }
});

test('Google and GitHub configuration uses trusted endpoints and requires credentials', () => {
  const providers = ['google', 'github'].map(type => ({ id: type, type, clientId: 'northstar', clientSecret: 'secret' }));
  const config = loadSsoConfig({ PUBLIC_URL: 'https://app.example', SIGNUP_ALLOWED: 'true', SSO_PROVIDERS: JSON.stringify(providers) });
  assert.equal(config.signupAllowed, true);
  assert.equal(config.providers[0].issuer, 'https://accounts.google.com');
  assert.equal(config.providers[0].tokenEndpointAuthMethod, 'client_secret_post');
  for (const p of providers) assert.throws(() => loadSsoConfig({ PUBLIC_URL: 'https://app.example', SSO_PROVIDERS: JSON.stringify([{ ...p, clientSecret: '' }]) }));
  assert.throws(() => loadSsoConfig({ SIGNUP_ALLOWED: 'yes' }), /SIGNUP_ALLOWED/);
});

test('GitHub sign-in binds state and PKCE, prevents replay and enforces signup for new identities', async () => {
  const config = loadSsoConfig({ PUBLIC_URL: 'https://app.example', SSO_PROVIDERS: JSON.stringify([{ id: 'github', name: 'GitHub', type: 'github', clientId: 'northstar', clientSecret: 'secret' }]) });
  let calls = 0, userId = 123, failure = false, challenge;
  const options = { fetch: async (url, init) => {
    calls++;
    assert.equal(init.redirect, 'error');
    if (url === 'https://github.com/login/oauth/access_token') {
      assert.equal(init.body.get('client_secret'), 'secret');
      assert.equal(init.body.get('redirect_uri'), 'https://app.example/api/auth/sso/github/callback');
      assert.equal(createHash('sha256').update(init.body.get('code_verifier')).digest('base64url'), challenge);
      return Response.json(failure ? { error: 'bad_verification_code' } : { access_token: 'test-token', token_type: 'bearer' });
    }
    assert.equal(url, 'https://api.github.com/user');
    assert.equal(init.headers.authorization, 'Bearer test-token');
    return Response.json({ id: userId, login: 'owner', email: 'owner', role: 'admin' });
  } };
  const { db, auth, service } = setup(config, options);
  const begin = async () => { const flow = await start(service, 'github', '/teams.html'); challenge = flow.url.searchParams.get('code_challenge'); assert.equal(flow.url.origin, 'https://github.com'); assert.equal(flow.url.searchParams.get('code_challenge_method'), 'S256'); return flow; };
  const finish = async (flow, cookie = flow.cookie) => { const res = response(); await service.handle(request('GET', cookie), res, new URL(`https://app.example/api/auth/sso/github/callback?code=valid&state=${flow.url.searchParams.get('state')}`)); return res; };
  try {
    const flow = await begin();
    assert.equal((await finish(flow, '')).headers.location, '/login.html?ssoError=1'); assert.equal(calls, 0);
    const signedIn = await finish(flow); assert.equal(signedIn.headers.location, '/teams.html');
    const session = signedIn.headers['set-cookie'].find(c => c.startsWith('northstar_session=')).split(';')[0];
    const user = auth.userForRequest(request('GET', session)); assert.equal(user.role, 'read_only'); assert.notEqual(user.username, 'owner');
    assert.equal((await finish(flow)).headers.location, '/login.html?ssoError=1'); assert.equal(calls, 2);
    const deniedAuth = createAuthService(db, { disabled: false, signupAllowed: false });
    const denied = createSsoService(db, deniedAuth, config, options);
    const old = await start(denied, 'github'); challenge = old.url.searchParams.get('code_challenge');
    const callback = async flow => { const res = response(); await denied.handle(request('GET', flow.cookie), res, new URL(`https://app.example/api/auth/sso/github/callback?code=valid&state=${flow.url.searchParams.get('state')}`)); return res; };
    assert.equal((await callback(old)).headers.location, '/');
    userId = 456;
    const fresh = await start(denied, 'github'); challenge = fresh.url.searchParams.get('code_challenge');
    assert.equal((await callback(fresh)).headers.location, '/login.html?ssoError=1');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2);
    failure = true; const bad = await begin(); assert.equal((await finish(bad)).headers.location, '/login.html?ssoError=1');
    failure = false; userId = 'invalid'; const invalid = await begin(); assert.equal((await finish(invalid)).headers.location, '/login.html?ssoError=1');
    const expired = await begin(); db.prepare('UPDATE auth_sso_requests SET expires_at = 0').run();
    const before = calls; assert.equal((await finish(expired)).headers.location, '/login.html?ssoError=1'); assert.equal(calls, before);
  } finally { db.close(); }
});
