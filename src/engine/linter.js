'use strict';
// Mode 3 checker. Reads a Dockerfile, compose file and .dockerignore the user
// wrote from scratch and reports problems with reasons, never the answer.
// It is deliberately conceptual: it does not run Docker (out of scope) and it
// does not parse YAML fully; it looks for the shapes a correct file must have.
//
// Each finding: { level: 'error'|'warn'|'ok', file, concept, message, hint }
//   error  the file would not work or is unsafe in a way the course covers
//   warn   works, but a mastered concept says you can do better
//   ok     something done right; shown so the user sees what they got

const { DB_SPECS } = require('./compose');
const { CONCEPT_MAP } = require('./concepts');

const DEFAULT_PORTS = { node: 3000, django: 8000, static: 80, generic: 8080 };

function parseDockerfile(text) {
  const instructions = [];
  const lines = String(text || '').split(/\r?\n/);
  let buf = null;
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i];
    const trimmed = l.trim();
    if (!buf && (trimmed === '' || trimmed.startsWith('#'))) continue;
    const cont = /\\\s*$/.test(l);
    l = l.replace(/\\\s*$/, '');
    if (buf) buf.raw += ' ' + l.trim();
    else buf = { raw: l.trim(), line: i + 1 };
    if (cont) continue;
    const m = buf.raw.match(/^(\w+)\s*(.*)$/s);
    if (m) instructions.push({ name: m[1].toUpperCase(), args: m[2].trim(), line: buf.line });
    buf = null;
  }
  if (buf) {
    const m = buf.raw.match(/^(\w+)\s*(.*)$/s);
    if (m) instructions.push({ name: m[1].toUpperCase(), args: m[2].trim(), line: buf.line });
  }
  return instructions;
}

function lintDockerfile(text, answers) {
  const F = [];
  const ins = parseDockerfile(text);
  const add = (level, concept, message, hint) => F.push({ level, file: 'Dockerfile', concept, message, hint: hint || null });
  const has = (name) => ins.some((i) => i.name === name);
  const all = (name) => ins.filter((i) => i.name === name);

  if (ins.length === 0) {
    add('error', 'base-images', 'The Dockerfile is empty.', 'Every Dockerfile starts with FROM. What image does your app need to run on top of?');
    return F;
  }

  // FROM & pinning
  const froms = all('FROM');
  if (froms.length === 0) {
    add('error', 'base-images', 'No FROM instruction. A Dockerfile has to start from a base image.', 'What runtime does your app need? There is an official image for it.');
  } else {
    if (ins[0].name !== 'FROM' && ins[0].name !== 'ARG') add('error', 'base-images', `The first instruction is ${ins[0].name}, but it must be FROM (only ARG may precede it).`);
    for (const f of froms) {
      const image = f.args.split(/\s+/)[0];
      if (/^scratch$/i.test(image)) continue;
      if (!image.includes(':') && !image.includes('@')) add('error', 'base-images', `\`FROM ${image}\` has no tag, which means :latest.`, 'A tag that moves means a build that changes. What version are you actually developing against?');
      else if (/:latest$/.test(image)) add('error', 'base-images', `\`FROM ${image}\` pins nothing.`, 'latest is a label that gets moved to every new release. Name the version.');
      else add('ok', 'base-images', `Base image ${image} is pinned.`);
      const expected = { node: /^node/, django: /^python/, static: /^(nginx|caddy|httpd)/ }[answers.appType];
      if (expected && !expected.test(image) && froms.length === 1) add('warn', 'base-images', `\`${image}\` is an unusual base for a ${answers.appType} app.`, 'Is there an official image that already has your runtime installed and patched?');
    }
  }

  if (!has('WORKDIR') && answers.appType !== 'static') add('warn', 'layer-caching', 'No WORKDIR. Files will land in / and every path in COPY, RUN and CMD has to be absolute.', 'Pick a folder for the app and set it once; later instructions are relative to it.');

  // Layer caching: manifest copied before install, source after.
  const copies = ins.filter((i) => i.name === 'COPY' || i.name === 'ADD');
  const runs = all('RUN');
  const manifestRe = { node: /package(-lock)?\.json|package\*?\.json/, django: /requirements[\w*]*\.txt|pyproject\.toml|requirements\//, generic: /go\.(mod|sum)|Gemfile|pom\.xml|Cargo\.toml|composer\.json|requirements|package\.json|\.csproj/ }[answers.appType];
  const installRe = { node: /npm (ci|install|i\b)|yarn|pnpm/, django: /pip3? install|poetry install|uv (pip|sync)/, generic: /install|go mod download|bundle|mvn|cargo (build|fetch)|composer/ }[answers.appType];
  if (manifestRe && installRe) {
    const manifestCopy = copies.find((c) => manifestRe.test(c.args) && !/^\.\s+\.?\/?\S*$/.test(c.args.replace(/--\S+\s+/g, '')));
    const install = runs.find((r) => installRe.test(r.args));
    const copyAll = copies.find((c) => /^(\.|\.\/)\s+/.test(c.args.replace(/--\S+\s+/g, '')));
    if (!install) add('error', 'layer-caching', 'No RUN step installs dependencies.', `Something has to turn ${answers.appType === 'node' ? 'package.json' : answers.appType === 'django' ? 'requirements.txt' : 'your manifest'} into installed packages inside the image.`);
    else if (!manifestCopy) add('warn', 'layer-caching', 'The dependency manifest is not copied on its own before the install step.', 'Which file describes your dependencies? If it is copied alone first, the install layer is cached until that file changes.');
    else if (manifestCopy.line > install.line) add('error', 'layer-caching', 'The manifest is copied after the install step runs, so the install has nothing to work with.', 'The install step can only see files copied above it.');
    else if (copyAll && copyAll.line < install.line) add('warn', 'layer-caching', 'COPY . . comes before the dependency install, so any source edit invalidates the install layer.', 'What is the one thing the install step needs? Copy that first, the rest after.');
    else add('ok', 'layer-caching', 'Manifest copied before install, source after: the install layer is cacheable.');
    if (!copyAll && !copies.some((c) => !manifestRe.test(c.args))) add('error', 'layer-caching', 'The application source is never copied into the image.', 'After dependencies are installed, the code itself still has to get in.');
  }
  if (answers.appType === 'static' && !copies.some((c) => /nginx\/html|\/srv|\/usr\/share/.test(c.args))) add('error', 'layer-caching', 'Nothing is copied to the folder the web server serves from.', 'Check the image documentation for its document root and COPY the site there.');

  // Multi-stage (prod, node/django)
  if (answers.target === 'prod' && ['node', 'django'].includes(answers.appType)) {
    if (froms.length < 2) add('warn', 'multi-stage-builds', 'Single-stage build for a production target: build tooling and dev dependencies ship in the final image.', 'A second FROM starts a clean image. What is the minimum the final stage has to copy from the first?');
    else if (!copies.some((c) => /--from=/.test(c.args))) add('error', 'multi-stage-builds', 'There are multiple stages but nothing is copied between them, so the first stage is wasted.', 'The final stage needs the installed dependencies from the earlier one. COPY has a flag for that.');
    else add('ok', 'multi-stage-builds', 'Multi-stage build with COPY --from: the final image only gets what is copied in.');
    if (answers.appType === 'node' && runs.some((r) => /npm (ci|install)/.test(r.args)) && !runs.some((r) => /--omit=dev|--production|--only=prod/.test(r.args))) add('warn', 'multi-stage-builds', 'npm installs devDependencies into a production image.', 'Test runners and linters never run in production. npm has a flag to leave them out.');
    if (answers.appType === 'django' && has('CMD') && /runserver/.test(all('CMD')[0].args)) add('error', 'expose-vs-publish', 'Production CMD uses runserver, the single-threaded development server.', 'Django documents which servers are meant for production. gunicorn is the usual choice.');
  }

  // Non-root. Only enforced for production targets: dev images in this
  // course stay root on purpose so bind-mounted files keep host ownership.
  // The nginx image manages its own worker privileges, so static is skipped.
  const user = all('USER');
  const lastUser = user.length ? user[user.length - 1] : null;
  if (answers.appType === 'static') {
    // nothing to check
  } else if (!lastUser || /^root$|^0$/.test(lastUser.args)) {
    if (answers.target === 'prod') add('error', 'non-root-user', 'The app runs as root inside the container.', 'Who should the process run as? Node images ship a user; Python images need one created. It goes after the setup steps, before CMD.');
  } else {
    const cmdIdx = ins.findIndex((i) => i.name === 'CMD' || i.name === 'ENTRYPOINT');
    const installAfterUser = runs.some((r) => r.line > lastUser.line && /apt-get|apk add|useradd|npm ci|pip install/.test(r.args));
    if (installAfterUser) add('error', 'non-root-user', `USER ${lastUser.args} comes before a RUN step that needs root, so that step will fail with permission errors.`, 'Do the privileged setup first; switch users only when nothing else needs root.');
    else if (cmdIdx !== -1 && ins[cmdIdx].line < lastUser.line) add('warn', 'non-root-user', 'USER appears after CMD; it still applies, but reads out of order.');
    else add('ok', 'non-root-user', `Runs as ${lastUser.args}, not root.`);
    if (answers.appType === 'django' && lastUser.args !== 'root' && !runs.some((r) => /useradd|adduser/.test(r.args))) add('error', 'non-root-user', `USER ${lastUser.args} is set but no RUN step creates that account. The python image ships no unprivileged user.`, 'An account has to exist before you can switch to it.');
  }

  // EXPOSE & CMD
  const expose = all('EXPOSE');
  const port = DEFAULT_PORTS[answers.appType];
  if (expose.length === 0) add('warn', 'expose-vs-publish', 'No EXPOSE. The image works, but nobody reading it can tell which port to publish.', 'Which port does the app listen on inside the container?');
  else if (expose.some((e) => e.args.includes(':'))) add('error', 'expose-vs-publish', 'EXPOSE with host:container syntax. EXPOSE takes only the container port; publishing is done in compose.', 'EXPOSE documents; ports: in compose connects.');
  else add('ok', 'expose-vs-publish', `EXPOSE ${expose.map((e) => e.args).join(', ')} documents the listening port.`);

  const cmd = all('CMD').concat(all('ENTRYPOINT'));
  if (answers.appType === 'static') {
    // nginx image has its own CMD.
  } else if (cmd.length === 0) add('error', 'expose-vs-publish', 'No CMD or ENTRYPOINT: the container has nothing to run.', 'What command starts your app? Put it in JSON array form.');
  else {
    const c = cmd[cmd.length - 1];
    if (!c.args.startsWith('[')) add('warn', 'expose-vs-publish', 'CMD in shell form: a shell becomes process 1 and your app will not receive the stop signal Docker sends.', 'The JSON array form runs the program directly.');
    if (/npm start|npm run/.test(c.args) && answers.target === 'prod') add('warn', 'expose-vs-publish', 'CMD goes through npm, which does not forward SIGTERM to node; stops take 10s and skip cleanup.', 'Run the node binary on your entry file directly.');
    if (/127\.0\.0\.1|localhost/.test(c.args)) add('error', 'expose-vs-publish', 'The app binds to localhost inside the container, so published traffic is refused.', 'Inside a container, localhost is the container. Which address accepts connections from any interface?');
    if (answers.appType === 'django' && /runserver/.test(c.args) && !/0\.0\.0\.0/.test(c.args)) add('error', 'expose-vs-publish', 'runserver without an address binds 127.0.0.1, which refuses the traffic compose forwards in.', 'Tell runserver to listen on all interfaces.');
  }

  // SQLite: the data folder must exist and belong to the non-root user.
  if (answers.database === 'sqlite' && answers.target === 'prod' && lastUser && !/^root$|^0$/.test(lastUser.args)) {
    const prep = runs.find((r) => /mkdir/.test(r.args) && /chown/.test(r.args) && r.line < lastUser.line);
    if (!prep) add('error', 'non-root-user', 'SQLite writes to a folder inside the container, but nothing creates that folder and hands it to the non-root user before USER.', 'Who owns the directory a volume gets mounted on? What can still run as root at that point in the file?');
    else add('ok', 'non-root-user', 'Data directory is created and owned by the app user before switching users.');
  }

  // Hygiene
  if (runs.some((r) => /apt-get install/.test(r.args) && !/rm -rf \/var\/lib\/apt\/lists/.test(r.args))) add('warn', 'layer-caching', 'apt-get install without cleaning /var/lib/apt/lists in the same RUN leaves package indexes in the layer.', 'Anything created and deleted in different RUN steps still exists in the earlier layer.');
  if (runs.some((r) => /apt-get (upgrade|dist-upgrade)/.test(r.args))) add('warn', 'base-images', 'apt-get upgrade in a Dockerfile makes builds non-reproducible.', 'Get a newer base image instead; that is what the tag is for.');
  if (copies.some((c) => /\.env\b/.test(c.args))) add('error', 'dockerignore', 'A .env file is explicitly copied into the image. Secrets baked into a layer are permanent.', 'Secrets should reach the container at run time, not build time.');
  if (has('ADD') && !all('ADD').some((a) => /^https?:|\.tar/.test(a.args))) add('warn', 'layer-caching', 'ADD used where COPY would do. ADD has extra behaviours (URL fetch, tar extraction) that surprise readers.');

  return F;
}

function lintCompose(text, answers) {
  const F = [];
  const add = (level, concept, message, hint) => F.push({ level, file: 'docker-compose.yml', concept, message, hint: hint || null });
  const src = String(text || '');
  if (!src.trim()) {
    add('error', 'compose-networking', 'The compose file is empty.', 'It needs a services: section with at least the app.');
    return F;
  }
  const lines = src.split(/\r?\n/);
  // Top-level and service-level keys via indentation.
  const top = lines.filter((l) => /^\S/.test(l)).map((l) => l.trim().replace(/:.*$/, ''));
  const services = [];
  let inServices = false;
  for (const l of lines) {
    if (/^\S/.test(l)) inServices = /^services\s*:/.test(l);
    else if (inServices && /^\s{2}[\w.-]+\s*:/.test(l) && !/^\s{3,}/.test(l)) services.push(l.trim().replace(/:.*$/, ''));
  }
  const block = (name) => {
    const start = lines.findIndex((l) => new RegExp(`^\\s{2}${name}\\s*:`).test(l));
    if (start === -1) return '';
    const out = [];
    for (let i = start + 1; i < lines.length; i++) {
      if (/^\S/.test(lines[i]) || /^\s{2}[\w.-]+\s*:/.test(lines[i]) && !/^\s{3,}/.test(lines[i])) break;
      out.push(lines[i]);
    }
    return out.join('\n');
  };

  if (/^version\s*:/m.test(src)) add('warn', 'compose-networking', 'The version: key is obsolete; modern compose ignores it.', 'Only services:, volumes: and networks: matter at the top level.');
  if (!top.includes('services')) { add('error', 'compose-networking', 'No services: section.', 'Every container you want is a service under that key.'); return F; }
  if (services.length === 0) { add('error', 'compose-networking', 'services: is empty.', 'The app itself has to be a service.'); return F; }

  const db = DB_SPECS[answers.database] || null;
  const appName = services.find((s) => !(db && s === db.service) && !/^(db|postgres|redis|database|cache)$/.test(s)) || services[0];
  const app = block(appName);

  if (!/build\s*:/.test(app)) add('error', 'compose-networking', `Service "${appName}" has no build: so it never uses your Dockerfile.`, 'How does compose know to build an image from the Dockerfile in this folder?');
  else add('ok', 'compose-networking', `"${appName}" is built from the Dockerfile.`);

  const port = DEFAULT_PORTS[answers.appType];
  const portsMatch = app.match(/ports\s*:\s*\n((?:\s+-.*\n?)+)/);
  if (!portsMatch) add('error', 'expose-vs-publish', `"${appName}" publishes no ports, so nothing on your machine can reach it.`, 'EXPOSE in the Dockerfile documents; something in compose has to actually forward a port in.');
  else {
    const entries = portsMatch[1].match(/-\s*"?([\w.:]+)"?/g) || [];
    const containerSides = entries.map((e) => e.replace(/-\s*"?/, '').replace(/"$/, '').split(':').pop());
    if (!containerSides.includes(String(port))) add('warn', 'expose-vs-publish', `Published ports map to container port ${containerSides.join(', ') || '?'}, but a ${answers.appType} app in this course listens on ${port}.`, 'The right-hand side has to be the port the process inside actually binds.');
    else add('ok', 'expose-vs-publish', `Port ${port} is published.`);
    if (entries.some((e) => !/:/.test(e.replace(/-\s*"?/, '')))) add('warn', 'expose-vs-publish', 'A ports: entry has a single number, so Docker picks a random host port each start.', 'host:container makes the address predictable.');
  }

  if (db) {
    if (/localhost|127\.0\.0\.1/.test(app)) add('error', 'compose-networking', 'The app is configured to reach the database at localhost, which inside its container is itself.', 'What hostname does compose give every service?');
    const dbSvc = services.find((s) => s === db.service) || services.find((s) => new RegExp(`image\\s*:\\s*(${db.imageNames.join('|')})`).test(block(s)));
    if (!dbSvc) add('error', 'compose-networking', `No service runs ${answers.database}.`, 'The database is a second container: another entry under services: using the official image.');
    else {
      const d = block(dbSvc);
      const img = (d.match(/image\s*:\s*(\S+)/) || [])[1];
      if (!img) add('error', 'base-images', `Service "${dbSvc}" has no image:.`, 'The database is not built from your Dockerfile; it comes ready-made from a registry.');
      else if (!img.includes(':') || /:latest$/.test(img)) add('error', 'base-images', `Database image \`${img}\` is not pinned; a surprise major upgrade can make the data volume unreadable.`, 'Name the major version.');
      else add('ok', 'base-images', `Database image ${img} is pinned.`);
      const volMatch = d.match(/volumes\s*:\s*\n((?:\s+-.*\n?)+)/);
      const dataMount = volMatch && (volMatch[1].match(/-\s*"?([^:\s"]+):([^\s"]+)/) || []);
      if (!volMatch || !volMatch[1].includes(db.dataPath)) add('error', 'volumes-vs-bind-mounts', `"${dbSvc}" has no volume on ${db.dataPath}, so every docker compose down wipes the data.`, 'The container filesystem is disposable. Where does the database write its files, and what kind of mount keeps them?');
      else if (dataMount && /^[./]/.test(dataMount[1])) add('warn', 'volumes-vs-bind-mounts', `"${dbSvc}" data is on a bind mount (${dataMount[1]}). Works on Linux, but slow and permission-prone on macOS/Windows.`, 'Docker-managed storage avoids the ownership problems.');
      else {
        add('ok', 'volumes-vs-bind-mounts', `"${dbSvc}" data is on a named volume.`);
        const name = dataMount && dataMount[1];
        if (name && !new RegExp(`^volumes\\s*:[\\s\\S]*^\\s{2}${name}\\s*:`, 'm').test(src)) add('error', 'volumes-vs-bind-mounts', `Named volume "${name}" is used but not declared under the top-level volumes: key.`, 'compose needs to know which storage to create.');
      }
      if (!/healthcheck\s*:/.test(d)) add('warn', 'compose-networking', `"${dbSvc}" has no healthcheck, so depends_on can only wait for "created", not "ready".`, 'What command tells you the database accepts connections?');
      if (/ports\s*:/.test(d)) add('warn', 'compose-networking', `"${dbSvc}" publishes a port to your machine. Fine for poking at it with a client, but the app does not need it.`, 'Services on the compose network talk directly; ports: only opens things to the outside.');

      // App -> db wiring.
      if (!/depends_on\s*:/.test(app)) add('warn', 'compose-networking', `"${appName}" has no depends_on, so it may start before ${dbSvc} exists.`);
      else if (!/service_healthy/.test(app)) add('warn', 'compose-networking', 'depends_on waits for the database container to exist, not to be ready.', 'There is a condition that uses the healthcheck.');
      else add('ok', 'compose-networking', 'App waits for the database healthcheck.');
      const envText = app + '\n';
      const urlMentions = envText.match(new RegExp(`(${db.urlEnv}|_HOST|HOST)\\s*[=:]\\s*"?([^\\s"]+)`, 'g')) || [];
      if (/localhost|127\.0\.0\.1/.test(envText)) { /* already reported above */ }
      else if (!/env_file\s*:/.test(app) && !new RegExp(`\\b${dbSvc}\\b`).test(envText.replace(/depends_on[\s\S]*?(?=\n\s{4}\S|$)/, ''))) add('warn', 'compose-networking', `Nothing in "${appName}" points the app at host "${dbSvc}".`, 'The app needs a connection URL or host variable, and the host is the service name.');
      else add('ok', 'compose-networking', 'App is pointed at the database by service name or env file.');
      if (answers.target === 'prod' && /PASSWORD\s*[:=]\s*\S+/i.test(src) && !/\$\{/.test(src)) add('warn', 'env-vars', 'A password is written inline in a production compose file, which is normally committed.', 'compose can load variables from a file that git ignores.');
      void urlMentions;
    }
  }

  if (answers.database === 'sqlite') {
    const volMatch = app.match(/volumes\s*:\s*\n((?:\s+-.*\n?)+)/);
    const named = volMatch && (volMatch[1].match(/-\s*"?([a-z][\w-]*):(\S+?)"?\s*$/m) || []);
    if (services.some((s) => /^(db|postgres|mariadb|mysql|sqlite)$/.test(s))) add('warn', 'compose-networking', 'There is a database service, but SQLite is a library inside the app, not a server. Nothing would connect to that container.', 'What does the app actually need in order to keep its SQLite file safe?');
    if (!volMatch) add('error', 'volumes-vs-bind-mounts', `"${appName}" mounts nothing, so the SQLite file is deleted with the container.`, 'The container filesystem is disposable. What kind of storage does Docker manage for you?');
    else if (!named) add('warn', 'volumes-vs-bind-mounts', `"${appName}" has mounts but no named volume, so the database file lives on a bind mount in your project tree.`, 'Fine on Linux, but easy to commit or COPY by accident. What keeps data out of the source tree entirely?');
    else {
      add('ok', 'volumes-vs-bind-mounts', `SQLite data is on the named volume "${named[1]}".`);
      if (!new RegExp(`^volumes\\s*:[\\s\\S]*^\\s{2}${named[1]}\\s*:`, 'm').test(src)) add('error', 'volumes-vs-bind-mounts', `Named volume "${named[1]}" is used but not declared under the top-level volumes: key.`, 'compose needs to know which storage to create.');
    }
  }

  if (answers.target === 'dev') {
    if (!/volumes\s*:/.test(app)) add('warn', 'volumes-vs-bind-mounts', `Dev target but "${appName}" mounts nothing, so every edit needs a rebuild.`, 'What kind of mount makes your working folder appear inside the container?');
    else if (answers.appType === 'node' && /-\s*"?\.\/?:/.test(app) && !/-\s*"?\/app\/node_modules"?\s*$/m.test(app)) add('warn', 'volumes-vs-bind-mounts', 'The bind mount will shadow the container\'s node_modules with the copy from your machine.', 'An extra volume entry with only a container path keeps the container\'s own copy.');
    else add('ok', 'volumes-vs-bind-mounts', 'Source is mounted for live editing.');
  } else if (/-\s*"?\.\/?:\/?app/.test(app)) add('warn', 'volumes-vs-bind-mounts', 'Production target bind-mounts the source folder, so the image contents are ignored at run time.', 'In production the image is the artefact; mounts are for dev.');

  return F;
}

function lintDockerignore(text, answers) {
  const F = [];
  const add = (level, message, hint) => F.push({ level, file: '.dockerignore', concept: 'dockerignore', message, hint: hint || null });
  const entries = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (entries.length === 0) { add('error', 'No .dockerignore. Everything in the folder, including secrets, goes to the builder and into COPY . .', 'Which folders are huge, and which files hold secrets?'); return F; }
  const covers = (name) => entries.some((e) => e === name || e === name + '/' || e === '**/' + name || e === '*' || e === '**' || (e.includes('*') && new RegExp('^' + e.replace(/\./g, '\\.').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '$').test(name)));
  if (!covers('.env')) add('error', '.env is not ignored, so COPY . . bakes your secrets into a permanent layer.', 'Anything in the build context can end up in the image.');
  else add('ok', '.env is kept out of the image.');
  if (!covers('.git')) add('warn', '.git is not ignored; the whole history is sent to the builder on every build.');
  if (answers.appType === 'node' && !covers('node_modules')) add('error', 'node_modules is not ignored. Sending it is slow and native modules built on your OS will not run in the container.', 'The image installs its own copy anyway.');
  if (answers.database === 'sqlite' && !(covers('app.db') || covers('db.sqlite3') || covers('data') || entries.some((e) => /\*\.(db|sqlite3?)$/.test(e)))) add('warn', 'A local SQLite file (*.db, *.sqlite3) is not ignored; a copy would be baked into the image, stale from day one.');
  if (answers.appType === 'django' && !(covers('__pycache__') || covers('*.pyc'))) add('warn', 'Python bytecode (__pycache__) is not ignored.');
  if (answers.appType === 'django' && !(covers('.venv') || covers('venv'))) add('warn', 'A local virtualenv (.venv) would be copied in; it holds binaries for your OS.');
  return F;
}

function lint(files, answers) {
  const findings = [...lintDockerfile(files.dockerfile, answers), ...lintCompose(files.compose, answers), ...lintDockerignore(files.dockerignore, answers)];
  for (const f of findings) f.conceptTitle = f.concept && CONCEPT_MAP[f.concept] ? CONCEPT_MAP[f.concept].title : null;
  const summary = {
    errors: findings.filter((f) => f.level === 'error').length,
    warnings: findings.filter((f) => f.level === 'warn').length,
    ok: findings.filter((f) => f.level === 'ok').length,
  };
  return { findings, summary, passed: summary.errors === 0 };
}

module.exports = { lint, lintDockerfile, lintCompose, lintDockerignore, parseDockerfile };
