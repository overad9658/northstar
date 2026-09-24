import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SESSION_DAYS = 7;

export class AuthError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function cleanUsername(value) {
  const username = String(value || '').trim();
  if (!/^[A-Za-z0-9._@-]{3,80}$/.test(username)) throw new AuthError(400, 'Username must be 3–80 letters, numbers, or . _ @ - characters.');
  return username;
}

function passwordHash(password) {
  const value = String(password || '');
  if (value.length < 10 || value.length > 200) throw new AuthError(400, 'Password must be between 10 and 200 characters.');
  const salt = randomBytes(16);
  return `scrypt:${salt.toString('hex')}:${scryptSync(value, salt, 64).toString('hex')}`;
}

function verifyPassword(password, encoded) {
  const [, saltHex, hashHex] = String(encoded).split(':');
  if (!saltHex || !hashHex) return false;
  const supplied = scryptSync(String(password || ''), Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function cookieValue(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return '';
}

function publicUser(row) {
  return row && { id: row.id, username: row.username, role: row.role, createdAt: row.created_at };
}

export function createAuthService(db, { disabled = process.env.AUTH_DISABLED === 'true' } = {}) {
  const sessionSeconds = SESSION_DAYS * 24 * 60 * 60;

  function usersCount() { return db.prepare('SELECT COUNT(*) AS count FROM users').get().count; }
  function userForRequest(req) {
    if (disabled) return { id: 0, username: 'development', role: 'admin', createdAt: null };
    const token = cookieValue(req, 'northstar_session');
    if (!token) return null;
    const row = db.prepare(`
      SELECT u.* FROM auth_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > CURRENT_TIMESTAMP
    `).get(token);
    return publicUser(row);
  }
  function setSession(res, userId, req) {
    const token = randomBytes(32).toString('base64url');
    db.prepare("INSERT INTO auth_sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', ?))")
      .run(token, userId, `+${sessionSeconds} seconds`);
    const secure = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
    res.setHeader('set-cookie', `northstar_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionSeconds}${secure ? '; Secure' : ''}`);
  }
  function clearSession(req, res) {
    const token = cookieValue(req, 'northstar_session');
    if (token) db.prepare('DELETE FROM auth_sessions WHERE token = ?').run(token);
    res.setHeader('set-cookie', 'northstar_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  }
  function createUser(input, setup = false) {
    const username = cleanUsername(input.username);
    const role = setup ? 'admin' : String(input.role || 'read_only');
    if (!['admin', 'read_only'].includes(role)) throw new AuthError(400, 'Role must be admin or read_only.');
    try {
      const result = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
        .run(username, passwordHash(input.password), role);
      return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid));
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) throw new AuthError(409, 'That username is already in use.');
      throw error;
    }
  }

  return {
    disabled,
    setupRequired: () => !disabled && usersCount() === 0,
    userForRequest,
    setup(input, req, res) {
      if (disabled || usersCount()) throw new AuthError(409, 'Initial setup is already complete.');
      const user = createUser(input, true); setSession(res, user.id, req); return user;
    },
    login(input, req, res) {
      const row = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(String(input.username || '').trim());
      if (!row || !verifyPassword(input.password, row.password_hash)) throw new AuthError(401, 'Invalid username or password.');
      db.prepare('DELETE FROM auth_sessions WHERE expires_at <= CURRENT_TIMESTAMP').run();
      setSession(res, row.id, req); return publicUser(row);
    },
    logout: clearSession,
    listUsers: () => db.prepare('SELECT id, username, role, created_at AS createdAt FROM users ORDER BY username COLLATE NOCASE').all(),
    createUser,
    updateUser(id, input, currentUser) {
      const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      if (!row) throw new AuthError(404, 'User not found.');
      const username = input.username === undefined ? row.username : cleanUsername(input.username);
      const role = input.role === undefined ? row.role : String(input.role);
      if (!['admin', 'read_only'].includes(role)) throw new AuthError(400, 'Role must be admin or read_only.');
      if (row.role === 'admin' && role !== 'admin' && db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get().count === 1) throw new AuthError(409, 'At least one admin must remain.');
      const hash = input.password ? passwordHash(input.password) : row.password_hash;
      try { db.prepare('UPDATE users SET username = ?, role = ?, password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(username, role, hash, id); }
      catch (error) { if (String(error.message).includes('UNIQUE')) throw new AuthError(409, 'That username is already in use.'); throw error; }
      return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
    },
    deleteUser(id, currentUser) {
      if (id === currentUser.id) throw new AuthError(409, 'You cannot delete your own account.');
      const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      if (!row) throw new AuthError(404, 'User not found.');
      if (row.role === 'admin' && db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get().count === 1) throw new AuthError(409, 'At least one admin must remain.');
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
    },
  };
}
