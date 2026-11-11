const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const { wrap, auth, role, signToken, loginLimiter, limiter, httpError, num } = require('../middleware/auth');
const audit = require('../services/audit');
const { seedStarter, DEFAULT_SETTINGS, seedRegs } = require('../seedData');

const router = express.Router();
const ROLES = ['admin', 'creator', 'reviewer', 'approver', 'agency', 'auditor'];
const publicUser = (u) => ({ id: u.id, org_id: u.org_id, email: u.email, name: u.name, role: u.role, groups: u.groups || [], email_notifications: u.email_notifications !== false, away: u.away_delegate_id && u.away_until && new Date(u.away_until) > new Date() ? { delegate_to_id: u.away_delegate_id, until: u.away_until } : null });
const cleanEmail = (e) => String(e || '').toLowerCase().trim();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const str = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);

router.post('/login', loginLimiter, wrap(async (req, res) => {
  const { email, password } = req.body || {};
  const u = await db.findOne('users', { email: cleanEmail(email) });
  const ok = u && await bcrypt.compare(String(password || ''), u.password_hash);
  if (!ok) throw httpError(401, 'Wrong email or password.');
  await audit.log(u.org_id, u.id, 'auth.login', 'user', u.id);
  const org = await db.get('orgs', u.org_id);
  res.json({ token: signToken(u), user: publicUser(u), org: { id: org.id, name: org.name } });
}));

// Create a brand-new organisation with a starter guideline pack and its first admin.
router.post('/register-org', limiter(60 * 60 * 1000, 10, 'Too many sign-ups from this address. Try again later.'), wrap(async (req, res) => {
  if (!config.allowRegistration) throw httpError(403, 'Self-service sign-up is turned off on this server.');
  const b = req.body || {};
  const orgName = str(b.orgName, 100), name = str(b.name, 100), email = cleanEmail(b.email), password = String(b.password || '');
  if (!orgName || !name || !email || !password) throw httpError(400, 'Organisation name, your name, email and password are required.');
  if (!EMAIL_RE.test(email)) throw httpError(400, 'Please enter a valid email address.');
  if (password.length < 8) throw httpError(400, 'Password must be at least 8 characters.');
  if (await db.findOne('users', { email })) throw httpError(409, 'That email is already registered.');
  await seedRegs();
  const orgId = await db.insert('orgs', { name: orgName, api_key: 'bs_' + crypto.randomBytes(18).toString('hex'), settings: JSON.stringify(DEFAULT_SETTINGS), created_at: db.now() });
  let uid;
  try {
    await seedStarter(orgId);
    uid = await db.insert('users', { org_id: orgId, email, name, password_hash: await bcrypt.hash(password, 10), role: 'admin', created_at: db.now() });
  } catch (e) {
    // Roll back the half-created organisation.
    for (const c of ['guidelines', 'terms']) await db.remove(c, { org_id: orgId });
    await db.remove('orgs', orgId);
    if (db.isDuplicate(e)) throw httpError(409, 'That email is already registered.');
    throw e;
  }
  await audit.log(orgId, uid, 'org.create', 'org', orgId, { orgName });
  const u = await db.get('users', uid);
  res.status(201).json({ token: signToken(u), user: publicUser(u), org: { id: orgId, name: orgName } });
}));

router.get('/me', auth, wrap(async (req, res) => {
  const org = await db.get('orgs', req.user.org_id);
  const full = await db.get('users', req.user.id);
  res.json({ user: publicUser(full), org: { id: org.id, name: org.name } });
}));

router.put('/me/prefs', auth, wrap(async (req, res) => {
  const b = req.body || {};
  if (b.email_notifications !== undefined) await db.update('users', req.user.id, { email_notifications: !!b.email_notifications });
  res.json({ ok: true });
}));

router.post('/change-password', auth, wrap(async (req, res) => {
  const { current, next } = req.body || {};
  const u = await db.get('users', req.user.id);
  if (!(await bcrypt.compare(String(current || ''), u.password_hash))) throw httpError(400, 'Your current password is not correct.');
  if (String(next || '').length < 8) throw httpError(400, 'The new password must be at least 8 characters.');
  await db.update('users', u.id, { password_hash: await bcrypt.hash(String(next), 10) });
  await audit.log(u.org_id, u.id, 'auth.password_change', 'user', u.id);
  res.json({ ok: true });
}));

router.get('/users', auth, wrap(async (req, res) => {
  const rows = await db.find('users', { org_id: req.user.org_id }, { sort: { name: 1 }, project: ['id', 'name', 'email', 'role', 'groups'] });
  rows.forEach((r) => { r.groups = r.groups || []; });
  res.json(rows);
}));

router.post('/users', auth, role('admin'), wrap(async (req, res) => {
  const b = req.body || {};
  const name = str(b.name, 100), email = cleanEmail(b.email), password = String(b.password || '');
  if (!name || !email || !password || !ROLES.includes(b.role)) throw httpError(400, `Name, email, password and a valid role (${ROLES.join(', ')}) are required.`);
  if (!EMAIL_RE.test(email)) throw httpError(400, 'Please enter a valid email address.');
  if (password.length < 8) throw httpError(400, 'Password must be at least 8 characters.');
  let id;
  try { id = await db.insert('users', { org_id: req.user.org_id, email, name, password_hash: await bcrypt.hash(password, 10), role: b.role, created_at: db.now() }); }
  catch (e) { if (db.isDuplicate(e)) throw httpError(409, 'That email is already registered.'); throw e; }
  await audit.log(req.user.org_id, req.user.id, 'user.create', 'user', id, { email, role: b.role });
  res.status(201).json({ id, name, email, role: b.role });
}));

router.put('/users/:id', auth, role('admin'), wrap(async (req, res) => {
  const u = await db.findOne('users', { id: num(req.params.id), org_id: req.user.org_id });
  if (!u) throw httpError(404, 'User not found.');
  const r = (req.body || {}).role;
  if (!ROLES.includes(r)) throw httpError(400, 'Invalid role.');
  if (u.id === req.user.id && r !== 'admin') throw httpError(400, 'You cannot remove your own admin role.');
  await db.update('users', u.id, { role: r });
  await audit.log(req.user.org_id, req.user.id, 'user.role', 'user', u.id, { from: u.role, to: r });
  res.json({ ok: true });
}));

module.exports = router;
