'use strict';
// The generation engine. Turns wizard answers into annotated files.
// Pure: no I/O, so it is trivially testable and reusable.
const { toText } = require('./lines');
const { CONCEPT_MAP } = require('./concepts');

const PRESETS = {
  node: require('./presets/node'),
  django: require('./presets/django'),
  static: require('./presets/static'),
  generic: require('./presets/generic'),
};

const APP_TYPES = [
  { key: 'node', label: 'Node.js / Express', blurb: 'A JavaScript server started with node. package.json lists its dependencies.' },
  { key: 'django', label: 'Python / Django', blurb: 'A Python web app with manage.py and requirements.txt.' },
  { key: 'static', label: 'Static site', blurb: 'Plain HTML, CSS and JS with no server code. Served by nginx.' },
  { key: 'generic', label: 'Something else', blurb: 'A skeleton with the universal parts filled in and TODOs for your stack.' },
];
const DATABASES = [
  { key: 'none', label: 'No database', blurb: 'Just the app.' },
  { key: 'postgres', label: 'PostgreSQL', blurb: 'A relational database as a second service.' },
  { key: 'mariadb', label: 'MariaDB / MySQL', blurb: 'A relational database as a second service, MySQL-compatible.' },
  { key: 'sqlite', label: 'SQLite', blurb: 'A file inside the app container, kept on a volume. No second service.' },
  { key: 'redis', label: 'Redis', blurb: 'An in-memory store for caching, queues or sessions.' },
];
const TARGETS = [
  { key: 'dev', label: 'Development', blurb: 'Live-reload with your code mounted in. Bigger, friendlier image.' },
  { key: 'prod', label: 'Production', blurb: 'Multi-stage build, non-root user, nothing but what runs.' },
];

function normalizeAnswers(a) {
  const appType = APP_TYPES.some((t) => t.key === a.appType) ? a.appType : 'node';
  let database = DATABASES.some((d) => d.key === a.database) ? a.database : 'none';
  if (appType === 'static') database = 'none';
  const target = TARGETS.some((t) => t.key === a.target) ? a.target : 'dev';
  return { appType, database, target };
}

/**
 * @returns {{ answers, files: [{name, lines, text}], concepts: string[], port }}
 */
function generate(rawAnswers) {
  const answers = normalizeAnswers(rawAnswers);
  const preset = PRESETS[answers.appType];
  const out = preset.build(answers);
  const files = [
    { name: 'Dockerfile', key: 'dockerfile', lines: out.dockerfile },
    { name: 'docker-compose.yml', key: 'compose', lines: out.compose },
    { name: '.dockerignore', key: 'dockerignore', lines: out.dockerignore },
  ].map((f) => ({ ...f, text: toText(f.lines) }));

  // Validate invariants early so a broken preset fails loudly.
  const seen = new Set();
  for (const f of files) {
    for (const l of f.lines) {
      if (!l.id) continue;
      if (seen.has(l.id)) throw new Error(`duplicate line id ${l.id} in ${f.name}`);
      seen.add(l.id);
      if (l.concept && !CONCEPT_MAP[l.concept]) throw new Error(`unknown concept ${l.concept} on ${l.id}`);
    }
  }

  // Concepts relevant to this stack = every concept any generated line refers to.
  const concepts = [];
  for (const f of files) for (const l of f.lines) if (l.concept && !concepts.includes(l.concept)) concepts.push(l.concept);
  // Keep dashboard order.
  concepts.sort((a, b) => Object.keys(CONCEPT_MAP).indexOf(a) - Object.keys(CONCEPT_MAP).indexOf(b));

  return { answers, files, concepts, port: out.port };
}

function allLines(generated) {
  return generated.files.flatMap((f) => f.lines);
}
function explainableLines(generated) {
  return allLines(generated).filter((l) => l.id && l.explain);
}
function blankLines(generated) {
  return allLines(generated).filter((l) => l.blank);
}
function findLine(generated, id) {
  return allLines(generated).find((l) => l.id === id) || null;
}

module.exports = { generate, normalizeAnswers, allLines, explainableLines, blankLines, findLine, APP_TYPES, DATABASES, TARGETS };
