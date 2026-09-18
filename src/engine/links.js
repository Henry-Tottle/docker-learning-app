'use strict';
// Every "read more" link the app offers, in one place so URLs are easy to
// audit and update. Explanations reference these by key.
const DOCS = {
  from: { href: 'https://docs.docker.com/reference/dockerfile/#from', label: 'Dockerfile reference: FROM' },
  digest: { href: 'https://docs.docker.com/reference/cli/docker/image/pull/#pull-an-image-by-digest-immutable-identifier', label: 'Pulling an image by digest (an immutable identifier)' },
  syntax: { href: 'https://docs.docker.com/reference/dockerfile/#syntax', label: 'Dockerfile reference: the syntax directive' },
  cache: { href: 'https://docs.docker.com/build/cache/', label: 'Docker build cache: how layer invalidation works' },
  layers: { href: 'https://docs.docker.com/get-started/docker-concepts/building-images/understanding-image-layers/', label: 'Understanding image layers' },
  multistage: { href: 'https://docs.docker.com/build/building/multi-stage/', label: 'Multi-stage builds' },
  user: { href: 'https://docs.docker.com/reference/dockerfile/#user', label: 'Dockerfile reference: USER' },
  nodeNonRoot: { href: 'https://github.com/nodejs/docker-node/blob/main/docs/BestPractices.md#non-root-user', label: 'Node image best practices: non-root user' },
  nodeSignals: { href: 'https://github.com/nodejs/docker-node/blob/main/docs/BestPractices.md#handling-kernel-signals', label: 'Node image best practices: handling kernel signals' },
  expose: { href: 'https://docs.docker.com/reference/dockerfile/#expose', label: 'Dockerfile reference: EXPOSE' },
  publish: { href: 'https://docs.docker.com/engine/network/#published-ports', label: 'Published ports' },
  cmd: { href: 'https://docs.docker.com/reference/dockerfile/#cmd', label: 'Dockerfile reference: CMD (exec form vs shell form)' },
  env: { href: 'https://docs.docker.com/reference/dockerfile/#env', label: 'Dockerfile reference: ENV' },
  healthcheck: { href: 'https://docs.docker.com/reference/dockerfile/#healthcheck', label: 'Dockerfile reference: HEALTHCHECK' },
  dockerignore: { href: 'https://docs.docker.com/build/concepts/context/#dockerignore-files', label: '.dockerignore files and the build context' },
  composePorts: { href: 'https://docs.docker.com/reference/compose-file/services/#ports', label: 'Compose file reference: ports' },
  composeEnvFile: { href: 'https://docs.docker.com/reference/compose-file/services/#env_file', label: 'Compose file reference: env_file' },
  composeEnv: { href: 'https://docs.docker.com/compose/how-tos/environment-variables/set-environment-variables/', label: 'Setting environment variables in Compose' },
  composeNetworking: { href: 'https://docs.docker.com/compose/how-tos/networking/', label: 'Networking in Compose' },
  startupOrder: { href: 'https://docs.docker.com/compose/how-tos/startup-order/', label: 'Controlling startup order in Compose' },
  composeHealthcheck: { href: 'https://docs.docker.com/reference/compose-file/services/#healthcheck', label: 'Compose file reference: healthcheck' },
  volumes: { href: 'https://docs.docker.com/engine/storage/volumes/', label: 'Volumes' },
  bindMounts: { href: 'https://docs.docker.com/engine/storage/bind-mounts/', label: 'Bind mounts' },
  composeVolumes: { href: 'https://docs.docker.com/reference/compose-file/volumes/', label: 'Compose file reference: top-level volumes' },
  npmCi: { href: 'https://docs.npmjs.com/cli/v10/commands/npm-ci', label: 'npm ci' },
  npmIgnoreScripts: { href: 'https://docs.npmjs.com/cli/v10/using-npm/config#ignore-scripts', label: 'npm config: ignore-scripts' },
  gunicorn: { href: 'https://docs.gunicorn.org/', label: 'Gunicorn documentation (see "Deploying Gunicorn")' },
  djangoDeploy: { href: 'https://docs.djangoproject.com/en/stable/howto/deployment/', label: 'Django: how to deploy' },
  runserver: { href: 'https://docs.djangoproject.com/en/stable/ref/django-admin/#runserver', label: 'Django: runserver is for development only' },
  pipCache: { href: 'https://pip.pypa.io/en/stable/topics/caching/', label: 'pip caching (and --no-cache-dir)' },
  distroless: { href: 'https://github.com/GoogleContainerTools/distroless', label: 'Distroless images: no shell, no package manager' },
  nginxImage: { href: 'https://hub.docker.com/_/nginx', label: 'Official nginx image' },
  postgresImage: { href: 'https://hub.docker.com/_/postgres', label: 'Official postgres image' },
  mariadbImage: { href: 'https://hub.docker.com/_/mariadb', label: 'Official mariadb image' },
  redisImage: { href: 'https://hub.docker.com/_/redis', label: 'Official redis image' },
  trivy: { href: 'https://trivy.dev/latest/docs/', label: 'Trivy vulnerability scanner' },
  sqliteWal: { href: 'https://www.sqlite.org/wal.html', label: 'SQLite write-ahead logging' },
};

const DB_IMAGE_LINK = { postgres: DOCS.postgresImage, mariadb: DOCS.mariadbImage, redis: DOCS.redisImage };

// Links per generated line id. A value may be an array, or an object keyed by
// appType with a `default` fallback.
const LINE_LINKS = {
  'df-syntax': [DOCS.syntax],
  'df-base': { static: [DOCS.from, DOCS.nginxImage, DOCS.digest], default: [DOCS.from, DOCS.digest] },
  'df-base-runtime': [DOCS.multistage],
  'df-manifest': [DOCS.cache, DOCS.layers],
  'df-install': { node: [DOCS.npmCi, DOCS.cache], django: [DOCS.pipCache, DOCS.cache], default: [DOCS.cache] },
  'df-copy-deps': [DOCS.multistage],
  'df-copy-src': [DOCS.cache],
  'df-copy': [DOCS.nginxImage],
  'df-env': [DOCS.env],
  'df-py-env': [DOCS.env],
  'df-pip-env': [DOCS.env, DOCS.pipCache],
  'df-sqlite-env': [DOCS.env],
  'df-build-deps': [DOCS.multistage],
  'df-runtime-deps': [DOCS.multistage],
  'df-useradd': [DOCS.user],
  'df-data-dir': [DOCS.user, DOCS.volumes],
  'df-user': { node: [DOCS.user, DOCS.nodeNonRoot], default: [DOCS.user] },
  'df-expose': [DOCS.expose, DOCS.publish],
  'df-cmd': { node: [DOCS.cmd, DOCS.nodeSignals], django: [DOCS.cmd, DOCS.gunicorn, DOCS.runserver, DOCS.djangoDeploy], default: [DOCS.cmd] },
  'c-app': [DOCS.composeNetworking],
  'c-build': [DOCS.composePorts],
  'c-ports': [DOCS.composePorts, DOCS.publish],
  'c-env': [DOCS.composeEnv],
  'c-env-file': [DOCS.composeEnvFile, DOCS.composeEnv],
  'c-db-url': [DOCS.composeNetworking],
  'c-depends': [DOCS.startupOrder],
  'c-depends-healthy': [DOCS.startupOrder],
  'c-volumes': [DOCS.volumes, DOCS.bindMounts],
  'c-bind': [DOCS.bindMounts],
  'c-anon--app-node-modules': [DOCS.volumes],
  'c-sqlite-volume': [DOCS.volumes, DOCS.composeVolumes],
  'c-db-service': [DOCS.composeNetworking],
  'c-db-env': [DOCS.composeEnv],
  'c-db-env-file': [DOCS.composeEnvFile],
  'c-db-volume': [DOCS.volumes],
  'c-db-health': [DOCS.composeHealthcheck, DOCS.startupOrder],
  'c-top-volumes': [DOCS.composeVolumes],
  'i-git': [DOCS.dockerignore],
  'i-env': [DOCS.dockerignore],
  'i-docker': [DOCS.dockerignore],
  'i-node-modules': [DOCS.dockerignore],
  'i-pycache': [DOCS.dockerignore],
  'i-sqlite': [DOCS.dockerignore],
};

function linksFor(lineId, answers) {
  const entry = LINE_LINKS[lineId];
  let list = [];
  if (Array.isArray(entry)) list = entry;
  else if (entry) list = entry[answers.appType] || entry.default || [];
  if (lineId === 'c-db-image' && DB_IMAGE_LINK[answers.database]) list = [DB_IMAGE_LINK[answers.database], DOCS.digest];
  return list;
}

module.exports = { DOCS, LINE_LINKS, linksFor };
