# Docker Learning App

An interactive, single-user web app that teaches you to containerize your own project:
first with every line explained, then with the decisions blanked out, then from an empty
editor. Progress is tracked per concept so you can watch the scaffolding shrink.

## Run it

You need Node 22+. Nothing else.

```bash
npm install
npm start          # http://localhost:3000
npm run dev        # same, restarts on file changes
npm test           # engine, linter, gating and HTTP tests
```

Progress is stored in `data/progress.db` (SQLite). Delete the file to start over.
`PORT` and `DB_PATH` can be overridden; see `.env.example`.

## Run it in Docker

```bash
docker compose up --build   # http://localhost:3000
```

Progress lives in a named volume (`app-data`) and survives rebuilds. To scan the image
(Trivy is free; `brew install trivy`):

```bash
docker build -t docker-learning-app .
trivy image --severity HIGH,CRITICAL docker-learning-app
```

The result of doing exactly that, and what was changed because of it, is in `DECISIONS.md`. The image is a
multi-stage, non-root build on a pinned `node:22.x-bookworm-slim` base. The app explains
its own Dockerfile line by line at `/how-this-app-was-containerized`.

## How to use it

1. **Why Docker?** (`/uses`) if you are starting from zero.
2. **New project**: three questions (app type; database: none, PostgreSQL, MariaDB, SQLite
   or Redis; dev/prod). SQLite is deliberately *not* a second service: it becomes a
   volume on the app itself, the same way this app stores its own progress.
3. **Guided build**: click every highlighted line. The files unlock for download once
   every explanation has been opened. Opening an explanation also unlocks that concept's
   quiz.
4. **Quizzes** (`/dashboard` or any concept link): 2–3 questions, all must be right, retry
   freely. Passing marks the concept mastered and earns hint tokens.
5. **Scaffold & fill**: fill the blanks. Blanks for concepts you have not mastered are
   locked and say which quiz opens them. Hints cost a token.
6. **Free build**: unlocks when every concept your stack uses is mastered. Write all three
   files from scratch; the checker reports problems and points at concepts.

## Project layout

```
src/engine/       pure generation + checking logic (presets, concepts, linter)
src/services/     progress.js: all state and all gating rules
src/routes/       thin HTTP handlers
src/views/        EJS templates
src/content/      static prose (uses page, self-containerization walkthrough)
public/           css and small progressive-enhancement scripts
test/             node:test suites
```

`ARCHITECTURE.md` explains why it is shaped this way. `DECISIONS.md` is the log of
judgment calls made while building, in order; it is the most useful file to read if you
want to understand the tradeoffs.

## If you were extending this

- **Add a preset** (say, Go): create `src/engine/presets/go.js` exporting `build({database, target})`
  that returns `{ dockerfile, compose, dockerignore, port }` using `line()` / `blank()`
  from `lines.js` and `composeLines()` from `compose.js`. Register it in `generator.js`
  `PRESETS` and `APP_TYPES`. Add the app type's port and manifest/install regexes to
  `linter.js`. Run `npm test`: the suite will check every blank accepts its answer, every
  explanation is a sane length, and the linter passes your preset's own output.
- **Add a database**: a server database (like MariaDB) is one entry in `DB_SPECS` in
  `src/engine/compose.js`, plus native driver packages in the Django preset's `NATIVE`
  table if its Python driver needs them. An embedded database (like SQLite) is a
  different shape: see the `o.database === 'sqlite'` branches for the pattern.
- **Add a concept**: append to `CONCEPTS` in `concepts.js`, then tag lines with its key.
  The test "every concept is reachable from at least one preset" will fail until you do.
- **Change a gating rule**: `src/services/progress.js` only. The HTTP test walks the whole
  progression and will tell you what you broke.
- **Loosen a blank**: add to that line's `accept` list (strings or regexes) and, ideally,
  a `feedback` entry explaining the common near-miss you noticed.
- **Real YAML parsing for the checker**: `lintCompose` in `linter.js` is the one function
  to replace; keep the finding shape `{ level, file, concept, message, hint }`.
- **Multi-user**: add a `user_id` column to the progress tables and a session; nothing in
  the engine needs to change, because it has no idea users exist.

## Out of scope (v1)

Auth, actually building or running containers from the app, and anything beyond basic
compose (no Kubernetes).
