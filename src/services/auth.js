'use strict';
// Authentication and account management. Built on node:crypto only:
// scrypt for password hashing, random tokens for sessions.
const crypto = require('node:crypto');

const SESSION_DAYS = 30;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{2,31}$/i;
const MIN_PASSWORD = 8;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [scheme, n, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, { ...SCRYPT, N: Number(n) });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

const tokenId = (token) => crypto.createHash('sha256').update(token).digest('hex');

// Very small in-memory login limiter: N failures per key per window.
function createLimiter({ max = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const hits = new Map();
  return {
    blocked(key) {
      const h = hits.get(key);
      if (!h) return false;
      if (Date.now() - h.first > windowMs) { hits.delete(key); return false; }
      return h.count >= max;
    },
    fail(key) {
      const h = hits.get(key);
      if (!h || Date.now() - h.first > windowMs) hits.set(key, { first: Date.now(), count: 1 });
      else h.count++;
    },
    reset(key) { hits.delete(key); },
  };
}

function createAuth(db, options = {}) {
  const env = options.env || process.env;
  const q = {
    userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
    userById: db.prepare('SELECT id, username, role, hint_tokens, created_at, last_login_at FROM users WHERE id = ?'),
    userCount: db.prepare('SELECT COUNT(*) AS n FROM users'),
    insertUser: db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)'),
    touchLogin: db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?"),
    setPassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
    setRole: db.prepare('UPDATE users SET role = ? WHERE id = ?'),
    deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
    listUsers: db.prepare(`
      SELECT u.id, u.username, u.role, u.created_at, u.last_login_at,
             (SELECT COUNT(*) FROM projects p WHERE p.user_id = u.id) AS projects,
             (SELECT COUNT(*) FROM concept_progress c WHERE c.user_id = u.id AND c.status = 'mastered') AS mastered
      FROM users u ORDER BY u.id`),

    insertSession: db.prepare("INSERT INTO sessions (id, user_id, expires_at, user_agent) VALUES (?, ?, datetime('now', ?), ?)"),
    sessionUser: db.prepare(`
      SELECT u.id, u.username, u.role, u.hint_tokens FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > datetime('now')`),
    deleteSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
    deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    purgeExpired: db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')"),

    claimProjects: db.prepare('UPDATE projects SET user_id = ? WHERE user_id = 0'),
    claimAttempts: db.prepare('UPDATE quiz_attempts SET user_id = ? WHERE user_id = 0'),
    claimConcepts: db.prepare('UPDATE OR IGNORE concept_progress SET user_id = ? WHERE user_id = 0'),
    setTokens: db.prepare('UPDATE users SET hint_tokens = ? WHERE id = ?'),
  };
  const limiter = createLimiter();

  function registrationMode() {
    const mode = String(env.REGISTRATION_MODE || 'open').toLowerCase();
    return ['open', 'invite', 'closed'].includes(mode) ? mode : 'open';
  }
  function userCount() { return q.userCount.get().n; }

  // Returns { ok, error } describing whether a registration may proceed.
  function canRegister(inviteCode) {
    const mode = registrationMode();
    const first = userCount() === 0;
    if (mode === 'invite') {
      const expected = String(env.INVITE_CODE || '');
      if (!expected) return { ok: false, error: 'Registration needs an invite code, but the server has none configured (INVITE_CODE).' };
      const given = String(inviteCode || '');
      const same = given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
      return same ? { ok: true } : { ok: false, error: 'That invite code is not right.' };
    }
    if (mode === 'closed' && !first) return { ok: false, error: 'Registration is closed on this server.' };
    return { ok: true };
  }

  function validate(username, password) {
    const errors = [];
    if (!USERNAME_RE.test(username || '')) errors.push('Username: 3-32 characters, letters, digits, _ or -, starting with a letter or digit.');
    if (String(password || '').length < MIN_PASSWORD) errors.push(`Password: at least ${MIN_PASSWORD} characters.`);
    return errors;
  }

  // The first account becomes admin and adopts any data from before accounts existed.
  const createUser = db.transaction((username, password, roleOverride) => {
    const first = userCount() === 0;
    const role = roleOverride || (first ? 'admin' : 'user');
    const info = q.insertUser.run(username, hashPassword(password), role);
    const id = Number(info.lastInsertRowid);
    if (first) claimLegacyData(id);
    return q.userById.get(id);
  });

  function claimLegacyData(userId) {
    q.claimProjects.run(userId);
    q.claimAttempts.run(userId);
    q.claimConcepts.run(userId);
    // The settings table only exists in databases migrated from v0, so it is
    // looked up here rather than prepared at startup.
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'").get()) {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'hint_tokens'").get();
      if (row) q.setTokens.run(Number(row.value), userId);
      db.exec('DROP TABLE settings');
    }
  }

  function register(username, password, inviteCode) {
    const errors = validate(username, password);
    if (errors.length) return { errors };
    const gate = canRegister(inviteCode);
    if (!gate.ok) return { errors: [gate.error] };
    if (q.userByName.get(username)) return { errors: ['That username is taken.'] };
    return { user: createUser(username, password) };
  }

  function login(username, password, key) {
    if (limiter.blocked(key)) return { error: 'Too many failed attempts. Wait fifteen minutes and try again.' };
    const row = q.userByName.get(String(username || ''));
    // Always run the hash so timing does not reveal whether the user exists.
    const ok = row ? verifyPassword(String(password || ''), row.password_hash) : (verifyPassword('x', DUMMY_HASH), false);
    if (!ok) { limiter.fail(key); return { error: 'Wrong username or password.' }; }
    limiter.reset(key);
    q.touchLogin.run(row.id);
    return { user: q.userById.get(row.id) };
  }

  function createSession(userId, userAgent) {
    q.purgeExpired.run();
    const token = crypto.randomBytes(32).toString('base64url');
    q.insertSession.run(tokenId(token), userId, `+${SESSION_DAYS} days`, String(userAgent || '').slice(0, 200));
    return token;
  }
  function userForSession(token) {
    if (!token) return null;
    return q.sessionUser.get(tokenId(token)) || null;
  }
  function destroySession(token) { if (token) q.deleteSession.run(tokenId(token)); }

  function changePassword(userId, current, next) {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!row || !verifyPassword(String(current || ''), row.password_hash)) return { error: 'Current password is wrong.' };
    if (String(next || '').length < MIN_PASSWORD) return { error: `New password: at least ${MIN_PASSWORD} characters.` };
    q.setPassword.run(hashPassword(next), userId);
    q.deleteUserSessions.run(userId); // log out every other device
    return { ok: true };
  }

  function listUsers() { return q.listUsers.all(); }
  function getUser(id) { return q.userById.get(id) || null; }
  function setRole(id, role) {
    if (!['user', 'admin'].includes(role)) return { error: 'Unknown role.' };
    const admins = listUsers().filter((u) => u.role === 'admin');
    if (role === 'user' && admins.length === 1 && admins[0].id === Number(id)) return { error: 'Cannot demote the only admin.' };
    q.setRole.run(role, id);
    return { ok: true };
  }
  function deleteUser(id) {
    const admins = listUsers().filter((u) => u.role === 'admin');
    if (admins.length === 1 && admins[0].id === Number(id)) return { error: 'Cannot delete the only admin.' };
    q.deleteUser.run(id);
    return { ok: true };
  }

  return { registrationMode, userCount, canRegister, register, login, createSession, userForSession, destroySession, changePassword, listUsers, getUser, setRole, deleteUser, SESSION_DAYS };
}

const DUMMY_HASH = hashPassword('dummy-password-for-constant-time');

module.exports = { createAuth, hashPassword, verifyPassword, USERNAME_RE, MIN_PASSWORD };
