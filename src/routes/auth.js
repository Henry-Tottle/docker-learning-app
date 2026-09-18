'use strict';
const express = require('express');
const { setSessionCookie, clearSessionCookie, requireLogin } = require('../middleware/auth');

const router = express.Router();

const safeNext = (v) => (typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') ? v : '/');
const clientKey = (req, username) => `${req.ip}|${String(username || '').toLowerCase()}`;

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(safeNext(req.query.next));
  res.render('login', { title: 'Log in', next: safeNext(req.query.next), error: null, notice: req.query.reset === '1' ? 'Password reset. Log in with the new one.' : null, username: '' });
});

router.post('/login', (req, res) => {
  const { auth } = req.app.locals;
  const next = safeNext(req.body.next);
  const result = auth.login(req.body.username, req.body.password, clientKey(req, req.body.username));
  if (result.error) return res.status(401).render('login', { title: 'Log in', next, error: result.error, notice: null, username: req.body.username || '' });
  const token = auth.createSession(result.user.id, req.headers['user-agent']);
  setSessionCookie(req, res, token, auth.SESSION_DAYS);
  res.redirect(next);
});

router.get('/register', (req, res) => {
  const { auth } = req.app.locals;
  if (req.user) return res.redirect('/');
  res.render('register', { title: 'Create an account', errors: [], username: '', mode: auth.registrationMode(), first: auth.userCount() === 0 });
});

router.post('/register', (req, res) => {
  const { auth } = req.app.locals;
  const result = auth.register(String(req.body.username || '').trim(), req.body.password, req.body.invite);
  if (result.errors) {
    return res.status(400).render('register', { title: 'Create an account', errors: result.errors, username: req.body.username || '', mode: auth.registrationMode(), first: auth.userCount() === 0 });
  }
  const token = auth.createSession(result.user.id, req.headers['user-agent']);
  setSessionCookie(req, res, token, auth.SESSION_DAYS);
  res.redirect('/');
});

router.post('/logout', (req, res) => {
  req.app.locals.auth.destroySession(req.sessionToken);
  clearSessionCookie(req, res);
  res.redirect('/');
});

// Password reset with an admin-issued code. Public: the user is locked out.
router.get('/reset', (req, res) => {
  res.render('reset', { title: 'Reset your password', error: null, username: String(req.query.username || '') });
});

router.post('/reset', (req, res) => {
  const { auth } = req.app.locals;
  const username = String(req.body.username || '').trim();
  const result = auth.resetPassword(username, req.body.code, req.body.password, clientKey(req, username));
  if (result.error) return res.status(400).render('reset', { title: 'Reset your password', error: result.error, username });
  clearSessionCookie(req, res);
  res.redirect('/login?reset=1');
});

router.get('/account', requireLogin, (req, res) => {
  res.render('account', { title: 'Your account', message: null, error: null });
});

router.post('/account/password', requireLogin, (req, res) => {
  const { auth } = req.app.locals;
  const result = auth.changePassword(req.user.id, req.body.current, req.body.next);
  if (result.error) return res.status(400).render('account', { title: 'Your account', message: null, error: result.error });
  // changePassword revoked every session, including this one; issue a fresh one.
  const token = auth.createSession(req.user.id, req.headers['user-agent']);
  setSessionCookie(req, res, token, auth.SESSION_DAYS);
  res.render('account', { title: 'Your account', message: 'Password changed. Other devices have been logged out.', error: null });
});

router.post('/account/delete', requireLogin, (req, res) => {
  const result = req.app.locals.auth.deleteSelf(req.user.id, req.body.password);
  if (result.error) return res.status(400).render('account', { title: 'Your account', message: null, error: result.error });
  clearSessionCookie(req, res);
  res.redirect('/');
});

module.exports = router;
