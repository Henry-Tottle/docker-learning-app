'use strict';
// All reads and writes of user state, and every gating rule, live here.
// Routes call these functions and render the result; they never decide
// on their own whether something is unlocked.
const { CONCEPTS, CONCEPT_MAP } = require('../engine/concepts');
const gen = require('../engine/generator');

const HINT_TOKENS_START = 3; // matches the INSERT in db.js
const HINT_TOKENS_PER_PASS = 2;

function createProgress(db) {
  const q = {
    insertProject: db.prepare('INSERT INTO projects (name, app_type, database, target) VALUES (?, ?, ?, ?)'),
    getProject: db.prepare('SELECT * FROM projects WHERE id = ?'),
    listProjects: db.prepare('SELECT * FROM projects ORDER BY created_at DESC, id DESC'),
    deleteProject: db.prepare('DELETE FROM projects WHERE id = ?'),

    viewed: db.prepare('SELECT line_id FROM explanation_views WHERE project_id = ?'),
    markViewed: db.prepare('INSERT OR IGNORE INTO explanation_views (project_id, line_id) VALUES (?, ?)'),

    concept: db.prepare('SELECT * FROM concept_progress WHERE concept = ?'),
    concepts: db.prepare('SELECT * FROM concept_progress'),
    unlockConcept: db.prepare("INSERT OR IGNORE INTO concept_progress (concept, status) VALUES (?, 'unlocked')"),
    updateConcept: db.prepare(
      "UPDATE concept_progress SET status = CASE WHEN ? THEN 'mastered' ELSE status END, best_score = MAX(best_score, ?), attempts = attempts + 1, mastered_at = CASE WHEN ? AND mastered_at IS NULL THEN datetime('now') ELSE mastered_at END WHERE concept = ?"
    ),
    insertAttempt: db.prepare('INSERT INTO quiz_attempts (concept, score, total, passed, answers) VALUES (?, ?, ?, ?, ?)'),
    attempts: db.prepare('SELECT * FROM quiz_attempts WHERE concept = ? ORDER BY id DESC'),

    getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
    setSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),

    blanks: db.prepare('SELECT * FROM blank_progress WHERE project_id = ?'),
    upsertBlank: db.prepare(
      'INSERT INTO blank_progress (project_id, blank_id, correct, attempts) VALUES (?, ?, ?, 1) ON CONFLICT(project_id, blank_id) DO UPDATE SET correct = MAX(correct, excluded.correct), attempts = attempts + 1'
    ),
    hintShown: db.prepare(
      'INSERT INTO blank_progress (project_id, blank_id, hint_shown, attempts) VALUES (?, ?, 1, 0) ON CONFLICT(project_id, blank_id) DO UPDATE SET hint_shown = 1'
    ),

    insertSubmission: db.prepare(
      'INSERT INTO free_build_submissions (project_id, dockerfile, compose, dockerignore, errors, warnings, report) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ),
    submissions: db.prepare('SELECT id, errors, warnings, submitted_at FROM free_build_submissions WHERE project_id = ? ORDER BY id DESC'),
    submission: db.prepare('SELECT * FROM free_build_submissions WHERE id = ? AND project_id = ?'),
    latestSubmission: db.prepare('SELECT * FROM free_build_submissions WHERE project_id = ? ORDER BY id DESC LIMIT 1'),
  };

  // ---- projects -----------------------------------------------------------
  function createProject(name, answers) {
    const a = gen.normalizeAnswers(answers);
    const info = q.insertProject.run(name.trim() || 'Untitled project', a.appType, a.database, a.target);
    return getProject(info.lastInsertRowid);
  }
  function getProject(id) {
    const row = q.getProject.get(id);
    return row ? withGenerated(row) : null;
  }
  function listProjects() {
    return q.listProjects.all().map(withGenerated);
  }
  function deleteProject(id) {
    q.deleteProject.run(id);
  }
  function withGenerated(row) {
    const generated = gen.generate({ appType: row.app_type, database: row.database, target: row.target });
    return { ...row, answers: generated.answers, generated };
  }

  // ---- mode 1: explanations ------------------------------------------------
  function viewedIds(projectId) {
    return new Set(q.viewed.all(projectId).map((r) => r.line_id));
  }
  function markViewed(project, lineId) {
    const line = gen.findLine(project.generated, lineId);
    if (!line || !line.explain) return false;
    q.markViewed.run(project.id, lineId);
    // Viewing an explanation is what unlocks the concept's quiz.
    if (line.concept) q.unlockConcept.run(line.concept);
    return true;
  }
  function mode1Status(project) {
    const required = gen.explainableLines(project.generated);
    const viewed = viewedIds(project.id);
    const remaining = required.filter((l) => !viewed.has(l.id));
    return { total: required.length, viewed: required.length - remaining.length, remaining: remaining.map((l) => l.id), complete: remaining.length === 0 };
  }

  // ---- concepts & quizzes ---------------------------------------------------
  function conceptStatus(key) {
    const row = q.concept.get(key);
    if (!row) return 'locked';
    return row.status; // unlocked | mastered
  }
  function conceptRows() {
    const rows = Object.fromEntries(q.concepts.all().map((r) => [r.concept, r]));
    return CONCEPTS.map((c) => {
      const r = rows[c.key];
      return {
        ...c,
        status: r ? r.status : 'locked',
        bestScore: r ? r.best_score : 0,
        attempts: r ? r.attempts : 0,
        masteredAt: r ? r.mastered_at : null,
        total: c.quiz.length,
      };
    });
  }
  function recordQuiz(key, grade, answers) {
    const wasMastered = conceptStatus(key) === 'mastered';
    q.unlockConcept.run(key);
    q.updateConcept.run(grade.passed ? 1 : 0, grade.score, grade.passed ? 1 : 0, key);
    q.insertAttempt.run(key, grade.score, grade.total, grade.passed ? 1 : 0, JSON.stringify(answers));
    let tokensEarned = 0;
    if (grade.passed && !wasMastered) {
      tokensEarned = HINT_TOKENS_PER_PASS;
      addHintTokens(tokensEarned);
    }
    return { tokensEarned };
  }
  function quizAttempts(key) {
    return q.attempts.all(key);
  }

  // ---- hint tokens ----------------------------------------------------------
  function hintTokens() {
    const row = q.getSetting.get('hint_tokens');
    return row ? Number(row.value) : HINT_TOKENS_START;
  }
  function addHintTokens(n) {
    q.setSetting.run('hint_tokens', String(hintTokens() + n));
  }
  function spendHintToken() {
    const t = hintTokens();
    if (t <= 0) return false;
    q.setSetting.run('hint_tokens', String(t - 1));
    return true;
  }

  // ---- mode 2: blanks -------------------------------------------------------
  function blankProgress(projectId) {
    return Object.fromEntries(q.blanks.all(projectId).map((r) => [r.blank_id, r]));
  }
  function recordBlankAttempt(projectId, blankId, correct) {
    q.upsertBlank.run(projectId, blankId, correct ? 1 : 0);
  }
  function markHintShown(projectId, blankId) {
    q.hintShown.run(projectId, blankId);
  }
  // Which blanks may be attempted: those whose concept has been mastered.
  // Surfaced per blank so the user sees exactly which quiz unlocks what.
  function mode2Status(project) {
    const blanks = gen.blankLines(project.generated);
    const prog = blankProgress(project.id);
    const items = blanks.map((l) => {
      const status = l.concept ? conceptStatus(l.concept) : 'mastered';
      const locked = status !== 'mastered';
      const p = prog[l.id];
      return {
        id: l.id,
        concept: l.concept,
        conceptTitle: l.concept ? CONCEPT_MAP[l.concept].title : null,
        locked,
        correct: !!(p && p.correct),
        hintShown: !!(p && p.hint_shown),
        attempts: p ? p.attempts : 0,
      };
    });
    const lockedConcepts = [...new Set(items.filter((i) => i.locked).map((i) => i.concept))];
    return {
      items,
      total: items.length,
      correct: items.filter((i) => i.correct).length,
      locked: items.filter((i) => i.locked).length,
      lockedConcepts: lockedConcepts.map((k) => ({ key: k, title: CONCEPT_MAP[k].title, status: conceptStatus(k) })),
      complete: items.length > 0 && items.every((i) => i.correct),
    };
  }

  // ---- mode 3: free build -----------------------------------------------------
  function mode3Status(project) {
    const required = project.generated.concepts;
    const statuses = required.map((k) => ({ key: k, title: CONCEPT_MAP[k].title, status: conceptStatus(k) }));
    const missing = statuses.filter((s) => s.status !== 'mastered');
    const latest = q.latestSubmission.get(project.id);
    return {
      required: statuses,
      missing,
      unlocked: missing.length === 0,
      submissions: q.submissions.all(project.id),
      latest,
      passed: !!(latest && latest.errors === 0),
    };
  }
  function saveSubmission(projectId, files, report) {
    const info = q.insertSubmission.run(
      projectId,
      files.dockerfile,
      files.compose,
      files.dockerignore,
      report.summary.errors,
      report.summary.warnings,
      JSON.stringify(report)
    );
    return info.lastInsertRowid;
  }
  function getSubmission(projectId, id) {
    return q.submission.get(id, projectId);
  }

  // ---- dashboard --------------------------------------------------------------
  function overview() {
    const concepts = conceptRows();
    const mastered = concepts.filter((c) => c.status === 'mastered').length;
    const unlocked = concepts.filter((c) => c.status === 'unlocked').length;
    return {
      concepts,
      mastered,
      unlocked,
      locked: concepts.length - mastered - unlocked,
      total: concepts.length,
      percent: Math.round((mastered / concepts.length) * 100),
      hintTokens: hintTokens(),
    };
  }
  function projectSummary(project) {
    return { mode1: mode1Status(project), mode2: mode2Status(project), mode3: mode3Status(project) };
  }

  return {
    createProject, getProject, listProjects, deleteProject,
    viewedIds, markViewed, mode1Status,
    conceptStatus, conceptRows, recordQuiz, quizAttempts,
    hintTokens, addHintTokens, spendHintToken,
    blankProgress, recordBlankAttempt, markHintShown, mode2Status,
    mode3Status, saveSubmission, getSubmission,
    overview, projectSummary,
    HINT_TOKENS_PER_PASS,
  };
}

module.exports = { createProgress };
