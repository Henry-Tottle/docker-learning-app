'use strict';
// Authentication and account management. Built on node:crypto only:
// scrypt for password hashing, random tokens for sessions and reset codes.
const crypto = require('node:crypto');

const SESSION_DAYS = 30;
const RESET_MINUTES = 60;
// OWASP's recommended scrypt parameters: N=2^17, r=8, p=1. maxmem must exceed
// 128 * N * r bytes (128 MiB here) or Node refuses to run it.
const SCRYPT = { N: 131072, r: 8, p: 1, keylen: 64, maxmem: 256 * 1024 * 1024 };
const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{2,31}$/i;
const MIN_PASSWORD = 8;
// Reset codes use an alphabet without look-alike characters (no 0/O, 1/I/L).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function parseHash(stored) {
  const [scheme, n, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !n || !salt || !hash) return null;
  return { N: Number(n), salt: Buffer.from(salt, 'base64'), hash: Buffer.from(hash, 'base64') };
}

function verifyPassword(password, stored) {
  const p = parseHash(stored);
  if (!p) return false;
  const actual = crypto.scryptSync(password, p.salt, p.hash.length, { ...SCRYPT, N: p.N });
  return actual.length === p.hash.length && crypto.timingSafeEqual(actual, p.hash);
}

// True when a stored hash was made with a lower cost than we use now.
function needsRehash(stored) {
  const p = parseHash(stored);
  return !p || p.N < SCRYPT.N;
}

function generateCode() {
  const bytes = crypto.randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out.match(/.{4}/g).join('-');
}
const normalizeCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Very small in-memory limiter: N failures per key per window.
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
    userFull: db.prepare('SELECT * FROM users WHERE id = ?'),
    userById: db.prepare('SELECT id, username, role, hint_tokens, created_at, last_login_at FROM users WHERE id = ?'),
    userCount: db.prepare('SELECT COUNT(*) AS n FROM users'),
    adminCount: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'"),
    insertUser: db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)'),
    touchLogin: db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?"),
    setPassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
    setRole: db.prepare('UPDATE users SET role = ? WHERE id = ?'),
    deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
    listUsers: db.prepare(`
      SELECT u.id, u.username, u.role, u.created_at, u.last_login_at,
             (SELECT COUNT(*) FROM projects p WHERE p.user_id = u.id) AS projects,
             (SELECT COUNT(*) FROM concept_progress c WHERE c.user_id = u.id AND c.status = 'mastered') AS mastered,
             (SELECT COUNT(*) FROM password_resets r WHERE r.user_id = u.id AND r.used_at IS NULL AND r.expires_at > datetime('now')) AS pending_reset
      FROM users u ORDER BY u.id`),

    insertSession: db.prepare("INSERT INTO sessions (id, user_id, expires_at, user_agent) VALUES (?, ?, datetime('now', ?), ?)"),
    sessionUser: db.prepare(`
      SELECT u.id, u.username, u.role, u.hint_tokens FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > datetime('now')`),
    deleteSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
    deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    purgeExpired: db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')"),

    voidResets: db.prepare("UPDATE password_resets SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL"),
    insertReset: db.prepare("INSERT INTO password_resets (user_id, code_hash, created_by, expires_at) VALUES (?, ?, ?, datetime('now', ?))"),
    liveReset: db.prepare(`
      SELECT r.id, r.code_hash, r.user_id FROM password_resets r JOIN users u ON u.id = r.user_id
      WHERE u.username = ? AND r.used_at IS NULL AND r.expires_at > datetime('now') ORDER BY r.id DESC LIMIT 1`),
    useReset: db.prepare("UPDATE password_resets SET used_at = datetime('now') WHERE id = ?"),

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
  function isLastAdmin(id) {
    const u = q.userFull.get(id);
    return !!u && u.role === 'admin' && q.adminCount.get().n === 1;
  }

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
    // The settings table only exists in databases migrated from v0.
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
    // Upgrade older, cheaper hashes now that we know the password.
    if (needsRehash(row.password_hash)) q.setPassword.run(hashPassword(password), row.id);
    return { user: q.userById.get(row.id) };
  }

  function createSession(userId, userAgent) {
    q.purgeExpired.run();
    const token = crypto.randomBytes(32).toString('base64url');
    q.insertSession.run(sha256(token), userId, `+${SESSION_DAYS} days`, String(userAgent || '').slice(0, 200));
    return token;
  }
  function userForSession(token) {
    if (!token) return null;
    return q.sessionUser.get(sha256(token)) || null;
  }
  function destroySession(token) { if (token) q.deleteSession.run(sha256(token)); }

  function changePassword(userId, current, next) {
    const row = q.userFull.get(userId);
    if (!row || !verifyPassword(String(current || ''), row.password_hash)) return { error: 'Current password is wrong.' };
    if (String(next || '').length < MIN_PASSWORD) return { error: `New password: at least ${MIN_PASSWORD} characters.` };
    q.setPassword.run(hashPassword(next), userId);
    q.deleteUserSessions.run(userId); // log out every other device
    return { ok: true };
  }

  // ---- admin-issued password reset ------------------------------------------
  // Returns the plain code exactly once; only its hash is stored. Any earlier
  // unused code for the same user is voided so there is at most one live code.
  const createResetCode = db.transaction((userId, adminId) => {
    if (!q.userById.get(userId)) return { error: 'No such user.' };
    q.voidResets.run(userId);
    const code = generateCode();
    q.insertReset.run(userId, sha256(normalizeCode(code)), adminId, `+${RESET_MINUTES} minutes`);
    return { code, expiresInMinutes: RESET_MINUTES };
  });

  function resetPassword(username, code, newPassword, key) {
    const GENERIC = 'That code is not valid for that username, or it has expired. Ask an admin for a new one.';
    if (limiter.blocked(key)) return { error: 'Too many failed attempts. Wait fifteen minutes and try again.' };
    if (String(newPassword || '').length < MIN_PASSWORD) return { error: `New password: at least ${MIN_PASSWORD} characters.` };
    const live = q.liveReset.get(String(username || ''));
    const given = Buffer.from(sha256(normalizeCode(code)));
    const ok = !!live && crypto.timingSafeEqual(given, Buffer.from(live.code_hash));
    if (!ok) { limiter.fail(key); return { error: GENERIC }; }
    limiter.reset(key);
    db.transaction(() => {
      q.useReset.run(live.id);
      q.setPassword.run(hashPassword(newPassword), live.user_id);
      q.deleteUserSessions.run(live.user_id);
    })();
    return { ok: true, user: q.userById.get(live.user_id) };
  }

  // ---- account management -------------------------------------------------------
  function listUsers() { return q.listUsers.all(); }
  function getUser(id) { return q.userById.get(id) || null; }
  function setRole(id, role) {
    if (!['user', 'admin'].includes(role)) return { error: 'Unknown role.' };
    if (role === 'user' && isLastAdmin(id)) return { error: 'Cannot demote the only admin.' };
    q.setRole.run(role, id);
    return { ok: true };
  }
  function deleteUser(id) {
    if (isLastAdmin(id)) return { error: 'Cannot delete the only admin.' };
    q.deleteUser.run(id);
    return { ok: true };
  }
  function deleteSelf(userId, password) {
    const row = q.userFull.get(userId);
    if (!row || !verifyPassword(String(password || ''), row.password_hash)) return { error: 'Password is wrong.' };
    if (isLastAdmin(userId)) return { error: 'You are the only admin. Promote someone else first, or delete the deployment instead.' };
    q.deleteUser.run(userId);
    return { ok: true };
  }

  return {
    registrationMode, userCount, canRegister, register, login, createSession, userForSession, destroySession,
    changePassword, createResetCode, resetPassword, listUsers, getUser, setRole, deleteUser, deleteSelf,
    SESSION_DAYS, RESET_MINUTES,
  };
}

const DUMMY_HASH = hashPassword('dummy-password-for-constant-time');

module.exports = { createAuth, hashPassword, verifyPassword, needsRehash, USERNAME_RE, MIN_PASSWORD, SCRYPT };
