'use strict';
// Mounted behind requireAdmin in app.js.
const express = require('express');

const router = express.Router();

function page(req, res, extra = {}) {
  const { auth } = req.app.locals;
  res.render('admin-users', { title: 'Users', users: auth.listUsers(), mode: auth.registrationMode(), flash: req.query.msg || null, reset: null, ...extra });
}

router.get('/users', (req, res) => page(req, res));

router.post('/users/:id/role', (req, res) => {
  const result = req.app.locals.auth.setRole(Number(req.params.id), req.body.role);
  res.redirect('/admin/users?msg=' + encodeURIComponent(result.error || 'Role updated.'));
});

router.post('/users/:id/delete', (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.redirect('/admin/users?msg=' + encodeURIComponent('Delete your own account from the account page, not here.'));
  const result = req.app.locals.auth.deleteUser(Number(req.params.id));
  res.redirect('/admin/users?msg=' + encodeURIComponent(result.error || 'User deleted, along with their projects and progress.'));
});

// Rendered rather than redirected: the code must never appear in a URL.
router.post('/users/:id/reset', (req, res) => {
  const { auth } = req.app.locals;
  const target = auth.getUser(Number(req.params.id));
  if (!target) return res.redirect('/admin/users?msg=' + encodeURIComponent('No such user.'));
  const result = auth.createResetCode(target.id, req.user.id);
  if (result.error) return res.redirect('/admin/users?msg=' + encodeURIComponent(result.error));
  page(req, res, { reset: { username: target.username, code: result.code, minutes: result.expiresInMinutes } });
});

module.exports = router;
