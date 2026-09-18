'use strict';
// End-to-end through HTTP. Walks the whole progression for several stacks:
// guided -> quizzes -> scaffold -> free build, as a logged-in user.
const test = require('node:test');
const assert = require('node:assert/strict');
const { CONCEPTS } = require('../src/engine/concepts');
const gen = require('../src/engine/generator');
const { startApp } = require('./helpers');

test('public pages render without login; private ones redirect', async () => {
  const t = await startApp();
  try {
    const c = t.client();
    for (const p of ['/', '/uses', '/how-this-app-was-containerized', '/healthz', '/login', '/register']) assert.equal((await c.get(p)).status, 200, p);
    for (const p of ['/dashboard', '/wizard', '/projects/1', '/concepts/base-images', '/account', '/admin/users']) {
      const r = await c.get(p);
      assert.equal(r.status, 302, p);
      assert.match(r.headers.get('location'), /^\/login\?next=/);
    }
    assert.equal((await c.json('/projects/1/guided/viewed', { lineId: 'x' })).status, 401);
    assert.equal((await c.get('/nothing-here')).status, 404);
  } finally { t.close(); }
});

test('wizard rejects a missing name', async () => {
  const t = await startApp();
  try {
    const c = t.client();
    await c.register('alice');
    assert.equal((await c.form('/wizard', { name: '', appType: 'node', database: 'postgres', target: 'prod' })).status, 400);
  } finally { t.close(); }
});

for (const answers of [
  { appType: 'node', database: 'postgres', target: 'prod' },
  { appType: 'django', database: 'postgres', target: 'dev' },
  { appType: 'django', database: 'sqlite', target: 'prod' },
  { appType: 'django', database: 'mariadb', target: 'prod' },
]) test(`full progression for ${answers.appType} + ${answers.database} + ${answers.target}`, async () => {
  const t = await startApp();
  const c = t.client();
  const { get, form, json } = c;
  try {
  assert.equal((await c.register('learner')).status, 302);
  const created = await form('/wizard', { name: 'my-app', ...answers });
  assert.equal(created.status, 302);
  const projectPath = new URL(created.headers.get('location'), t.base).pathname;
  assert.match(projectPath, /^\/projects\/\d+$/);
  const g = gen.generate(answers);
  for (const p of ['', '/guided', '/scaffold', '/free']) assert.equal((await get(projectPath + p)).status, 200, p);

  // Mode 1 gate: nothing downloadable, quizzes locked.
  assert.equal((await get(projectPath + '/guided/files/dockerfile')).status, 403);
  assert.equal((await form('/concepts/base-images/quiz', { q0: 1, q1: 0, q2: 2 })).status, 403);

  // Free build locked, scaffold blanks locked.
  assert.equal((await json(projectPath + '/free/lint', { dockerfile: 'FROM x' })).status, 403);
  assert.equal((await json(projectPath + '/scaffold/check', { blankId: 'df-base', value: 'anything' })).status, 403);

  // Read every explanation; the guided page shows read-more links.
  assert.match(await (await get(projectPath + '/guided')).text(), /class="links"/);
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
    const cpt = CONCEPTS.find((x) => x.key === key);
    const wrong = Object.fromEntries(cpt.quiz.map((q, i) => [`q${i}`, (q.answer + 1) % q.options.length]));
    const r1 = await form(`/concepts/${key}/quiz`, wrong);
    assert.equal(r1.status, 200);
    assert.match(await r1.text(), /Not yet\./);
    const right = Object.fromEntries(cpt.quiz.map((q, i) => [`q${i}`, q.answer]));
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
  assert.match(await (await get(projectPath + '/free')).text(), /Your attempts/);
  assert.match(await (await get(projectPath)).text(), /Try it without help/);

  // Delete.
  assert.equal((await form(projectPath + '/delete', {})).status, 302);
  assert.equal((await get(projectPath)).status, 404);
  } finally {
    t.close();
  }
});
