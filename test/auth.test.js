'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { openDatabase, CURRENT_VERSION } = require('../src/db');
const { hashPassword, verifyPassword } = require('../src/services/auth');
const { startApp } = require('./helpers');

test('password hashing round-trips and rejects wrong passwords', () => {
  const h = hashPassword('hunter22hunter');
  assert.match(h, /^scrypt\$/);
  assert.equal(verifyPassword('hunter22hunter', h), true);
  assert.equal(verifyPassword('hunter22hunteR', h), false);
  assert.notEqual(hashPassword('hunter22hunter'), h, 'salted');
});

test('first account is admin, later ones are users; validation and duplicates are enforced', async () => {
  const t = await startApp();
  try {
    const a = t.client();
    assert.equal((await a.register('ab', 'short')).status, 400);
    assert.equal((await a.register('alice')).status, 302);
    assert.ok(a.cookie, 'session cookie set');
    assert.match(await (await a.get('/account')).text(), /alice.*admin/s);
    assert.equal((await a.get('/admin/users')).status, 200);

    const b = t.client();
    assert.equal((await b.register('ALICE')).status, 400, 'usernames are case-insensitive');
    assert.equal((await b.register('bob')).status, 302);
    assert.match(await (await b.get('/account')).text(), /bob.*user/s);
    assert.equal((await b.get('/admin/users')).status, 403);
    assert.equal((await b.form('/admin/users/1/role', { role: 'user' })).status, 403);
  } finally { t.close(); }
});

test('login, logout, wrong password, and rate limiting', async () => {
  const t = await startApp();
  try {
    const a = t.client();
    await a.register('alice');
    await a.form('/logout', {});
    assert.equal(a.cookie, '', 'cookie cleared');
    assert.equal((await a.get('/dashboard')).status, 302);

    assert.equal((await a.login('alice', 'wrong-password')).status, 401);
    assert.equal((await a.login('nobody', 'whatever')).status, 401);
    assert.equal((await a.login('alice')).status, 302);
    assert.equal((await a.get('/dashboard')).status, 200);

    const b = t.client();
    for (let i = 0; i < 10; i++) await b.login('alice', 'nope-nope-nope');
    const blocked = await b.login('alice');
    assert.equal(blocked.status, 401);
    assert.match(await blocked.text(), /Too many failed attempts/);
  } finally { t.close(); }
});

test('projects and progress are private to their owner', async () => {
  const t = await startApp();
  try {
    const a = t.client(); await a.register('alice');
    const b = t.client(); await b.register('bob');
    const created = await a.form('/wizard', { name: 'secret', appType: 'node', database: 'none', target: 'dev' });
    const p = new URL(created.headers.get('location'), t.base).pathname;
    assert.equal((await a.get(p)).status, 200);
    assert.equal((await b.get(p)).status, 404, 'other users cannot see it');
    assert.equal((await b.json(p + '/guided/viewed', { lineId: 'df-base' })).status, 404);
    assert.equal((await b.form(p + '/delete', {})).status, 404);
    assert.equal((await a.get(p)).status, 200, 'still there');

    // Concept mastery is per user: alice viewing an explanation unlocks nothing for bob.
    await a.json(p + '/guided/viewed', { lineId: 'df-base' });
    assert.match(await (await a.get('/concepts/base-images')).text(), /Check answers/);
    assert.match(await (await b.get('/concepts/base-images')).text(), /This quiz is locked/);
  } finally { t.close(); }
});

test('registration modes: invite and closed', async () => {
  const inv = await startApp({ env: { REGISTRATION_MODE: 'invite', INVITE_CODE: 'let-me-in' } });
  try {
    const c = inv.client();
    assert.equal((await c.register('alice', undefined, 'wrong')).status, 400, 'even the first user needs the code');
    assert.equal((await c.register('alice', undefined, 'let-me-in')).status, 302);
  } finally { inv.close(); }

  const closed = await startApp({ env: { REGISTRATION_MODE: 'closed' } });
  try {
    const c = closed.client();
    assert.equal((await c.register('alice')).status, 302, 'bootstrap: first account allowed');
    const d = closed.client();
    assert.equal((await d.register('bob')).status, 400);
    assert.match(await (await d.get('/')).text(), /Log in to start/);
  } finally { closed.close(); }
});

test('cross-site POSTs are rejected', async () => {
  const t = await startApp();
  try {
    const c = t.client();
    await c.register('alice');
    const r = await c.form('/wizard', { name: 'x', appType: 'node', database: 'none', target: 'dev' }, { Origin: 'https://evil.example' });
    assert.equal(r.status, 403);
    const ok = await c.form('/wizard', { name: 'x', appType: 'node', database: 'none', target: 'dev' }, { Origin: 'http://' + new URL(t.base).host });
    assert.equal(ok.status, 302);
  } finally { t.close(); }
});

test('admin can change roles and delete users, but not remove the last admin', async () => {
  const t = await startApp();
  try {
    const a = t.client(); await a.register('alice');
    const b = t.client(); await b.register('bob');
    let r = await a.form('/admin/users/1/role', { role: 'user' });
    assert.match(decodeURIComponent(r.headers.get('location')), /only admin/);
    r = await a.form('/admin/users/2/role', { role: 'admin' });
    assert.match(decodeURIComponent(r.headers.get('location')), /Role updated/);
    assert.equal((await b.get('/admin/users')).status, 200, 'bob is admin now');
    r = await a.form('/admin/users/2/delete', {});
    assert.match(decodeURIComponent(r.headers.get('location')), /deleted/);
    assert.equal((await b.get('/dashboard')).status, 302, 'bob session gone');
  } finally { t.close(); }
});

test('changing password logs out other sessions', async () => {
  const t = await startApp();
  try {
    const a = t.client(); await a.register('alice');
    const other = t.client(); await other.login('alice');
    assert.equal((await other.get('/dashboard')).status, 200);
    assert.equal((await a.form('/account/password', { current: 'wrong', next: 'new-password-1' })).status, 400);
    assert.equal((await a.form('/account/password', { current: 'correct horse battery', next: 'new-password-1' })).status, 200);
    assert.equal((await a.get('/dashboard')).status, 200, 'this device re-issued');
    assert.equal((await other.get('/dashboard')).status, 302, 'other device out');
    const again = t.client();
    assert.equal((await again.login('alice', 'new-password-1')).status, 302);
  } finally { t.close(); }
});

test('a pre-accounts (v0) database migrates and its data goes to the first account', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dla-')), 'v0.db');
  const v0 = new Database(file);
  v0.exec(`
    CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, app_type TEXT NOT NULL, database TEXT NOT NULL, target TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE explanation_views (project_id INTEGER NOT NULL, line_id TEXT NOT NULL, viewed_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (project_id, line_id));
    CREATE TABLE concept_progress (concept TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'unlocked', best_score INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, mastered_at TEXT);
    CREATE TABLE quiz_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, concept TEXT NOT NULL, score INTEGER NOT NULL, total INTEGER NOT NULL, passed INTEGER NOT NULL, answers TEXT NOT NULL, taken_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE blank_progress (project_id INTEGER NOT NULL, blank_id TEXT NOT NULL, correct INTEGER NOT NULL DEFAULT 0, hint_shown INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (project_id, blank_id));
    CREATE TABLE free_build_submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, dockerfile TEXT NOT NULL, compose TEXT NOT NULL, dockerignore TEXT NOT NULL, errors INTEGER NOT NULL, warnings INTEGER NOT NULL, report TEXT NOT NULL, submitted_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO settings VALUES ('hint_tokens', '7');
    INSERT INTO projects (name, app_type, database, target) VALUES ('old one', 'django', 'postgres', 'dev');
    INSERT INTO concept_progress (concept, status, best_score, attempts) VALUES ('layer-caching', 'mastered', 2, 1);
    INSERT INTO quiz_attempts (concept, score, total, passed, answers) VALUES ('layer-caching', 2, 2, 1, '[1,1]');
    INSERT INTO explanation_views (project_id, line_id) VALUES (1, 'df-base');
    INSERT INTO blank_progress (project_id, blank_id, correct, attempts) VALUES (1, 'df-base', 1, 1);
  `);
  v0.close();

  const db = openDatabase(file);
  assert.equal(db.pragma('user_version', { simple: true }), CURRENT_VERSION);
  assert.equal(db.prepare('SELECT start FROM projects').get().start, 'existing', 'v2 column added with its default');
  const t = await startApp({ db });
  try {
    const a = t.client();
    assert.match(await (await a.get('/register')).text(), /First account/);
    await a.register('alice');
    const home = await (await a.get('/')).text();
    assert.match(home, /old one/);
    assert.match(await (await a.get('/dashboard')).text(), /7 hint tokens/);
    assert.match(await (await a.get('/concepts/layer-caching')).text(), /Already mastered/);
    assert.equal(db.prepare('SELECT user_id FROM projects').get().user_id, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM explanation_views').get().n, 1, 'child rows survived the rebuild');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM blank_progress').get().n, 1);
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1, 'foreign keys back on');
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'settings'").get(), undefined, 'settings table retired');
    const b = t.client(); await b.register('bob');
    assert.doesNotMatch(await (await b.get('/')).text(), /old one/);
  } finally { t.close(); db.close(); fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
});

test('admin-issued reset code: one use, one hour, revokes sessions, generic failure', async () => {
  const t = await startApp();
  try {
    const a = t.client(); await a.register('alice');
    const b = t.client(); await b.register('bob');
    const bOther = t.client(); await bOther.login('bob');

    // Only admins can issue codes.
    assert.equal((await b.form('/admin/users/1/reset', {})).status, 403);

    const issued = await a.form('/admin/users/2/reset', {});
    assert.equal(issued.status, 200);
    const html = await issued.text();
    const code = (html.match(/id="reset-code">([A-Z2-9-]{19})</) || [])[1];
    assert.ok(code, 'code shown once on the page');
    assert.match(html, /reset pending/);
    assert.equal(t.app.locals.db.prepare('SELECT COUNT(*) AS n FROM password_resets WHERE code_hash = ?').get(code).n, 0, 'plain code is not stored');

    // Wrong code and wrong user are the same generic error; the reset page is public.
    const r = t.client();
    assert.equal((await r.get('/reset')).status, 200);
    const bad = await r.form('/reset', { username: 'bob', code: 'AAAA-BBBB-CCCC-DDDD', password: 'brand-new-password' });
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /not valid for that username, or it has expired/);
    const wrongUser = await r.form('/reset', { username: 'alice', code, password: 'brand-new-password' });
    assert.equal(wrongUser.status, 400);
    assert.equal((await r.form('/reset', { username: 'bob', code, password: 'short' })).status, 400, 'password rules apply');

    // Right code, lower-case with spaces: normalised.
    const ok = await r.form('/reset', { username: 'BOB', code: code.toLowerCase().replace(/-/g, ' '), password: 'brand-new-password' });
    assert.equal(ok.status, 302);
    assert.match(ok.headers.get('location'), /reset=1/);
    assert.equal((await bOther.get('/dashboard')).status, 302, 'old sessions revoked');
    assert.equal((await r.login('bob', 'correct horse battery')).status, 401, 'old password gone');
    assert.equal((await r.login('bob', 'brand-new-password')).status, 302);
    assert.equal((await t.client().form('/reset', { username: 'bob', code, password: 'another-new-password' })).status, 400, 'single use');

    // Expiry: issue, then age the row.
    await a.form('/admin/users/2/reset', {});
    t.app.locals.db.prepare("UPDATE password_resets SET expires_at = datetime('now', '-1 minute') WHERE user_id = 2 AND used_at IS NULL").run();
    const expired = await t.client().form('/reset', { username: 'bob', code: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ', password: 'yet-another-password' });
    assert.equal(expired.status, 400);

    // Reset attempts are rate limited like logins.
    const spam = t.client();
    for (let i = 0; i < 10; i++) await spam.form('/reset', { username: 'bob', code: 'AAAA-AAAA-AAAA-AAAA', password: 'whatever-password' });
    assert.match(await (await spam.form('/reset', { username: 'bob', code: 'AAAA-AAAA-AAAA-AAAA', password: 'whatever-password' })).text(), /Too many failed attempts/);
  } finally { t.close(); }
});

test('older, cheaper scrypt hashes are upgraded on login', async () => {
  const { SCRYPT } = require('../src/services/auth');
  const t = await startApp();
  try {
    const db = t.app.locals.db;
    const crypto = require('node:crypto');
    const salt = crypto.randomBytes(16);
    const old = crypto.scryptSync('legacy-password', salt, 64, { N: 16384, r: 8, p: 1 });
    db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('old', ?, 'user')").run(`scrypt$16384$${salt.toString('base64')}$${old.toString('base64')}`);
    const c = t.client();
    assert.equal((await c.login('old', 'wrong-password-here')).status, 401);
    assert.match(db.prepare("SELECT password_hash FROM users WHERE username = 'old'").get().password_hash, /^scrypt\$16384\$/, 'untouched after a failed login');
    assert.equal((await c.login('old', 'legacy-password')).status, 302);
    assert.match(db.prepare("SELECT password_hash FROM users WHERE username = 'old'").get().password_hash, new RegExp(`^scrypt\\$${SCRYPT.N}\\$`), 'rehashed at the current cost');
    assert.equal((await c.get('/dashboard')).status, 200, 'session from that login still valid');
    assert.equal((await t.client().login('old', 'legacy-password')).status, 302, 'password unchanged');
  } finally { t.close(); }
});

test('users can delete their own account, but not the last admin', async () => {
  const t = await startApp();
  try {
    const a = t.client(); await a.register('alice');
    const wrong = await a.form('/account/delete', { password: 'nope-nope-nope' });
    assert.equal(wrong.status, 400);
    const last = await a.form('/account/delete', { password: 'correct horse battery' });
    assert.equal(last.status, 400);
    assert.match(await last.text(), /only admin/);

    const b = t.client(); await b.register('bob');
    const created = await b.form('/wizard', { name: 'gone soon', appType: 'node', database: 'none', target: 'dev' });
    assert.equal(created.status, 302);
    const bye = await b.form('/account/delete', { password: 'correct horse battery' });
    assert.equal(bye.status, 302);
    assert.equal(b.cookie, '', 'cookie cleared');
    assert.equal((await t.client().login('bob')).status, 401);
    assert.equal(t.app.locals.db.prepare("SELECT COUNT(*) AS n FROM projects WHERE name = 'gone soon'").get().n, 0, 'projects cascade');
  } finally { t.close(); }
});

test('security headers are set and no page ships inline scripts', async () => {
  const t = await startApp();
  try {
    const c = t.client(); await c.register('alice');
    const created = await c.form('/wizard', { name: 'p', appType: 'django', database: 'postgres', target: 'prod' });
    const p = new URL(created.headers.get('location'), t.base).pathname;
    for (const path of ['/', '/account', p, p + '/guided', p + '/scaffold', p + '/free', '/admin/users', '/how-this-app-was-containerized']) {
      const r = await c.get(path);
      assert.equal(r.status, 200, path);
      assert.match(r.headers.get('content-security-policy'), /script-src 'self';/);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      const html = await r.text();
      const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
      for (const [, attrs, body] of scripts) {
        if (/src=/.test(attrs)) continue;
        assert.match(attrs, /type="application\/json"/, `${path} has an executable inline script`);
        assert.ok(!body.includes('</'), `${path} JSON block contains an unescaped closing tag`);
      }
      assert.ok(!/\son(click|submit|change|load)=/.test(html), `${path} has an inline event handler`);
    }
  } finally { t.close(); }
});
