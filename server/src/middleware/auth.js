const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const db = require('../db');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function signToken(user) {
  return jwt.sign({ uid: user.id }, config.jwtSecret, { expiresIn: '12h' });
}

// Accepts "Authorization: Bearer <jwt>" (or ?token= for file downloads / image previews / reports).
const auth = async (req, res, next) => {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (typeof req.query.token === 'string' ? req.query.token : '');
  if (!token) return res.status(401).json({ error: 'Please sign in.' });
  let uid;
  try { ({ uid } = jwt.verify(token, config.jwtSecret)); } catch { return res.status(401).json({ error: 'Your session expired. Please sign in again.' }); }
  try {
    const u = await db.get('users', uid);
    if (!u) return res.status(401).json({ error: 'Account no longer exists.' });
    req.user = { id: u.id, org_id: u.org_id, email: u.email, name: u.name, role: u.role };
    next();
  } catch (e) { next(e); }
};

const role = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ error: `The "${req.user.role}" role cannot do this.` });

// Brute-force protection for sign-in: 5 attempts per minute per IP + email (in memory; fine for one instance).
const attempts = new Map();
function loginLimiter(req, res, next) {
  const key = `${req.ip}|${(req.body && typeof req.body.email === 'string' && req.body.email) || ''}`;
  const now = Date.now();
  const list = (attempts.get(key) || []).filter((t) => now - t < 60000);
  if (list.length >= 5) return res.status(429).json({ error: 'Too many sign-in attempts. Try again in a minute.' });
  list.push(now);
  attempts.set(key, list);
  if (attempts.size > 5000) for (const [k, v] of attempts) if (!v.some((t) => now - t < 60000)) attempts.delete(k);
  next();
}

// General API limiter (per IP). Disabled under test so suites can hammer the API.
const limiter = (windowMs, max, message) => (config.isTest
  ? (req, res, next) => next()
  : rateLimit({ windowMs, limit: max, standardHeaders: true, legacyHeaders: false, message: { error: message || 'Too many requests. Please slow down.' } }));

// Strip MongoDB operator keys ("$ne", "a.b") from user input so it can never become a query (NoSQL injection).
function sanitizeValue(v, depth = 0) {
  if (depth > 8 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => sanitizeValue(x, depth + 1));
  const out = {};
  for (const [k, val] of Object.entries(v)) { if (k.startsWith('$') || k.includes('.')) continue; out[k] = sanitizeValue(val, depth + 1); }
  return out;
}
const sanitize = (req, res, next) => {
  if (req.body) req.body = sanitizeValue(req.body);
  if (req.query) { const q = sanitizeValue(req.query); for (const k of Object.keys(req.query)) delete req.query[k]; Object.assign(req.query, q); }
  next();
};

const httpError = (status, message) => { const e = new Error(message); e.status = status; return e; };
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : -1; };

module.exports = { wrap, auth, role, signToken, loginLimiter, limiter, sanitize, httpError, num };
