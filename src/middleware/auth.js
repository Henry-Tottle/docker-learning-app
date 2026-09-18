'use strict';
// Request-level auth: reads the session cookie, exposes req.user, and guards
// routes. Also a same-origin check for state-changing requests.
const COOKIE = 'dla_session';

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieOptions(req, maxAgeSeconds) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,           // true behind Railway's TLS (trust proxy), false on plain http locally
    path: '/',
    maxAge: maxAgeSeconds * 1000,
  };
}

function sessionMiddleware(auth, progressFactory) {
  return (req, res, next) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const user = auth.userForSession(token);
    req.sessionToken = token || null;
    req.user = user;
    res.locals.user = user;
    req.progress = user ? progressFactory.forUser(user.id) : null;
    res.locals.hintTokens = req.progress ? req.progress.hintTokens() : null;
    next();
  };
}

function setSessionCookie(req, res, token, days) {
  res.cookie(COOKIE, token, cookieOptions(req, days * 24 * 3600));
}
function clearSessionCookie(req, res) {
  res.clearCookie(COOKIE, { path: '/' });
}

function wantsJson(req) {
  return (req.headers.accept || '').includes('application/json') || req.is('application/json');
}

function requireLogin(req, res, next) {
  if (req.user) return next();
  if (wantsJson(req)) return res.status(401).json({ error: 'login-required' });
  const back = encodeURIComponent(req.originalUrl);
  res.redirect(`/login?next=${back}`);
}

function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  if (!req.user) return requireLogin(req, res, next);
  res.status(403).render('error', { title: 'Admins only', message: 'That page is for administrators.' });
}

// Reject cross-site POSTs even if a cookie somehow came along. Browsers send
// Origin on every POST; when present it must match the Host we were reached on.
function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null);
  if (!origin) return next();
  let host;
  try { host = new URL(origin).host; } catch { host = null; }
  if (host && host === req.headers.host) return next();
  if (wantsJson(req)) return res.status(403).json({ error: 'cross-origin request rejected' });
  res.status(403).render('error', { title: 'Rejected', message: 'This request came from a different site.' });
}

module.exports = { sessionMiddleware, setSessionCookie, clearSessionCookie, requireLogin, requireAdmin, sameOrigin, COOKIE };
