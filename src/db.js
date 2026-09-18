'use strict';
// Opens the SQLite database and applies the schema.
// Single-user tool, so there is no users table: all progress rows are global
// except those scoped to a project.
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  app_type    TEXT NOT NULL,     -- node | django | static | generic
  database    TEXT NOT NULL,     -- postgres | redis | none
  target      TEXT NOT NULL,     -- dev | prod
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Mode 1: which explanation lines the user has expanded, per project.
CREATE TABLE IF NOT EXISTS explanation_views (
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  line_id     TEXT NOT NULL,
  viewed_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, line_id)
);

-- Per-concept mastery. A concept becomes 'unlocked' the first time one of its
-- explanations is viewed in Mode 1, and 'mastered' when its quiz is passed.
CREATE TABLE IF NOT EXISTS concept_progress (
  concept     TEXT PRIMARY KEY,
  status      TEXT NOT NULL DEFAULT 'unlocked',  -- unlocked | mastered
  best_score  INTEGER NOT NULL DEFAULT 0,
  attempts    INTEGER NOT NULL DEFAULT 0,
  mastered_at TEXT
);

CREATE TABLE IF NOT EXISTS quiz_attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  concept     TEXT NOT NULL,
  score       INTEGER NOT NULL,
  total       INTEGER NOT NULL,
  passed      INTEGER NOT NULL,
  answers     TEXT NOT NULL,     -- JSON array of chosen option indexes
  taken_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Mode 2: which blanks have been answered correctly, and hints revealed.
CREATE TABLE IF NOT EXISTS blank_progress (
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  blank_id    TEXT NOT NULL,
  correct     INTEGER NOT NULL DEFAULT 0,
  hint_shown  INTEGER NOT NULL DEFAULT 0,
  attempts    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, blank_id)
);

-- Mode 3: every submission is kept so the user can see their own progression.
CREATE TABLE IF NOT EXISTS free_build_submissions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  dockerfile    TEXT NOT NULL,
  compose       TEXT NOT NULL,
  dockerignore  TEXT NOT NULL,
  errors        INTEGER NOT NULL,
  warnings      INTEGER NOT NULL,
  report        TEXT NOT NULL,   -- JSON
  submitted_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Key/value for the few global settings (hint tokens, etc).
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO settings (key, value) VALUES ('hint_tokens', '3');
`;

function openDatabase(dbPath) {
  const resolved = dbPath || process.env.DB_PATH || path.join(__dirname, '..', 'data', 'progress.db');
  if (resolved !== ':memory:') fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new Database(resolved);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDatabase };
