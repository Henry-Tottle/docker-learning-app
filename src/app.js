'use strict';
const path = require('node:path');
const express = require('express');
const { openDatabase } = require('./db');
const { createProgress } = require('./services/progress');
const { createAuth } = require('./services/auth');
const { CONCEPTS } = require('./engine/concepts');
const { sessionMiddleware, sameOrigin, requireLogin, requireAdmin } = require('./middleware/auth');

function createApp(options = {}) {
  const env = options.env || process.env;
  const db = options.db || openDatabase(options.dbPath);
  const progress = createProgress(db);
  const auth = createAuth(db, { env });

  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  // Behind a TLS-terminating proxy (Railway, most PaaS) X-Forwarded-Proto is
  // what tells us the user is on https, which decides the cookie's Secure flag.
  if (env.TRUST_PROXY) app.set('trust proxy', Number(env.TRUST_PROXY) || 1);
  app.locals.db = db;
  app.locals.auth = auth;
  app.locals.concepts = CONCEPTS;

  // Security headers. The CSP allows no inline scripts: page data reaches
  // client scripts through <script type="application/json"> blocks, which the
  // browser never executes. Inline style attributes (progress bars) are allowed.
  app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });
  // JSON safe to embed in an HTML script block: "<" is escaped so "</script>"
  // inside user data cannot end the block early.
  app.locals.jsonForScript = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

  app.use(express.urlencoded({ extended: false }));
  app.use(express.json({ limit: '200kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use(sessionMiddleware(auth, progress));
  app.use((req, res, next) => {
    res.locals.path = req.path;
    res.locals.registrationMode = auth.registrationMode();
    next();
  });
  app.use(sameOrigin); // after the view locals: it may render the error page

  app.use('/', require('./routes/index'));           // public pages + healthz; dashboard guards itself
  app.use('/', require('./routes/auth'));            // login, register, logout, account, admin
  app.use('/wizard', requireLogin, require('./routes/wizard'));
  app.use('/projects', requireLogin, require('./routes/projects'));
  app.use('/concepts', requireLogin, require('./routes/quiz'));
  app.use('/admin', requireAdmin, require('./routes/admin'));

  app.use((req, res) => {
    res.status(404).render('error', { title: 'Not found', message: `Nothing lives at ${req.path}.` });
  });
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');
    if (wantsJson || req.path.endsWith('.json')) {
      return res.status(500).json({ error: err.message });
    }
    res.status(500).render('error', { title: 'Something broke', message: err.message });
  });

  return app;
}

module.exports = { createApp };
