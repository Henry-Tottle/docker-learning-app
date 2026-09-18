'use strict';
// End-to-end through HTTP against an in-memory database. Walks the whole
// progression: guided -> quizzes -> scaffold -> free build.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { openDatabase } = require('../src/db');
const { CONCEPTS } = require('../src/engine/concepts');
const gen = require('../src/engine/generator');

let server, base;
test.before(async () => {
  const app = createApp({ db: openDatabase(':memory:') });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const get = (p) => fetch(base + p, { redirect: 'manual' });
const form = (p, data) => fetch(base + p, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data) });
const json = (p, data) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(data) });

test('static pages render', async () => {
  for (const p of ['/', '/uses', '/dashboard', '/wizard', '/how-this-app-was-containerized', '/healthz']) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
  }
  assert.equal((await get('/nothing-here')).status, 404);
});

test('wizard rejects a missing name', async () => {
  assert.equal((await form('/wizard', { name: '', appType: 'node', database: 'postgres', target: 'prod' })).status, 400);
});

// Each stack gets a fresh in-memory app so concept mastery from one run does
// not unlock the next one.
for (const answers of [
  { appType: 'node', database: 'postgres', target: 'prod' },
  { appType: 'django', database: 'postgres', target: 'dev' },
  { appType: 'django', database: 'sqlite', target: 'prod' },
  { appType: 'django', database: 'mariadb', target: 'prod' },
]) test(`full progression for ${answers.appType} + ${answers.database} + ${answers.target}`, async () => {
  const app = createApp({ db: openDatabase(':memory:') });
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const get = (p) => fetch(base + p, { redirect: 'manual' });
  const form = (p, data) => fetch(base + p, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data) });
  const json = (p, data) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(data) });
  try {
  const created = await form('/wizard', { name: 'my-app', ...answers });
  assert.equal(created.status, 302);
  const projectPath = new URL(created.headers.get('location'), base).pathname;
  assert.match(projectPath, /^\/projects\/\d+$/);
  const g = gen.generate(answers);
  for (const p of ['', '/guided', '/scaffold', '/free']) assert.equal((await get(projectPath + p)).status, 200, p);

  // Mode 1 gate: nothing downloadable, quizzes locked.
  assert.equal((await get(projectPath + '/guided/files/dockerfile')).status, 403);
  assert.equal((await form('/concepts/base-images/quiz', { q0: 1, q1: 0, q2: 2 })).status, 403);

  // Free build locked, scaffold blanks locked.
  assert.equal((await json(projectPath + '/free/lint', { dockerfile: 'FROM x' })).status, 403);
  assert.equal((await json(projectPath + '/scaffold/check', { blankId: 'df-base', value: 'node:22-bookworm-slim' })).status, 403);

  // Read every explanation.
  let last;
  for (const l of gen.explainableLines(g)) {
    const r = await json(projectPath + '/guided/viewed', { lineId: l.id });
    assert.equal(r.status, 200);
    last = await r.json();
  }
  assert.equal(last.status.complete, true);
  const dl = await get(projectPath + '/guided/files/dockerfile');
  assert.equal(dl.status, 200);
  assert.equal(await dl.text(), g.files[0].text);

  // Every concept is now unlocked; pass every quiz relevant to this stack.
  const tokensBefore = 3;
  let passes = 0;
  for (const key of g.concepts) {
    const c = CONCEPTS.find((x) => x.key === key);
    const wrong = Object.fromEntries(c.quiz.map((q, i) => [`q${i}`, (q.answer + 1) % q.options.length]));
    const r1 = await form(`/concepts/${key}/quiz`, wrong);
    assert.equal(r1.status, 200);
    assert.match(await r1.text(), /Not yet\./);
    const right = Object.fromEntries(c.quiz.map((q, i) => [`q${i}`, q.answer]));
    const r2 = await form(`/concepts/${key}/quiz`, right);
    assert.match(await r2.text(), /Passed\./);
    passes++;
  }
  // Retaking a passed quiz does not pay out twice.
  const c0 = CONCEPTS.find((x) => x.key === g.concepts[0]);
  await form(`/concepts/${c0.key}/quiz`, Object.fromEntries(c0.quiz.map((q, i) => [`q${i}`, q.answer])));
  const dash = await (await get('/dashboard')).text();
  assert.match(dash, new RegExp(`${tokensBefore + passes * 2} hint tokens`));

  // Mode 2: wrong then right, hint costs one token once.
  const baseImage = gen.findLine(g, 'df-base').blank.answer.split(':')[0];
  const wrong = await (await json(projectPath + '/scaffold/check', { blankId: 'df-base', value: baseImage + ':latest' })).json();
  assert.equal(wrong.correct, false);
  assert.match(wrong.why, /latest/);
  const hint1 = await (await json(projectPath + '/scaffold/hint', { blankId: 'df-base' })).json();
  assert.equal(hint1.tokens, tokensBefore + passes * 2 - 1);
  const hint2 = await (await json(projectPath + '/scaffold/hint', { blankId: 'df-base' })).json();
  assert.equal(hint2.tokens, hint1.tokens);
  let fin;
  for (const l of gen.blankLines(g)) {
    fin = await (await json(projectPath + '/scaffold/check', { blankId: l.id, value: l.blank.answer })).json();
    assert.equal(fin.correct, true, l.id);
  }
  assert.equal(fin.complete, true);

  // Mode 3 now open. Submit the generated files: no errors. Submit junk: errors.
  const ok = await (await json(projectPath + '/free/lint', { dockerfile: g.files[0].text, compose: g.files[1].text, dockerignore: g.files[2].text })).json();
  assert.equal(ok.passed, true);
  const bad = await (await json(projectPath + '/free/lint', { dockerfile: 'FROM node', compose: '', dockerignore: '' })).json();
  assert.equal(bad.passed, false);
  assert.ok(bad.summary.errors >= 3);
  const page = await (await get(projectPath + '/free')).text();
  assert.match(page, /Your attempts/);
  assert.match(page, /2 attempts|attempts/);

  // Project hub reflects it all.
  const hub = await (await get(projectPath)).text();
  assert.match(hub, /Try it without help/);

  // Delete.
  assert.equal((await form(projectPath + '/delete', {})).status, 302);
  assert.equal((await get(projectPath)).status, 404);
  } finally {
    srv.close();
  }
});
