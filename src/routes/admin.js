'use strict';
// Mounted behind requireAdmin in app.js.
const express = require('express');

const router = express.Router();

router.get('/users', (req, res) => {
  const { auth } = req.app.locals;
  res.render('admin-users', { title: 'Users', users: auth.listUsers(), mode: auth.registrationMode(), flash: req.query.msg || null });
});

router.post('/users/:id/role', (req, res) => {
  const result = req.app.locals.auth.setRole(Number(req.params.id), req.body.role);
  res.redirect('/admin/users?msg=' + encodeURIComponent(result.error || 'Role updated.'));
});

router.post('/users/:id/delete', (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.redirect('/admin/users?msg=' + encodeURIComponent('Delete your own account from the account page, not here.'));
  const result = req.app.locals.auth.deleteUser(Number(req.params.id));
  res.redirect('/admin/users?msg=' + encodeURIComponent(result.error || 'User deleted, along with their projects and progress.'));
});

module.exports = router;
