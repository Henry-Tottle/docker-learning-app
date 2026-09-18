'use strict';
// The "how this app was containerized" walkthrough. It reads the REAL
// Dockerfile, compose file and .dockerignore from the repo root at request
// time and pairs each line with an explanation keyed by the line's text.
// A test asserts every meaningful line has an explanation, so the page cannot
// silently drift from the files it describes.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

const DOCKERFILE = {
  '# syntax=docker/dockerfile:1': ['Opts in to the current Dockerfile syntax. Harmless on new Docker versions and protects the multi-stage COPY --from lines from surprises on old ones.', null],
  'FROM node:22.23.2-bookworm-slim AS deps': [
    'Pinned to the exact Node version installed on the machine this was built on, so the container runs the same runtime the tests ran on. -slim omits compilers and docs. The stage is named deps because that is all it produces. A stricter pin would add @sha256:... after the tag; it was left off so the file stays readable, but it is the next step for a real deployment.',
    'base-images',
  ],
  'WORKDIR /app': ['Creates /app and makes every later path relative to it. It appears in both stages because each FROM starts from a clean filesystem.', null],
  'COPY package.json package-lock.json ./': [
    'Only the manifests, so the npm ci layer below is reused until dependencies change. Source edits, which happen constantly, never invalidate it.',
    'layer-caching',
  ],
  'RUN npm ci --omit=dev --ignore-scripts': [
    'Installs exactly what the lock file says and skips devDependencies (test runners, linters never run in production). --ignore-scripts is here for better-sqlite3, a native module: the package ships prebuilt binaries for Linux, but npm sees its binding.gyp and tries to compile anyway, which fails on a slim image with no compiler. Skipping install scripts lets the prebuilt binary be used. If a dependency ever genuinely needed compiling, this stage is where python3 and g++ would go, and they would never reach the final image.',
    'multi-stage-builds',
  ],
  'FROM node:22.23.2-bookworm-slim AS runtime': [
    'A second, clean stage. Nothing from deps comes along unless copied. Same pinned base, so the native module built above matches the runtime here.',
    'multi-stage-builds',
  ],
  'ENV NODE_ENV=production': ['Express disables verbose errors and enables view caching when this is set. Baked in so every container from this image gets it by default.', 'env-vars'],
  'ENV DB_PATH=/data/progress.db': [
    'The app reads its SQLite path from the environment. Inside the container it points at /data, which compose mounts as a named volume, so progress survives container replacement. On the host it defaults to ./data instead.',
    'env-vars',
  ],
  'COPY --from=deps /app/node_modules ./node_modules': ['Brings the installed, production-only dependencies across from the deps stage. This is the only thing that stage exists to produce.', 'multi-stage-builds'],
  'COPY package.json ./': ['Node reads "type" and "main" from it, and it is tiny. Copied on its own so a change to it does not invalidate the source layers below.', 'layer-caching'],
  'COPY src ./src': ['The application code, copied as an explicit folder rather than COPY . . so nothing unexpected is added when the repo grows. Listed after dependencies because it changes most.', 'layer-caching'],
  'COPY public ./public': ['Static assets served by Express. Separate COPY so the layer is reused when only server code changed.', 'layer-caching'],
  'COPY Dockerfile docker-compose.yml .dockerignore ./': [
    'The one unusual line. This app has a page that reads its own Dockerfile from disk to explain it, so the files have to be inside the image. A normal app would leave them out; they are in .dockerignore for that reason, and named explicitly here to override that only for these three.',
    'dockerignore',
  ],
  'RUN mkdir -p /data && chown node:node /data \\': [
    'Creates the folder the volume will be mounted on and hands it to the unprivileged user. Done as root, before USER, because the app will not have permission to do it later. Without this, the first write to the database fails with EACCES. The backslash continues the instruction onto the next line so both steps share one layer.',
    'non-root-user',
  ],
  '&& rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack': [
    'Deletes npm from the final image. The app is started with node directly and never runs npm, but npm ships hundreds of its own dependencies, and a Trivy scan of the first build showed every fixable HIGH finding in the Node layer came from them. Removing a tool the container does not use removes its vulnerabilities from the running filesystem. It does not make the image smaller: layers only add, and npm still exists in the base layer underneath. Shrinking it would need a base without npm, which is the next step if size mattered. This is the "scan, understand, act" loop in miniature.',
    'multi-stage-builds',
  ],
  'USER node': ['Everything above needed root. The running app does not. If a request handler is ever exploited, the attacker is "node" in a container, not root.', 'non-root-user'],
  'EXPOSE 3000': ['Documents the listening port. Publishing is done by ports: in compose or -p on the command line.', 'expose-vs-publish'],
  "HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD [\"node\", \"-e\", \"fetch('http://127.0.0.1:3000/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))\"]": [
    'Tells Docker how to know the app is really serving, not just running. It uses node itself because the slim image has no curl, and 127.0.0.1 is correct here: the check runs inside the container. docker ps shows (healthy) or (unhealthy) and orchestrators can restart on failure.',
    'compose-networking',
  ],
  'CMD ["node", "src/server.js"]': [
    'JSON form so node is process 1 and receives SIGTERM directly; server.js handles it and closes cleanly so SQLite is not left mid-write. npm start would have sat in between and swallowed the signal.',
    'expose-vs-publish',
  ],
};

const COMPOSE = {
  'services:': ['One service: the app. SQLite lives inside it, so there is no database container. That is the whole point of choosing SQLite for a single-user tool.', 'compose-networking'],
  'app:': [null, null],
  'build: .': ['Build the image from the Dockerfile in this folder rather than pulling one.', null],
  'ports:': [null, null],
  '- "3000:3000"': ['Forwards port 3000 on your machine to 3000 in the container. This is what makes http://localhost:3000 work; EXPOSE alone would not.', 'expose-vs-publish'],
  'volumes:': [null, null],
  '- app-data:/data': ['A named volume over /data, where DB_PATH points. Rebuild the image, recreate the container, and your progress is still there. A bind mount would also work but Docker-managed storage avoids ownership problems with the non-root user.', 'volumes-vs-bind-mounts'],
  'restart: unless-stopped': ['If the process crashes or the machine reboots, Docker starts it again, unless you stopped it on purpose.', null],
  'app-data:': ['Declares the named volume used above. compose creates it on first up and never deletes it unless asked with -v.', 'volumes-vs-bind-mounts'],
};

const DOCKERIGNORE = {
  node_modules: ['The image installs its own with npm ci. The host copy contains a native module compiled for macOS.', 'dockerignore'],
  'npm-debug.log': ['Crash logs from failed installs; junk.', 'dockerignore'],
  '.env': ['Configuration overrides for local runs. Never inside an image, even if today it holds nothing secret.', 'dockerignore'],
  data: ['The SQLite database. User data must not be baked into an image: it would be stale and every copy of the image would carry it.', 'dockerignore'],
  '.git': ['History is large and can contain secrets from old commits.', 'dockerignore'],
  '.gitignore': ['Meaningless inside an image.', 'dockerignore'],
  test: ['Tests run before the image is built, not inside it.', 'dockerignore'],
  '*.md': ['README, ARCHITECTURE and DECISIONS are for humans reading the repo, not the container. Note the Dockerfile still copies three specific ignored files back in on purpose, because the walkthrough page reads them.', 'dockerignore'],
};

function annotate(fileName, map) {
  const text = fs.readFileSync(path.join(ROOT, fileName), 'utf8');
  const lines = text.replace(/\n$/, '').split('\n');
  return {
    name: fileName,
    lines: lines.map((raw, i) => {
      const key = raw.trim();
      const entry = map[key];
      const isMeaningful = key && !(fileName === 'Dockerfile' && key.startsWith('# ---'));
      return {
        id: `${fileName.replace(/\W/g, '')}-${i}`,
        text: raw,
        explain: entry ? entry[0] : null,
        concept: entry ? entry[1] : null,
        missing: isMeaningful && !entry && !(fileName === 'Dockerfile' && key.startsWith('#') && !key.startsWith('# syntax')),
      };
    }),
  };
}

function selfWalkthrough() {
  return {
    files: [annotate('Dockerfile', DOCKERFILE), annotate('docker-compose.yml', COMPOSE), annotate('.dockerignore', DOCKERIGNORE)],
  };
}

module.exports = { selfWalkthrough };
