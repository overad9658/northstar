import { X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto';
import { AuthError } from './auth-service.mjs';
import { loadSsoConfig } from './sso-service.mjs';

const fields = ['id', 'name', 'type', 'issuer', 'clientId', 'clientSecret', 'tokenEndpointAuthMethod', 'scopes', 'entryPoint', 'idpIssuer', 'entityId', 'idpCert', 'privateKey', 'publicCert', 'identifierFormat', 'wantAuthnResponseSigned'];
const secrets = ['clientSecret', 'privateKey'];

export function createSsoSettings(db) {
  function stored() { return db.prepare('SELECT config, revision FROM auth_sso_settings WHERE id = 1').get(); }
  function load() {
    const row = stored();
    return row ? JSON.parse(row.config) : loadSsoConfig();
  }
  function view() {
    const config = load(), row = stored();
    return {
      publicUrl: config.publicUrl || '', signupAllowed: config.signupAllowed === true, revision: row?.revision || 0, source: row ? 'saved' : 'environment',
      providers: config.providers.map((p) => {
        const safe = Object.fromEntries(fields.filter((key) => !secrets.includes(key) && p[key] !== undefined).map((key) => [key, p[key]]));
        for (const key of secrets) safe[`has${key[0].toUpperCase()}${key.slice(1)}`] = Boolean(p[key]);
        return safe;
      }),
    };
  }
  function save(input) {
    const row = stored();
    if (input.revision !== (row?.revision || 0)) throw new AuthError(409, 'SSO settings changed in another window. Reload before saving.');
    if (!Array.isArray(input.providers) || input.providers.length > 20) throw new AuthError(400, 'Configure up to 20 SSO providers.');
    if (typeof input.publicUrl !== 'string') throw new AuthError(400, 'Enter the public Northstar URL.');
    const current = load();
    if (input.signupAllowed !== undefined && typeof input.signupAllowed !== 'boolean') throw new AuthError(400, 'Signup allowed must be a checkbox value.');
    try {
      const providers = input.providers.map((p) => {
        if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('Invalid provider settings.');
        const clean = Object.fromEntries(fields.filter((key) => p[key] !== undefined).map((key) => [key, p[key]]));
        const prior = current.providers.find((old) => old.id === p.id && old.type === p.type);
        for (const key of secrets) {
          if (p[`clear${key[0].toUpperCase()}${key.slice(1)}`] === true) delete clean[key];
          else if (!clean[key] && prior?.[key]) clean[key] = prior[key];
          if (clean[key] !== undefined && typeof clean[key] !== 'string') throw new Error(`Invalid ${key}.`);
        }
        if (p.clearPrivateKey === true) delete clean.publicCert;
        if (clean.name !== undefined && (typeof clean.name !== 'string' || clean.name.length > 100)) throw new Error('Provider names must be at most 100 characters.');
        if (clean.wantAuthnResponseSigned !== undefined && typeof clean.wantAuthnResponseSigned !== 'boolean') throw new Error('Signed response setting must be a checkbox value.');
        if (clean.type === 'saml') {
          const certs = Array.isArray(clean.idpCert) ? clean.idpCert : [clean.idpCert];
          for (const cert of certs) new X509Certificate(cert);
          if (clean.privateKey) {
            const privateKey = createPrivateKey(clean.privateKey);
            const certificate = new X509Certificate(clean.publicCert);
            if (!certificate.publicKey.equals(createPublicKey(privateKey))) throw new Error('SP signing key and certificate must match.');
          }
        }
        return clean;
      });
      const config = loadSsoConfig({ PUBLIC_URL: input.publicUrl.trim(), SIGNUP_ALLOWED: String(input.signupAllowed ?? current.signupAllowed ?? false), SSO_PROVIDERS: JSON.stringify(providers) });
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO auth_sso_settings (id, config, revision) VALUES (1, ?, 1) ON CONFLICT(id) DO UPDATE SET config = excluded.config, revision = auth_sso_settings.revision + 1').run(JSON.stringify(config));
        db.prepare('DELETE FROM auth_sso_requests').run();
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return config;
    } catch (error) { throw new AuthError(400, `Unable to save SSO settings: ${error.message}`); }
  }
  return { load, view, save };
}
