'use strict';
const { line, raw, blank } = require('../lines');
const { composeLines, dockerignoreLines } = require('../compose');

const BASE = 'node:22-bookworm-slim';
const PORT = 3000;

const baseImageBlank = (id, template, extra) =>
  blank(
    id,
    template,
    BASE,
    'The base image: a minimal Debian ("bookworm") with Node 22 preinstalled. The major version is pinned so the build is reproducible; -slim leaves out compilers and docs you do not need at run time, which makes the image smaller and gives attackers less to work with.' + (extra || ''),
    {
      concept: 'base-images',
      prompt: 'image:tag',
      accept: [/^node:22(\.\d+)*(-(bookworm|bullseye|alpine)(-slim)?|-slim)?$/],
      hint: 'The official node image, pinned to major version 22, ideally the slim Debian variant: name:version-os-variant.',
      feedback: [
        { match: /^node:latest$/, why: 'latest is whatever Node published most recently. The same Dockerfile could build Node 22 today and Node 25 next year. Pin a version.' },
        { match: /^node$/, why: 'No tag means :latest, which moves. Pin the major version you develop against.' },
        { match: /^node:(1\d|20|21)/, why: 'That is an older Node line than the one you are developing on. Match the version you run locally (22).' },
        { match: /^(ubuntu|debian|alpine)/, why: 'A bare OS image would work, but you would have to install Node yourself in a RUN step. The official node image already did that correctly.' },
        { match: /^python|^nginx/, why: 'This is a Node/Express app, so it needs a Node runtime.' },
      ],
    }
  );

const DATA_DIR = '/app/data';

const sqliteEnv = () =>
  line(
    'df-sqlite-env',
    `ENV DATABASE_PATH=${DATA_DIR}/app.db`,
    'Where the app should open its SQLite file. Set in the Dockerfile as a default so the path is fixed by the image layout, not remembered by whoever runs it. Read it in your code with process.env.DATABASE_PATH. compose mounts a volume at that folder so the file outlives the container.',
    { concept: 'env-vars' }
  );

function build({ database, target }) {
  const df = [];
  const prod = target === 'prod';
  const sqlite = database === 'sqlite';

  if (prod) {
    df.push(line('df-syntax', '# syntax=docker/dockerfile:1', 'Opts in to the current Dockerfile syntax so features like multi-stage COPY --from behave consistently across Docker versions.'));
    df.push(baseImageBlank('df-base', 'FROM ___ AS deps', ' "AS deps" names this stage so a later stage can copy files out of it.'));
    df.push(line('df-workdir', 'WORKDIR /app', 'Creates /app and makes it the current directory for every later instruction. Without it, files would land in / and paths in COPY and CMD become guesswork.'));
    df.push(
      blank(
        'df-manifest',
        'COPY ___ ./',
        'package.json package-lock.json',
        'Only the dependency manifests are copied first, on purpose. Docker caches each instruction as a layer and reuses it while its inputs are unchanged. Copying the manifests alone means the npm install layer below survives edits to your source code and is only redone when dependencies change.',
        {
          concept: 'layer-caching',
          prompt: 'file(s) to copy',
          accept: ['package*.json', 'package.json package-lock.json', 'package-lock.json package.json', 'package.json'],
          hint: 'Which file lists your dependencies? Copy that (and its lock file), and nothing else, before installing.',
          feedback: [
            { match: /^\.$/, why: 'Copying everything here would invalidate the install layer every time any source file changes, so npm install would rerun on every build. Copy only the dependency manifests first.' },
            { match: /node_modules/, why: 'node_modules is built by npm inside the image, and should be in .dockerignore. Copy the manifest that describes it instead.' },
            { match: /src|\.js$/, why: 'Source code changes often. Copy it later, after dependencies are installed, so the install layer stays cached.' },
          ],
        }
      )
    );
    df.push(
      blank(
        'df-install',
        'RUN ___',
        'npm ci --omit=dev',
        'npm ci installs exactly what package-lock.json says, which is what you want for reproducible images (npm install may update the lock). --omit=dev skips devDependencies such as test runners and linters: they never run in production and every package is more attack surface.',
        {
          concept: 'multi-stage-builds',
          prompt: 'install command',
          accept: ['npm ci --only=production', 'npm ci --production', 'npm install --omit=dev', 'npm install --production'],
          hint: 'Install dependencies from the lock file, and leave out the dev-only ones. npm has a subcommand made for clean installs.',
          feedback: [
            { match: /^npm (ci|install|i)$/, why: 'That installs devDependencies too. Fine for dev, but a production image should skip test runners and linters: smaller and fewer things to exploit.' },
            { match: /^npm start|^node /, why: 'This step installs dependencies; starting the app comes later in CMD.' },
            { match: /yarn|pnpm/, why: 'Only if your project actually uses that package manager; this preset assumes a package-lock.json, so use npm.' },
          ],
        }
      )
    );
    df.push(raw(''));
    df.push(
      line(
        'df-base-runtime',
        `FROM ${BASE} AS runtime`,
        'A second FROM starts a fresh stage from the same clean base. Nothing from the deps stage comes along unless explicitly copied, so build-time leftovers (npm cache, temp files) are not in the final image.',
        { concept: 'multi-stage-builds' }
      )
    );
    df.push(line('df-env', 'ENV NODE_ENV=production', 'Express and many libraries switch off debug output and enable caching when NODE_ENV is production. Set in the Dockerfile so it is the default for every container from this image.', { concept: 'env-vars' }));
    if (sqlite) df.push(sqliteEnv());
    df.push(line('df-workdir2', 'WORKDIR /app', 'Each stage starts fresh, so the working directory has to be set again.'));
    df.push(
      blank(
        'df-copy-deps',
        'COPY --from=___ /app/node_modules ./node_modules',
        'deps',
        'Pulls the installed, production-only node_modules across from the deps stage. This is the whole point of the multi-stage build: the final image gets the result of the install without the tooling and cache that produced it.',
        {
          concept: 'multi-stage-builds',
          prompt: 'stage name',
          hint: 'Look at the first FROM line. What did it name that stage with AS?',
          feedback: [
            { match: /^node/, why: '--from can name an image, but here you want the stage you built above, referenced by the name after AS.' },
            { match: /^\.|^\//, why: '--from takes a stage name, not a path. The path comes after it.' },
          ],
        }
      )
    );
    df.push(line('df-copy-src', 'COPY . .', 'Now the application source. It changes most often, so it comes last: nothing after this line is expensive. .dockerignore decides what "." actually includes.', { concept: 'layer-caching' }));
    if (sqlite) {
      df.push(
        line(
          'df-data-dir',
          `RUN mkdir -p ${DATA_DIR} && chown node:node ${DATA_DIR}`,
          'Creates the folder the volume will be mounted on and hands it to the unprivileged user. This runs as root, before USER, because the app will not have permission to do it later. Without it, the first write to the database fails with a permission error.',
          { concept: 'non-root-user' }
        )
      );
    }
    df.push(
      blank(
        'df-user',
        'USER ___',
        'node',
        'Switches from root to the unprivileged "node" account the official image ships with, before the app starts. Everything above needed root (installing into system paths); the running app does not, and if it is compromised the attacker gets a limited user rather than root in the container.',
        {
          concept: 'non-root-user',
          prompt: 'user name',
          hint: 'The official node image already includes an unprivileged account named after the runtime.',
          feedback: [
            { match: /^root$/, why: 'root is the default and exactly what this line exists to move away from. Any code-execution bug would then run as root inside the container.' },
            { match: /^(app|appuser|www-data|nobody)$/, why: 'Reasonable name, but that account does not exist in the node image unless you create it. The image ships with one already.' },
          ],
        }
      )
    );
  } else {
    df.push(baseImageBlank('df-base', 'FROM ___'));
    df.push(line('df-workdir', 'WORKDIR /app', 'Creates /app and makes it the current directory for every later instruction. Without it, files would land in / and paths in COPY and CMD become guesswork.'));
    df.push(
      blank(
        'df-manifest',
        'COPY ___ ./',
        'package.json package-lock.json',
        'Only the dependency manifests are copied first, on purpose. Docker caches each instruction as a layer and reuses it while its inputs are unchanged. Copying the manifests alone means the npm install layer below survives edits to your source code and is only redone when dependencies change.',
        {
          concept: 'layer-caching',
          prompt: 'file(s) to copy',
          accept: ['package*.json', 'package.json package-lock.json', 'package-lock.json package.json', 'package.json'],
          hint: 'Which file lists your dependencies? Copy that (and its lock file), and nothing else, before installing.',
          feedback: [
            { match: /^\.$/, why: 'Copying everything here would invalidate the install layer every time any source file changes, so npm install would rerun on every build. Copy only the dependency manifests first.' },
            { match: /node_modules/, why: 'node_modules is built by npm inside the image, and should be in .dockerignore. Copy the manifest that describes it instead.' },
            { match: /src|\.js$/, why: 'Source code changes often. Copy it later, after dependencies are installed, so the install layer stays cached.' },
          ],
        }
      )
    );
    df.push(
      blank(
        'df-install',
        'RUN ___',
        'npm ci',
        'npm ci installs exactly what package-lock.json says, so everyone on the team gets identical dependencies. In dev the devDependencies (test runners, nodemon) are wanted, so nothing is omitted.',
        {
          concept: 'layer-caching',
          prompt: 'install command',
          accept: ['npm install', 'npm i'],
          hint: 'Install dependencies, including dev ones, from the lock file.',
          feedback: [
            { match: /--omit=dev|--production|--only=prod/, why: 'This is the dev image: you want devDependencies here (test runners, watchers). Omit them in the production build instead.' },
            { match: /^npm start|^node /, why: 'This step installs dependencies; starting the app comes later in CMD.' },
          ],
        }
      )
    );
    df.push(line('df-copy-src', 'COPY . .', 'Now the application source. It changes most often, so it comes last. In dev, compose bind-mounts your folder over this anyway, but the copy means the image also works standalone.', { concept: 'layer-caching' }));
    if (sqlite) df.push(sqliteEnv());
  }

  df.push(
    blank(
      'df-expose',
      'EXPOSE ___',
      String(PORT),
      `Documentation, not a firewall rule. It records that the app listens on ${PORT} so tools and teammates know which port to publish. It opens nothing by itself: the ports: line in compose does that.`,
      {
        concept: 'expose-vs-publish',
        prompt: 'port',
        hint: 'Which port does your Express app call listen() on? The compose ports: line has the same number on its right-hand side.',
        feedback: [
          { match: /:/, why: 'EXPOSE takes only the container port. The host:container mapping belongs in compose, not the Dockerfile.' },
          { match: /^(80|443|8080)$/, why: 'Those are conventional web ports, but the question is which port *your app* listens on. Express apps in this preset use 3000.' },
          { match: /^8000$/, why: '8000 is the Django default. This is a Node app; check what your server listens on.' },
        ],
      }
    )
  );
  df.push(
    blank(
      'df-cmd',
      'CMD ___',
      prod ? '["node", "server.js"]' : '["node", "--watch", "server.js"]',
      prod
        ? 'The command the container runs. The JSON ("exec") form runs node directly as process 1, so it receives SIGTERM when Docker stops the container and can shut down cleanly. "npm start" would put npm in between and swallow that signal. Change server.js to your actual entry file.'
        : 'The command the container runs. node --watch restarts the server when files change, which works with the bind mount in compose. The JSON ("exec") form runs node directly as process 1 so it receives stop signals. Change server.js to your entry file.',
      {
        concept: 'expose-vs-publish',
        prompt: 'command in JSON form',
        accept: prod
          ? [/^\["node",\s*"[\w./-]+\.[cm]?js"\]$/, /^\["node",\s*"src\/[\w./-]+"\]$/]
          : [/^\["node",\s*"--watch",\s*"[\w./-]+"\]$/, /^\["npm",\s*"run",\s*"dev"\]$/],
        hint: 'A JSON array: the program, then its arguments. Run node on your entry file' + (prod ? '.' : ', with a flag that restarts on file changes.'),
        feedback: [
          { match: /^\["npm",\s*"start"\]$/, why: 'Works, but npm sits between Docker and your app and does not forward SIGTERM, so stops take 10 seconds and skip your cleanup. Run node directly.' },
          { match: /^[^[]/, why: 'Use the JSON array ("exec") form: ["node", "server.js"]. The plain string form runs through a shell, which becomes process 1 and hides signals from your app.' },
          { match: /python|gunicorn/, why: 'This is a Node app; the command has to start node.' },
        ],
      }
    )
  );

  const compose = composeLines({ appType: 'node', database, target, port: PORT, devMounts: ['/app/node_modules'], dataDir: DATA_DIR });
  const dockerignore = dockerignoreLines({
    sqlite,
    ignore: [
      blank('i-node-modules', '___', 'node_modules', 'The largest folder in most Node projects, and the image installs its own copy with npm anyway. Sending it would be slow, and native modules compiled on macOS would not run on Linux.', {
        concept: 'dockerignore',
        prompt: 'folder to exclude',
        hint: 'Which folder does npm install create, and which the image will recreate itself?',
        feedback: [{ match: /package/, why: 'The manifests are needed inside the image. It is the installed packages folder that should stay out.' }],
      }),
      line('i-npm-log', 'npm-debug.log', 'Crash logs from failed installs. Junk that would otherwise be copied into the image.', { concept: 'dockerignore' }),
    ],
  });

  return { dockerfile: df, compose, dockerignore, port: PORT };
}

module.exports = { build, PORT, BASE };
