# Docker Learning App

An interactive web app that teaches you to containerize your own project: first with
every line explained, then with the decisions blanked out, then from an empty editor.
Progress is tracked per account and per concept so you can watch the scaffolding shrink.

Runs on macOS, Linux and Windows. Two ways to run it: in Docker (nothing to install but
Docker) or directly with Node (for hacking on it).

## Option A: run it in Docker (recommended)

You need [Git](https://git-scm.com/downloads) and Docker:

| OS | Install |
|---|---|
| macOS | [Docker Desktop for Mac](https://docs.docker.com/desktop/setup/install/mac-install/) |
| Windows | [Docker Desktop for Windows](https://docs.docker.com/desktop/setup/install/windows-install/) with the WSL 2 backend (the installer's default) |
| Linux | [Docker Engine](https://docs.docker.com/engine/install/) plus the [Compose plugin](https://docs.docker.com/compose/install/), or Docker Desktop for Linux |

Then, in any terminal (Terminal, PowerShell, or a Linux shell):

```bash
git clone <this repository> docker-learning-app
cd docker-learning-app
docker compose up --build
```

Open http://localhost:3000 and create the first account, which becomes the admin.

Notes:

- `docker compose` (with a space) is Compose v2, built into current Docker. If your
  system only has the older `docker-compose` (with a hyphen) it works too, but it is
  unmaintained; the Compose plugin is the supported path.
- Progress lives in a named volume called `app-data` and survives `docker compose
  down` and rebuilds. `docker compose down -v` deletes it.
- On Windows, Git may be configured to convert line endings on checkout. The repository
  ships a `.gitattributes` that keeps every text file LF, so the Dockerfile and scripts
  are byte-identical on every OS. Nothing to do unless you have overridden it.
- To stop: `Ctrl+C`, then `docker compose down`.

## Option B: run it with Node

You need Node 22 or newer. `npm install` needs no compiler on any OS: the one native
dependency (`better-sqlite3`) ships prebuilt binaries for macOS, Linux and Windows.

| OS | Install Node 22 |
|---|---|
| macOS | `brew install node@22 && brew link --overwrite node@22`, or the [installer](https://nodejs.org/en/download) |
| Windows | `winget install OpenJS.NodeJS.LTS`, or the [installer](https://nodejs.org/en/download) |
| Linux | Your distro's package if it is 22+, otherwise [nvm](https://github.com/nvm-sh/nvm) (`nvm install 22`) or the [official downloads](https://nodejs.org/en/download) |

```bash
npm install
npm start          # http://localhost:3000
npm run dev        # same, restarts on file changes
npm test           # engine, linter, auth, gating and HTTP tests
```

Progress is stored in `data/progress.db` (SQLite). Delete the file to start over.

Configuration is read from environment variables. On every OS the easiest way to set
them is to copy `.env.example` to `.env` and edit it; `npm start` loads that file
automatically. (If you prefer the shell: `PORT=3001 npm start` in bash/zsh,
`$env:PORT=3001; npm start` in PowerShell, `set PORT=3001 && npm start` in cmd.)

## Accounts and access control

- Every user has their own projects, concept mastery and hint tokens.
- **The first account created becomes the administrator.** Admins get a Users page
  (`/admin/users`) to change roles and delete accounts. Nobody can remove the last admin.
- `REGISTRATION_MODE` controls who can sign up: `open` (default), `invite` (requires
  `INVITE_CODE`), or `closed` (nobody, except the very first account).
- Passwords are hashed with scrypt; sessions are random tokens in HttpOnly, SameSite=Lax
  cookies, stored hashed in the database, valid for 30 days. Ten failed logins in fifteen
  minutes locks that username for that client. Changing your password logs out every other
  device.

## Deploying to Railway

The image is production-shaped already (multi-stage, pinned base, non-root, healthcheck,
graceful shutdown), so deployment is mostly configuration. This is written from Railway's
documentation rather than from a deployment I have run, so treat it as the checklist to
verify against, not gospel.

1. Push this repository to GitHub.
2. In Railway: **New Project → Deploy from GitHub repo**. Railway finds the `Dockerfile`
   and builds from it ([docs](https://docs.railway.com/guides/dockerfiles)).
3. Add a **Volume** to the service and mount it at `/data`. That is where the Dockerfile's
   `DB_PATH` points, so the database persists across deploys
   ([docs](https://docs.railway.com/guides/volumes)).
4. Set these **Variables** on the service:

   | Variable | Value | Why |
   |---|---|---|
   | `TRUST_PROXY` | `1` | Railway terminates TLS; this makes session cookies Secure on https |
   | `REGISTRATION_MODE` | `invite` | So strangers cannot register on your public URL |
   | `INVITE_CODE` | a long random string | Share it with the people you want in |

   Do not set `PORT`; Railway injects it and the app reads it.
5. **Settings → Networking → Generate Domain.** Optionally set the healthcheck path to
   `/healthz`.
6. Open the domain and register the first account immediately: it becomes the admin.
7. If the logs show `EACCES` on `/data`: the image runs as the unprivileged `node` user,
   and Railway's volume reference says images that run as a non-root UID "will have
   permissions issues when performing operations within an attached volume", with
   `RAILWAY_RUN_UID=0` as the documented workaround
   ([docs](https://docs.railway.com/reference/volumes)). That runs the process as root,
   which trades away one of the things this app teaches, so try without it first and
   reach for it only if the error actually appears.

The same recipe applies to any platform that builds a Dockerfile and offers a volume
(Fly.io, Render): mount storage at `/data`, set `TRUST_PROXY=1`, choose a registration mode.

## How to use it

1. **Why Docker?** (`/uses`) if you are starting from zero.
2. **New project**: three questions (app type; database: none, PostgreSQL, MariaDB, SQLite
   or Redis; dev/prod). SQLite is deliberately *not* a second service: it becomes a
   volume on the app itself, the same way this app stores its own progress.
3. **Guided build**: click every highlighted line. Each explanation ends with links to the
   official documentation for that instruction. The files unlock for download once every
   explanation has been opened. Opening an explanation also unlocks that concept's quiz.
4. **Quizzes** (`/dashboard` or any concept link): 2–3 questions, all must be right, retry
   freely. Passing marks the concept mastered and earns hint tokens.
5. **Scaffold & fill**: fill the blanks. Blanks for concepts you have not mastered are
   locked and say which quiz opens them. Hints cost a token.
6. **Free build**: unlocks when every concept your stack uses is mastered. Write all three
   files from scratch; the checker reports problems and points at concepts.

The app explains its own Dockerfile line by line at `/how-this-app-was-containerized`.
To scan the image yourself ([Trivy](https://trivy.dev/latest/docs/) is free):

```bash
docker build -t docker-learning-app .
trivy image --severity HIGH,CRITICAL docker-learning-app
```

The result of doing exactly that, and what was changed because of it, is in `DECISIONS.md`.

## Project layout

```
src/engine/       pure generation + checking logic (presets, concepts, linter, links)
src/services/     progress.js: all learning state and gating rules; auth.js: accounts
src/middleware/   session cookie parsing, requireLogin/requireAdmin, same-origin check
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
- **Add or fix a "read more" link**: every URL is in `src/engine/links.js`, keyed by
  name; lines pick them up by id in `LINE_LINKS`, concepts in `concepts.js`.
- **Add a concept**: append to `CONCEPTS` in `concepts.js`, then tag lines with its key.
  The test "every concept is reachable from at least one preset" will fail until you do.
- **Change a gating rule**: `src/services/progress.js` only. The HTTP test walks the whole
  progression and will tell you what you broke.
- **Change the schema**: bump `CURRENT_VERSION` in `src/db.js` and add a migration step;
  `test/auth.test.js` has a v0-to-v1 migration test to copy.
- **Loosen a blank**: add to that line's `accept` list (strings or regexes) and, ideally,
  a `feedback` entry explaining the common near-miss you noticed.
- **Real YAML parsing for the checker**: `lintCompose` in `linter.js` is the one function
  to replace; keep the finding shape `{ level, file, concept, message, hint }`.

## Out of scope

Actually building or running containers from the app, and anything beyond basic compose
(no Kubernetes).
