'use strict';
const path = require('node:path');
const express = require('express');
const { openDatabase } = require('./db');
const { createProgress } = require('./services/progress');
const { CONCEPTS } = require('./engine/concepts');

function createApp(options = {}) {
  const db = options.db || openDatabase(options.dbPath);
  const progress = createProgress(db);

  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.locals.db = db;
  app.locals.progress = progress;
  app.locals.concepts = CONCEPTS;

  app.use(express.urlencoded({ extended: false }));
  app.use(express.json({ limit: '200kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Values every view needs.
  app.use((req, res, next) => {
    res.locals.path = req.path;
    res.locals.hintTokens = progress.hintTokens();
    next();
  });

  app.use('/', require('./routes/index'));
  app.use('/wizard', require('./routes/wizard'));
  app.use('/projects', require('./routes/projects'));
  app.use('/concepts', require('./routes/quiz'));

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
