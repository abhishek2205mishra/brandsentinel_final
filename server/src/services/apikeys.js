// Per-user API keys for the browser extension and other integrations.
// Keys look like  bsk_<32 chars>.  Only a SHA-256 hash is stored; the full key is shown once, at creation.
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');

const PREFIX = 'bsk_';
const ALLOWED_ROLES = ['admin', 'creator', 'agency', 'reviewer', 'approver']; // auditors are read-only: no keys
const MAX_ACTIVE_PER_USER = 5;
const hashKey = (k) => crypto.createHash('sha256').update(String(k)).digest('hex');
const fail = (status, msg) => Object.assign(new Error(msg), { status });

async function create(user, name) {
  if (!ALLOWED_ROLES.includes(user.role)) throw fail(403, `The "${user.role}" role cannot create API keys.`);
  const label = String(name || '').trim().slice(0, 60) || 'Browser extension';
  const active = await db.count('api_keys', { user_id: user.id, revoked_at: null });
  if (active >= MAX_ACTIVE_PER_USER) throw fail(400, `You already have ${MAX_ACTIVE_PER_USER} active keys. Revoke one first.`);
  const key = PREFIX + crypto.randomBytes(24).toString('base64url');
  const id = await db.insert('api_keys', {
    org_id: user.org_id, user_id: user.id, name: label, prefix: key.slice(0, 12), key_hash: hashKey(key),
    created_at: db.now(), last_used_at: null, use_count: 0, revoked_at: null, revoked_by: null,
  });
  return { id, key, name: label, prefix: key.slice(0, 12) };
}

const present = (k, users) => ({
  id: k.id, name: k.name, prefix: k.prefix, created_at: k.created_at, last_used_at: k.last_used_at, use_count: k.use_count || 0,
  revoked_at: k.revoked_at, ...(users ? { user_id: k.user_id, user_name: (users.get(k.user_id) || {}).name } : {}),
});

async function list(user, { all = false } = {}) {
  const filter = all && user.role === 'admin' ? { org_id: user.org_id } : { org_id: user.org_id, user_id: user.id };
  const rows = await db.find('api_keys', filter, { sort: { id: -1 } });
  const users = all ? await db.mapByIds('users', rows.map((r) => r.user_id), ['name']) : null;
  return rows.map((r) => present(r, users));
}

async function revoke(user, id) {
  const k = await db.findOne('api_keys', { id: Number(id), org_id: user.org_id });
  if (!k || (k.user_id !== user.id && user.role !== 'admin')) throw fail(404, 'Key not found.');
  if (!k.revoked_at) await db.update('api_keys', k.id, { revoked_at: db.now(), revoked_by: user.id });
  return k;
}

// Resolve an x-api-key header. User keys (bsk_...) act as that user; the legacy organisation key keeps working unchanged.
async function resolve(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 200) return null;
  if (raw.startsWith(PREFIX)) {
    const k = await db.findOne('api_keys', { key_hash: hashKey(raw) });
    if (!k || k.revoked_at) return null;
    const user = await db.get('users', k.user_id);
    if (!user || user.org_id !== k.org_id || !ALLOWED_ROLES.includes(user.role)) return null;
    const org = await db.get('orgs', k.org_id);
    if (!org) return null;
    const ts = Date.now();
    if (!k.last_used_at || ts - new Date(k.last_used_at).getTime() > 60000) db.update('api_keys', k.id, { last_used_at: db.now(), use_count: (k.use_count || 0) + 1 }).catch(() => {});
    return { org: { id: org.id, name: org.name }, user: { id: user.id, org_id: user.org_id, name: user.name, email: user.email, role: user.role }, keyId: `k${k.id}`, key: { id: k.id, name: k.name, prefix: k.prefix }, legacy: false, limit: config.gateRatePerMin };
  }
  const org = await db.findOne('orgs', { api_key: raw });
  if (!org) return null;
  return { org: { id: org.id, name: org.name }, user: null, keyId: `o${org.id}`, key: null, legacy: true, limit: 60 };
}

// Sliding-window limiter, per key (not per IP), plus a daily cap. In memory: fine for one Render instance.
const hits = new Map();
const daily = new Map();
function take(keyId, perMin) {
  const now = Date.now();
  const list = (hits.get(keyId) || []).filter((t) => now - t < 60000);
  if (list.length >= perMin) return { ok: false, retryAfter: Math.max(1, Math.ceil((60000 - (now - list[0])) / 1000)), reason: `Rate limit reached (${perMin} requests per minute for this key).` };
  const day = new Date().toISOString().slice(0, 10);
  const d = daily.get(keyId);
  const count = d && d.day === day ? d.n : 0;
  if (count >= config.gateDailyCap) return { ok: false, retryAfter: 3600, reason: `Daily limit reached (${config.gateDailyCap} requests per key).` };
  list.push(now); hits.set(keyId, list); daily.set(keyId, { day, n: count + 1 });
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > 60000) hits.delete(k);
  return { ok: true, remaining: perMin - list.length };
}
const resetLimits = () => { hits.clear(); daily.clear(); };

module.exports = { create, list, revoke, resolve, take, resetLimits, ALLOWED_ROLES, hashKey };
