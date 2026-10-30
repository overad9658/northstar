import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createBackupService } from './backup-service.mjs';
import { json, readJson } from './http-utils.mjs';

function csvCell(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

function tokenHash(token) {
  return createHash('sha256').update(String(token), 'utf8').digest();
}

function authorized(req, expectedToken, expectedHash = '') {
  const match = String(req.headers.authorization || '').match(/^Bearer (.+)$/i);
  if (!match || (!expectedToken && !expectedHash)) return false;
  const supplied = expectedHash ? tokenHash(match[1]) : Buffer.from(match[1], 'utf8');
  const expected = expectedHash ? Buffer.from(expectedHash, 'hex') : Buffer.from(String(expectedToken), 'utf8');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

// Returns the caller's token access ({ name, scope }) or null. The single legacy token always has write scope.
export function apiTokenAccess(db, req, { apiToken = process.env.API_TOKEN } = {}) {
  const match = String(req.headers.authorization || '').match(/^Bearer (.+)$/i);
  if (!match) return null;
  const settings = db.prepare('SELECT api_token_hash AS hash FROM portfolio_settings WHERE id = 1').get();
  if (authorized(req, apiToken, settings?.hash)) return { name: 'API token', scope: 'write' };
  const row = db.prepare('SELECT id, name, scope FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL')
    .get(tokenHash(match[1]).toString('hex'));
  if (!row) return null;
  db.prepare("UPDATE api_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ? AND (last_used_at IS NULL OR last_used_at < datetime('now', ?))")
    .run(row.id, '-60 seconds');
  return { name: row.name, scope: row.scope };
}

export function isApiTokenAuthorized(db, req, options) {
  return apiTokenAccess(db, req, options)?.scope === 'write';
}

function publicToken(row) {
  return { id: row.id, name: row.name, scope: row.scope, createdAt: row.created_at, lastUsedAt: row.last_used_at || null, revokedAt: row.revoked_at || null };
}

function unauthorized(res) {
  res.writeHead(401, {
    'content-type': 'application/json; charset=utf-8',
    'www-authenticate': 'Bearer realm="Northstar bulk API"',
  });
  res.end(JSON.stringify({ error: 'A valid bearer token is required.' }));
}

export function createDataApi(db, projects, { apiToken = process.env.API_TOKEN } = {}) {
  const backups = createBackupService(db);

  // Exports take an admin session or an API token on GET. A read token sees what the read-only role sees and
  // cannot download backups, which hold hidden projects and planning-room keys. Restore stays session-only.
  function exportAccess(req, res, user, { write = false } = {}) {
    if (user?.role === 'admin') return { includeHidden: true };
    const token = req.method === 'GET' ? apiTokenAccess(db, req, { apiToken }) : null;
    if (token?.scope === 'write') return { includeHidden: true };
    if (token && !write) return { includeHidden: false };
    if (token) return json(res, 403, { error: 'This API token is read-only.' }), null;
    if (!user) res.setHeader('www-authenticate', 'Bearer realm="Northstar export API"');
    json(res, user ? 403 : 401, { error: user ? 'Admin access is required.' : 'Authentication is required.' });
    return null;
  }

  function apiTokenSettings() {
    return db.prepare('SELECT api_token_hash AS hash, api_token_created_at AS createdAt FROM portfolio_settings WHERE id = 1').get();
  }

  return async function dataApi(req, res, url, user) {
    if (url.pathname === '/api/api-token') {
      if (user?.role !== 'admin') return json(res, user ? 403 : 401, { error: user ? 'Admin access is required.' : 'Authentication is required.' }), true;
      if (req.method === 'GET') {
        const settings = apiTokenSettings();
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ configured: Boolean(settings.hash || apiToken), managed: Boolean(settings.hash), createdAt: settings.createdAt || null }));
        return true;
      }
      if (req.method === 'POST') {
        const token = `northstar_${randomBytes(32).toString('base64url')}`;
        const createdAt = new Date().toISOString();
        db.prepare('UPDATE portfolio_settings SET api_token_hash = ?, api_token_created_at = ? WHERE id = 1').run(tokenHash(token).toString('hex'), createdAt);
        res.writeHead(201, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ token, createdAt }));
        return true;
      }
      json(res, 405, { error: 'Method not allowed.' });
      return true;
    }

    const namedTokenMatch = url.pathname.match(/^\/api\/api-tokens(?:\/(\d+))?$/);
    if (namedTokenMatch) {
      if (user?.role !== 'admin') return json(res, user ? 403 : 401, { error: user ? 'Admin access is required.' : 'Authentication is required.' }), true;
      const id = namedTokenMatch[1] ? Number(namedTokenMatch[1]) : null;
      if (req.method === 'GET' && !id) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(db.prepare('SELECT * FROM api_tokens ORDER BY id').all().map(publicToken)));
        return true;
      }
      if (req.method === 'POST' && !id) {
        const input = await readJson(req);
        const name = String(input.name ?? '').trim();
        if (!name || name.length > 80) return json(res, 400, { error: 'Token name must be 1 to 80 characters.' }), true;
        if (!['read', 'write'].includes(input.scope)) return json(res, 400, { error: 'Token scope must be read or write.' }), true;
        const token = `northstar_${randomBytes(32).toString('base64url')}`;
        const result = db.prepare('INSERT INTO api_tokens (name, scope, token_hash) VALUES (?, ?, ?)').run(name, input.scope, tokenHash(token).toString('hex'));
        const row = db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(result.lastInsertRowid);
        res.writeHead(201, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ...publicToken(row), token }));
        return true;
      }
      if (req.method === 'DELETE' && id) {
        const result = db.prepare('UPDATE api_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND revoked_at IS NULL').run(id);
        if (!result.changes) return json(res, 404, { error: 'Active API token not found.' }), true;
        res.writeHead(204);
        res.end();
        return true;
      }
      json(res, 405, { error: 'Method not allowed.' });
      return true;
    }

    const bulkMatch = url.pathname.match(/^\/api\/projects\/bulk\/(add|archive|delete)$/);
    if (bulkMatch) {
      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' }), true;
      const settings = apiTokenSettings();
      const writeTokens = db.prepare("SELECT COUNT(*) AS count FROM api_tokens WHERE scope = 'write' AND revoked_at IS NULL").get().count;
      if (!settings.hash && !apiToken && !writeTokens) return json(res, 503, { error: 'Bulk API token is not configured.' }), true;
      const access = apiTokenAccess(db, req, { apiToken });
      if (access?.scope !== 'write') return unauthorized(res), true;
      const input = await readJson(req);
      if (bulkMatch[1] === 'add') {
        const created = projects.bulkCreate(input.projects);
        return json(res, 201, { count: created.length, projects: created }), true;
      }
      if (bulkMatch[1] === 'archive') {
        const archived = projects.bulkArchive(input.projectIds, { actor: access.name });
        return json(res, 200, { count: archived.length, projects: archived }), true;
      }
      const projectIds = projects.bulkDelete(input.projectIds);
      return json(res, 200, { count: projectIds.length, projectIds }), true;
    }

    if (url.pathname === '/api/status-export') {
      const access = exportAccess(req, res, user);
      if (!access) return true;
      if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' }), true;
      const exportProjects = projects.statusExportRows(access);
      const headings = ['Project ID', 'Project', 'Team', 'Status', 'Blocked Note', 'People Assigned', 'Impact', 'Urgency', 'Confidence', 'Effort', 'Source Link', 'Context', 'Updated At'];
      const fields = ['projectId', 'name', 'team', 'status', 'blockedNote', 'capacity', 'impact', 'urgency', 'confidence', 'effort', 'externalUrl', 'description', 'updatedAt'];
      const csv = [headings, ...exportProjects.map((project) => fields.map((field) => project[field]))]
        .map((row) => row.map(csvCell).join(','))
        .join('\r\n');
      const filename = `northstar-project-status-${new Date().toISOString().slice(0, 10)}.csv`;
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'no-store',
      });
      res.end(`\uFEFF${csv}\r\n`);
      return true;
    }

    if (url.pathname === '/api/backup') {
      if (!exportAccess(req, res, user, { write: true })) return true;
      if (req.method === 'GET') {
        const filename = `northstar-backup-${new Date().toISOString().slice(0, 10)}.json`;
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename="${filename}"`,
          'cache-control': 'no-store',
        });
        res.end(JSON.stringify(backups.export(), null, 2));
        return true;
      }
      if (req.method === 'POST') {
        const restored = backups.restore(await readJson(req, 10_000_000));
        json(res, 200, { restored });
        return true;
      }
      json(res, 405, { error: 'Method not allowed.' });
      return true;
    }

    return false;
  };
}
