'use strict';
// Opens the SQLite database and brings its schema up to date.
//
// Schema versions are tracked with PRAGMA user_version. A brand-new file gets
// the full current schema; an older file is migrated step by step. Version 0
// was the single-user schema; version 1 added users, sessions and ownership.
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const CURRENT_VERSION = 1;

// Tables that did not exist before accounts. Safe to create on any file.
const ACCOUNT_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',   -- user | admin
  hint_tokens   INTEGER NOT NULL DEFAULT 3,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

-- Session id stored here is a SHA-256 of the cookie value, so a copy of the
-- database does not hand out live sessions.
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL,
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
`;

// The learning-state tables in their current (v1) shape.
const LEARNING_SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL DEFAULT 0 REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  app_type    TEXT NOT NULL,     -- node | django | static | generic
  database    TEXT NOT NULL,     -- postgres | mariadb | sqlite | redis | none
  target      TEXT NOT NULL,     -- dev | prod
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS projects_user ON projects(user_id);

-- Mode 1: which explanation lines the user has expanded, per project.
CREATE TABLE IF NOT EXISTS explanation_views (
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  line_id     TEXT NOT NULL,
  viewed_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, line_id)
);

-- Per-user, per-concept mastery. 'unlocked' the first time one of its
-- explanations is viewed in Mode 1, 'mastered' when its quiz is passed.
CREATE TABLE IF NOT EXISTS concept_progress (
  user_id     INTEGER NOT NULL DEFAULT 0,
  concept     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'unlocked',  -- unlocked | mastered
  best_score  INTEGER NOT NULL DEFAULT 0,
  attempts    INTEGER NOT NULL DEFAULT 0,
  mastered_at TEXT,
  PRIMARY KEY (user_id, concept)
);

CREATE TABLE IF NOT EXISTS quiz_attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL DEFAULT 0,
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
`;

// Version 0 -> 1: the single-user layout gains users and ownership. Existing
// rows get user_id 0 ("unclaimed"); the first account to register adopts them
// (see auth.js claimLegacyData). Hint tokens move from settings to users.
//
// SQLite will not ADD COLUMN a REFERENCES column with a non-null default, so
// projects is rebuilt with the documented copy-drop-rename procedure. This must
// run with foreign_keys OFF, otherwise DROP TABLE projects would cascade-delete
// every explanation view, blank and submission.
const MIGRATE_0_TO_1 = `
CREATE TABLE projects_v1 (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL DEFAULT 0 REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  app_type    TEXT NOT NULL,
  database    TEXT NOT NULL,
  target      TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO projects_v1 (id, user_id, name, app_type, database, target, created_at)
  SELECT id, 0, name, app_type, database, target, created_at FROM projects;
DROP TABLE projects;
ALTER TABLE projects_v1 RENAME TO projects;
CREATE INDEX IF NOT EXISTS projects_user ON projects(user_id);
ALTER TABLE quiz_attempts ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE concept_progress RENAME TO concept_progress_v0;
CREATE TABLE concept_progress (
  user_id     INTEGER NOT NULL DEFAULT 0,
  concept     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'unlocked',
  best_score  INTEGER NOT NULL DEFAULT 0,
  attempts    INTEGER NOT NULL DEFAULT 0,
  mastered_at TEXT,
  PRIMARY KEY (user_id, concept)
);
INSERT INTO concept_progress (user_id, concept, status, best_score, attempts, mastered_at)
  SELECT 0, concept, status, best_score, attempts, mastered_at FROM concept_progress_v0;
DROP TABLE concept_progress_v0;
`;

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function migrate(db) {
  const version = db.pragma('user_version', { simple: true });
  if (version >= CURRENT_VERSION) return;
  const legacy = version === 0 && tableExists(db, 'projects');
  // foreign_keys cannot change inside a transaction, so toggle it around one.
  if (legacy) db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(ACCOUNT_SCHEMA);
      if (legacy) db.exec(MIGRATE_0_TO_1);
      else db.exec(LEARNING_SCHEMA);
      // Unclaimed legacy rows carry user_id 0 until the first account adopts
      // them (auth.js claimLegacyData); that is the one violation we expect.
      const violations = db.pragma('foreign_key_check').filter((v) => !(v.table === 'projects' && v.parent === 'users'));
      if (violations.length) throw new Error('migration left foreign key violations: ' + JSON.stringify(violations));
      db.pragma(`user_version = ${CURRENT_VERSION}`);
    })();
  } finally {
    if (legacy) db.pragma('foreign_keys = ON');
  }
}

function openDatabase(dbPath) {
  const resolved = dbPath || process.env.DB_PATH || path.join(__dirname, '..', 'data', 'progress.db');
  if (resolved !== ':memory:') fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new Database(resolved);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

module.exports = { openDatabase, migrate, CURRENT_VERSION };
