'use strict';
// A tiny HTTP client with a cookie jar, so tests can log in like a browser.
const { createApp } = require('../src/app');
const { openDatabase } = require('../src/db');

async function startApp(options = {}) {
  const app = createApp({ db: options.db || openDatabase(':memory:'), env: { ...options.env } });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { app, server, base, client: () => makeClient(base), close: () => server.close() };
}

function makeClient(base) {
  let cookie = '';
  const remember = (res) => {
    const set = res.headers.get('set-cookie');
    if (!set) return;
    const pair = set.split(';')[0];
    cookie = /=;|=$/.test(pair) || /Expires=Thu, 01 Jan 1970/.test(set) ? '' : pair;
  };
  const headers = (extra) => ({ ...(cookie ? { Cookie: cookie } : {}), ...extra });
  const client = {
    async get(p, extra) { const r = await fetch(base + p, { redirect: 'manual', headers: headers(extra) }); remember(r); return r; },
    async form(p, data, extra) {
      const r = await fetch(base + p, { method: 'POST', redirect: 'manual', headers: headers({ 'Content-Type': 'application/x-www-form-urlencoded', ...extra }), body: new URLSearchParams(data) });
      remember(r); return r;
    },
    async json(p, data, extra) {
      const r = await fetch(base + p, { method: 'POST', headers: headers({ 'Content-Type': 'application/json', Accept: 'application/json', ...extra }), body: JSON.stringify(data) });
      remember(r); return r;
    },
    async register(username, password = 'correct horse battery', invite) { return client.form('/register', { username, password, ...(invite ? { invite } : {}) }); },
    async login(username, password = 'correct horse battery') { return client.form('/login', { username, password }); },
    get cookie() { return cookie; },
  };
  return client;
}

module.exports = { startApp, makeClient };
