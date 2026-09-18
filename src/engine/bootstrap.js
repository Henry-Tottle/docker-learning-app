'use strict';
// Two things the generated files alone do not tell a newcomer:
//   usageSteps()     where to save the files, what to call them, how to run them
//   bootstrapLines() how to create a project from nothing, inside the container,
//                    for people who chose "starting fresh" in the wizard
// Both are pure and depend only on the wizard answers.
const { line, raw } = require('./lines');
const { DB_SPECS } = require('./compose');
const { DOCS } = require('./links');
const node = require('./presets/node');
const django = require('./presets/django');
const generic = require('./presets/generic');

const MANIFEST = { node: 'package.json', django: 'requirements.txt', static: 'index.html', generic: 'your dependency manifest' };

// The one-liner that runs a command inside a throwaway container of the base
// image with the current folder mounted at /app. $PWD works in bash, zsh and
// PowerShell; cmd.exe users substitute %cd%.
const inBase = (image, cmd) => `docker run --rm -v "$PWD:/app" -w /app ${image} sh -c "${cmd}"`;

const RUN_WHY =
  'A throwaway container from the same base image the Dockerfile uses. -v mounts the current folder at /app (a bind mount, exactly like the dev compose file), -w makes it the working directory, and --rm deletes the container afterwards. Whatever the command creates lands on your disk through the mount. $PWD works in bash, zsh and PowerShell; in cmd.exe write %cd% instead.';

const CHOWN = line(
  'b-chown',
  'sudo chown -R "$USER" .    # Linux only, and only if the new files show as owned by root',
  'The container ran as root, and on a Linux host a bind mount passes that ownership straight through, so the files it created may belong to root. macOS and Windows translate ownership for you, so this step is not needed there. This is the same reason production images switch to a non-root user.',
  { concept: 'non-root-user', links: [DOCS.bindMounts] }
);

function upLine(hostPort) {
  return line(
    'b-up',
    'docker compose up --build',
    `Builds the image from the Dockerfile, creates the containers and streams their logs. Open http://localhost:${hostPort} in a browser. Ctrl+C stops it; docker compose down removes the containers (add -v to also delete named volumes and their data). --build can be dropped once the Dockerfile stops changing.`,
    { concept: 'expose-vs-publish', links: [DOCS.composeRun, DOCS.composeDown] }
  );
}

function bootstrapLines(answers, hostPort) {
  const prod = answers.target === 'prod';
  const db = DB_SPECS[answers.database] || null;
  const L = [raw('# Getting started: run these in the folder where you saved the three files above.'), raw('')];

  if (answers.appType === 'django') {
    L.push(raw('# 1. Create a file called requirements.txt containing:'));
    L.push(
      line(
        'b-manifest',
        prod ? 'Django>=5.1,<6\ngunicorn>=23' : 'Django>=5.1,<6',
        'The Dockerfile copies requirements.txt before anything else, so it must exist before the first build. It is a plain text file you write by hand, one package per line. The version range pins the major so a future Django 6 cannot arrive uninvited.' +
          (prod ? ' gunicorn is the production server the CMD line runs.' : '') +
          (db ? ` You will add the ${answers.database === 'postgres' ? 'psycopg[binary]' : 'mysqlclient'} driver here once the project exists.` : ''),
        { links: [DOCS.pipRequirements] }
      )
    );
    L.push(raw(''), raw('# 2. Generate the project inside a throwaway container of the same base image:'));
    L.push(
      line(
        'b-generate',
        inBase(django.BASE, 'pip install -r requirements.txt && django-admin startproject config .'),
        RUN_WHY + ' django-admin startproject creates manage.py and a config/ package; the name config matches the gunicorn command in the production preset, and the trailing dot means "in this folder".',
        { concept: 'volumes-vs-bind-mounts', links: [DOCS.dockerRun, DOCS.djangoTutorial] }
      )
    );
  } else if (answers.appType === 'node') {
    L.push(raw('# 1. Create package.json and install express inside a throwaway container of the same base image:'));
    L.push(
      line(
        'b-generate',
        inBase(node.BASE, 'npm init -y && npm install express'),
        RUN_WHY + ' npm init -y writes a default package.json and npm install adds express and creates package-lock.json, the two files the Dockerfile copies first.',
        { concept: 'volumes-vs-bind-mounts', links: [DOCS.dockerRun, DOCS.npmInit] }
      )
    );
    L.push(raw(''), raw('# 2. Create a file called server.js containing:'));
    L.push(
      line(
        'b-server',
        "const express = require('express');\nconst app = express();\napp.get('/', (req, res) => res.send('Hello from a container'));\napp.listen(3000, '0.0.0.0', () => console.log('listening on 3000'));",
        'The smallest possible app, named to match the CMD line in the Dockerfile. It listens on 3000 to match EXPOSE and the compose ports: line, and binds 0.0.0.0 because inside a container "localhost" would mean the container itself and refuse the traffic compose forwards in.',
        { concept: 'expose-vs-publish', links: [DOCS.expressHello] }
      )
    );
  } else if (answers.appType === 'static') {
    L.push(raw('# 1. Create a file called index.html containing:'));
    L.push(
      line(
        'b-index',
        '<!doctype html>\n<title>Hello</title>\n<h1>Served by nginx from a container</h1>',
        'nginx serves whatever is in its document root, and index.html is what it returns for "/". There is nothing to install and no manifest: the whole site is the files themselves, which is why this preset has no dependency step and no CMD.',
        { concept: 'layer-caching', links: [DOCS.nginxImage] }
      )
    );
  } else {
    L.push(raw('# 1. Create the project with your stack\'s own init command, inside a throwaway container of your base image:'));
    L.push(
      line(
        'b-generate',
        inBase(generic.BASE, 'echo replace this with your init command, e.g. go mod init example.com/app'),
        RUN_WHY + ' Use the base image you put in the FROM line so the generated project is built with the same toolchain the image will run.',
        { concept: 'volumes-vs-bind-mounts', links: [DOCS.dockerRun] }
      )
    );
  }

  if (answers.appType !== 'static') {
    L.push(raw(''), raw('# Next, Linux hosts only:'));
    L.push(CHOWN);
  }
  L.push(raw(''), raw('# Finally, build and run:'));
  L.push(upLine(hostPort));
  if (answers.appType === 'django' && db) {
    const next = {
      postgres: `add psycopg[binary]>=3 to requirements.txt and point DATABASES in settings.py at the ${db.urlEnv} environment variable.`,
      mariadb: `add mysqlclient>=2 to requirements.txt and point DATABASES in settings.py at the ${db.urlEnv} environment variable.`,
      redis: `add redis>=5 to requirements.txt and read ${db.urlEnv} from the environment wherever you create the client.`,
    }[answers.database];
    L.push(raw(''), raw(`# Then: ${next}`));
  }
  return L;
}

function usageSteps(answers, hostPort) {
  const prod = answers.target === 'prod';
  const db = DB_SPECS[answers.database] || null;
  const fresh = answers.start === 'fresh';
  const steps = [];

  steps.push({
    title: 'Save the three files',
    body: fresh
      ? 'Make a new, empty folder for the project and save all three files into it. The Getting started file below then creates the project itself in that folder.'
      : `Save all three into the root of your project: the folder that holds ${MANIFEST[answers.appType]}. Not a subfolder. The Dockerfile's COPY lines are relative to that folder.`,
    code: 'Dockerfile\ndocker-compose.yml\n.dockerignore',
    notes: [
      'The first file is called exactly Dockerfile: capital D, no extension. Windows sometimes saves a download as Dockerfile.txt; rename it if so.',
      '.dockerignore starts with a dot, which makes it a hidden file on macOS and Linux. Use the terminal or "show hidden files" to see it.',
    ],
  });

  if (prod && db) {
    const lines = [`${db.urlEnv}=${db.url}`, ...db.env.map(([k, v]) => `${k}=${v}`)];
    steps.push({
      title: 'Create a .env file',
      body: 'The production compose file loads configuration from .env, which is deliberately not generated and is git-ignored. Create it next to the compose file. These are development values; change the password before this goes anywhere real.',
      code: lines.join('\n'),
      notes: [],
    });
  }

  steps.push({
    title: fresh ? 'Follow Getting started' : 'Build and run',
    body: fresh
      ? 'The Getting started file at the bottom of this page creates the project inside a container and then starts it.'
      : `From that folder, build the image and start everything. The first build downloads the base image, so it takes a minute; later builds reuse cached layers.`,
    code: fresh ? null : 'docker compose up --build',
    notes: fresh ? [] : [`Then open http://localhost:${hostPort}. Ctrl+C stops it; docker compose down removes the containers, and docker compose down -v also deletes named volumes and their data.`],
  });

  return steps;
}

// A short comment header prepended to the copy-all text.
function usageHeader(answers, hostPort) {
  return [
    '# Save these as Dockerfile (no extension), docker-compose.yml and .dockerignore',
    answers.start === 'fresh' ? '# in a new empty folder, then follow the Getting started section.' : `# in the folder that holds ${MANIFEST[answers.appType]}, then run: docker compose up --build`,
    `# App will be at http://localhost:${hostPort}`,
    '',
  ].join('\n');
}

module.exports = { bootstrapLines, usageSteps, usageHeader, MANIFEST };
