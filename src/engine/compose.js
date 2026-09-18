'use strict';
// Builds the docker-compose.yml and .dockerignore lines shared by presets.
// Presets pass in what differs (port, env, extra mounts); the reasoning for
// each line is written once here.
const { line, raw, blank } = require('./lines');

const DB_SPECS = {
  postgres: {
    service: 'db',
    image: 'postgres:16-alpine',
    port: 5432,
    volume: 'db-data',
    dataPath: '/var/lib/postgresql/data',
    urlEnv: 'DATABASE_URL',
    url: 'postgres://app:app@db:5432/app',
    healthcheck: 'pg_isready -U app -d app',
    env: [
      ['POSTGRES_USER', 'app'],
      ['POSTGRES_PASSWORD', 'app'],
      ['POSTGRES_DB', 'app'],
    ],
  },
  redis: {
    service: 'redis',
    image: 'redis:7-alpine',
    port: 6379,
    volume: 'redis-data',
    dataPath: '/data',
    urlEnv: 'REDIS_URL',
    url: 'redis://redis:6379/0',
    healthcheck: 'redis-cli ping',
    env: [],
  },
};

/**
 * @param {object} o
 * @param {string} o.appType      node | django | static | generic
 * @param {string} o.database     postgres | redis | none
 * @param {string} o.target       dev | prod
 * @param {number} o.port         container port the app listens on
 * @param {number} [o.hostPort]   host port to publish (defaults to port)
 * @param {string[]} [o.devMounts] extra anonymous volumes for dev (e.g. /app/node_modules)
 */
function composeLines(o) {
  const db = DB_SPECS[o.database] || null;
  const hostPort = o.hostPort || o.port;
  const L = [];

  L.push(
    line(
      'c-services',
      'services:',
      'A compose file is a list of services, each of which becomes one container. Older tutorials start with a version: key; modern compose ignores it, so it is left out.',
      { concept: 'compose-networking' }
    )
  );
  L.push(
    line(
      'c-app',
      '  app:',
      'The service name doubles as its hostname on the private network compose creates. Other services could reach this one at http://app:' + o.port + '.',
      { concept: 'compose-networking' }
    )
  );
  L.push(
    line(
      'c-build',
      '    build: .',
      'Instead of pulling a ready-made image, compose builds one from the Dockerfile in the current folder. Running docker compose up --build rebuilds it whenever the Dockerfile or source changes.'
    )
  );
  L.push(
    blank(
      'c-ports',
      '    ports:\n      - "___"',
      `${hostPort}:${o.port}`,
      `Publishes the app to your machine: traffic to localhost:${hostPort} on your laptop is forwarded to port ${o.port} inside the container. The format is host:container. Without this line the app runs but nothing outside the compose network can reach it.`,
      {
        concept: 'expose-vs-publish',
        prompt: 'host:container',
        accept: [new RegExp(`^"?${hostPort}:${o.port}"?$`)],
        hint: `Host port on the left, container port on the right. The app listens on ${o.port}.`,
        feedback: [
          { match: new RegExp(`^"?${o.port}:${hostPort}"?$`), why: hostPort === o.port ? 'Right numbers.' : 'Backwards. The left side is the port on your machine, the right side is the port the app listens on inside the container.' },
          { match: /^\d+$/, why: 'A single number publishes to a random host port. Use host:container so the address is predictable.' },
          { match: /localhost|127\.0\.0\.1/, why: 'Close. compose wants just the numbers, host:container. Binding to a specific address is a separate optional prefix.' },
        ],
      }
    )
  );

  // Environment: app config that differs between dev and prod.
  if (db) {
    if (o.target === 'prod') {
      L.push(
        line(
          'c-env-file',
          '    env_file: .env',
          'Loads variables like ' + db.urlEnv + '=' + db.url + ' from a .env file that is git-ignored. The compose file is committed and shared; the secrets in .env are not. Same mechanism as environment:, different place to keep the values.',
          { concept: 'env-vars' }
        )
      );
    } else {
      L.push(line('c-env', '    environment:', 'Environment variables are how configuration reaches the app without being hard-coded. Inline values are fine for a dev setup where the password is throwaway.', { concept: 'env-vars' }));
      L.push(
        blank(
          'c-db-url',
          `      - ${db.urlEnv}=___`,
          db.url,
          `The hostname in this URL is "${db.service}", the name of the database service below. compose gives every service a DNS entry, so the app connects by service name. "localhost" here would mean the app container itself, where no database is running.`,
          {
            concept: 'compose-networking',
            prompt: 'connection URL',
            accept: [new RegExp(`^${db.url.split('@')[0].split('//')[0]}//.*@${db.service}:${db.port}(/.*)?$`)],
            hint: `A URL of the form scheme://user:pass@HOST:${db.port}/name. The host is the service name of the database, not localhost.`,
            feedback: [
              { match: /localhost|127\.0\.0\.1/, why: 'Inside the app container, localhost is the app container. The database is a separate container reachable by its service name.' },
              { match: /@db-data|@postgres:|@redis-data/, why: 'Close, but the hostname must be the *service* name, the key you write under services:, not the image or volume name.' },
              { match: /^(postgres|redis)$/i, why: 'That is the database, not a connection URL. The app needs scheme://user:pass@host:port/name.' },
            ],
          }
        )
      );
    }
    L.push(line('c-depends', '    depends_on:', 'Start order. The app must not try to connect before the database exists.', { concept: 'compose-networking' }));
    L.push(line('c-depends-svc', `      ${db.service}:`, null));
    L.push(
      line(
        'c-depends-healthy',
        '        condition: service_healthy',
        `"Created" is not "ready". Without this the app can start while ${db.service} is still initialising and crash on its first connection. service_healthy waits for the healthcheck defined on the ${db.service} service.`,
        { concept: 'compose-networking' }
      )
    );
  }

  if (o.target === 'dev') {
    L.push(line('c-volumes', '    volumes:', 'Mounts for live development. Nothing here belongs in the production file.', { concept: 'volumes-vs-bind-mounts' }));
    L.push(
      blank(
        'c-bind',
        '      - ___:/app',
        '.',
        'A bind mount: the current folder on your machine appears at /app inside the container. Edits on your laptop are visible instantly, so the dev server can reload without rebuilding the image.',
        {
          concept: 'volumes-vs-bind-mounts',
          prompt: 'host path',
          accept: ['./', new RegExp('^\\./?$')],
          hint: 'Which folder on your machine holds the source code you are editing? Relative paths are relative to the compose file.',
          feedback: [
            { match: /^\/app$/, why: '/app is the container side. The left side is a path on your machine, and your project is the current folder.' },
            { match: /node_modules|__pycache__/, why: 'You want to mount the whole project, not just one folder.' },
            { match: /^[a-z][\w-]*$/i, why: 'A bare name is a named volume, which starts empty. To see your own files you need a path, and the project is the current folder.' },
          ],
        }
      )
    );
    for (const m of o.devMounts || []) {
      L.push(
        line(
          'c-anon-' + m.replace(/\W+/g, '-'),
          `      - ${m}`,
          `An anonymous volume with no host side. It exists so the bind mount above does not shadow ${m} with the copy from your machine, which may hold binaries built for the wrong OS. The container keeps its own.`,
          { concept: 'volumes-vs-bind-mounts' }
        )
      );
    }
  }

  if (db) {
    L.push(raw(''));
    L.push(
      blank(
        'c-db-service',
        '  ___:',
        db.service,
        `The database service. Its name is what the app uses as a hostname, so this must match the host in ${db.urlEnv}. Keep names short and boring.`,
        {
          concept: 'compose-networking',
          prompt: 'service name',
          hint: `Look at the hostname in ${db.urlEnv} on the app service. This key has to be that exact word.`,
          feedback: [
            { match: /localhost/, why: 'localhost cannot be a service name, and the app would not find the database under it anyway.' },
            { match: /:/, why: 'Just the name, no colon or image tag. The image goes on the next line.' },
          ],
        }
      )
    );
    L.push(
      blank(
        'c-db-image',
        '    image: ___',
        db.image,
        `A ready-made image from Docker Hub, pinned to a major version. No build: step here because nothing is customised. The -alpine variant is smaller; fine for a database because it needs no extra OS packages.`,
        {
          concept: 'base-images',
          prompt: 'image:tag',
          accept: [new RegExp(`^${o.database}:\\d+(\\.\\d+)*(-[a-z0-9.]+)?$`)],
          hint: `The official ${o.database} image with a version tag, like name:MAJOR-variant.`,
          feedback: [
            { match: /latest$/, why: 'latest is a moving target: a database upgrade you did not ask for can corrupt or refuse to open the data volume. Pin a major version.' },
            { match: new RegExp(`^${o.database}$`), why: 'No tag means latest. Pin a version so the data format stays stable.' },
            { match: /^(node|python|nginx|debian|ubuntu)/, why: `That is an application image. The database service needs the official ${o.database} image.` },
          ],
        }
      )
    );
    if (db.env.length && o.target === 'prod') {
      L.push(
        line(
          'c-db-env-file',
          '    env_file: .env',
          'The database reads ' + db.env.map(([k]) => k).join(', ') + ' from the same git-ignored .env the app uses, so the real password is written exactly once and never committed. Your .env would hold those three plus ' + db.urlEnv + '.',
          { concept: 'env-vars' }
        )
      );
    } else if (db.env.length) {
      L.push(line('c-db-env', '    environment:', 'The official image reads these on first start to create the database, user and password. Change them and the app\'s ' + db.urlEnv + ' must change to match. Inline is fine for a throwaway dev password; the production preset moves them to .env.', { concept: 'env-vars' }));
      for (const [k, v] of db.env) L.push(line('c-db-env-' + k.toLowerCase(), `      ${k}: ${v}`, null));
    }
    L.push(line('c-db-volumes', '    volumes:', null, { concept: 'volumes-vs-bind-mounts' }));
    L.push(
      blank(
        'c-db-volume',
        `      - ___:${db.dataPath}`,
        db.volume,
        `A named volume. The container's own filesystem is discarded when the container is removed, so without this every docker compose down would wipe the data. A named volume is Docker-managed storage that outlives containers, with permissions the database is happy with.`,
        {
          concept: 'volumes-vs-bind-mounts',
          prompt: 'volume name',
          accept: [new RegExp('^[a-z][a-z0-9_-]*$')],
          hint: 'A short name for Docker-managed storage. It must also be declared under the top-level volumes: key at the bottom.',
          feedback: [
            { match: /^\.\.?\//, why: 'A relative path makes this a bind mount from your machine. Database files on a bind mount are slow on macOS/Windows and often break on file ownership. Use a named volume.' },
            { match: /^\//, why: 'An absolute path makes this a bind mount from your machine. For database data, prefer a named volume that Docker manages.' },
          ],
        }
      )
    );
    L.push(line('c-db-health', '    healthcheck:', 'Tells compose how to know the database is actually accepting connections, which depends_on: service_healthy relies on.', { concept: 'compose-networking' }));
    L.push(line('c-db-health-test', `      test: ["CMD-SHELL", "${db.healthcheck}"]`, null));
    L.push(line('c-db-health-interval', '      interval: 5s', null));
    L.push(line('c-db-health-retries', '      retries: 10', null));
    L.push(raw(''));
    L.push(line('c-top-volumes', 'volumes:', 'Named volumes must be declared once at the top level. This is the list of storage compose will create and keep.', { concept: 'volumes-vs-bind-mounts' }));
    L.push(line('c-top-volume', `  ${db.volume}:`, null));
  }

  return L;
}

function dockerignoreLines(o) {
  const L = [];
  L.push(line('i-git', '.git', 'The whole git history would otherwise be sent to the builder on every build. It is large and can contain secrets from old commits.', { concept: 'dockerignore' }));
  L.push(
    blank(
      'i-env',
      '___',
      '.env',
      'Secrets. COPY . . would bake this file into a layer, and layers are permanent: deleting the file in a later instruction does not remove it from image history. The values reach the container through compose instead.',
      {
        concept: 'dockerignore',
        prompt: 'file to exclude',
        accept: ['.env*', '*.env'],
        hint: 'Which file holds the database password and other secrets that must never be inside the image?',
        feedback: [
          { match: /^env$/i, why: 'Almost: the file is a dotfile, so it starts with a dot.' },
          { match: /docker-compose|Dockerfile/, why: 'Those are not secrets. The file to protect is the one holding passwords.' },
        ],
      }
    )
  );
  for (const extra of o.ignore || []) L.push(extra);
  L.push(line('i-docker', 'Dockerfile\ndocker-compose.yml\n.dockerignore', 'The image does not need its own build instructions inside it. Harmless but pointless, and changing them would invalidate the COPY . . layer.', { concept: 'dockerignore' }));
  return L;
}

module.exports = { composeLines, dockerignoreLines, DB_SPECS };
