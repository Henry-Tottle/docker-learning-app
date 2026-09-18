'use strict';
const express = require('express');
const { getConcept, gradeQuiz } = require('../engine/concepts');

const router = express.Router();

function loadConcept(req, res, next) {
  const concept = getConcept(req.params.key);
  if (!concept) return res.status(404).render('error', { title: 'No such concept', message: `There is no concept called "${req.params.key}".` });
  req.concept = concept;
  next();
}

router.get('/:key', loadConcept, (req, res) => {
  const { progress } = req.app.locals;
  const status = progress.conceptStatus(req.concept.key);
  const back = typeof req.query.back === 'string' && req.query.back.startsWith('/') ? req.query.back : null;
  res.render('quiz', { title: `Quiz: ${req.concept.title}`, concept: req.concept, status, attempts: progress.quizAttempts(req.concept.key), grade: null, chosen: [], back });
});

router.post('/:key/quiz', loadConcept, (req, res) => {
  const { progress } = req.app.locals;
  const status = progress.conceptStatus(req.concept.key);
  const back = typeof req.body.back === 'string' && req.body.back.startsWith('/') ? req.body.back : null;
  if (status === 'locked') {
    return res.status(403).render('quiz', { title: `Quiz: ${req.concept.title}`, concept: req.concept, status, attempts: [], grade: null, chosen: [], back, locked: true });
  }
  const chosen = req.concept.quiz.map((_, i) => {
    const v = req.body[`q${i}`];
    return v === undefined ? -1 : Number(v);
  });
  const grade = gradeQuiz(req.concept, chosen);
  const { tokensEarned } = progress.recordQuiz(req.concept.key, grade, chosen);
  res.locals.hintTokens = progress.hintTokens();
  res.render('quiz', { title: `Quiz: ${req.concept.title}`, concept: req.concept, status: progress.conceptStatus(req.concept.key), attempts: progress.quizAttempts(req.concept.key), grade, chosen, tokensEarned, back });
});

module.exports = router;
