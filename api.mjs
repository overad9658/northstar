import { AuthError, createAuthService } from './auth-service.mjs';
import { createDataApi } from './data-api.mjs';
import { json, readJson } from './http-utils.mjs';
import { createPlanningService, PlanningError } from './planning-service.mjs';
import { createProjectService, ProjectError } from './project-service.mjs';
import { createTeamService } from './team-service.mjs';

export function createApi(db, { apiToken = process.env.API_TOKEN } = {}) {
  const auth = createAuthService(db);
  const planning = createPlanningService(db);
  const projects = createProjectService(db);
  const teams = createTeamService(db);
  const dataApi = createDataApi(db, projects, { apiToken });
  const requireUser = (req) => { const user = auth.userForRequest(req); if (!user) throw new AuthError(401, 'Authentication is required.'); return user; };
  const requireAdmin = (req) => { const user = requireUser(req); if (user.role !== 'admin') throw new AuthError(403, 'Admin access is required.'); return user; };

  return async function api(req, res, url) {
    try {
      if (url.pathname === '/api/auth/status' && req.method === 'GET') return json(res, 200, { setupRequired: auth.setupRequired(), authenticated: Boolean(auth.userForRequest(req)) }), true;
      if (url.pathname === '/api/auth/setup' && req.method === 'POST') return json(res, 201, auth.setup(await readJson(req), req, res)), true;
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

      const user = auth.userForRequest(req);
      if (await dataApi(req, res, url, user)) return true;
      if (!url.pathname.startsWith('/api/')) return false;
      requireUser(req);

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
      const status = error instanceof PlanningError || error instanceof ProjectError || error instanceof AuthError ? error.status : 400;
      const details = error instanceof PlanningError ? error.data : {};
      json(res, status, { error: error instanceof Error ? error.message : 'Request failed.', ...details });
      return true;
    }
  };
}
