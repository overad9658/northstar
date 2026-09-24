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

function unauthorized(res) {
  res.writeHead(401, {
    'content-type': 'application/json; charset=utf-8',
    'www-authenticate': 'Bearer realm="Northstar bulk API"',
  });
  res.end(JSON.stringify({ error: 'A valid bearer token is required.' }));
}

export function createDataApi(db, projects, { apiToken = process.env.API_TOKEN } = {}) {
  const backups = createBackupService(db);

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

    const bulkMatch = url.pathname.match(/^\/api\/projects\/bulk\/(add|archive|delete)$/);
    if (bulkMatch) {
      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' }), true;
      const settings = apiTokenSettings();
      if (!settings.hash && !apiToken) return json(res, 503, { error: 'Bulk API token is not configured.' }), true;
      if (!authorized(req, apiToken, settings.hash)) return unauthorized(res), true;
      const input = await readJson(req);
      if (bulkMatch[1] === 'add') {
        const created = projects.bulkCreate(input.projects);
        return json(res, 201, { count: created.length, projects: created }), true;
      }
      if (bulkMatch[1] === 'archive') {
        const archived = projects.bulkArchive(input.projectIds);
        return json(res, 200, { count: archived.length, projects: archived }), true;
      }
      const projectIds = projects.bulkDelete(input.projectIds);
      return json(res, 200, { count: projectIds.length, projectIds }), true;
    }

    if (url.pathname === '/api/status-export') {
      if (user?.role !== 'admin') return json(res, user ? 403 : 401, { error: user ? 'Admin access is required.' : 'Authentication is required.' }), true;
      if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' }), true;
      const exportProjects = projects.statusExportRows();
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
      if (user?.role !== 'admin') return json(res, user ? 403 : 401, { error: user ? 'Admin access is required.' : 'Authentication is required.' }), true;
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
