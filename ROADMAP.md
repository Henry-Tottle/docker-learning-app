# ROADMAP.md — upcoming work

Agreed items are ready to build. Proposed items are written up so the reasoning is
visible before anyone commits to them. Completed items move to DECISIONS.md.

## 1. Password reset and account hardening (agreed)

**Admin-issued one-time reset code.** No email infrastructure; fits an invite-only
deployment where the admin already has a way to reach each user.

- New table `password_resets(user_id, code_hash, expires_at, created_by, used_at)`.
  Shaped so a future email-based self-service flow can reuse it.
- Admin Users page gets a **Reset password** action. The app generates a random code,
  stores its SHA-256 with a one-hour expiry, and shows the code to the admin once.
- New public page `/reset`: username, code, new password. On success the code is marked
  used, the password is re-hashed, and every session for that account is revoked.
  Wrong or expired codes get the same generic message, and reset attempts go through the
  same rate limiter as login.
- The login page gets a "Forgot your password? Ask an admin for a reset code" link.
- The admin never learns the new password.

**Scrypt cost 2^14 → 2^17** (OWASP's current recommendation), with `maxmem` raised to
suit. Existing hashes keep their recorded cost and are re-hashed transparently on the
next successful login, so nobody is locked out and nobody has to do anything.

**Self-delete on the account page.** The admin page already points users there; the
button does not exist yet. Requires the current password, refuses if this is the last
admin, and deletes projects and progress with the account.

**Small extras while in there:** a few security headers (`X-Content-Type-Options`,
`Referrer-Policy`, a conservative `Content-Security-Policy`), and a note in the README
that volume backups contain password hashes.

## 2. "Where do these files go, and what if I have no project yet?" (proposed)

**Observed gap.** The guided build hands over three files and never says: put them in
the root of your project folder, next to `package.json` or `manage.py`; the first one
is called exactly `Dockerfile` with no extension; then run `docker compose up --build`.
Nothing states the prerequisite that a project already exists, either. The Django path
copies `requirements.txt` as if it were already there, which is wrong for someone who
wants the container *first* and the project generated inside it.

**Proposed fix, in two parts.**

*a) A "Using these files" panel on the guided page,* shown once the gate opens and
included as a comment header in the copy-all output:

- exact filenames, and that `Dockerfile` has no extension and a capital D;
- where they go: the folder that holds your dependency manifest;
- OS notes: Windows may append `.txt` to a downloaded `Dockerfile`, and `.dockerignore`
  is a hidden file on macOS/Linux, so use "show hidden files" or the terminal;
- the commands: `docker compose up --build`, what you should see, how to stop, and
  `docker compose down`;
- for `env_file: .env` targets, what the `.env` must contain, since it is git-ignored
  and therefore not generated.

*b) A wizard question: "Do you already have a project, or are you starting fresh?"*
"Starting fresh" adds a **Bootstrap** section before the files, taught with the same
explained-line mechanism:

- the one hand-written file the build needs: `requirements.txt` containing a single
  pinned line such as `Django>=5.1,<6`, or `package.json` from `npm init -y` followed by
  `npm install express`;
- the command that generates the project *inside* the container and, thanks to the dev
  bind mount, onto your disk: `docker compose run --rm app django-admin startproject
  config .` (the name `config` matches the production preset's gunicorn command). Why
  `run` rather than `up` (the image has no `manage.py` to serve yet), why `--rm`, and why
  the files appear on your machine at all (the bind mount, which is already a taught
  concept);
- the ownership note for Linux hosts: the dev image runs as root on purpose (DECISIONS
  #012), so generated files may be root-owned; one `sudo chown -R $USER .` fixes it, or
  set `user: "${UID}:${GID}"` on the service.

The manifest explanations should also say "if you do not have this file yet, it is a
one-line file you write by hand", which removes the chicken-and-egg feeling even for
users who skip the bootstrap flow.

**Why a wizard question rather than always showing bootstrap:** most of the spec's
audience has an existing project, and the bootstrap steps would be noise for them. The
question also makes the prerequisite explicit for everyone.
