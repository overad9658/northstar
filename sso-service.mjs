import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as oidc from 'openid-client';
import { SAML } from '@node-saml/node-saml';
import { AuthError } from './auth-service.mjs';

const LOGIN_MS = 10 * 60 * 1000;
const digest = (value) => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');

export function safeReturnTo(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || /[\\\s\x00-\x1f\x7f]/.test(value)) return '/';
  try {
    const url = new URL(value, 'https://northstar.invalid');
    return url.origin === 'https://northstar.invalid' ? url.pathname + url.search + url.hash : '/';
  } catch { return '/'; }
}

function secureUrl(value, field, allowLocal = false) {
  const url = new URL(value);
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(allowLocal && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error(`${field} must use HTTPS (HTTP is allowed only for a localhost public URL).`);
  }
  return url;
}

export function loadSsoConfig(env = process.env) {
  const providers = JSON.parse(env.SSO_CONFIG_FILE ? readFileSync(env.SSO_CONFIG_FILE, 'utf8') : env.SSO_PROVIDERS || '[]');
  if (!Array.isArray(providers)) throw new Error('SSO providers must be a JSON array.');
  if (env.SIGNUP_ALLOWED !== undefined && !['true', 'false'].includes(env.SIGNUP_ALLOWED)) throw new Error('SIGNUP_ALLOWED must be true or false.');
  const signupAllowed = env.SIGNUP_ALLOWED === 'true';
  if (!providers.length && !env.PUBLIC_URL) return { providers: [], publicUrl: null, signupAllowed };
  if (!env.PUBLIC_URL) throw new Error('PUBLIC_URL is required when SSO is configured.');
  const publicUrl = secureUrl(env.PUBLIC_URL, 'PUBLIC_URL', true);
  if (publicUrl.pathname !== '/' || publicUrl.search) throw new Error('PUBLIC_URL must be an origin without a path or query.');
  const ids = new Set();
  const required = (p, field) => {
    if (typeof p[field] !== 'string' || !p[field].trim()) throw new Error(`SSO provider ${p.id} requires ${field}.`);
  };
  for (const p of providers) {
    if (!p || typeof p.id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(p.id) || ids.has(p.id)) throw new Error('SSO provider IDs must be unique lowercase names (up to 32 characters).');
    ids.add(p.id);
    if (!['oidc', 'saml', 'google', 'github'].includes(p.type)) throw new Error(`Unsupported SSO type for ${p.id}.`);
    if (p.type === 'google') {
      p.issuer = 'https://accounts.google.com';
      p.tokenEndpointAuthMethod = 'client_secret_post';
    }
    if (['oidc', 'google', 'github'].includes(p.type)) {
      required(p, 'clientId');
      if (p.type !== 'github') { required(p, 'issuer'); secureUrl(p.issuer, 'OIDC issuer'); }
      if (p.clientSecretEnv) {
        p.clientSecret = env[p.clientSecretEnv];
        required(p, 'clientSecret');
      }
      p.tokenEndpointAuthMethod ||= p.clientSecret ? 'client_secret_basic' : 'none';
      if (!['client_secret_basic', 'client_secret_post', 'none'].includes(p.tokenEndpointAuthMethod)) throw new Error(`Unsupported tokenEndpointAuthMethod for ${p.id}.`);
      if (p.tokenEndpointAuthMethod !== 'none' || p.type !== 'oidc') required(p, 'clientSecret');
      if (p.scopes !== undefined && typeof p.scopes !== 'string') throw new Error(`Invalid scopes for ${p.id}.`);
    } else {
      if (publicUrl.protocol !== 'https:') throw new Error('SAML requires an HTTPS PUBLIC_URL for browser correlation cookies.');
      required(p, 'entryPoint'); required(p, 'idpIssuer'); required(p, 'entityId'); secureUrl(p.entryPoint, 'SAML entryPoint');
      for (const field of ['idpCert', 'privateKey', 'publicCert']) {
        if (p[`${field}File`]) p[field] = readFileSync(p[`${field}File`], 'utf8');
      }
      if (!p.idpCert || (Array.isArray(p.idpCert) && !p.idpCert.length)) throw new Error(`SSO provider ${p.id} requires idpCert or idpCertFile.`);
      if (Boolean(p.privateKey) !== Boolean(p.publicCert)) throw new Error(`SSO provider ${p.id} requires both privateKey and publicCert for signed requests.`);
    }
  }
  return { providers, publicUrl: publicUrl.origin, signupAllowed };
}

function cookie(req, name) {
  const part = String(req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(`${name}=`));
  return part ? part.slice(name.length + 1) : '';
}

export function createSsoService(db, auth, config = loadSsoConfig(), { discover = oidc.discovery, fetch: providerFetch = globalThis.fetch } = {}) {
  const providers = new Map(config.providers.map((p) => [p.id, p]));
  const discoveries = new Map();
  const callback = (p) => `${config.publicUrl}/api/auth/sso/${p.id}/callback`;
  const cookieName = (p) => `northstar_sso_${p.id}`;
  function correlationCookie(res, p, value, maxAge) {
    const secure = config.publicUrl.startsWith('https:');
    res.setHeader('set-cookie', `${cookieName(p)}=${value}; Path=/api/auth/sso/${p.id}; HttpOnly; SameSite=${p.type === 'saml' ? 'None' : 'Lax'}; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
  }
  async function discovery(p) {
    if (!discoveries.has(p.id)) {
      const authentication = p.tokenEndpointAuthMethod === 'client_secret_basic' ? oidc.ClientSecretBasic(p.clientSecret)
        : p.tokenEndpointAuthMethod === 'client_secret_post' ? oidc.ClientSecretPost(p.clientSecret) : oidc.None();
      discoveries.set(p.id, discover(new URL(p.issuer), p.clientId, { client_secret: p.clientSecret }, authentication, { timeout: 10 }).then((configuration) => {
        oidc.enableNonRepudiationChecks(configuration);
        return configuration;
      }).catch((error) => {
        discoveries.delete(p.id); throw error;
      }));
    }
    return discoveries.get(p.id);
  }
  function saml(p, transaction) {
    // Each validator sees only this browser's request ID, even across restarts.
    const requests = new Map(transaction ? [[transaction.requestId, new Date(transaction.createdAt).toISOString()]] : []);
    return new SAML({
      callbackUrl: callback(p), issuer: p.entityId, audience: p.entityId,
      entryPoint: p.entryPoint, idpIssuer: p.idpIssuer, idpCert: p.idpCert,
      privateKey: p.privateKey, publicCert: p.publicCert,
      signatureAlgorithm: 'sha256', digestAlgorithm: 'sha256',
      wantAssertionsSigned: true, wantAuthnResponseSigned: p.wantAuthnResponseSigned === true,
      validateInResponseTo: 'always', requestIdExpirationPeriodMs: LOGIN_MS,
      acceptedClockSkewMs: 30_000, maxAssertionAgeMs: LOGIN_MS,
      identifierFormat: p.identifierFormat ?? 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
      disableRequestedAuthnContext: true,
      generateUniqueId: () => transaction?.requestId || `_${random()}`,
      cacheProvider: {
        async saveAsync(key, value) { requests.set(key, value); return { value, createdAt: Date.now() }; },
        async getAsync(key) { return requests.get(key) || null; },
        async removeAsync(key) { const value = requests.get(key) || null; requests.delete(key); return value; },
      },
    });
  }
  function provision(p, issuer, subject) {
    if (typeof subject !== 'string' || !subject || subject.length > 1024) throw new AuthError(401, 'The identity provider did not supply a stable user identifier.');
    const identity = db.prepare('SELECT user_id FROM auth_identities WHERE provider_id = ? AND issuer = ? AND subject = ?').get(p.id, issuer, subject);
    if (identity) return identity.user_id;
    if (!auth.signupAllowed()) throw new AuthError(403, 'Account signup is disabled.');
    db.exec('BEGIN IMMEDIATE');
    try {
      const username = `sso-${p.id}-${digest(JSON.stringify([issuer, subject])).slice(0, 24)}`;
      const result = db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, '', 'read_only')").run(username);
      db.prepare('INSERT INTO auth_identities (provider_id, issuer, subject, user_id) VALUES (?, ?, ?, ?)').run(p.id, issuer, subject, result.lastInsertRowid);
      db.exec('COMMIT');
      return result.lastInsertRowid;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function redirect(res, target) {
    res.writeHead(303, { location: target, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end();
  }
  async function formBody(req) {
    if (String(req.headers['content-type'] || '').split(';')[0] !== 'application/x-www-form-urlencoded') throw new AuthError(400, 'Expected a form-encoded SAML response.');
    let size = 0; const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1_000_000) throw new AuthError(413, 'SAML response is too large.');
      chunks.push(chunk);
    }
    const fields = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    if (fields.getAll('RelayState').length !== 1 || fields.getAll('SAMLResponse').length !== 1) throw new AuthError(400, 'Invalid SAML response fields.');
    return Object.fromEntries(fields);
  }
  return {
    providers: () => auth.disabled ? [] : config.providers.map((p) => ({ id: p.id, name: p.name || p.id, type: p.type })),
    async handle(req, res, url) {
      const match = url.pathname.match(/^\/api\/auth\/sso\/([a-z][a-z0-9-]{0,31})\/(login|callback|metadata)$/);
      if (!match) return false;
      const p = providers.get(match[1]), action = match[2];
      if (!p || auth.disabled) throw new AuthError(404, 'SSO provider not found.');
      if (action === 'metadata') {
        if (p.type !== 'saml') throw new AuthError(404, 'Metadata is available only for SAML providers.');
        if (req.method !== 'GET') throw new AuthError(405, 'Method not allowed.');
        res.writeHead(200, { 'content-type': 'application/samlmetadata+xml', 'cache-control': 'no-store' });
        res.end(saml(p).generateServiceProviderMetadata(null, p.publicCert || null)); return true;
      }
      if (auth.setupRequired()) throw new AuthError(409, 'Create the first local admin account before using SSO.');
      if (action === 'login') {
        if (req.method !== 'GET') throw new AuthError(405, 'Method not allowed.');
        db.prepare('DELETE FROM auth_sso_requests WHERE expires_at <= ?').run(Date.now());
        if (db.prepare('SELECT COUNT(*) AS count FROM auth_sso_requests').get().count >= 1000) throw new AuthError(429, 'Too many pending sign-ins. Try again later.');
        const state = random(), browserToken = random();
        const transaction = { returnTo: safeReturnTo(url.searchParams.get('returnTo')), createdAt: Date.now(), configFingerprint: digest(JSON.stringify(config)) };
        let target;
        try {
          if (p.type === 'github') {
            transaction.verifier = oidc.randomPKCECodeVerifier();
            const authorize = new URL('https://github.com/login/oauth/authorize');
            authorize.search = new URLSearchParams({ client_id: p.clientId, redirect_uri: callback(p), state,
              scope: 'read:user', code_challenge: await oidc.calculatePKCECodeChallenge(transaction.verifier), code_challenge_method: 'S256' });
            target = authorize.href;
          } else if (['oidc', 'google'].includes(p.type)) {
            transaction.verifier = oidc.randomPKCECodeVerifier(); transaction.nonce = oidc.randomNonce();
            target = oidc.buildAuthorizationUrl(await discovery(p), {
              redirect_uri: callback(p), scope: [...new Set(['openid', ...(p.scopes || 'profile email').split(/\s+/).filter(Boolean)])].join(' '),
              response_type: 'code', response_mode: 'query', state, nonce: transaction.nonce,
              code_challenge: await oidc.calculatePKCECodeChallenge(transaction.verifier), code_challenge_method: 'S256',
            }).href;
          } else {
            transaction.requestId = `_${random()}`;
            target = await saml(p, transaction).getAuthorizeUrlAsync(state);
          }
        } catch { throw new AuthError(502, 'Unable to start SSO. Check the provider configuration.'); }
        db.prepare('INSERT INTO auth_sso_requests (state, provider_id, browser_hash, payload, expires_at) VALUES (?, ?, ?, ?, ?)')
          .run(state, p.id, digest(browserToken), JSON.stringify(transaction), Date.now() + LOGIN_MS);
        correlationCookie(res, p, browserToken, LOGIN_MS / 1000);
        redirect(res, target); return true;
      }
      if (req.method !== (p.type === 'saml' ? 'POST' : 'GET')) throw new AuthError(405, 'Method not allowed.');
      try {
        const body = p.type === 'saml' ? await formBody(req) : null;
        if (!body && url.searchParams.getAll('state').length !== 1) throw new AuthError(401, 'Invalid SSO state.');
        const state = body ? body.RelayState : url.searchParams.get('state');
        const row = db.prepare('DELETE FROM auth_sso_requests WHERE state = ? AND provider_id = ? AND browser_hash = ? AND expires_at > ? RETURNING payload')
          .get(state || '', p.id, digest(cookie(req, cookieName(p))), Date.now());
        if (!row) throw new AuthError(401, 'Invalid or expired SSO request.');
        const transaction = JSON.parse(row.payload);
        if (transaction.configFingerprint !== digest(JSON.stringify(config))) throw new AuthError(401, 'SSO configuration has changed. Start a new sign-in.');
        let issuer, subject;
        if (p.type === 'github') {
          if (url.searchParams.has('error') || url.searchParams.getAll('code').length !== 1 || !url.searchParams.get('code')) throw new AuthError(401, 'Invalid GitHub callback.');
          const tokenResponse = await providerFetch('https://github.com/login/oauth/access_token', {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
            headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ client_id: p.clientId, client_secret: p.clientSecret, code: url.searchParams.get('code'), redirect_uri: callback(p), code_verifier: transaction.verifier }),
          });
          if (!tokenResponse.ok) throw new AuthError(401, 'GitHub token exchange failed.');
          const token = await tokenResponse.json();
          if (token.error || typeof token.access_token !== 'string' || !token.access_token || token.token_type?.toLowerCase() !== 'bearer') throw new AuthError(401, 'Invalid GitHub token.');
          const userResponse = await providerFetch('https://api.github.com/user', {
            redirect: 'error', signal: AbortSignal.timeout(10_000),
            headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token.access_token}`, 'user-agent': 'Northstar' },
          });
          if (!userResponse.ok) throw new AuthError(401, 'GitHub identity lookup failed.');
          const user = await userResponse.json();
          if (!Number.isSafeInteger(user.id) || user.id <= 0) throw new AuthError(401, 'Invalid GitHub user identifier.');
          issuer = 'https://github.com'; subject = String(user.id);
        } else if (['oidc', 'google'].includes(p.type)) {
          const callbackUrl = new URL(callback(p)); callbackUrl.search = url.search;
          const tokens = await oidc.authorizationCodeGrant(await discovery(p), callbackUrl, {
            pkceCodeVerifier: transaction.verifier, expectedState: state, expectedNonce: transaction.nonce, idTokenExpected: true,
          });
          const claims = tokens.claims(); issuer = claims?.iss; subject = claims?.sub;
          if (issuer !== p.issuer) throw new AuthError(401, 'Invalid identity provider issuer.');
        } else {
          const { profile, loggedOut } = await saml(p, transaction).validatePostResponseAsync(body);
          if (loggedOut || !profile || profile.issuer !== p.idpIssuer || profile.inResponseTo !== transaction.requestId) throw new AuthError(401, 'Invalid SAML identity.');
          const assertion = profile.getAssertion?.().Assertion;
          const confirmations = assertion?.Subject?.[0]?.SubjectConfirmation || [];
          const validRecipient = confirmations.some((confirmation) => {
            const data = confirmation.SubjectConfirmationData?.[0]?.$;
            const expires = Date.parse(data?.NotOnOrAfter);
            const notBefore = data?.NotBefore === undefined ? 0 : Date.parse(data.NotBefore);
            return confirmation.$?.Method === 'urn:oasis:names:tc:SAML:2.0:cm:bearer' && data?.Recipient === callback(p)
              && data?.InResponseTo === transaction.requestId && Number.isFinite(expires) && expires > Date.now() - 30_000
              && Number.isFinite(notBefore) && notBefore <= Date.now() + 30_000;
          });
          if (!validRecipient) throw new AuthError(401, 'Invalid SAML recipient or subject confirmation.');
          issuer = profile.issuer; subject = profile.nameID;
          if (profile.nameIDFormat === 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient') throw new AuthError(401, 'SAML requires a stable NameID.');
        }
        const userId = provision(p, issuer, subject);
        correlationCookie(res, p, '', 0);
        auth.establishSession(userId, req, res);
        redirect(res, transaction.returnTo);
      } catch {
        correlationCookie(res, p, '', 0);
        redirect(res, '/login.html?ssoError=1');
      }
      return true;
    },
  };
}
