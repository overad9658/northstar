import { AuthError, createAuthService } from './auth-service.mjs';
import { createDataApi, isApiTokenAuthorized } from './data-api.mjs';
import { json, readJson } from './http-utils.mjs';
import { createPlanningService, PlanningError } from './planning-service.mjs';
import { createProjectService, ProjectError } from './project-service.mjs';
import { createTeamService } from './team-service.mjs';
import { createSsoService } from './sso-service.mjs';
import { createSsoSettings } from './sso-settings.mjs';
import { createKanbanService, KanbanError } from './kanban-service.mjs';

export function createApi(db, { apiToken = process.env.API_TOKEN } = {}) {
  const ssoSettings = createSsoSettings(db);
  let ssoConfig = ssoSettings.load();
  const auth = createAuthService(db, { signupAllowed: () => ssoConfig.signupAllowed === true, secureCookies: () => ssoConfig.publicUrl?.startsWith('https:') });
  let sso = createSsoService(db, auth, ssoConfig);
  const planning = createPlanningService(db);
  const projects = createProjectService(db);
  const teams = createTeamService(db);
  const kanban = createKanbanService(db);
  const dataApi = createDataApi(db, projects, { apiToken });
  const requireUser = (req) => { const user = auth.userForRequest(req); if (!user) throw new AuthError(401, 'Authentication is required.'); return user; };
  const requireAdmin = (req) => { const user = requireUser(req); if (user.role !== 'admin') throw new AuthError(403, 'Admin access is required.'); return user; };

  return async function api(req, res, url) {
    try {
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
      if (url.pathname === '/api/auth/login' && req.method === 'POST') return json(res, 200, auth.login(await readJson(req), req, res)), true;
      if (url.pathname === '/api/auth/logout' && req.method === 'POST') { auth.logout(req, res); return json(res, 200, { ok: true }), true; }
      if (url.pathname === '/api/auth/me' && req.method === 'GET') return json(res, 200, requireUser(req)), true;

      const usersMatch = url.pathname.match(/^\/api\/users(?:\/(\d+))?$/);
      if (usersMatch) {
        const currentUser = requireAdmin(req);
        const id = usersMatch[1] ? Number(usersMatch[1]) : null;
        if (req.method === 'GET' && !id) return json(res, 200, auth.listUsers()), true;
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
      const tokenUser = kanbanPath && isApiTokenAuthorized(db, req, { apiToken }) ? { id: 0, username: 'API token', role: 'admin' } : null;
      const user = tokenUser || sessionUser;
      if (await dataApi(req, res, url, sessionUser)) return true;
      if (!url.pathname.startsWith('/api/')) return false;
      if (kanbanPath) {
        if (!user) {
          res.setHeader('www-authenticate', 'Bearer realm="Northstar kanban API"');
          throw new AuthError(401, 'Authentication is required.');
        }
      } else requireUser(req);
      const requireKanbanAdmin = () => { if (user.role !== 'admin') throw new AuthError(403, 'Admin access is required.'); };

      if (url.pathname === '/api/kanban') {
        if (req.method === 'GET') return json(res, 200, kanban.list({ includeHidden: user.role === 'admin' })), true;
        return json(res, 405, { error: 'Method not allowed.' }), true;
      }
      if (url.pathname === '/api/kanban/report') {
        if (req.method === 'GET') return json(res, 200, kanban.report({ includeHidden: user.role === 'admin' })), true;
        return json(res, 405, { error: 'Method not allowed.' }), true;
      }
      if (url.pathname === '/api/kanban/projects') {
        if (req.method === 'GET') return json(res, 200, projects.list({ includeHidden: user.role === 'admin' }).map(({ id, projectId, name, status, archived }) => ({ id, projectId, name, status, archived }))), true;
        return json(res, 405, { error: 'Method not allowed.' }), true;
      }
      const columnMatch = url.pathname.match(/^\/api\/kanban\/columns(?:\/(\d+))?$/);
      if (columnMatch) {
        requireKanbanAdmin();
        const id = columnMatch[1] ? Number(columnMatch[1]) : null;
        if (req.method === 'POST' && !id) return json(res, 201, kanban.createColumn(await readJson(req))), true;
        if (req.method === 'PUT' && id) return json(res, 200, kanban.updateColumn(id, await readJson(req))), true;
        if (req.method === 'DELETE' && id) { kanban.deleteColumn(id); res.writeHead(204); res.end(); return true; }
        return json(res, 405, { error: 'Method not allowed.' }), true;
      }
      const cardMatch = url.pathname.match(/^\/api\/kanban\/cards(?:\/(\d+))?$/);
      const historyMatch = url.pathname.match(/^\/api\/kanban\/cards\/(\d+)\/history$/);
      if (historyMatch) {
        if (req.method === 'GET') return json(res, 200, kanban.history(Number(historyMatch[1]), { includeHidden: user.role === 'admin' })), true;
        return json(res, 405, { error: 'Method not allowed.' }), true;
      }
      const noteMatch = url.pathname.match(/^\/api\/kanban\/cards\/(\d+)\/notes(?:\/(\d+))?$/);
      if (noteMatch) {
        const cardId = Number(noteMatch[1]);
        const noteId = noteMatch[2] ? Number(noteMatch[2]) : null;
        if (req.method === 'GET' && !noteId) return json(res, 200, kanban.listNotes(cardId, { includeHidden: user.role === 'admin' })), true;
        requireKanbanAdmin();
        if (req.method === 'POST' && !noteId) return json(res, 201, kanban.createNote(cardId, await readJson(req))), true;
        if (req.method === 'DELETE' && noteId) { kanban.deleteNote(cardId, noteId); res.writeHead(204); res.end(); return true; }
        return json(res, 405, { error: 'Method not allowed.' }), true;
      }
      if (cardMatch) {
        const id = cardMatch[1] ? Number(cardMatch[1]) : null;
        if (req.method === 'GET' && id) return json(res, 200, kanban.getCard(id, { includeHidden: user.role === 'admin' })), true;
        requireKanbanAdmin();
        if (req.method === 'POST' && !id) return json(res, 201, kanban.createCard(await readJson(req))), true;
        if (req.method === 'PUT' && id) return json(res, 200, kanban.updateCard(id, await readJson(req))), true;
        if (req.method === 'DELETE' && id) { kanban.deleteCard(id); res.writeHead(204); res.end(); return true; }
        return json(res, 405, { error: 'Method not allowed.' }), true;
      }

      if (url.pathname === '/api/capacity') {
        if (req.method === 'GET') return json(res, 200, projects.capacity({ includeHidden:user.role === 'admin' })), true;
        requireAdmin(req);
        if (req.method !== 'PUT') return json(res, 405, { error: 'Method not allowed.' }), true;
        return json(res, 200, projects.setCapacity(await readJson(req))), true;
      }

      const teamMatch = url.pathname.match(/^\/api\/teams(?:\/(\d+))?$/);
      if (teamMatch) {
        const id = teamMatch[1] ? Number(teamMatch[1]) : null;
        if (req.method === 'GET' && !id) return json(res, 200, teams.list({ includeHidden:user.role === 'admin' })), true;
        requireAdmin(req);
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
        if (user.role === 'read_only' && projects.isHidden(projectId)) return json(res, 404, { error: 'Project not found.' }), true;
        return json(res, 200, projects.moves(projectId)), true;
      }

      const match = url.pathname.match(/^\/api\/projects(?:\/(\d+))?$/);
      if (!match) return false;
      const id = match[1] ? Number(match[1]) : null;
      if (req.method === 'GET' && !id) return json(res, 200, projects.list({ includeHidden: user.role === 'admin' })), true;
      requireAdmin(req);
      if (req.method === 'POST' && !id) return json(res, 201, projects.create(await readJson(req))), true;
      if (req.method === 'PUT' && id) return json(res, 200, projects.update(id, await readJson(req))), true;
      if (req.method === 'DELETE' && id) { projects.delete(id); res.writeHead(204); res.end(); return true; }
      return json(res, 405, { error: 'Method not allowed.' }), true;
    } catch (error) {
      const status = error instanceof PlanningError || error instanceof ProjectError || error instanceof AuthError || error instanceof KanbanError ? error.status : 400;
      const details = error instanceof PlanningError ? error.data : {};
      json(res, status, { error: error instanceof Error ? error.message : 'Request failed.', ...details });
      return true;
    }
  };
}
