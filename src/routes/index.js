'use strict';
const express = require('express');
const { USES } = require('../content/uses');
const { selfWalkthrough } = require('../content/self');

const router = express.Router();

router.get('/', (req, res) => {
  const { progress } = req.app.locals;
  const projects = progress.listProjects().map((p) => ({ ...p, summary: progress.projectSummary(p) }));
  res.render('home', { title: 'Docker, explained as you build', projects, overview: progress.overview() });
});

router.get('/healthz', (req, res) => {
  // Used by the Dockerfile HEALTHCHECK. Touches the DB so a broken volume shows up.
  req.app.locals.db.prepare('SELECT 1').get();
  res.json({ ok: true });
});

router.get('/uses', (req, res) => {
  res.render('uses', { title: 'What would you use Docker for?', uses: USES });
});

router.get('/dashboard', (req, res) => {
  const { progress } = req.app.locals;
  const projects = progress.listProjects().map((p) => ({ ...p, summary: progress.projectSummary(p) }));
  res.render('dashboard', { title: 'Progress', overview: progress.overview(), projects });
});

router.get('/how-this-app-was-containerized', (req, res) => {
  const walkthrough = selfWalkthrough();
  res.render('self', { title: 'How this app was containerized', walkthrough });
});

module.exports = router;
