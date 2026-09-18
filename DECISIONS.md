# DECISIONS.md — running log of judgment calls

This is a chronological log of the non-obvious choices made while building this app.
Each entry says what was decided, what the alternatives were, and why the choice won.
Entries are appended as decisions are made, not written retrospectively.

---

## 001 — Node installed with Homebrew rather than via nvm or Docker-only

**Context:** The machine had Docker and Homebrew but no Node runtime.

**Options:**
1. Install `node@22` via Homebrew.
2. Install nvm, then a Node version.
3. Skip a host Node entirely and develop inside a container.

**Decision:** Homebrew `node@22`, linked into `PATH`.

**Why:** The spec says the app should be runnable locally *and* in a container, and the
Dockerfile explanation page compares the two. Developing with a host runtime keeps the
edit/test loop fast and makes the Docker build a deliberate later step, which is what the
spec asks for ("worth doing deliberately rather than as an afterthought"). Node 22 rather
than 24 because it is the current LTS line, and the Docker base image will pin the same
major so host and container behave identically. nvm would have worked but adds shell
init complexity for no benefit on a single-user machine.

## 002 — `better-sqlite3` over Node's built-in `node:sqlite`

**Context:** Node 22.23 ships a built-in `node:sqlite` module, which would mean zero native
dependencies and a simpler Docker build.

**Decision:** Use `better-sqlite3` anyway.

**Why:**
- `node:sqlite` still prints an `ExperimentalWarning` on every start and its API is
  marked "active development". For a learning tool that should keep working when reopened
  in six months, a stable API matters more than one fewer dependency.
- `better-sqlite3` has a synchronous API, which keeps the progress/gating code simple:
  no `await` chains in route handlers for what is a tiny single-user database.
- The native module is a *feature* for the containerization chapter: it forces the
  multi-stage Dockerfile to be honest about build tooling. Prebuilt binaries exist for
  Debian-based images, so the build stays fast, but the "why is there a builder stage"
  explanation becomes concrete rather than hypothetical.

**Rejected:** `lowdb` / JSON file. It would have worked, but it makes concurrent writes
(two tabs open) a foot-gun and gives nothing to teach.

## 003 — Server-rendered EJS with a little vanilla JS, not a React SPA

**Decision:** EJS templates rendered by Express. Small progressive-enhancement scripts in
`public/js/` for the interactive bits (expanding explanations, checking blanks, running
the linter).

**Why:** The spec explicitly says the frontend "isn't the interesting part". A SPA would
double the build surface (bundler, API layer, client state) for a single-user tool whose
interactions are all simple request/response. Server rendering also means gating logic
lives in exactly one place (the server), so it cannot be bypassed by editing client state.
Where JS is needed, it POSTs to small JSON endpoints and updates the DOM in place.

## 004 — One annotated-line data model drives all three modes

**Decision:** The generation engine does not produce a Dockerfile *string*. It produces an
array of line objects: `{ id, text, explain, concept, blank }`. Mode 1 renders `text` and
`explain`. Mode 2 hides `text` wherever a `blank` is defined and validates against it.
Mode 3 uses the same generated output as the reference the linter compares against.

**Why:** The three modes are the *same content* with decreasing scaffolding. If each mode
had its own template, the explanations, the blanks, and the linter's expectations would
drift apart the first time a preset changed. One data model means one place to edit and
means tests can assert invariants across modes (every blank has an answer, every concept
referenced by a line exists, the linter passes the generator's own output).

## 005 — Project layout

```
src/
  server.js          starts the HTTP server (only place that reads PORT)
  app.js             builds the Express app (importable by tests without listening)
  db.js              opens SQLite, runs schema
  engine/            pure functions: generator, presets, concepts, linter. No DB, no HTTP.
  services/          progress.js: all reads/writes of user state, all gating rules
  routes/            thin HTTP handlers that call engine + services and render views
  content/           static prose (uses page, self-containerization walkthrough)
  views/             EJS templates
public/              css + progressive-enhancement JS
test/                node:test suites
```

**Why:** The engine is kept free of I/O so it can be tested exhaustively with plain
function calls, and so the same functions can be reused for the "how this app was
containerized" page. Gating rules live in one service rather than being spread over
routes, because the spec's whole point is that the rules are visible and consistent.

## 006 — A ninth concept, "running as a non-root user", added to the spec's eight

**Context:** The spec lists eight concepts to track. It separately asks the Mode 3 linter to
flag "running as root" and asks that the app's own Dockerfile use a non-root user.

**Decision:** Add `non-root-user` as a tracked concept with its own quiz.

**Why:** Without it, the linter would report a problem the user had never been taught and
could not link to a quiz, and the self-containerization page would explain USER lines
with no concept to attach to. Every linter finding links to a concept; a finding without
one breaks the "feedback points you back at the material" loop. Nine concepts is still a
small enough dashboard to read at a glance.

## 007 — Quiz pass threshold is all-correct, with unlimited retries

**Options:** (a) pass at 2/3, (b) pass only when every question is right, (c) weighted by
attempt count.

**Decision:** (b), with no attempt limit and every option carrying its own explanation.

**Why:** With 2–3 questions and 3 options each, a 2/3 threshold is passable by guessing
often enough to make "mastered" meaningless. All-correct is strict, but each wrong answer
shows *why* it is wrong and *why* the right one is right, so a retry is another pass
through the explanation rather than a punishment. Unlimited retries keep the strictness
from becoming a wall.

## 008 — Concepts unlock on first explanation view, not on Mode 1 completion

**Decision:** A concept's quiz becomes available the first time the user opens any
explanation tagged with that concept, in any project. Finishing all of Mode 1 is only
required for downloading the files.

**Why:** The spec says quizzes are "unlocked after it's been explained in Mode 1". Tying
that to *finishing* Mode 1 would make the user read 30 explanations before taking the
first quiz, by which point the first ones are forgotten. Unlocking per concept lets the
user read three lines about layer caching, take the quiz while it is fresh, and continue.
It also means concepts are global, not per project: once you understand layer caching you
understand it for Django too.

## 009 — Mode 2 locks individual blanks, not the whole mode

**Context:** The spec says the app "won't let a user drop into Mode 2 for a concept they
haven't passed the quiz on — surface that plainly".

**Options:** (a) block the Mode 2 page entirely until all relevant quizzes are passed,
(b) render the page but lock each blank whose concept is unmastered, showing which quiz
opens it.

**Decision:** (b).

**Why:** Per-blank locking is the literal reading of "for a concept", and it is more
motivating: the user sees the file taking shape and sees exactly which quiz is between
them and the next blank. A whole-page block would turn Mode 2 into a second dashboard.
The lock is enforced server-side in the check endpoint, not just hidden in the UI, so the
gate cannot be bypassed by editing the page.

## 010 — Hint tokens: start with 3, earn 2 per first quiz pass, hints cost 1 once

**Decision:** Tokens are global (not per project). A revealed hint is remembered per
blank and never charged twice. Re-passing a quiz pays nothing.

**Why:** The token exists to make hints a considered choice, not to punish. Starting at 3
means a stuck beginner can get unstuck before passing anything. Paying out on quiz passes
ties the economy to the progression system rather than to time or clicks. Not charging
twice for the same blank avoids the frustrating "I refreshed and lost a token" case.
Global rather than per-project because mastery is global too.

## 011 — "Reveal all" in Mode 1 is the download/copy action itself

**Context:** The spec: "a 'reveal all' isn't available until they've expanded each section
once".

**Decision:** There is no separate reveal-all. Download and copy-to-clipboard are what
gets unlocked, and the gate is enforced in the download route (HTTP 403 with the count of
unread explanations), not only by hiding the buttons.

**Why:** The files *are* the thing the user wants to walk away with, so gating them is the
enforcement mechanism the spec describes. A separate reveal-all button would add a step
with no learning value. Server-side enforcement matters because the client JS is trivially
editable.

## 012 — Development images intentionally run as root; the linter only enforces USER for prod

**Decision:** The dev presets omit `USER`. The linter treats a missing USER as an error for
prod targets and says nothing for dev.

**Why:** With a bind mount, files created inside the container (migrations, generated
assets) are owned by whatever uid the container runs as. A non-root uid that does not
match the host user produces permission errors on the host, which is the single most
common "Docker is broken" complaint from beginners. Teaching non-root in the production
preset, where there is no bind mount, keeps the message clear without the foot-gun. The
nginx image is also skipped: it drops privileges for its workers itself.

## 013 — The Mode 3 checker is conceptual and pattern-based, not a real parser or build

**Decision:** `linter.js` parses Dockerfile instructions properly (continuations,
comments) but reads the compose file with indentation-aware regexes rather than a YAML
parser, and never invokes Docker.

**Why:** Running builds is explicitly out of scope. A YAML dependency would be the only
one added for a single file, and the checks the course needs are shape checks: is there a
service with `build:`, does the db service mount its data path, is a named volume
declared. If the checker grows beyond that, the honest next step is a YAML parser, and
`lintCompose` is the one function that would change. Every finding carries a concept key
so it links back to the quiz, and a test asserts the checker never leaks a pinned image
name or a finished line: feedback, not answers.

## 014 — The linter must accept the generator's own output, and a test enforces it

**Decision:** `test/engine.test.js` runs every preset combination through the linter and
asserts zero errors and zero warnings (except for the generic preset's deliberate TODOs).

**Why:** Otherwise Mode 3 would contradict Mode 1: the user writes exactly what the guided
mode taught and gets told it is wrong. This test caught two real inconsistencies while
building (the linter demanded WORKDIR from the nginx preset, and USER from dev images) and
forced the policy in #012 to be written down rather than implied.

## 015 — The self-containerization page reads the real files from disk

**Options:** (a) hard-code an annotated copy of the Dockerfile in the content module,
(b) read `Dockerfile`, `docker-compose.yml` and `.dockerignore` at request time and look
up explanations by exact line text.

**Decision:** (b), plus a test that fails if any meaningful line lacks an explanation.

**Why:** A copy would drift the first time someone edits the Dockerfile. Keying by line
text makes drift a test failure instead of a silent lie. The cost is that the image has
to contain its own Dockerfile, which is why the Dockerfile has one unusual line copying
those three files back in despite `.dockerignore` excluding them; that line is itself
explained on the page.

## 016 — Static preset publishes 8080:80 and skips WORKDIR/CMD

**Decision:** The static preset relies on the nginx image's own CMD and document root,
has no WORKDIR, and maps host 8080 to container 80.

**Why:** It is the one preset where "the image already knows how to run" is the lesson:
not every Dockerfile needs a CMD. Host port 8080 rather than 80 because binding 80 on
macOS/Linux needs privileges and collides with anything else on the machine; this is also
the first place the user meets a host:container mapping whose two sides differ, which
makes the EXPOSE-vs-publish distinction concrete.

## 017 — `npm ci --ignore-scripts` in the Dockerfile instead of installing a compiler

**Context:** The first `docker build` failed inside `npm ci`: node-gyp tried to compile
`better-sqlite3` and the slim image has no Python or g++. Decision #002 had predicted
that a native module might force build tools into the builder stage.

**What was actually going on:** `better-sqlite3` 13.x ships prebuilt binaries for every
platform inside the npm package (`prebuilds/linux-arm64.node` and friends) and has *no*
install script. npm's default behaviour is: if a package has a `binding.gyp` and no
install script, run `node-gyp rebuild`. So npm was compiling something that did not need
compiling, and failing. On the Mac it "worked" only because Xcode tools happen to exist.

**Options:**
1. `apt-get install python3 make g++` in the deps stage (the textbook multi-stage answer).
2. `npm ci --omit=dev --ignore-scripts`, letting the shipped prebuilt binary be used.

**Decision:** Option 2.

**Why:** Option 1 would compile from source for no reason, add a minute to every cold
build, and teach the wrong lesson ("native module means compiler"). Option 2 is the
accurate fix. The trade-off is real and is written on the walkthrough page:
`--ignore-scripts` skips *every* package's lifecycle scripts, which is safe for this app's
three dependencies but would need revisiting if a dependency with a genuine postinstall
were added. The HTTP test suite would catch a missing binary immediately.

## 018 — Graceful shutdown verified, not assumed

**Decision:** `server.js` handles SIGTERM/SIGINT and closes the server; `CMD` uses the
JSON form so node is PID 1. `docker compose stop` was timed after the build.

**Result:** 0.25 seconds, with "SIGTERM received, shutting down" in the logs. Without the
handler (or with `npm start` in between) Docker waits 10 seconds and sends SIGKILL, which
can leave SQLite's write-ahead log unflushed. The generated presets teach this in the CMD
explanation; the app itself now demonstrates it.

## 019 — Trivy scan: results, what was changed because of it, and what was not

**Scan 1** (`trivy image docker-learning-app:latest`, all severities), first build:

| | CRITICAL | HIGH | MEDIUM | LOW |
|---|---|---|---|---|
| no fix available (Debian) | 4 | 52 | 92 | 72 |
| fix available | 1 | 13 | 10 | 1 |

Total 247. Of the 27 fixable findings, 19 were in Node packages, and every one of those
was in npm's *own* bundled dependencies (`tar`, `pacote`, `sigstore`, `brace-expansion`,
`picomatch`...) under `/usr/local/lib/node_modules/npm`, not in this app's three
dependencies. The remaining fixable ones were Debian packages (`liblzma5`, `libpcre2`)
with updates published after the base image was cut. The 4 unfixable CRITICALs are
`perl-base` and `zlib1g` items Debian has marked deferred or will-not-fix; `perl-base`
is present only because the Debian image ships it, and nothing in this app calls perl.

**Decision 1: remove npm from the runtime stage.** The app is started with `node` and
never runs npm, so npm is pure attack surface. One `rm -rf` in the same RUN as the `/data`
setup.

**Scan 2**, after the change: total 228, Node-package findings 0, fixable HIGH 13 → 3.
Image size unchanged at 392 MB, which is the honest footnote: layers only add, so the
files still exist in the base layer. Trivy (and an attacker) see the final filesystem, so
the vulnerabilities are gone from what runs; the bytes are not gone from what is shipped.
Shrinking would mean a base without npm (a distroless or hand-built image), which is out
of proportion for a local single-user tool. The walkthrough page says exactly this.

**Decision 2: do not `apt-get upgrade` in the Dockerfile.** It would fix the three
remaining fixable HIGHs today and make the build non-reproducible forever; the app's own
linter warns users against it. The right fix is the one the app teaches: bump the pinned
base tag when a newer `node:22.x-bookworm-slim` is published. That is a maintenance task,
not a Dockerfile change.

**What this shows:** a scan of a well-built image on a pinned, current slim base still
reports over 200 findings, almost all unfixable OS-level items in packages the app never
executes. The number is not the signal. The signal is the fixable list, and whether the
things on it are things you run.

## 020 — MariaDB and SQLite added as database options, treated differently

**Context:** Asked to add MariaDB and SQLite "if that makes sense and not if not".

**MariaDB: yes, as a plain second service.** It is structurally identical to Postgres:
an official image, a data directory to put on a named volume, credentials via
environment, a healthcheck, a hostname the app connects to. It slots into the existing
`DB_SPECS` table with no new concepts. Two small generalisations fell out: the URL blank
now accepts every scheme a driver might use (`mysql://` or `mariadb://`), and the image
blank accepts `mysql:` as well as `mariadb:`, since users reasonably reach for either. The
Django preset gained a table of native driver dependencies (`libpq-dev`/`libpq5` for
Postgres, `default-libmysqlclient-dev`/`libmariadb3` for MariaDB) so the multi-stage
"build headers stay behind, runtime library comes along" lesson is taught for both.

**SQLite: yes, but it is not a service and must not be modelled as one.** SQLite is a
library inside the app process; the "database" is a file. Making it a compose service
would teach something false. Instead choosing it produces:

- `ENV DATABASE_PATH=/app/data/...` in the Dockerfile (env-vars),
- in production, `RUN mkdir -p /app/data && chown ...` before `USER` (non-root-user),
- a named volume `app-data:/app/data` on the *app* service and a top-level `volumes:`
  declaration (volumes-vs-bind-mounts),
- `*.db`, `*.sqlite`, `*.sqlite3` in `.dockerignore` (dockerignore),
- and **no** `compose-networking` requirement, because there is nothing to network.

That last point exposed an inaccuracy: the `services:` and `app:` lines were tagged with
the networking concept unconditionally, so even a database-less project demanded a quiz
about connecting to a database container. The tag now applies only when a second service
exists, and the `app:` explanation changes wording accordingly. A consequence is that the
static-site production preset touches four concepts rather than five, which is honest.

This is also exactly how the app containerizes itself (decision #002, the walkthrough
page), so a user who picks SQLite sees the same pattern twice: once generated for their
project, once real.

**The linter learned the same distinctions.** For SQLite it errors if the app service has
no volume, warns if the only mount is a bind mount into the source tree, errors if the
named volume is undeclared, errors in production if nothing prepares the data directory
for the non-root user, warns if a database service is present anyway, and warns if the
SQLite file is not in `.dockerignore`. For MariaDB it finds the database service under
either image name.

## 021 — Accounts added, and how (spec said "no auth for v1")

**Context:** The spec explicitly left auth out of v1. The app is now going to be hosted
on Railway, on a public URL, so a single shared progress record is no longer acceptable
and unauthenticated writes are an abuse vector. The scope change is deliberate and
requested.

**What was added:** username/password accounts, sessions, two roles (`user`, `admin`),
project ownership, per-user concept mastery and hint tokens, an admin page for roles and
deletions, password change, and three registration modes.

**Decision: no new dependencies.** Node's `crypto` provides scrypt (password hashing
with a per-user salt and constant-time comparison) and `randomBytes` (session tokens).
Sessions are a table in the same SQLite file, keyed by the SHA-256 of the cookie value
so a copied database does not contain usable sessions. The cookie is `HttpOnly`,
`SameSite=Lax`, and `Secure` whenever the request arrived over https (behind a proxy this
requires `TRUST_PROXY=1`, see README). The alternatives, `express-session` plus a store
adapter plus `bcrypt`, would have added three dependencies with native or maintenance
concerns for a total of maybe sixty lines saved, and would have hidden the mechanism
that is worth learning here.

**Decision: authorisation is enforced by scoping, not by checks in routes.**
`progress.forUser(userId)` returns an API whose every query includes `user_id`. A route
asking for someone else's project gets `null` and renders 404, the same as a project
that never existed. There is no `if (project.user_id !== req.user.id)` anywhere to
forget. Admin capabilities are limited to user management; admins do not see other
people's projects, because nothing in the app needs that.

**Decision: first account becomes admin; registration mode is an environment setting.**
`open` for a laptop, `invite` (shared code) for a small public deployment, `closed` once
everyone is in. The bootstrap rule (first account allowed even when closed) means a fresh
deployment can always be claimed. The README tells the deployer to register immediately,
and to prefer `invite` from the start so nobody can race them.

**CSRF:** `SameSite=Lax` stops browsers attaching the cookie to cross-site POSTs, and
the JSON endpoints require a JSON content type, which cross-site forms cannot send. On
top of that, a middleware rejects any state-changing request whose `Origin` (or `Referer`)
host differs from the `Host` we were reached on. No per-form tokens. This is the standard
modern position for a same-origin app; it would need revisiting if the app ever served
an API to other origins.

**Rate limiting:** an in-memory counter per (client IP, username), ten failures per
fifteen minutes. In-memory is fine for one process; a second replica would not share it,
and the README's Railway recipe runs one.

**Migration:** `PRAGMA user_version` now tracks the schema. A v0 file (the single-user
layout) is migrated in place: new tables, `user_id` columns defaulting to 0, and the
first account to register adopts every `user_id = 0` row plus the old hint-token count.
A test creates a v0 file from the old schema and checks all of that.

One SQLite detail bit during this: `ALTER TABLE ... ADD COLUMN` refuses a `REFERENCES`
column with a non-null default, so `projects` is rebuilt with the documented
copy/drop/rename procedure. That in turn has to run with `foreign_keys = OFF`, because
dropping the old `projects` with cascades on would silently delete every explanation
view, blank and submission. The migration checks `foreign_key_check` before committing
and the test asserts the child rows survived.

## 022 — "Read more" links: one registry, attached by line id

**Context:** Feedback that explanations like "a digest pin is the next step for a real
deployment" should link to how.

**Decision:** `src/engine/links.js` holds every URL once, with a label. Generated lines
get links from a `LINE_LINKS` map keyed by line id (with per-app-type variants where the
right reference differs, e.g. gunicorn docs for Django's CMD, Node's signal-handling
notes for Node's). Concepts carry their own list, shown on the quiz page and the
dashboard. The self-containerization page attaches links per explained line.

**Why by id rather than inline in presets:** the same line id appears in several presets
and both targets; one map means one edit when a URL moves. It also made auditing easy:
every URL was fetched during the build and two 404s were replaced before shipping.
Links open in a new tab with `rel="noopener"`; the app never needs to leave the page.

**Why official docs only:** blog posts rot and contradict each other; the Docker,
npm, Django and gunicorn references are maintained and are what a working engineer
actually consults.

## 023 — Cross-platform README and the choices behind it

- **Docker first, Node second.** Cloning and `docker compose up --build` is the same three
  commands on macOS, Linux and Windows, which is precisely the app's own sales pitch
  ("fast onboarding"). The Node path is for people editing the code.
- **`.gitattributes` with `* text=auto eol=lf`.** Windows Git defaults can rewrite text
  files to CRLF on checkout. The Dockerfile and JS tolerate that, but "byte-identical on
  every OS" is worth one line, and it removes a class of "works on my machine" report.
- **`--env-file-if-exists=.env` in the npm scripts.** Setting environment variables is
  the one thing that differs across shells (`FOO=1 cmd`, `$env:FOO=1`, `set FOO=1`).
  Node 22 can load a `.env` file itself, so the README can give one instruction for all
  three. The Docker image does not use it: `.env` is in `.dockerignore`, and containers
  get real environment variables.
- **`docker compose` vs `docker-compose`.** Both are mentioned because the hyphenated v1
  is what people already have; the note says which is maintained.
- **Railway section is labelled as untested.** It is written from Railway's docs, checked
  today, including the `RAILWAY_RUN_UID=0` workaround for volumes that are not writable
  by a non-root user. I have not run this deployment, and the README says so rather than
  implying otherwise.

## 024 — Password reset without email, scrypt cost, self-delete, security headers

**Reset flow: admin-issued one-time code.** The app stores no email addresses, on
purpose, so the usual "we sent you a link" flow is not available. Instead an admin
presses Reset on the Users page, the app generates a 16-character code from an alphabet
with no look-alike characters (no 0/O, 1/I/L), stores only its SHA-256 with a one-hour
expiry, and renders the code once. It is rendered, not redirected to, so it never appears
in a URL, browser history or access log. The user enters username, code and a new
password at `/reset`; on success the code is marked used, the password is re-hashed and
every session for that account is revoked. Wrong code, wrong username and expired code
all produce the same message so the page cannot be used to probe accounts, and reset
attempts share the login rate limiter. Issuing a new code voids the previous one, so at
most one live code exists per user. The table is shaped so an email-based self-service
flow could reuse it later by adding a sender and an optional email column.

**Rejected:** letting the admin type a temporary password. Simpler, but the admin would
know the user's password until they changed it, and nothing would force the change.

**Scrypt cost raised from 2^14 to 2^17**, OWASP's current recommendation. Node needs the
`maxmem` option raised above 128 MiB for that cost or it refuses to run. Existing hashes
record their own cost in the stored string, so verification still works; on the next
successful login the hash is transparently rewritten at the new cost. Nobody is locked out
and nobody notices. The test suite got about six seconds slower, which is the honest price
of a hash that takes a real fraction of a second per attempt.

**Self-delete** on the account page, confirmed with the current password. The last admin
cannot delete themselves, for the same reason they cannot be demoted: the deployment would
become unmanageable. Cascades remove projects and progress.

**Security headers, and what they forced.** A `Content-Security-Policy` with
`script-src 'self'` forbids inline scripts and inline event handlers entirely. The pages
had both: `<script>window.GUIDED = {...}</script>` blocks carrying page data, and
`onsubmit="return confirm(...)"` on delete forms. Rather than weaken the policy with
`'unsafe-inline'`, which would make it nearly pointless, the data now travels in
`<script type="application/json">` blocks, which browsers never execute, and the handlers
moved to a small `ui.js` that reads `data-confirm` / `data-autosubmit` attributes. The
JSON is emitted through a helper that escapes `<`, so a `</script>` inside user content
(a project named that, say) cannot break out of the block. Inline `style` attributes are
still allowed, because the progress bars use them and inline styles are not a script
execution vector. A test now fetches every page type and fails if any executable inline
script or `on*=` handler reappears.

## 025 — "Where do these files go?" and starting a project from nothing

**Context:** User feedback after trying the guided build: it never says where to save
the files, what to call them or how to run them, and the Django path copies a
`requirements.txt` the user does not have because they wanted the container first and
the project generated inside it.

**Two separate gaps.** The first was an omission: the page assumed the reader knew that
`Dockerfile` has no extension, that the three files sit in the project root, and that
`docker compose up --build` is the next command. The second was an unstated assumption
inherited from the spec, which frames the app as containerizing "your own project": the
wizard silently required the project to exist.

**Fix 1: a "Using these files" panel on every guided page**, generated from the
answers (`usageSteps` in `engine/bootstrap.js`). It states the exact filenames, the
folder (named by manifest: next to `package.json`, `manage.py` or `index.html`), the two
OS traps (Windows appending `.txt`, dotfiles hidden on macOS/Linux), and the run, open
and stop commands with the right host port. For production targets with a database it
also prints the `.env` the compose file expects, since that file is deliberately not
generated and its absence makes compose fail with a confusing error. The same essentials
are prepended as a comment to the copy-all text, because that is the moment the user
leaves the page.

**Fix 2: a wizard question, "Do you already have a project?"** Answering "no" adds a
fourth file, `getting-started.txt`, rendered with the same click-for-why mechanism and
counted in the Mode 1 gate. Its steps: hand-write the one manifest line the Dockerfile
needs (`Django>=5.1,<6`, plus `gunicorn` for production), generate the project inside a
throwaway container, fix ownership on Linux, then `docker compose up --build`.

**Why `docker run` with the base image, not `docker compose run app`.** The obvious
bootstrap is `docker compose run --rm app django-admin startproject config .`, but it
needs the image built first, the build needs `requirements.txt`, and for the production
target there is no bind mount so the generated files would vanish with the container.
`docker run --rm -v "$PWD:/app" -w /app python:3.12-slim-bookworm sh -c "..."` sidesteps
all three: no build, works for both targets, and it is a compact worked example of a
bind mount from the command line, which the explanation ties back to the concept the
user has already met in compose. `$PWD` was chosen over `$(pwd)` because it also works
in PowerShell; the explanation tells cmd.exe users to write `%cd%`.

**Why a wizard question rather than always showing bootstrap.** Most of the intended
audience has a project; a bootstrap section would be noise for them. The question also
makes the prerequisite explicit for everyone, which was half the problem.

**Why the Linux `chown` line exists.** The dev image runs as root on purpose (#012), so
files a root container creates through a bind mount are root-owned on a Linux host.
macOS and Windows translate ownership; Linux does not. One `sudo chown -R "$USER" .`
after generation is the honest fix, and it is another place the non-root concept gets
concrete.

**Not done:** Django's default project uses SQLite and knows nothing about the
`DATABASE_URL` the compose file sets. Getting started ends with a one-line "then: add
the driver and point DATABASES at the variable" note rather than editing `settings.py`,
because that is Django configuration, not Docker, and the app should stay in its lane.
