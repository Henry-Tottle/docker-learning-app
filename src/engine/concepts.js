'use strict';
// The concepts the app tracks mastery for. Each has a short "what/why" summary
// (shown on the dashboard and the quiz page) and a tiny quiz. Every option in
// a quiz carries its own `why` so a wrong answer is explained, not just marked.
//
// Order here is the order they appear on the dashboard: roughly the order a
// beginner meets them when reading a Dockerfile top to bottom.

const CONCEPTS = [
  {
    key: 'base-images',
    title: 'Base images & pinning',
    summary:
      'A base image is the starting filesystem your container is built on top of: an OS plus, usually, a language runtime. ' +
      'Pinning means naming an exact version (node:22-bookworm-slim) instead of a moving label like latest, so a build today and a build next year produce the same thing.',
    quiz: [
      {
        q: 'Why is `FROM node:latest` a bad idea for a project you expect to keep building?',
        options: [
          { text: 'It downloads a bigger image than a pinned tag would.', why: 'Size is unrelated to the tag name. latest can be small or large; the problem is that it changes.' },
          { text: '`latest` points at whatever Node published most recently, so the same Dockerfile can silently build something different next month.', why: 'Correct. A tag is a label that can be moved. Pinning a version makes builds reproducible.' },
          { text: 'Docker refuses to cache images tagged latest.', why: 'Docker caches all images the same way. Caching is not the issue.' },
        ],
        answer: 1,
      },
      {
        q: 'What does the `-slim` in `python:3.12-slim-bookworm` tell you?',
        options: [
          { text: 'It is a variant with fewer preinstalled OS packages, so the image is smaller and has less to keep patched.', why: 'Correct. Slim variants strip build tools and docs. You add back only what you need, which keeps the attack surface small.' },
          { text: 'It runs Python in a lower-memory mode.', why: 'The tag describes the image contents, not how Python runs. Python behaves identically.' },
          { text: 'It only supports single-threaded programs.', why: 'Nothing about the image limits threads. -slim is purely about which OS packages are included.' },
        ],
        answer: 0,
      },
      {
        q: 'You need Node 22 with a Debian userland. Which tag is the most reproducible choice?',
        options: [
          { text: '`node`', why: 'No tag means latest, the least reproducible option.' },
          { text: '`node:22`', why: 'Better, but 22 is a floating major: it will pick up new minor releases and OS updates over time.' },
          { text: '`node:22-bookworm-slim`', why: 'Correct. It names the major, the OS release (bookworm) and the variant. Even stricter would be a digest, but this is the practical sweet spot.' },
        ],
        answer: 2,
      },
    ],
  },
  {
    key: 'layer-caching',
    title: 'Layer caching',
    summary:
      'Every instruction in a Dockerfile produces a layer, and Docker reuses a layer from the last build if the instruction and everything before it are unchanged. ' +
      'Ordering instructions from "rarely changes" to "changes constantly" is the single biggest thing you can do to make rebuilds fast.',
    quiz: [
      {
        q: 'Why do Dockerfiles copy `package.json` (or `requirements.txt`) before copying the rest of the source code?',
        options: [
          { text: 'Docker requires manifests to be copied first or the build fails.', why: 'Docker has no such rule. You could copy everything at once; it would just be slow.' },
          { text: 'So the dependency-install layer can be reused from cache when only application code changed.', why: 'Correct. If the manifest is unchanged, the install step is skipped entirely. Copying source first would invalidate it on every edit.' },
          { text: 'Because small files copy faster and the order does not matter otherwise.', why: 'Order is the whole point. Docker invalidates every layer after the first changed one.' },
        ],
        answer: 1,
      },
      {
        q: 'You edit one line of `app.js` and rebuild. Which layers get rebuilt?',
        options: [
          { text: 'Only the layer that copies app.js.', why: 'Not quite. Docker cannot rebuild just one layer in the middle; everything after the changed layer is rebuilt too.' },
          { text: 'The layer that copies the source and every layer after it.', why: 'Correct. Cache invalidation is a one-way door: once one layer changes, all later ones rebuild.' },
          { text: 'Every layer, from FROM onwards.', why: 'Layers before the changed one are untouched. That is why ordering matters.' },
        ],
        answer: 1,
      },
    ],
  },
  {
    key: 'dockerignore',
    title: '.dockerignore',
    summary:
      'When you run docker build, Docker first sends the whole project folder (the "build context") to the builder. ' +
      '.dockerignore lists what to leave out so secrets and junk never reach the image and builds stay fast.',
    quiz: [
      {
        q: 'Why should `node_modules` be in `.dockerignore` even though the image needs those packages?',
        options: [
          { text: 'The image installs its own copy with npm during the build; sending the host copy is slow and may contain binaries built for the wrong OS.', why: 'Correct. Native modules compiled on macOS will not run on Linux. Let the build install them.' },
          { text: 'Docker cannot copy folders that large.', why: 'It can. It is just slow and the copied binaries may be wrong for the container OS.' },
          { text: 'Because npm refuses to run when node_modules already exists.', why: 'npm runs fine either way. The problem is correctness and speed, not npm.' },
        ],
        answer: 0,
      },
      {
        q: 'Your `.env` holds a database password. `COPY . .` is in the Dockerfile. What happens without `.dockerignore`?',
        options: [
          { text: 'Nothing; Docker skips hidden files automatically.', why: 'It does not. Dotfiles are copied like any other file.' },
          { text: 'The password is baked into an image layer and travels with the image to every registry it is pushed to.', why: 'Correct. Layers are permanent. Deleting the file in a later instruction does not remove it from history.' },
          { text: 'The build fails because secrets are detected.', why: 'Docker does no secret scanning at build time.' },
        ],
        answer: 1,
      },
    ],
  },
  {
    key: 'multi-stage-builds',
    title: 'Multi-stage builds',
    summary:
      'A Dockerfile can have several FROM lines. Each starts a new stage, and a later stage can copy files out of an earlier one. ' +
      'This lets you install compilers and dev dependencies in a throwaway stage and ship a final image that contains only what runs.',
    quiz: [
      {
        q: 'What is the main reason to use a multi-stage build for a production image?',
        options: [
          { text: 'It makes the build run in parallel across CPU cores.', why: 'Stages can run in parallel when independent, but that is a side benefit, not the reason.' },
          { text: 'The final image contains only runtime files: no compilers, no dev dependencies, so it is smaller and has fewer things to exploit.', why: 'Correct. Everything in the builder stage that is not explicitly copied out is discarded.' },
          { text: 'It is required in order to use `USER`.', why: 'USER works in any Dockerfile. The two are unrelated.' },
        ],
        answer: 1,
      },
      {
        q: 'What does `COPY --from=deps /app/node_modules ./node_modules` do?',
        options: [
          { text: 'Copies node_modules from the stage named deps into the current stage.', why: 'Correct. --from names an earlier stage (or any image). Only that path is brought across.' },
          { text: 'Copies node_modules from a folder called deps on your laptop.', why: '--from refers to a build stage or image, not the host filesystem.' },
          { text: 'Tells npm to install dependencies from a cache called deps.', why: 'COPY never runs npm. It only moves files.' },
        ],
        answer: 0,
      },
    ],
  },
  {
    key: 'non-root-user',
    title: 'Running as a non-root user',
    summary:
      'By default a container\'s process runs as root inside the container. If an attacker gets code execution in your app, root makes any container escape or file tampering far easier. ' +
      'USER switches to an unprivileged account before the app starts.',
    quiz: [
      {
        q: 'Where in a Dockerfile should `USER node` go?',
        options: [
          { text: 'Right after FROM, before anything else.', why: 'Then the install steps would run without permission to write system paths and would fail. Do the privileged setup first.' },
          { text: 'After installing dependencies and copying files, just before EXPOSE/CMD.', why: 'Correct. Everything that needs root (installing packages, creating dirs) happens first; only the running app is unprivileged.' },
          { text: 'It does not matter; Docker applies it to the whole file.', why: 'USER only affects instructions after it and the final process. Position matters.' },
        ],
        answer: 1,
      },
      {
        q: 'The official `node` image already has a user called `node`. Why is that convenient?',
        options: [
          { text: 'You can use `USER node` without first creating an account with useradd.', why: 'Correct. Python images do not ship one, which is why the Django preset creates its own.' },
          { text: 'It gives the container root access on the host.', why: 'The opposite. It is an unprivileged account.' },
          { text: 'It automatically runs npm start.', why: 'A user account does not run anything. CMD does.' },
        ],
        answer: 0,
      },
    ],
  },
  {
    key: 'expose-vs-publish',
    title: 'EXPOSE vs publishing ports',
    summary:
      'EXPOSE in a Dockerfile is documentation: it records which port the app listens on but opens nothing. ' +
      'Publishing (ports: "3000:3000" in compose, or -p on the command line) is what actually forwards traffic from your machine into the container.',
    quiz: [
      {
        q: 'You add `EXPOSE 3000` and run the container with no other flags. Can you open http://localhost:3000?',
        options: [
          { text: 'Yes, EXPOSE opens the port.', why: 'It does not. EXPOSE is metadata for humans and tools; it forwards no traffic.' },
          { text: 'No. You still need to publish the port with -p 3000:3000 or a ports: entry in compose.', why: 'Correct. EXPOSE documents, publishing connects.' },
          { text: 'Only if the app is written in Node.', why: 'The language is irrelevant to networking.' },
        ],
        answer: 1,
      },
      {
        q: 'In compose, what does `ports: - "8080:3000"` mean?',
        options: [
          { text: 'The app inside listens on 8080 and your laptop reaches it on 3000.', why: 'Backwards. The format is host:container.' },
          { text: 'Traffic to port 8080 on your machine is forwarded to port 3000 inside the container.', why: 'Correct. Host port on the left, container port on the right.' },
          { text: 'The container may use any port between 3000 and 8080.', why: 'It is a mapping of two specific ports, not a range.' },
        ],
        answer: 1,
      },
      {
        q: 'Your app listens on 127.0.0.1:3000 inside the container. You publish the port. Why does nothing connect?',
        options: [
          { text: 'Published traffic arrives on the container\'s network interface, not its loopback; the app must bind 0.0.0.0.', why: 'Correct. Inside a container, localhost means the container itself, so bind to all interfaces.' },
          { text: 'Port 3000 is reserved by Docker.', why: 'No port is reserved by Docker.' },
          { text: 'You need to add EXPOSE too.', why: 'EXPOSE changes nothing about connectivity.' },
        ],
        answer: 0,
      },
    ],
  },
  {
    key: 'volumes-vs-bind-mounts',
    title: 'Volumes vs bind mounts',
    summary:
      'A container\'s filesystem is thrown away when the container is removed. A bind mount maps a folder on your machine into the container (good for live-editing code). ' +
      'A named volume is storage Docker manages itself (good for database files that must outlive the container).',
    quiz: [
      {
        q: 'Why does the Postgres service use `db-data:/var/lib/postgresql/data` rather than `./pgdata:/var/lib/postgresql/data`?',
        options: [
          { text: 'A named volume is managed by Docker with correct permissions and performance; a bind mount of DB files from macOS/Windows is slow and often breaks on ownership.', why: 'Correct. Use bind mounts for code you edit, named volumes for data the container owns.' },
          { text: 'Bind mounts cannot store more than 1 GB.', why: 'There is no such limit.' },
          { text: 'Postgres refuses to start on a bind mount.', why: 'It can start, but permission and performance problems are common. That is why volumes are recommended.' },
        ],
        answer: 0,
      },
      {
        q: 'In a dev compose file you see `- .:/app` and then `- /app/node_modules`. What does the second line do?',
        options: [
          { text: 'Deletes node_modules from the image.', why: 'It hides the host copy from the container; it does not delete anything.' },
          { text: 'Creates an anonymous volume at that path so the container keeps its own node_modules instead of the one from your laptop.', why: 'Correct. Without it, the bind mount would shadow the container\'s Linux-built modules with your host\'s.' },
          { text: 'Mounts your laptop\'s node_modules read-only.', why: 'A path with no colon is an anonymous volume, not a mount from the host.' },
        ],
        answer: 1,
      },
    ],
  },
  {
    key: 'env-vars',
    title: 'Environment variables vs .env files',
    summary:
      'Configuration that differs between machines (database URLs, secrets, debug flags) should come from the environment, not be hard-coded. ' +
      'compose can set values inline under environment: or load them from a file with env_file:, which keeps secrets out of files you commit.',
    quiz: [
      {
        q: 'Why does the production compose file use `env_file: .env` instead of listing the database password under `environment:`?',
        options: [
          { text: 'Because the compose file is committed to git and shared, while .env is ignored and stays on the machine that needs it.', why: 'Correct. Same mechanism, different file, so secrets do not end up in version control.' },
          { text: 'env_file is faster to parse.', why: 'Parsing speed is irrelevant here.' },
          { text: 'environment: does not support passwords.', why: 'It supports any string. The issue is where that string is stored.' },
        ],
        answer: 0,
      },
      {
        q: 'What does `ENV NODE_ENV=production` in a Dockerfile do that setting it in compose does not?',
        options: [
          { text: 'Bakes it into the image so it is set at build time (npm respects it during install) and at run time by default.', why: 'Correct. Dockerfile ENV is available during later build steps and becomes the default for containers. compose values only apply at run time.' },
          { text: 'Encrypts the value.', why: 'ENV values are plain text and visible with docker inspect. Never put secrets in a Dockerfile.' },
          { text: 'Nothing; they are identical.', why: 'Build-time availability is the difference. A value only in compose is invisible to RUN steps.' },
        ],
        answer: 0,
      },
    ],
  },
  {
    key: 'compose-networking',
    title: 'Networking between compose services',
    summary:
      'compose puts all services in one file on a private network and gives each a DNS name equal to its service name. ' +
      'So your app reaches the database at host "db", not "localhost", and nothing outside the network can see the database unless you publish its port.',
    quiz: [
      {
        q: 'Your app container connects to `localhost:5432` and gets "connection refused", but Postgres is running in the `db` service. Why?',
        options: [
          { text: 'Inside the app container, localhost is the app container itself. The database lives at hostname db.', why: 'Correct. Each container has its own network namespace. Use the service name.' },
          { text: 'Postgres needs a restart.', why: 'The database is fine. The address is wrong.' },
          { text: 'Compose blocks localhost for security.', why: 'Nothing is blocked. localhost just means something different inside a container.' },
        ],
        answer: 0,
      },
      {
        q: 'The `db` service has no `ports:` entry. Can the `app` service still reach it?',
        options: [
          { text: 'No, ports must be published for any connection.', why: 'ports: publishes to your machine. Containers on the same compose network talk directly without it.' },
          { text: 'Yes. Services on the same compose network reach each other on their container ports; ports: is only for reaching in from outside.', why: 'Correct. Leaving the database unpublished is a security feature: only the app can see it.' },
          { text: 'Only if both use the same image.', why: 'Images are irrelevant to networking.' },
        ],
        answer: 1,
      },
      {
        q: 'What does `depends_on: db: condition: service_healthy` add over a plain `depends_on: - db`?',
        options: [
          { text: 'It waits for the db container to pass its healthcheck before starting app, instead of only waiting for the container to be created.', why: 'Correct. "Started" is not "ready to accept connections"; the healthcheck closes that gap.' },
          { text: 'It restarts db if app crashes.', why: 'depends_on only orders startup.' },
          { text: 'It shares the db container\'s filesystem with app.', why: 'No files are shared by depends_on.' },
        ],
        answer: 0,
      },
    ],
  },
];

const CONCEPT_MAP = Object.fromEntries(CONCEPTS.map((c) => [c.key, c]));

function getConcept(key) {
  return CONCEPT_MAP[key] || null;
}

// Score a quiz submission. `answers` is an array of chosen option indexes.
// Returns per-question results with the explanation for the chosen option.
function gradeQuiz(concept, answers) {
  const results = concept.quiz.map((question, i) => {
    const chosen = Number.isInteger(answers[i]) ? answers[i] : -1;
    const correct = chosen === question.answer;
    return {
      index: i,
      chosen,
      correct,
      why: chosen >= 0 && question.options[chosen] ? question.options[chosen].why : 'No answer given.',
      correctWhy: question.options[question.answer].why,
    };
  });
  const score = results.filter((r) => r.correct).length;
  return { results, score, total: concept.quiz.length, passed: score === concept.quiz.length };
}

module.exports = { CONCEPTS, CONCEPT_MAP, getConcept, gradeQuiz };
