import { AuthError, createAuthService } from './auth-service.mjs';
import { apiTokenAccess, createDataApi } from './data-api.mjs';
import { json, readJson } from './http-utils.mjs';
import { createPlanningService, PlanningError } from './planning-service.mjs';
import { createProjectService, ProjectError } from './project-service.mjs';
import { createTeamService } from './team-service.mjs';
import { createSsoService } from './sso-service.mjs';
import { createSsoSettings } from './sso-settings.mjs';
import { createKanbanService, KanbanError } from './kanban-service.mjs';
import { ActivityError, createActivityService } from './activity-service.mjs';
import { createEventsService } from './events-service.mjs';
import { createFailureLimiter, positiveInteger } from './rate-limit.mjs';
import { readFile } from 'node:fs/promises';

// The docs page reads these two files and nothing else; no part of the request reaches the filesystem.
const DOCS = Object.freeze({
  api: new URL('./docs/api.md', import.meta.url),
  mcp: new URL('./mcp/README.md', import.meta.url),
});

// Lookup filters from the query string; absent parameters are left out.
// Requests that never change projects, the board or teams; every other committed write is published.
const UNPUBLISHED_PATHS = ['/api/auth/', '/api/users', '/api/admin/', '/api/api-token', '/api/events'];
const isPublishedWrite = (req, res, url) => !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && res.statusCode < 300
  && !UNPUBLISHED_PATHS.some((path) => url.pathname.startsWith(path));

function lookupParams(url, names) {
  return Object.fromEntries(names.filter((name) => url.searchParams.has(name)).map((name) => [name, url.searchParams.get(name)]));
}

export function createApi(db, { apiToken = process.env.API_TOKEN, tokenFailuresPerMinute = process.env.TOKEN_AUTH_FAILURES_PER_MINUTE } = {}) {
  const tokenFailures = createFailureLimiter({ limit: positiveInteger(tokenFailuresPerMinute, 10) });
  const loginFailures = createFailureLimiter({ limit: positiveInteger(process.env.LOGIN_FAILURES_PER_MINUTE, 5) });
  const loginAddressFailures = createFailureLimiter({ limit: positiveInteger(process.env.LOGIN_IP_FAILURES_PER_MINUTE, 20) });
  const ssoSettings = createSsoSettings(db);
  let ssoConfig = ssoSettings.load();
  const auth = createAuthService(db, { signupAllowed: () => ssoConfig.signupAllowed === true, secureCookies: () => ssoConfig.publicUrl?.startsWith('https:') });
  let sso = createSsoService(db, auth, ssoConfig);
  const planning = createPlanningService(db);
  const projects = createProjectService(db);
  const teams = createTeamService(db);
  const kanban = createKanbanService(db);
  const activity = createActivityService(db);
  const events = createEventsService({ projects, kanban, teams });
  const dataApi = createDataApi(db, projects, { apiToken });
  const requireUser = (req) => { const user = auth.userForRequest(req); if (!user) throw new AuthError(401, 'Authentication is required.'); return user; };
  const requireAdmin = (req) => { const user = requireUser(req); if (user.role !== 'admin') throw new AuthError(403, 'Admin access is required.'); return user; };
  const teamIdForName = (name) => db.prepare('SELECT id FROM teams WHERE name = ? COLLATE NOCASE').get(name)?.id;
  const canManageTeam = (user, teamId) => user.role === 'admin' || (user.role === 'team_manager' && user.teamIds.includes(teamId));
  const canEditTeamBoard = (user, teamId) => user.role === 'admin' || user.teamIds.includes(teamId);
  const requireTeamManager = (user, teamId) => { if (!canManageTeam(user, teamId)) throw new AuthError(403, 'Team manager access is required.'); };
  const requireBoardMember = (user, teamId) => { if (!canEditTeamBoard(user, teamId)) throw new AuthError(403, 'Team membership is required.'); };

  async function handle(req, res, url) {
    try {
      // Too many unknown bearer tokens from one address within a minute locks that address out of token auth.
      const bearer = url.pathname.startsWith('/api/') && /^Bearer /i.test(String(req.headers.authorization || ''));
      const clientIp = req.socket.remoteAddress || '';
      if (bearer) {
        const retryAfter = tokenFailures.retryAfter(clientIp);
        if (retryAfter) {
          res.setHeader('retry-after', String(retryAfter));
          return json(res, 429, { error: 'Too many failed API token attempts. Try again later.' }), true;
        }
      }
      const bearerAccess = bearer ? apiTokenAccess(db, req, { apiToken }) : null;
      if (bearer && !bearerAccess) tokenFailures.fail(clientIp);
      const kanbanPath = url.pathname === '/api/kanban' || url.pathname.startsWith('/api/kanban/');
      if (kanbanPath) res.setHeader('cache-control', 'no-store');
      if (url.pathname === '/api/admin/sso') {
        requireAdmin(req);
        res.setHeader('cache-control', 'no-store');
        if (req.method === 'GET') return json(res, 200, ssoSettings.view()), true;
        if (req.method === 'PUT') {
          ssoConfig = ssoSettings.save(await readJson(req, 500_000));
          sso = createSsoService(db, auth, ssoConfig);
          return json(res, 200, ssoSettings.view()), true;
        }
        return json(res, 405, { error: 'Method not allowed.' }), true;
      }
      if (await sso.handle(req, res, url)) return true;
      if (url.pathname === '/api/auth/status' && req.method === 'GET') return json(res, 200, { setupRequired: auth.setupRequired(), authenticated: Boolean(auth.userForRequest(req)), ssoProviders: sso.providers(), signupAllowed: auth.signupAllowed() }), true;
      if (url.pathname === '/api/auth/setup' && req.method === 'POST') return json(res, 201, auth.setup(await readJson(req), req, res)), true;
      if (url.pathname === '/api/auth/signup' && req.method === 'POST') return json(res, 201, auth.signup(await readJson(req), req, res)), true;
      if (url.pathname === '/api/auth/login' && req.method === 'POST') {
        // Failed passwords are limited per address and username, and per address across usernames.
        const input = await readJson(req);
        const userKey = `${clientIp}\n${String(input.username || '').trim().toLowerCase()}`;
        const retryAfter = Math.max(loginFailures.retryAfter(userKey), loginAddressFailures.retryAfter(clientIp));
        if (retryAfter) {
          res.setHeader('retry-after', String(retryAfter));
          return json(res, 429, { error: 'Too many failed sign-in attempts. Try again later.' }), true;
        }
        try {
          const user = auth.login(input, req, res);
          loginFailures.reset(userKey);
          return json(res, 200, user), true;
        } catch (error) {
          if (error instanceof AuthError && error.status === 401) { loginFailures.fail(userKey); loginAddressFailures.fail(clientIp); }
          throw error;
        }
      }
      if (url.pathname === '/api/auth/logout' && req.method === 'POST') { auth.logout(req, res); return json(res, 200, { ok: true }), true; }
      if (url.pathname === '/api/auth/me' && req.method === 'GET') return json(res, 200, requireUser(req)), true;
      if (url.pathname.startsWith('/api/docs/')) {
        requireUser(req);
        const name = url.pathname.slice('/api/docs/'.length);
        if (!Object.hasOwn(DOCS, name)) return json(res, 404, { error: 'Document not found.' }), true;
        if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' }), true;
        res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
        res.end(await readFile(DOCS[name], 'utf8'));
        return true;
      }

      const usersMatch = url.pathname.match(/^\/api\/users(?:\/(\d+))?$/);
      if (usersMatch) {
        const currentUser = requireUser(req);
        const id = usersMatch[1] ? Number(usersMatch[1]) : null;
        if (req.method === 'GET' && !id && ['admin', 'team_manager'].includes(currentUser.role)) return json(res, 200, auth.listUsers()), true;
        if (currentUser.role !== 'admin') throw new AuthError(403, 'Admin access is required.');
        if (req.method === 'POST' && !id) return json(res, 201, auth.createUser(await readJson(req))), true;
        if (req.method === 'PUT' && id) return json(res, 200, auth.updateUser(id, await readJson(req), currentUser)), true;
        if (req.method === 'DELETE' && id) { auth.deleteUser(id, currentUser); res.writeHead(204); res.end(); return true; }
        return json(res, 405, { error: 'Method not allowed.' }), true;
      }

      // Planning-room URLs are scoped capability links for invited participants.
      const sessionMatch = url.pathname.match(/^\/api\/sessions\/([A-Za-z0-9_-]+)(?:\/(votes|reveal|decide))?$/);
      if (sessionMatch) {
        const [, token, action] = sessionMatch;
        const session = planning.find(token);
        if (!session) return json(res, 404, { error: 'Planning room not found.' }), true;
        if (!session.guest_access) requireUser(req);
        if (req.method === 'GET' && !action) return json(res, 200, planning.payload(token, String(url.searchParams.get('voterToken') || '').slice(0, 80))), true;
        if (req.method === 'POST' && action) {
          const input = await readJson(req);
          const result = action === 'votes' ? planning.vote(session, token, input) : action === 'reveal' ? planning.reveal(session, token, input) : planning.decide(session, token, input);
          return json(res, 200, result), true;
        }
        return json(res, 405, { error: 'Method not allowed.' }), true;
      }

      const sessionUser = auth.userForRequest(req);
      const projectsPath = /^\/api\/projects(?:\/(?:\d+(?:\/moves)?|upsert))?$/.test(url.pathname);
      const teamsPath = /^\/api\/(?:teams(?:\/\d+)?|capacity)$/.test(url.pathname);
      const tokenPath = kanbanPath || projectsPath || teamsPath || ['/api/activity', '/api/events', '/api/version'].includes(url.pathname);
      const tokenAccess = tokenPath ? bearerAccess : null;
      if (tokenAccess?.scope === 'read' && req.method !== 'GET') throw new AuthError(403, 'This API token is read-only.');
      // Tokens belong to no team: a write token acts as an admin, a read token as a read-only viewer.
      const tokenUser = tokenAccess ? { id: 0, username: tokenAccess.name, role: tokenAccess.scope === 'write' ? 'admin' : 'read_only', teamIds: [] } : null;
      const user = tokenUser || sessionUser;
      if (await dataApi(req, res, url, sessionUser)) return true;
      if (!url.pathname.startsWith('/api/')) return false;
      if (tokenPath) {
        if (!user) {
          res.setHeader('www-authenticate', `Bearer realm="Northstar ${kanbanPath ? 'kanban' : 'projects'} API"`);
          throw new AuthError(401, 'Authentication is required.');
        }
      } else requireUser(req);
      const requireUserAdmin = () => { if (user.role !== 'admin') throw new AuthError(403, 'Admin access is required.'); };
      // Kanban boards belong to teams. A request names its board with ?teamId; without it, list and
      // column calls use the first team's board, and card calls use the card's own team.
      const requestedTeamId = Number(url.searchParams.get('teamId')) || null;
      const boardTeamId = requestedTeamId || db.prepare('SELECT id FROM teams ORDER BY id LIMIT 1').get()?.id;
      if (kanbanPath && !db.prepare('SELECT 1 FROM teams WHERE id = ?').get(boardTeamId)) throw new KanbanError(404, 'Team board not found.');
      const teamForCard = (cardId) => requestedTeamId || db.prepare('SELECT team_id AS teamId FROM kanban_cards WHERE id = ?').get(cardId)?.teamId || boardTeamId;
      const teamForColumn = (columnId) => requestedTeamId || db.prepare('SELECT team_id AS teamId FROM kanban_columns WHERE id = ?').get(Number(columnId))?.teamId || boardTeamId;
      const canSeeHiddenOn = (teamId) => user.role === 'admin' || canManageTeam(user, teamId);
      const requireKanbanManager = () => requireTeamManager(user, boardTeamId);
      const requireVisibleCard = (id, teamId) => kanban.getCard(id, { includeHidden: canSeeHiddenOn(teamId), teamId });
      const refuseHiddenProject = (input, teamId) => {
        if (!canSeeHiddenOn(teamId) && input.projectId && projects.isHidden(Number(input.projectId))) throw new KanbanError(404, 'Project not found.');
      };

      if (url.pathname === '/api/events') {
        if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' }), true;
        events.subscribe(req, res, { includeHidden: user.role === 'admin', lastEventId: req.headers['last-event-id'] });
        return true;
      }
      if (url.pathname === '/api/version') {
        if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' }), true;
        res.setHeader('cache-control', 'no-store');
        return json(res, 200, { version: events.version(user.role === 'admin') }), true;
      }
      if (url.pathname === '/api/activity') {
        if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' }), true;
        res.setHeader('cache-control', 'no-store');
        const query = { since: url.searchParams.get('since') ?? undefined, limit: url.searchParams.get('limit') ?? undefined };
        return json(res, 200, activity.list(query, { includeHidden: user.role === 'admin' })), true;
      }
      if (url.pathname === '/api/kanban') {
        if (req.method === 'GET') return json(res, 200, kanban.list({ includeHidden: canSeeHiddenOn(boardTeamId), teamId: boardTeamId, archived: url.searchParams.get('archived') ?? undefined })), true;
        return json(res, 405, { error: 'Method not allowed.' }), true;
      }
      if (url.pathname === '/api/kanban/report') {
        if (req.method === 'GET') return json(res, 200, kanban.report({ includeHidden: canSeeHiddenOn(boardTeamId), teamId: boardTeamId })), true;
        return json(res, 405, { error: 'Method not allowed.' }), true;
      }
      if (url.pathname === '/api/kanban/projects') {
        if (req.method === 'GET') { const teamName = db.prepare('SELECT name FROM teams WHERE id = ?').get(boardTeamId).name; return json(res, 200, projects.list({ includeHidden: user.role === 'admin' || canManageTeam(user, boardTeamId) }).filter((p) => p.team.toLocaleLowerCase() === teamName.toLocaleLowerCase()).map(({ id, projectId, name, status, archived }) => ({ id, projectId, name, status, archived }))), true; }
        return json(res, 405, { error: 'Method not allowed.' }), true;
      }
      const columnMatch = url.pathname.match(/^\/api\/kanban\/columns(?:\/(\d+))?$/);
      if (columnMatch) {
        requireKanbanManager();
        const id = columnMatch[1] ? Number(columnMatch[1]) : null;
        if (req.method === 'POST' && !id) return json(res, 201, kanban.createColumn({ ...await readJson(req), teamId: boardTeamId })), true;
        if (req.method === 'PUT' && id) return json(res, 200, kanban.updateColumn(id, { ...await readJson(req), teamId: boardTeamId })), true;
        if (req.method === 'DELETE' && id) { kanban.deleteColumn(id, boardTeamId); res.writeHead(204); res.end(); return true; }
        return json(res, 405, { error: 'Method not allowed.' }), true;
      }
      const cardMatch = url.pathname.match(/^\/api\/kanban\/cards(?:\/(\d+))?$/);
      const historyMatch = url.pathname.match(/^\/api\/kanban\/cards\/(\d+)\/history$/);
      if (historyMatch) {
        if (req.method === 'GET') { const teamId = teamForCard(Number(historyMatch[1])); return json(res, 200, kanban.history(Number(historyMatch[1]), { includeHidden: canSeeHiddenOn(teamId), teamId })), true; }
        return json(res, 405, { error: 'Method not allowed.' }), true;
      }
      const noteMatch = url.pathname.match(/^\/api\/kanban\/cards\/(\d+)\/notes(?:\/(\d+))?$/);
      if (noteMatch) {
        const cardId = Number(noteMatch[1]);
        const noteId = noteMatch[2] ? Number(noteMatch[2]) : null;
        const noteTeamId = teamForCard(cardId);
        if (req.method === 'GET' && !noteId) return json(res, 200, kanban.listNotes(cardId, { includeHidden: canSeeHiddenOn(noteTeamId), teamId: noteTeamId })), true;
        requireBoardMember(user, noteTeamId);
        requireVisibleCard(cardId, noteTeamId);
        if (req.method === 'POST' && !noteId) return json(res, 201, kanban.createNote(cardId, { ...await readJson(req), teamId: noteTeamId })), true;
        if (req.method === 'DELETE' && noteId) { kanban.deleteNote(cardId, noteId, noteTeamId); res.writeHead(204); res.end(); return true; }
        return json(res, 405, { error: 'Method not allowed.' }), true;
      }
      if (url.pathname === '/api/kanban/cards/upsert') {
        requireUserAdmin();
        if (req.method !== 'PUT') return json(res, 405, { error: 'Method not allowed.' }), true;
        const result = kanban.upsertCard(await readJson(req), { key: url.searchParams.get('key') ?? 'externalUrl', actor: user.username });
        return json(res, result.created ? 201 : 200, result), true;
      }
      if (cardMatch) {
        const id = cardMatch[1] ? Number(cardMatch[1]) : null;
        if (req.method === 'GET' && id) { const teamId = teamForCard(id); return json(res, 200, kanban.getCard(id, { includeHidden: canSeeHiddenOn(teamId), teamId })), true; }
        if (req.method === 'GET') return json(res, 200, kanban.findCards({ ...lookupParams(url, ['key', 'externalUrl', 'projectId', 'decision', 'tag', 'source', 'archived']), includeHidden: user.role === 'admin' })), true;
        if (req.method === 'POST' && !id) {
          const input = await readJson(req);
          const teamId = teamForColumn(input?.columnId);
          requireBoardMember(user, teamId);
          refuseHiddenProject(input, teamId);
          return json(res, 201, kanban.createCard({ ...input, teamId })), true;
        }
        const cardTeamId = id ? teamForCard(id) : boardTeamId;
        requireBoardMember(user, cardTeamId);
        if (id) requireVisibleCard(id, cardTeamId);
        if (req.method === 'PUT' && id) {
          const input = await readJson(req);
          refuseHiddenProject(input, cardTeamId);
          return json(res, 200, kanban.updateCard(id, { ...input, teamId: cardTeamId }, { actor: user.username })), true;
        }
        if (req.method === 'DELETE' && id) { kanban.deleteCard(id, cardTeamId); res.writeHead(204); res.end(); return true; }
        return json(res, 405, { error: 'Method not allowed.' }), true;
      }

      if (url.pathname === '/api/capacity') {
        if (req.method === 'GET') return json(res, 200, projects.capacity({ includeHidden:user.role === 'admin' })), true;
        requireUserAdmin();
        if (req.method !== 'PUT') return json(res, 405, { error: 'Method not allowed.' }), true;
        return json(res, 200, projects.setCapacity(await readJson(req))), true;
      }

      const membersMatch = url.pathname.match(/^\/api\/teams\/(\d+)\/members(?:\/(\d+))?$/);
      if (membersMatch) {
        const teamId = Number(membersMatch[1]);
        const memberId = membersMatch[2] ? Number(membersMatch[2]) : null;
        if (req.method === 'GET' && !memberId) return json(res, 200, teams.members(teamId)), true;
        requireTeamManager(user, teamId);
        if (req.method === 'POST' && !memberId) return json(res, 201, teams.addMember(teamId, Number((await readJson(req)).userId))), true;
        if (req.method === 'DELETE' && memberId) { teams.removeMember(teamId, memberId); res.writeHead(204); res.end(); return true; }
        return json(res, 405, { error: 'Method not allowed.' }), true;
      }

      const teamMatch = url.pathname.match(/^\/api\/teams(?:\/(\d+))?$/);
      if (teamMatch) {
        const id = teamMatch[1] ? Number(teamMatch[1]) : null;
        if (req.method === 'GET' && !id) return json(res, 200, teams.list({ includeHidden:user.role === 'admin' })), true;
        // Creating and deleting teams stays with admins (or a write token); a team's manager may rename it or set its capacity.
        if (req.method === 'POST' || req.method === 'DELETE') requireUserAdmin();
        else requireTeamManager(user, id);
        if (req.method === 'POST' && !id) return json(res, 201, teams.create(await readJson(req))), true;
        if (req.method === 'PUT' && id) return json(res, 200, teams.update(id, await readJson(req))), true;
        if (req.method === 'DELETE' && id) { teams.delete(id); res.writeHead(204); res.end(); return true; }
        return json(res, 405, { error: 'Method not allowed.' }), true;
      }

      if (url.pathname === '/api/planning-sessions') {
        requireAdmin(req);
        if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' }), true;
        const input = await readJson(req);
        return json(res, 201, planning.create(Array.isArray(input.projectIds) ? input.projectIds : [], { guestAccess:input.guestAccess !== false })), true;
      }
      const createSessionMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/sessions$/);
      if (createSessionMatch) {
        requireAdmin(req);
        if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' }), true;
        const projectId = Number(createSessionMatch[1]);
        const input = await readJson(req);
        return json(res, 201, planning.create(Array.isArray(input.projectIds) ? [projectId, ...input.projectIds] : [projectId], { guestAccess:input.guestAccess !== false })), true;
      }

      const movesMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/moves$/);
      if (movesMatch) {
        if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' }), true;
        const projectId = Number(movesMatch[1]);
        if (user.role !== 'admin' && projects.isHidden(projectId)) {
          const project = db.prepare('SELECT team FROM projects WHERE id = ?').get(projectId);
          if (!project || !canManageTeam(user, teamIdForName(project.team))) return json(res, 404, { error: 'Project not found.' }), true;
        }
        return json(res, 200, projects.moves(projectId)), true;
      }

      if (url.pathname === '/api/projects/upsert') {
        requireUserAdmin();
        if (req.method !== 'PUT') return json(res, 405, { error: 'Method not allowed.' }), true;
        const result = projects.upsert(url.searchParams.get('key'), await readJson(req), { actor: user.username });
        return json(res, result.created ? 201 : 200, result), true;
      }

      const match = url.pathname.match(/^\/api\/projects(?:\/(\d+))?$/);
      if (!match) return false;
      const id = match[1] ? Number(match[1]) : null;
      if (req.method === 'GET' && !id) return json(res, 200, projects.list({ ...lookupParams(url, ['projectId', 'externalUrl']), includeHidden: true }).filter((project) => user.role === 'admin' || !project.hiddenFromReadOnly || canManageTeam(user, teamIdForName(project.team)))), true;
      if (req.method === 'POST' && !id) {
        if (user.role === 'read_only') throw new AuthError(403, 'Team manager access is required.');
        const input = await readJson(req);
        if (user.role !== 'admin') requireTeamManager(user, teamIdForName(input.team));
        return json(res, 201, projects.create(input)), true;
      }
      if (req.method === 'PUT' && id) {
        const current = db.prepare('SELECT team FROM projects WHERE id = ?').get(id);
        if (!current) throw new ProjectError(404, 'Project not found.');
        const input = await readJson(req);
        if (user.role !== 'admin') {
          requireTeamManager(user, teamIdForName(current.team));
          if (input.team !== undefined) requireTeamManager(user, teamIdForName(input.team));
        }
        return json(res, 200, projects.update(id, input, { actor: user.username })), true;
      }
      if (req.method === 'DELETE' && id) {
        const current = db.prepare('SELECT team FROM projects WHERE id = ?').get(id);
        if (!current) throw new ProjectError(404, 'Project not found.');
        requireTeamManager(user, teamIdForName(current.team));
        projects.delete(id); res.writeHead(204); res.end(); return true;
      }
      return json(res, 405, { error: 'Method not allowed.' }), true;
    } catch (error) {
      const status = error instanceof PlanningError || error instanceof ProjectError || error instanceof AuthError || error instanceof KanbanError || error instanceof ActivityError ? error.status : 400;
      const details = error instanceof PlanningError ? error.data : {};
      json(res, status, { error: error instanceof Error ? error.message : 'Request failed.', ...details });
      return true;
    }
  }

  async function api(req, res, url) {
    const handled = await handle(req, res, url);
    if (handled && isPublishedWrite(req, res, url)) events.publish();
    return handled;
  }
  api.close = () => events.close();
  return api;
}
