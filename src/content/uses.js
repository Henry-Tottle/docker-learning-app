'use strict';
// The static "what would you use this for" explainer. Prose, not code.
const USES = [
  {
    title: 'Reproducible development environments',
    body:
      '"Works on my machine" happens because every machine is different: a different Node or Python version, a system library that is missing, a global package someone installed last year. A container packages the app with the exact runtime and libraries it needs, so the same image behaves the same on your laptop, a teammate\'s, and a server. The Dockerfile is the recipe, and it is checked into the repo alongside the code.',
  },
  {
    title: 'Dev/prod parity',
    body:
      'Bugs that only appear in production are usually environment differences. If production runs the image you built, and development runs a close cousin of it, most of that class of bug disappears. You still keep a dev variant (live reload, debug tools) and a prod variant (multi-stage, non-root, nothing extra), but they share the same base and the same shape.',
  },
  {
    title: 'Isolating dependencies between projects',
    body:
      'Project A needs Postgres 14, project B needs Postgres 16, and a third wants a Python you no longer have. Installing all of that natively means version juggling and conflicts. With containers each project brings its own, and removing a project removes its dependencies with it. Nothing leaks into the host.',
  },
  {
    title: 'Fast onboarding',
    body:
      'A new team member\'s first day should be "clone, docker compose up, open the browser", not a two-page setup document that is out of date. The compose file encodes every service the project needs and how they connect. That knowledge stops living in one person\'s head.',
  },
  {
    title: 'Packaging for CI/CD',
    body:
      'Continuous integration servers are fresh, empty machines. Building the same image there that you build locally means tests run against the real artefact. The image that passes CI is the image that gets deployed: not a rebuild, the same bytes. That is what makes a rollback trustworthy.',
  },
  {
    title: 'Running dependent services locally',
    body:
      'Need Postgres, Redis, and a mail catcher for local development? Three lines each in compose, with pinned versions, and no native installs. Tear them down with one command when you are done, keep their data in named volumes when you are not.',
  },
  {
    title: 'Worked example: a Django + Celery + Postgres stack',
    django: true,
    body:
      'A typical Django project has the web app, a Celery worker for background jobs, a broker (Redis) for Celery, and Postgres for data. Without containers a developer installs Postgres and Redis natively, remembers to start both, sets up a virtualenv, exports six environment variables and runs two terminals (runserver and celery worker). With compose it is four services in one file: web and worker are built from the same Dockerfile with different commands, db and redis come from official images, and depends_on with healthchecks means "docker compose up" starts them in a working order. The same Dockerfile, with a multi-stage build and gunicorn as the command, becomes the production image. The environment variables live in one .env that is git-ignored. Everyone on the team, and CI, gets the same stack.',
  },
];

module.exports = { USES };
