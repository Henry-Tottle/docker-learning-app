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
