// Tamper-evident audit log: each row stores the hash of the previous row (per organisation).
// A unique index on (org_id, prev_hash) makes concurrent writers retry instead of forking the chain.
const db = require('../db');
const { sha256 } = require('../util/text');

async function write(orgId, userId, action, entity, entityId, detail) {
  const d = detail == null ? null : typeof detail === 'string' ? detail : JSON.stringify(detail);
  for (let attempt = 0; attempt < 12; attempt++) {
    const last = await db.findOne('audit_log', { org_id: orgId }, { sort: { id: -1 } });
    const prev = last ? last.hash : 'GENESIS';
    const ts = db.now();
    const hash = sha256(prev + JSON.stringify([ts, userId, action, entity, entityId, d]));
    try {
      await db.insert('audit_log', { org_id: orgId, ts, user_id: userId, action, entity, entity_id: entityId, detail: d, prev_hash: prev, hash });
      return;
    } catch (e) { if (!db.isDuplicate(e)) throw e; await new Promise((r) => setTimeout(r, Math.random() * 25 * (attempt + 1))); }
  }
  throw new Error('Could not write the audit log (too much contention).');
}

// Writers in this process are queued per organisation; the unique (org_id, prev_hash) index plus retry protects against other instances.
const queues = new Map();
function log(orgId, userId, action, entity = null, entityId = null, detail = null) {
  const run = (queues.get(orgId) || Promise.resolve()).then(() => write(orgId, userId, action, entity, entityId, detail));
  queues.set(orgId, run.catch(() => {}));
  return run;
}

async function verifyChain(orgId) {
  const rows = await db.find('audit_log', { org_id: orgId }, { sort: { id: 1 } });
  let prev = 'GENESIS';
  for (const r of rows) {
    const expect = sha256(prev + JSON.stringify([r.ts, r.user_id, r.action, r.entity, r.entity_id, r.detail]));
    if (r.prev_hash !== prev || r.hash !== expect) return { ok: false, checked: rows.length, broken_at: r.id };
    prev = r.hash;
  }
  return { ok: true, checked: rows.length };
}

module.exports = { log, verifyChain };
