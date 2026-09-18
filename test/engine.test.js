'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const gen = require('../src/engine/generator');
const { CONCEPTS, CONCEPT_MAP, gradeQuiz } = require('../src/engine/concepts');
const { checkBlank } = require('../src/engine/lines');
const { lint, parseDockerfile } = require('../src/engine/linter');

const COMBOS = [];
for (const appType of ['node', 'django', 'static', 'generic'])
  for (const database of ['none', 'postgres', 'mariadb', 'sqlite', 'redis'])
    for (const target of ['dev', 'prod']) COMBOS.push({ appType, database, target });

test('every preset combination generates three files with unique ids and known concepts', () => {
  for (const answers of COMBOS) {
    const g = gen.generate(answers);
    assert.equal(g.files.length, 3, JSON.stringify(answers));
    const ids = gen.allLines(g).filter((l) => l.id).map((l) => l.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate ids in ' + JSON.stringify(answers));
    for (const l of gen.allLines(g)) if (l.concept) assert.ok(CONCEPT_MAP[l.concept], `unknown concept ${l.concept}`);
    assert.ok(g.concepts.length >= 4, 'too few concepts for ' + JSON.stringify(answers));
  }
});

test('every explanation is short and answers why (2-4 sentences, no wall of text)', () => {
  for (const answers of COMBOS) {
    for (const l of gen.explainableLines(gen.generate(answers))) {
      assert.ok(l.explain.length >= 40, `${l.id} explanation too short`);
      assert.ok(l.explain.length <= 620, `${l.id} explanation too long (${l.explain.length})`);
    }
  }
});

test('every blank accepts its own canonical answer and rejects garbage', () => {
  for (const answers of COMBOS) {
    for (const l of gen.blankLines(gen.generate(answers))) {
      assert.equal(checkBlank(l, l.blank.answer).correct, true, `${l.id} rejects its own answer`);
      assert.equal(checkBlank(l, '   ' + l.blank.answer + '  ').correct, true, `${l.id} is whitespace-sensitive`);
      assert.equal(checkBlank(l, '!!! not an answer !!!').correct, false, `${l.id} accepts garbage`);
      assert.ok(l.blank.hint, `${l.id} has no hint`);
      assert.ok(l.text === l.blank.template.replace('___', l.blank.answer), `${l.id} text/template mismatch`);
    }
  }
});

test('wrong answers get a specific reason where one is defined', () => {
  const g = gen.generate({ appType: 'node', database: 'postgres', target: 'prod' });
  const base = gen.findLine(g, 'df-base');
  assert.match(checkBlank(base, 'node:latest').why, /latest/);
  const url = gen.findLine(g, 'c-db-service');
  assert.match(checkBlank(url, 'localhost').why, /localhost/);
  const dev = gen.generate({ appType: 'node', database: 'postgres', target: 'dev' });
  assert.match(checkBlank(gen.findLine(dev, 'c-db-url'), 'postgres://app:app@localhost:5432/app').why, /localhost/);
  assert.equal(checkBlank(gen.findLine(dev, 'c-db-url'), 'postgres://user:pw@db:5432/whatever').correct, true);
});

test('static sites ignore the database choice', () => {
  const g = gen.generate({ appType: 'static', database: 'postgres', target: 'dev' });
  assert.equal(g.answers.database, 'none');
  assert.ok(!g.files[1].text.includes('db:'));
});

test('unknown answers fall back to safe defaults', () => {
  const g = gen.generate({ appType: 'cobol', database: 'oracle', target: 'staging' });
  assert.deepEqual(g.answers, { appType: 'node', database: 'none', target: 'dev' });
});

test('the linter passes the generator\'s own output for real presets', () => {
  for (const answers of COMBOS) {
    const g = gen.generate(answers);
    const report = lint({ dockerfile: g.files[0].text, compose: g.files[1].text, dockerignore: g.files[2].text }, g.answers);
    const problems = report.findings.filter((f) => f.level !== 'ok').map((f) => f.message);
    if (answers.appType === 'generic') {
      // The generic preset is intentionally a skeleton with TODO comments.
      assert.deepEqual(problems.map((m) => m.split('.')[0]), ['No RUN step installs dependencies', 'No CMD or ENTRYPOINT: the container has nothing to run']);
    } else {
      assert.deepEqual(problems, [], JSON.stringify(answers));
    }
  }
});

test('the linter catches the classic mistakes and never states the answer', () => {
  const answers = { appType: 'node', database: 'postgres', target: 'prod' };
  const report = lint(
    {
      dockerfile: 'FROM node\nWORKDIR /app\nCOPY . .\nRUN npm install\nCMD npm start\n',
      compose: "version: '3'\nservices:\n  web:\n    image: node\n    environment:\n      - DATABASE_URL=postgres://app:app@localhost:5432/app\n",
      dockerignore: '',
    },
    answers
  );
  const msgs = report.findings.map((f) => f.level + ':' + f.message);
  const expect = (re) => assert.ok(msgs.some((m) => re.test(m)), 'missing finding ' + re);
  expect(/error:.*no tag/);
  expect(/warn:.*Single-stage/);
  expect(/error:.*runs as root/);
  expect(/warn:.*No EXPOSE/);
  expect(/warn:.*shell form/);
  expect(/warn:.*version: key/);
  expect(/error:.*no build:/);
  expect(/error:.*publishes no ports/);
  expect(/error:.*No service runs postgres/);
  expect(/error:.*localhost/);
  expect(/error:.*No \.dockerignore/);
  assert.equal(report.passed, false);
  // Feedback, not answers: nothing in the report hands over the pinned image or the fixed line.
  for (const f of report.findings) {
    assert.ok(!/node:22-bookworm-slim|postgres:16-alpine/.test(f.message + f.hint), 'linter leaked an answer: ' + f.message);
  }
});

test('linter: USER before privileged RUN is flagged, and django needs useradd', () => {
  const r1 = lint({ dockerfile: 'FROM python:3.12-slim\nUSER appuser\nRUN pip install -r requirements.txt\nCMD ["python"]', compose: 'services:\n  app:\n    build: .\n    ports:\n      - "8000:8000"\n', dockerignore: '.env' }, { appType: 'django', database: 'none', target: 'prod' });
  assert.ok(r1.findings.some((f) => /before a RUN step that needs root/.test(f.message)));
  assert.ok(r1.findings.some((f) => /no RUN step creates that account/.test(f.message)));
});

test('linter: compose volume must be declared, bind mounts for db data warned', () => {
  const base = 'FROM node:22-slim\nWORKDIR /app\nCOPY package.json ./\nRUN npm ci\nCOPY . .\nUSER node\nEXPOSE 3000\nCMD ["node","server.js"]\n';
  const answers = { appType: 'node', database: 'postgres', target: 'dev' };
  const undeclared = lint({ dockerfile: base, compose: 'services:\n  app:\n    build: .\n    ports:\n      - "3000:3000"\n    environment:\n      - DATABASE_URL=postgres://a:b@db:5432/app\n    depends_on:\n      db:\n        condition: service_healthy\n    volumes:\n      - .:/app\n      - /app/node_modules\n  db:\n    image: postgres:16\n    volumes:\n      - pgdata:/var/lib/postgresql/data\n    healthcheck:\n      test: ["CMD", "pg_isready"]\n', dockerignore: '.env\nnode_modules' }, answers);
  assert.ok(undeclared.findings.some((f) => /not declared under the top-level volumes/.test(f.message)));
  const bind = lint({ dockerfile: base, compose: 'services:\n  app:\n    build: .\n    ports:\n      - "3000:3000"\n    volumes:\n      - .:/app\n      - /app/node_modules\n  db:\n    image: postgres:16\n    volumes:\n      - ./pgdata:/var/lib/postgresql/data\n', dockerignore: '.env\nnode_modules' }, answers);
  assert.ok(bind.findings.some((f) => /bind mount/.test(f.message) && f.file === 'docker-compose.yml'));
});

test('parseDockerfile handles continuations and comments', () => {
  const ins = parseDockerfile('# c\nFROM a:1\nRUN apt-get update && \\\n  apt-get install -y x\n\nCMD ["x"]');
  assert.deepEqual(ins.map((i) => i.name), ['FROM', 'RUN', 'CMD']);
  assert.match(ins[1].args, /update && apt-get install/);
});

test('quizzes: every question has exactly one correct option and per-option reasons', () => {
  for (const c of CONCEPTS) {
    assert.ok(c.quiz.length >= 2 && c.quiz.length <= 3, c.key + ' quiz size');
    for (const q of c.quiz) {
      assert.ok(q.options[q.answer], c.key + ' answer index out of range');
      for (const o of q.options) assert.ok(o.why && o.why.length > 15, c.key + ' option without reason');
    }
    const perfect = c.quiz.map((q) => q.answer);
    assert.equal(gradeQuiz(c, perfect).passed, true);
    const flawed = perfect.map((a, i) => (i === 0 ? (a + 1) % c.quiz[0].options.length : a));
    assert.equal(gradeQuiz(c, flawed).passed, false);
  }
});

test('every concept is reachable from at least one preset', () => {
  const seen = new Set();
  for (const answers of COMBOS) for (const k of gen.generate(answers).concepts) seen.add(k);
  for (const c of CONCEPTS) assert.ok(seen.has(c.key), `concept ${c.key} is never taught`);
});

test('sqlite is a volume on the app, not a second service', () => {
  for (const appType of ['node', 'django', 'generic']) {
    for (const target of ['dev', 'prod']) {
      const g = gen.generate({ appType, database: 'sqlite', target });
      const compose = g.files[1].text;
      assert.ok(!/^\s{2}db:/m.test(compose), `${appType}/${target} has a db service`);
      assert.match(compose, /app-data:\/app\/data/);
      assert.match(compose, /^volumes:\n  app-data:/m);
      assert.match(g.files[0].text, /ENV DATABASE_PATH=\/app\/data\//);
      if (target === 'prod') assert.match(g.files[0].text, /RUN mkdir -p \/app\/data && chown/);
      assert.ok(!g.concepts.includes('compose-networking'), 'sqlite should not require compose networking');
      assert.ok(g.concepts.includes('volumes-vs-bind-mounts'));
    }
  }
});

test('mariadb is a second service with mysql-compatible URL and image alternatives accepted', () => {
  const g = gen.generate({ appType: 'django', database: 'mariadb', target: 'prod' });
  assert.match(g.files[1].text, /image: mariadb:11\.4/);
  assert.match(g.files[0].text, /default-libmysqlclient-dev/);
  assert.match(g.files[0].text, /libmariadb3/);
  const dev = gen.generate({ appType: 'node', database: 'mariadb', target: 'dev' });
  assert.equal(checkBlank(gen.findLine(dev, 'c-db-url'), 'mariadb://u:p@db:3306/app').correct, true);
  assert.equal(checkBlank(gen.findLine(dev, 'c-db-image'), 'mysql:8.4').correct, true);
  assert.match(checkBlank(gen.findLine(dev, 'c-db-image'), 'mariadb').why, /latest/);
});

test('linter: sqlite without a volume or data-dir prep is caught', () => {
  const answers = { appType: 'node', database: 'sqlite', target: 'prod' };
  const r = lint({ dockerfile: 'FROM node:22-slim\nWORKDIR /app\nCOPY package.json ./\nRUN npm ci\nCOPY . .\nUSER node\nEXPOSE 3000\nCMD ["node","server.js"]\n', compose: 'services:\n  app:\n    build: .\n    ports:\n      - "3000:3000"\n', dockerignore: '.env\nnode_modules' }, answers);
  assert.ok(r.findings.some((f) => /nothing creates that folder/.test(f.message)));
  assert.ok(r.findings.some((f) => /deleted with the container/.test(f.message)));
  assert.ok(r.findings.some((f) => /SQLite file .* not ignored/.test(f.message)));
});
