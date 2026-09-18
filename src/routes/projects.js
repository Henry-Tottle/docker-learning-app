'use strict';
const express = require('express');
const gen = require('../engine/generator');
const { checkBlank } = require('../engine/lines');
const { lint } = require('../engine/linter');
const { CONCEPT_MAP } = require('../engine/concepts');

const router = express.Router();

function loadProject(req, res, next) {
  const id = Number(req.params.id);
  const project = Number.isInteger(id) ? req.app.locals.progress.getProject(id) : null;
  if (!project) return res.status(404).render('error', { title: 'No such project', message: 'That project does not exist (it may have been deleted).' });
  req.project = project;
  next();
}

router.get('/:id', loadProject, (req, res) => {
  const { progress } = req.app.locals;
  const summary = progress.projectSummary(req.project);
  const concepts = req.project.generated.concepts.map((k) => ({ key: k, title: CONCEPT_MAP[k].title, status: progress.conceptStatus(k) }));
  res.render('project', { title: req.project.name, project: req.project, summary, concepts, appTypes: gen.APP_TYPES, databases: gen.DATABASES, targets: gen.TARGETS });
});

router.post('/:id/delete', loadProject, (req, res) => {
  req.app.locals.progress.deleteProject(req.project.id);
  res.redirect('/');
});

// ---- Mode 1: guided build ---------------------------------------------------
router.get('/:id/guided', loadProject, (req, res) => {
  const { progress } = req.app.locals;
  const viewed = progress.viewedIds(req.project.id);
  const status = progress.mode1Status(req.project);
  res.render('guided', { title: `Guided build: ${req.project.name}`, project: req.project, generated: req.project.generated, viewed, status, concepts: CONCEPT_MAP, conceptStatus: (k) => progress.conceptStatus(k) });
});

router.post('/:id/guided/viewed', loadProject, (req, res) => {
  const { progress } = req.app.locals;
  const ok = progress.markViewed(req.project, String(req.body.lineId || ''));
  if (!ok) return res.status(400).json({ error: 'unknown line' });
  const status = progress.mode1Status(req.project);
  const line = gen.findLine(req.project.generated, req.body.lineId);
  res.json({ status, conceptStatus: line.concept ? progress.conceptStatus(line.concept) : null, concept: line.concept });
});

// Download is the "reveal all" the spec talks about: gated on having read every explanation.
router.get('/:id/guided/files/:key', loadProject, (req, res) => {
  const { progress } = req.app.locals;
  const status = progress.mode1Status(req.project);
  if (!status.complete) {
    return res.status(403).render('error', {
      title: 'Not yet',
      message: `You have opened ${status.viewed} of ${status.total} explanations. Read the rest first; the files unlock when every line has been explained once.`,
    });
  }
  const file = req.project.generated.files.find((f) => f.key === req.params.key);
  if (!file) return res.status(404).render('error', { title: 'No such file', message: 'Unknown file key.' });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${file.name}"`);
  res.send(file.text);
});

// ---- Mode 2: scaffold & fill ------------------------------------------------
router.get('/:id/scaffold', loadProject, (req, res) => {
  const { progress } = req.app.locals;
  const status = progress.mode2Status(req.project);
  const byId = Object.fromEntries(status.items.map((i) => [i.id, i]));
  res.render('scaffold', { title: `Scaffold & fill: ${req.project.name}`, project: req.project, generated: req.project.generated, status, byId, concepts: CONCEPT_MAP });
});

router.post('/:id/scaffold/check', loadProject, (req, res) => {
  const { progress } = req.app.locals;
  const line = gen.findLine(req.project.generated, String(req.body.blankId || ''));
  if (!line || !line.blank) return res.status(400).json({ error: 'unknown blank' });
  if (line.concept && progress.conceptStatus(line.concept) !== 'mastered') {
    return res.status(403).json({ error: 'locked', why: `This blank is locked until you pass the "${CONCEPT_MAP[line.concept].title}" quiz.`, concept: line.concept });
  }
  const result = checkBlank(line, req.body.value);
  progress.recordBlankAttempt(req.project.id, line.id, result.correct);
  const status = progress.mode2Status(req.project);
  res.json({ ...result, answer: result.correct ? line.blank.answer : undefined, complete: status.complete, correctCount: status.correct, total: status.total });
});

router.post('/:id/scaffold/hint', loadProject, (req, res) => {
  const { progress } = req.app.locals;
  const line = gen.findLine(req.project.generated, String(req.body.blankId || ''));
  if (!line || !line.blank) return res.status(400).json({ error: 'unknown blank' });
  const prog = progress.blankProgress(req.project.id)[line.id];
  if (prog && prog.hint_shown) return res.json({ hint: line.blank.hint, tokens: progress.hintTokens(), alreadyShown: true });
  if (!progress.spendHintToken()) {
    return res.status(402).json({ error: 'no-tokens', why: `No hint tokens left. Each quiz you pass earns ${progress.HINT_TOKENS_PER_PASS}.`, tokens: 0 });
  }
  progress.markHintShown(req.project.id, line.id);
  res.json({ hint: line.blank.hint, tokens: progress.hintTokens() });
});

// ---- Mode 3: free build ------------------------------------------------------
router.get('/:id/free', loadProject, (req, res) => {
  const { progress } = req.app.locals;
  const status = progress.mode3Status(req.project);
  const latest = status.latest ? { ...status.latest, report: JSON.parse(status.latest.report) } : null;
  res.render('free', { title: `Free build: ${req.project.name}`, project: req.project, status, latest, appTypes: gen.APP_TYPES, databases: gen.DATABASES, targets: gen.TARGETS });
});

router.post('/:id/free/lint', loadProject, (req, res) => {
  const { progress } = req.app.locals;
  const status = progress.mode3Status(req.project);
  if (!status.unlocked) return res.status(403).json({ error: 'locked', missing: status.missing });
  const files = {
    dockerfile: String(req.body.dockerfile || ''),
    compose: String(req.body.compose || ''),
    dockerignore: String(req.body.dockerignore || ''),
  };
  const report = lint(files, req.project.answers);
  const id = progress.saveSubmission(req.project.id, files, report);
  res.json({ id, ...report });
});

router.get('/:id/free/submissions/:sid', loadProject, (req, res) => {
  const sub = req.app.locals.progress.getSubmission(req.project.id, Number(req.params.sid));
  if (!sub) return res.status(404).json({ error: 'not found' });
  res.json({ ...sub, report: JSON.parse(sub.report) });
});

module.exports = router;
