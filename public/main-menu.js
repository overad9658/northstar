import { createDismissGroup } from './dismiss.js';

const header = document.querySelector('.topbar, .room-topbar, .auth-topbar');
const actions = header?.querySelector('.topbar-actions, .room-topbar-actions');

if (header && actions && !header.querySelector('.app-menu')) {
  const menu = document.createElement('details');
  menu.className = 'app-menu';
  menu.id = 'app-menu';
  menu.innerHTML = `<summary role="button" aria-label="Open main menu" aria-haspopup="true" aria-expanded="false" title="Menu"><span class="hamburger" aria-hidden="true"><i></i><i></i><i></i></span></summary><nav class="app-menu-panel" aria-label="Main menu"></nav>`;
  actions.append(menu);
  createDismissGroup().details(menu);

  const panel = menu.querySelector('.app-menu-panel');
  const item = (href, icon, title, detail) => `<a class="app-menu-item" href="${href}"><span aria-hidden="true">${icon}</span><strong>${title}</strong><small>${detail}</small></a>`;
  panel.innerHTML = item('/', '◇', 'Priority matrix', 'Portfolio and project priorities')
    + item('/docs.html', '?', 'Docs', 'API and MCP reference');

  const response = await fetch('/api/auth/me', { credentials: 'same-origin' }).catch(() => null);
  const user = response?.ok ? await response.json().catch(() => null) : null;
  if (user) {
    panel.innerHTML = item('/', '◇', 'Priority matrix', 'Portfolio and project priorities')
      + (user.id ? item('/todos.html', '✓', 'My to-do list', 'Private tasks, just for you') : '')
      + item('/kanban.html', '▦', 'Kanban board', 'General tasks and project work')
      + item('/progress.html', '↗', 'Progress', 'Daily numbers and reports')
      + item('/sequence.html', '≡', 'Sequence', 'What happens next, and who does it')
      + item('/okrs.html', '◎', 'OKRs', 'Objectives, results, and linked work')
      + item('/teams.html', '◎', 'Teams', 'View capacity')
      + item('/docs.html', '?', 'Docs', 'API and MCP reference')
      + (user.role === 'admin' ? item('/users.html', '♙', 'Users', 'Manage access and roles')
        + item('/sso.html', '⌘', 'Single sign-on', 'Configure SAML and OIDC')
        + item('/tokens.html', '⚿', 'API tokens', 'Named read and write tokens')
        + item('/?menu=api-access', '⌁', 'API access', 'Generate a bearer token')
        + item('/?menu=data', '<svg viewBox="0 0 16 16"><path d="M5 13V3m-3 3 3-3 3 3m3-3v10m-3-3 3 3 3-3"/></svg>', 'Data &amp; exports', 'Backup or restore')
        + item('/?menu=planning', '◇', 'Planning room', 'Score projects together') : '')
      + (user.role === 'admin' || (user.role === 'team_manager' && user.teamIds?.length)
        ? item('/?menu=add-project', '+', 'Add project', 'Create new work') : '')
      + '<button class="app-menu-item" id="menu-sign-out" type="button"><span aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M7 2H2v12h5m-1-6h8m-3-3 3 3-3 3"/></svg></span><strong>Sign out</strong><small>End this session</small></button>';
    panel.querySelector('#menu-sign-out').addEventListener('click', async () => {
      const result = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
      if (result.ok) location.replace('/login.html');
    });
  }

  const current = panel.querySelector(`a[href="${location.pathname}"]`);
  current?.setAttribute('aria-current', 'page');
}
