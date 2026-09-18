'use strict';
const { line, raw, blank } = require('../lines');
const { composeLines, dockerignoreLines } = require('../compose');

const BASE = 'python:3.12-slim-bookworm';
const PORT = 8000;

const baseImageBlank = (id, template, extra) =>
  blank(
    id,
    template,
    BASE,
    'The base image: minimal Debian ("bookworm") with Python 3.12 preinstalled. Pinning the minor version keeps builds reproducible; -slim leaves out compilers and docs, so the image is smaller and has fewer packages to keep patched.' + (extra || ''),
    {
      concept: 'base-images',
      prompt: 'image:tag',
      accept: [/^python:3\.1[1-3](\.\d+)?(-slim(-bookworm|-bullseye)?|-bookworm|-alpine)?$/],
      hint: 'The official python image, pinned to a 3.x minor version, ideally the slim Debian variant: name:version-variant-os.',
      feedback: [
        { match: /^python:latest$/, why: 'latest moves to each new Python release. Django and its packages are tested against specific minors; pin the one you use.' },
        { match: /^python$/, why: 'No tag means :latest, which changes under you. Pin the version.' },
        { match: /^python:3\.(\d|10)($|[.-])/, why: 'That Python line is old. Match the version you develop on (3.12).' },
        { match: /^python:3$/, why: 'Better than latest, but 3 will jump to the next minor when it is released. Pin the minor: 3.12.' },
        { match: /^(ubuntu|debian|alpine)/, why: 'You would then have to install Python yourself and keep it patched. The official python image already does that.' },
        { match: /^node|^nginx/, why: 'Django runs on Python, so the base image needs a Python runtime.' },
      ],
    }
  );

const DATA_DIR = '/app/data';

// Python database drivers that need OS packages. Build-time packages go in
// the builder stage, run-time libraries in the final one.
const NATIVE = {
  postgres: { driver: 'psycopg (the Postgres driver)', build: 'build-essential libpq-dev', runtime: 'libpq5', runtimeWhy: 'The Postgres driver needs the client *library* at run time (libpq5) but not the headers or compiler.' },
  mariadb: { driver: 'mysqlclient (the MariaDB/MySQL driver)', build: 'build-essential pkg-config default-libmysqlclient-dev', runtime: 'libmariadb3', runtimeWhy: 'The MariaDB driver needs the client *library* at run time (libmariadb3) but not the headers, pkg-config or compiler.' },
};

const sqliteEnv = () =>
  line(
    'df-sqlite-env',
    `ENV DATABASE_PATH=${DATA_DIR}/db.sqlite3`,
    'Where Django should keep its SQLite file. Set in the Dockerfile as a default so the path is fixed by the image layout. Point DATABASES["default"]["NAME"] at os.environ["DATABASE_PATH"] in settings.py; compose mounts a volume at that folder so the file outlives the container.',
    { concept: 'env-vars' }
  );

function build({ database, target }) {
  const df = [];
  const prod = target === 'prod';
  const native = NATIVE[database] || null;
  const pg = !!native;
  const sqlite = database === 'sqlite';

  if (prod) {
    df.push(line('df-syntax', '# syntax=docker/dockerfile:1', 'Opts in to the current Dockerfile syntax so features like multi-stage COPY --from behave consistently across Docker versions.'));
    df.push(baseImageBlank('df-base', 'FROM ___ AS builder', ' "AS builder" names this stage so the final stage can copy the installed packages out of it.'));
    df.push(line('df-pip-env', 'ENV PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_CACHE_DIR=1', 'Stops pip phoning home about its own version and stops it writing a download cache into the image layer. Both are noise that would only make the image bigger.', { concept: 'env-vars' }));
    if (pg) {
      df.push(
        line(
          'df-build-deps',
          `RUN apt-get update && apt-get install -y --no-install-recommends ${native.build} && rm -rf /var/lib/apt/lists/*`,
          `${native.driver} may need a C compiler and the database client headers to build. They belong in this throwaway stage only: the final image will get just the compiled result. Cleaning the apt lists in the same RUN keeps them out of the layer.`,
          { concept: 'multi-stage-builds' }
        )
      );
    }
    df.push(line('df-workdir', 'WORKDIR /app', 'Creates /app and makes it the current directory for every later instruction, so relative paths in COPY, RUN and CMD are predictable.'));
    df.push(
      blank(
        'df-manifest',
        'COPY ___ ./',
        'requirements.txt',
        'Only the dependency list is copied first, on purpose. Docker caches each instruction while its inputs are unchanged, so the pip install below is reused across builds until requirements.txt itself changes. Copying all the source here would rerun pip on every edit. No requirements.txt yet? It is a one-line text file you write by hand; see Getting started.',
        {
          concept: 'layer-caching',
          prompt: 'file to copy',
          accept: ['requirements*.txt', 'requirements/'],
          hint: 'Which file lists your Python dependencies? Copy only that before installing.',
          feedback: [
            { match: /^\.$/, why: 'Copying everything here would invalidate the install layer on every source edit, so pip install would rerun each build. Copy only the requirements file first.' },
            { match: /manage\.py|\.py$/, why: 'Source changes often. Copy it after dependencies are installed so the install layer stays cached.' },
            { match: /pyproject/, why: 'Only if your project uses pyproject.toml for dependencies. This preset assumes requirements.txt.' },
          ],
        }
      )
    );
    df.push(
      blank(
        'df-install',
        'RUN ___',
        'pip install --prefix=/install -r requirements.txt',
        'Installs the packages into /install instead of the system site-packages. That gives the final stage one clean folder to copy, rather than trying to pick installed files out of the whole filesystem.',
        {
          concept: 'multi-stage-builds',
          prompt: 'install command',
          accept: [/^pip install (--no-cache-dir )?--prefix[= ]\/install (--no-cache-dir )?-r requirements\.txt$/, /^pip install (--no-cache-dir )?-r requirements\.txt (--no-cache-dir )?--prefix[= ]\/install$/],
          hint: 'pip install from the requirements file, but with --prefix so everything lands in one folder (/install) that the next stage can copy.',
          feedback: [
            { match: /^pip install -r requirements\.txt$/, why: 'That works in a single-stage image, but here the final stage needs to copy the result. Install with --prefix=/install so it lands in one known folder.' },
            { match: /python manage\.py|gunicorn/, why: 'This step installs packages; running the app comes later in CMD.' },
            { match: /apt/, why: 'apt installs OS packages. Python packages come from pip and requirements.txt.' },
          ],
        }
      )
    );
    df.push(raw(''));
    df.push(line('df-base-runtime', `FROM ${BASE}`, 'A second FROM starts the final image from a clean base. The compiler and headers installed above are not carried over; only what is explicitly copied is.', { concept: 'multi-stage-builds' }));
    df.push(line('df-py-env', 'ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1', 'No .pyc files cluttering the image, and unbuffered stdout so log lines show up in docker logs immediately instead of when a buffer fills.', { concept: 'env-vars' }));
    if (sqlite) df.push(sqliteEnv());
    if (pg) {
      df.push(
        line(
          'df-runtime-deps',
          `RUN apt-get update && apt-get install -y --no-install-recommends ${native.runtime} && rm -rf /var/lib/apt/lists/*`,
          `${native.runtimeWhy} This is the payoff of the two stages: build tools stayed behind; only the small runtime library is installed here.`,
          { concept: 'multi-stage-builds' }
        )
      );
    }
    df.push(line('df-workdir2', 'WORKDIR /app', 'Each stage starts fresh, so the working directory has to be set again.'));
    df.push(
      blank(
        'df-copy-deps',
        'COPY --from=___ /install /usr/local',
        'builder',
        'Copies the installed packages from the builder stage into the place Python looks for them. This is the multi-stage trick: the final image gets the result of pip install without pip\'s cache, the compiler or the headers.',
        {
          concept: 'multi-stage-builds',
          prompt: 'stage name',
          hint: 'Look at the first FROM line. What did it name that stage with AS?',
          feedback: [
            { match: /^python/, why: '--from can name an image, but here you want the stage built above, referenced by the name after AS.' },
            { match: /^\.|^\//, why: '--from takes a stage name; the source path comes after it.' },
          ],
        }
      )
    );
    df.push(line('df-copy-src', 'COPY . .', 'Now the project source. It changes most often, so it comes last: nothing expensive runs after it. .dockerignore decides what "." actually includes.', { concept: 'layer-caching' }));
    df.push(
      line(
        'df-useradd',
        'RUN useradd --create-home --uid 1000 appuser && chown -R appuser:appuser /app',
        'Unlike the node image, python ships no unprivileged account, so one is created. The app folder is handed to it so Django can write collected static files or a SQLite file if needed.',
        { concept: 'non-root-user' }
      )
    );
    if (sqlite) {
      df.push(
        line(
          'df-data-dir',
          `RUN mkdir -p ${DATA_DIR} && chown appuser:appuser ${DATA_DIR}`,
          'Creates the folder the volume will be mounted on and hands it to the unprivileged user. This runs as root, before USER, because the app will not have permission to do it later. Without it, the first migrate fails with a permission error.',
          { concept: 'non-root-user' }
        )
      );
    }
    df.push(
      blank(
        'df-user',
        'USER ___',
        'appuser',
        'Switches away from root before the app starts. Everything above needed root (apt, useradd); the running app does not. If Django is compromised the attacker gets a limited user, not root in the container.',
        {
          concept: 'non-root-user',
          prompt: 'user name',
          hint: 'The account created by the useradd line just above.',
          feedback: [
            { match: /^root$/, why: 'root is the default and exactly what this line exists to avoid.' },
            { match: /^(node|www-data|nobody|django)$/, why: 'That account does not exist in this image. Use the one the RUN useradd line created.' },
          ],
        }
      )
    );
  } else {
    df.push(baseImageBlank('df-base', 'FROM ___'));
    df.push(line('df-py-env', 'ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1', 'No .pyc files cluttering the image, and unbuffered stdout so log lines show up in docker logs immediately instead of when a buffer fills.', { concept: 'env-vars' }));
    if (sqlite) df.push(sqliteEnv());
    if (pg) {
      df.push(
        line(
          'df-build-deps',
          `RUN apt-get update && apt-get install -y --no-install-recommends ${native.build} && rm -rf /var/lib/apt/lists/*`,
          `${native.driver} may need a C compiler and database client headers to build. In a dev image that is acceptable; the production preset moves them into a separate build stage.`,
          { concept: 'multi-stage-builds' }
        )
      );
    }
    df.push(line('df-workdir', 'WORKDIR /app', 'Creates /app and makes it the current directory for every later instruction, so relative paths in COPY, RUN and CMD are predictable.'));
    df.push(
      blank(
        'df-manifest',
        'COPY ___ ./',
        'requirements.txt',
        'Only the dependency list is copied first, on purpose. Docker caches each instruction while its inputs are unchanged, so the pip install below is reused across builds until requirements.txt itself changes. No requirements.txt yet? It is a one-line text file you write by hand; see Getting started.',
        {
          concept: 'layer-caching',
          prompt: 'file to copy',
          accept: ['requirements*.txt'],
          hint: 'Which file lists your Python dependencies? Copy only that before installing.',
          feedback: [
            { match: /^\.$/, why: 'Copying everything here would rerun pip install on every source edit. Copy only the requirements file first.' },
            { match: /manage\.py|\.py$/, why: 'Source changes often. Copy it after dependencies are installed so the install layer stays cached.' },
          ],
        }
      )
    );
    df.push(
      blank(
        'df-install',
        'RUN ___',
        'pip install --no-cache-dir -r requirements.txt',
        'Installs the dependencies. --no-cache-dir stops pip storing downloaded wheels in the layer, which would only make the image bigger.',
        {
          concept: 'layer-caching',
          prompt: 'install command',
          accept: ['pip install -r requirements.txt', 'pip3 install -r requirements.txt', 'pip3 install --no-cache-dir -r requirements.txt'],
          hint: 'pip install from the requirements file.',
          feedback: [
            { match: /python manage\.py|gunicorn|runserver/, why: 'This step installs packages; running the app comes later in CMD.' },
            { match: /apt/, why: 'apt installs OS packages. Python packages come from pip and requirements.txt.' },
          ],
        }
      )
    );
    df.push(line('df-copy-src', 'COPY . .', 'Now the project source. It changes most often, so it comes last. In dev, compose bind-mounts your folder over this anyway, but the copy means the image also works standalone.', { concept: 'layer-caching' }));
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
        hint: 'Which port does the Django server bind to? The compose ports: line has the same number on its right-hand side.',
        feedback: [
          { match: /:/, why: 'EXPOSE takes only the container port. The host:container mapping belongs in compose.' },
          { match: /^3000$/, why: '3000 is the Node preset. Django conventionally serves on 8000.' },
          { match: /^(80|443|8080)$/, why: 'Conventional web ports, but the question is what port the app itself binds. This preset binds 8000.' },
        ],
      }
    )
  );
  df.push(
    blank(
      'df-cmd',
      'CMD ___',
      prod ? '["gunicorn", "config.wsgi:application", "--bind", "0.0.0.0:8000"]' : '["python", "manage.py", "runserver", "0.0.0.0:8000"]',
      prod
        ? 'gunicorn is a production WSGI server; runserver is single-threaded and for development only. --bind 0.0.0.0 matters: published traffic arrives on the container\'s network interface, and binding 127.0.0.1 would refuse it. Change config.wsgi to your project\'s wsgi module.'
        : 'Django\'s dev server with auto-reload, bound to 0.0.0.0. Inside a container "localhost" means the container itself, so the default 127.0.0.1 would reject the traffic compose forwards in. The JSON form runs python directly as process 1 so it gets stop signals.',
      {
        concept: 'expose-vs-publish',
        prompt: 'command in JSON form',
        accept: prod
          ? [/^\["gunicorn",\s*"[\w.]+:application",\s*"(--bind|-b)",\s*"0\.0\.0\.0:8000"\]$/, /^\["gunicorn",\s*"(--bind|-b)",\s*"0\.0\.0\.0:8000",\s*"[\w.]+:application"\]$/]
          : [/^\["python",\s*"manage\.py",\s*"runserver",\s*"0\.0\.0\.0:8000"\]$/],
        hint: prod ? 'A JSON array running gunicorn on your wsgi module, bound to all interfaces on 8000.' : 'A JSON array running manage.py runserver, bound to all interfaces (0.0.0.0) on 8000.',
        feedback: [
          { match: /127\.0\.0\.1|localhost/, why: 'Inside the container, localhost is the container. Traffic from compose arrives on the container\'s own interface, so bind 0.0.0.0.' },
          { match: /runserver"?\]$|runserver$/, why: 'runserver defaults to 127.0.0.1, which refuses traffic forwarded in by Docker. Add 0.0.0.0:8000.' },
          { match: /^[^[]/, why: 'Use the JSON array ("exec") form so python is process 1 and receives stop signals: ["python", "manage.py", ...].' },
          { match: prod ? /runserver/ : /gunicorn/, why: prod ? 'runserver is a development server: single-threaded, no hardening. Production images should run a WSGI server such as gunicorn.' : 'gunicorn is right for production; for the dev image runserver gives you auto-reload and the debug page.' },
        ],
      }
    )
  );

  const compose = composeLines({ appType: 'django', database, target, port: PORT, devMounts: [], dataDir: DATA_DIR });
  const dockerignore = dockerignoreLines({
    sqlite,
    ignore: [
      blank('i-pycache', '___', '__pycache__', 'Compiled bytecode from your machine. Python regenerates it, and copies built by a different Python version are useless at best.', {
        concept: 'dockerignore',
        prompt: 'folder to exclude',
        accept: ['**/__pycache__', '*.pyc', '**/*.pyc'],
        hint: 'Which folders does Python create next to your .py files to store compiled bytecode?',
        feedback: [{ match: /requirements|manage/, why: 'Those are needed in the image. The thing to exclude is generated bytecode.' }],
      }),
      line('i-venv', '.venv\nvenv', 'A virtualenv from your machine contains binaries for your OS and a copy of every package. The image installs its own from requirements.txt.', { concept: 'dockerignore' }),
      ...(sqlite ? [] : [line('i-sqlite', 'db.sqlite3', 'A local development database. Data does not belong in an image: it would be stale, and every copy of the image would carry it.', { concept: 'dockerignore' })]),
    ],
  });

  return { dockerfile: df, compose, dockerignore, port: PORT };
}

module.exports = { build, PORT, BASE };
