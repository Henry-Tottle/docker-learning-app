'use strict';
const express = require('express');
const { APP_TYPES, DATABASES, TARGETS, generate } = require('../engine/generator');

const router = express.Router();

router.get('/', (req, res) => {
  res.render('wizard', { title: 'Describe your project', appTypes: APP_TYPES, databases: DATABASES, targets: TARGETS, values: { name: '', appType: 'node', database: 'none', target: 'dev' }, errors: [] });
});

router.post('/', (req, res) => {
  const { progress } = req.app.locals;
  const values = {
    name: String(req.body.name || '').trim(),
    appType: req.body.appType,
    database: req.body.database,
    target: req.body.target,
  };
  const errors = [];
  if (!values.name) errors.push('Give the project a name, even just "my api".');
  if (!APP_TYPES.some((t) => t.key === values.appType)) errors.push('Pick an app type.');
  if (!DATABASES.some((d) => d.key === values.database)) errors.push('Pick a database option.');
  if (!TARGETS.some((t) => t.key === values.target)) errors.push('Pick dev or production.');
  if (errors.length) {
    return res.status(400).render('wizard', { title: 'Describe your project', appTypes: APP_TYPES, databases: DATABASES, targets: TARGETS, values, errors });
  }
  const project = progress.createProject(values.name, values);
  res.redirect(`/projects/${project.id}`);
});

// Live preview used by the wizard page: what files would this produce?
router.get('/preview', (req, res) => {
  const g = generate(req.query);
  res.json({ answers: g.answers, concepts: g.concepts, files: g.files.map((f) => ({ name: f.name, lines: f.lines.length })) });
});

module.exports = router;
