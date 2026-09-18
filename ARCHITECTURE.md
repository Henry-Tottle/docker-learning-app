# ARCHITECTURE.md

What the major pieces are and why they are shaped the way they are. This is the
reasoning, not a file listing; see `README.md` for how to run it and `DECISIONS.md` for
the choices made along the way.

## The one idea everything hangs off

The app teaches by **removing scaffolding in three steps** over the *same content*:

| Mode | What the user sees | What is enforced |
|---|---|---|
| 1 Guided | Full generated files, every line clickable for its "why" | Files cannot be copied or downloaded until every explanation has been opened once |
| 2 Scaffold | Same files with the decisions blanked out | A blank is locked until the quiz for its concept is passed; wrong answers get a reason |
| 3 Free | Empty editors plus the original wizard answers | Unlocks only when every concept the stack uses is mastered; the checker gives feedback, never the line |

Because the three modes are views over one thing, the core design decision is that the
**generation engine emits annotated line objects, not text**:

```
{ id, text, explain, concept, blank: { template, answer, accept, hint, feedback } }
```

Mode 1 renders `text` + `explain`. Mode 2 hides `text` where `blank` exists and validates
against it. Mode 3 uses the same output as the linter's reference. The progress tracker
keys everything on `id` and `concept`. One data model, three renderings, no drift.

## The pieces

```
              wizard answers {appType, database, target}
                              │
                              ▼
   ┌──────────────────── engine/ (pure) ────────────────────┐
   │ presets/*.js ─► generator.js ─► annotated files        │
   │ concepts.js   (quizzes)        lines.js (blank check)  │
   │ linter.js     (Mode 3 checker) links.js (read-more)    │
   │ bootstrap.js  (usage panel, getting-started file)      │
   └────────────────────────────────────────────────────────┘
                              │
                              ▼
        services/auth.js      ── users, sessions, roles
        services/progress.js  ── forUser(id): all gating rules, all learning-state DB access
                              │
                              ▼
        middleware/auth.js    ── cookie -> req.user, req.progress; requireLogin/Admin
        routes/*.js           ── thin: load project, ask progress, render view
                              │
                              ▼
        views/*.ejs + public/js  ── server-rendered, small JSON calls for interactivity
```

### Engine (`src/engine/`)

Pure functions with no I/O. `generator.generate(answers)` normalises the answers,
dispatches to a preset, validates invariants (unique ids, known concept keys) and returns
files plus the list of concepts the stack touches. That list is what "all concepts
relevant to a chosen stack" means for Mode 3 unlocking: it is derived from the lines,
never maintained by hand.

Presets (`node`, `django`, `static`, `generic`) are the content. They share
`compose.js` for the compose and `.dockerignore` lines because the reasoning for
"why a named volume for Postgres" is identical whichever app sits in front of it.
Writing it once means the explanation is consistent across stacks.

`concepts.js` holds the nine concepts, their summaries and quizzes. Every quiz option
carries its own `why`, so grading returns an explanation for whatever was chosen.

`bootstrap.js` produces the two things the files alone do not say: a "Using these
files" panel (where to save them, how to run them) for every project, and a Getting
started file for projects that do not exist yet. Both are plain functions of the answers.

`linter.js` is the Mode 3 checker. It knows the wizard answers, so it can say "a Django
app in this course listens on 8000" without knowing what the user wrote. Every finding
carries a concept key so the UI can link back to the quiz. It is deliberately not a
Docker build (out of scope) and not a YAML parser (see DECISIONS #013).

### Progress service (`src/services/progress.js`)

The only module that touches SQLite, and the only place gating rules exist. Routes ask it
questions (`mode1Status`, `mode2Status`, `mode3Status`) and never compute unlock state
themselves. This is deliberate: the spec's whole premise is that the rules are visible and
consistent, so they live in one file with the schema in `db.js` next to it.

State is global for concepts (mastery is knowledge, not a project attribute) and
per-project for explanation views, blanks and free-build submissions.

### Accounts (`src/services/auth.js`, `src/middleware/auth.js`)

Added when the app moved from "single local user" to "hosted". `auth.js` owns users,
password hashing (scrypt, via `node:crypto`), sessions (random tokens, stored hashed) and
registration policy. `middleware/auth.js` turns the session cookie into `req.user` and
`req.progress`, and provides `requireLogin`, `requireAdmin` and a same-origin check for
state-changing requests.

The important design point is where authorisation lives: nowhere in the routes.
`progress.forUser(userId)` scopes every query, so another user's project is simply not
found. Roles only gate the admin router. See DECISIONS #021.

### Routes and views

Routes are thin. Each Mode has one page route and one or two JSON endpoints the page's
script calls (`/guided/viewed`, `/scaffold/check`, `/scaffold/hint`, `/free/lint`). Every
gate is enforced in the endpoint, not the page: the download route returns 403 until Mode
1 is complete, the check route returns 403 for a locked blank, the lint route returns 403
until Mode 3 is unlocked. The client scripts are convenience, not security.

`views/partials/annotated-file.ejs` is shared by Mode 1 and the self-containerization
page, so the app's own Dockerfile is explained with exactly the mechanism it teaches.

### The self-containerization page (`src/content/self.js`)

Reads the real `Dockerfile`, `docker-compose.yml` and `.dockerignore` from the repo root
at request time and pairs lines with explanations keyed by exact line text. A test fails
if any meaningful line lacks an explanation, so the page cannot drift from the files.

## Why server-rendered

Interactions are simple request/response. A SPA would add a bundler, an API layer and
client state for no learning benefit, and would tempt gating logic to leak into the
client. EJS plus three small scripts keeps the server the source of truth.

## Where to look when something is wrong

- Wrong or unclear explanation → the preset in `src/engine/presets/` or `compose.js`.
- A blank rejects a reasonable answer → that line's `accept` list; add a string or regex.
- A quiz question is ambiguous → `src/engine/concepts.js`.
- Something unlocked when it should not have → `src/services/progress.js`, nowhere else.
- Someone saw something that is not theirs → `progress.forUser` scoping, or a route that
  bypassed `req.progress` and used the database directly (none should).
- A read-more link is wrong → `src/engine/links.js`.
- The checker complains about correct files → `linter.js`, and note the test that runs
  every preset through it will tell you the moment the two disagree.
