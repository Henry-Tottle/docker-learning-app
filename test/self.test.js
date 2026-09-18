'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { selfWalkthrough } = require('../src/content/self');

test('every meaningful line of the real Dockerfile, compose and .dockerignore has an explanation', () => {
  for (const f of selfWalkthrough().files) {
    const missing = f.lines.filter((l) => l.missing).map((l) => l.text);
    assert.deepEqual(missing, [], `${f.name} has unexplained lines`);
    assert.ok(f.lines.some((l) => l.explain), `${f.name} has no explanations at all`);
  }
});

test('the real Dockerfile follows the practices the app teaches', () => {
  const df = selfWalkthrough().files[0].lines.map((l) => l.text);
  const froms = df.filter((l) => l.startsWith('FROM '));
  assert.equal(froms.length, 2, 'multi-stage');
  for (const f of froms) assert.match(f, /node:\d+\.\d+\.\d+-bookworm-slim/, 'pinned base');
  assert.ok(df.some((l) => l === 'USER node'), 'non-root');
  assert.ok(df.indexOf('USER node') > df.findIndex((l) => l.startsWith('RUN mkdir')), 'USER after privileged RUN');
  assert.ok(df.indexOf('COPY package.json package-lock.json ./') < df.findIndex((l) => l.startsWith('RUN npm ci')), 'manifest before install');
  const ignore = selfWalkthrough().files[2].lines.map((l) => l.text);
  for (const must of ['node_modules', '.env', 'data', '.git']) assert.ok(ignore.includes(must), `.dockerignore lacks ${must}`);
});
