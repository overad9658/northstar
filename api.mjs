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
  const teamIdForName = (name) => db.prepare('SELECT id FROM teams WHERE name = ? COLLATE NOCASE').get(name)?.id;
  const canManageTeam = (user, teamId) => user.role === 'admin' || (user.role === 'team_manager' && user.teamIds.includes(teamId));
  const canEditTeamBoard = (user, teamId) => user.role === 'admin' || user.teamIds.includes(teamId);
  const requireTeamManager = (user, teamId) => { if (!canManageTeam(user, teamId)) throw new AuthError(403, 'Team manager access is required.'); };
  const requireBoardMember = (user, teamId) => { if (!canEditTeamBoard(user, teamId)) throw new AuthError(403, 'Team membership is required.'); };

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
      const requestedTeamId = Number(url.searchParams.get('teamId'));
      const boardTeamId = requestedTeamId || db.prepare('SELECT id FROM teams ORDER BY id LIMIT 1').get()?.id;
      if (kanbanPath && !db.prepare('SELECT 1 FROM teams WHERE id = ?').get(boardTeamId)) throw new KanbanError(404, 'Team board not found.');
      const requireKanbanManager = () => requireTeamManager(user, boardTeamId);
      const requireKanbanMember = () => requireBoardMember(user, boardTeamId);
      const boardCanSeeHidden = user.role === 'admin' || canManageTeam(user, boardTeamId);
      const requireVisibleCard = (id) => kanban.getCard(id, { includeHidden: boardCanSeeHidden, teamId: boardTeamId });

      if (url.pathname === '/api/kanban') {
        if (req.method === 'GET') return json(res, 200, kanban.list({ includeHidden: boardCanSeeHidden, teamId: boardTeamId })), true;
        return json(res, 405, { error: 'Method not allowed.' }), true;
      }
      if (url.pathname === '/api/kanban/report') {
        if (req.method === 'GET') return json(res, 200, kanban.report({ includeHidden: boardCanSeeHidden, teamId: boardTeamId })), true;
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
        if (req.method === 'GET') return json(res, 200, kanban.history(Number(historyMatch[1]), { includeHidden: boardCanSeeHidden, teamId: boardTeamId })), true;
        return json(res, 405, { error: 'Method not allowed.' }), true;
      }
      const noteMatch = url.pathname.match(/^\/api\/kanban\/cards\/(\d+)\/notes(?:\/(\d+))?$/);
      if (noteMatch) {
        const cardId = Number(noteMatch[1]);
        const noteId = noteMatch[2] ? Number(noteMatch[2]) : null;
        if (req.method === 'GET' && !noteId) return json(res, 200, kanban.listNotes(cardId, { includeHidden: boardCanSeeHidden, teamId: boardTeamId })), true;
        requireKanbanMember();
        requireVisibleCard(cardId);
        if (req.method === 'POST' && !noteId) return json(res, 201, kanban.createNote(cardId, { ...await readJson(req), teamId: boardTeamId })), true;
        if (req.method === 'DELETE' && noteId) { kanban.deleteNote(cardId, noteId, boardTeamId); res.writeHead(204); res.end(); return true; }
        return json(res, 405, { error: 'Method not allowed.' }), true;
      }
      if (cardMatch) {
        const id = cardMatch[1] ? Number(cardMatch[1]) : null;
        if (req.method === 'GET' && id) return json(res, 200, kanban.getCard(id, { includeHidden: boardCanSeeHidden, teamId: boardTeamId })), true;
        requireKanbanMember();
        if (req.method === 'POST' && !id) {
          const input = await readJson(req);
          if (!boardCanSeeHidden && input.projectId && projects.isHidden(Number(input.projectId))) throw new KanbanError(404, 'Project not found.');
          return json(res, 201, kanban.createCard({ ...input, teamId: boardTeamId })), true;
        }
        if (id) requireVisibleCard(id);
        if (req.method === 'PUT' && id) {
          const input = await readJson(req);
          if (!boardCanSeeHidden && input.projectId && projects.isHidden(Number(input.projectId))) throw new KanbanError(404, 'Project not found.');
          return json(res, 200, kanban.updateCard(id, { ...input, teamId: boardTeamId })), true;
        }
        if (req.method === 'DELETE' && id) { kanban.deleteCard(id, boardTeamId); res.writeHead(204); res.end(); return true; }
        return json(res, 405, { error: 'Method not allowed.' }), true;
      }

      if (url.pathname === '/api/capacity') {
        if (req.method === 'GET') return json(res, 200, projects.capacity({ includeHidden:user.role === 'admin' })), true;
        requireAdmin(req);
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
        if (req.method === 'POST' || req.method === 'DELETE') requireAdmin(req);
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

      const match = url.pathname.match(/^\/api\/projects(?:\/(\d+))?$/);
      if (!match) return false;
      const id = match[1] ? Number(match[1]) : null;
      if (req.method === 'GET' && !id) return json(res, 200, projects.list({ includeHidden: true }).filter((project) => user.role === 'admin' || !project.hiddenFromReadOnly || canManageTeam(user, teamIdForName(project.team)))), true;
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
        return json(res, 200, projects.update(id, input)), true;
      }
      if (req.method === 'DELETE' && id) {
        const current = db.prepare('SELECT team FROM projects WHERE id = ?').get(id);
        if (!current) throw new ProjectError(404, 'Project not found.');
        requireTeamManager(user, teamIdForName(current.team));
        projects.delete(id); res.writeHead(204); res.end(); return true;
      }
      return json(res, 405, { error: 'Method not allowed.' }), true;
    } catch (error) {
      const status = error instanceof PlanningError || error instanceof ProjectError || error instanceof AuthError || error instanceof KanbanError ? error.status : 400;
      const details = error instanceof PlanningError ? error.data : {};
      json(res, status, { error: error instanceof Error ? error.message : 'Request failed.', ...details });
      return true;
    }
  };
}
