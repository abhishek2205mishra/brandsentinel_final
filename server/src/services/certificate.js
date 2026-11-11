// Clearance Certificate: an HMAC signature over (org, item, version, content hash) and, from v2, over the public
// verification code and a summary of what was checked. A CMS, agency or partner can call /api/gate/verify, or open the
// public page /verify/<code>, and refuse to publish anything that does not match.
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const { sha256 } = require('../util/text');

const sign = (orgId, itemId, versionN, hash) =>
  crypto.createHmac('sha256', config.certSecret).update(`${orgId}:${itemId}:${versionN}:${hash}`).digest('hex');
const signV2 = (c) =>
  crypto.createHmac('sha256', config.certSecret).update(`v2:${c.org_id}:${c.item_id}:${c.version_n}:${c.content_hash}:${c.verification_code}:${sha256(c.snapshot || '')}`).digest('hex');
const signatureOk = (c) => (c.sig_v === 2 ? signV2(c) : sign(c.org_id, c.item_id, c.version_n, c.content_hash)) === c.signature;

// Wording hash that ignores formatting (line wraps, repeated spaces), so text pasted from a rendered page still matches.
const normHash = (t) => sha256(String(t || '').replace(/\s+/g, ' ').trim().toLowerCase());

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
function newCode() {
  const pick = (n) => Array.from({ length: n }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
  return `BS-${pick(4)}-${pick(4)}-${pick(4)}`;
}
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^BS/, '');
const codeFromNorm = (n) => `BS-${n.slice(0, 4)}-${n.slice(4, 8)}-${n.slice(8, 12)}`;

// "What was checked", recorded when the certificate is issued. No author names, no content.
async function buildSnapshot(item, version, { approvals = [], workflow = null, reconstructed = false } = {}) {
  const { ENGINE_VERSION, RULE_MODULES } = require('../engine'); // lazy: avoids a require cycle
  const org = await db.get('orgs', item.org_id);
  const st = db.json(org.settings, {});
  const n = version.n;
  const [findings, events, ledger, decisions, guidelines, terms, facts, claims] = await Promise.all([
    db.find('findings', { item_id: item.id, version_n: n, advisory: 0 }),
    db.find('finding_events', { item_id: item.id }),
    db.find('ai_ledger', { item_id: item.id }),
    db.find('decisions', { item_id: item.id, version_n: n, decision: 'approve' }, { sort: { id: 1 } }),
    db.count('guidelines', { org_id: item.org_id, active: 1 }), db.count('terms', { org_id: item.org_id }), db.count('facts', { org_id: item.org_id }), db.count('claims', { org_id: item.org_id }),
  ]);
  const roles = await db.mapByIds('users', decisions.map((d) => d.user_id), ['role']);
  const bySev = {};
  findings.forEach((f) => { bySev[f.severity] = (bySev[f.severity] || 0) + 1; });
  const count = (a) => events.filter((e) => e.action === a).length;
  return {
    v: 1, reconstructed, engine_version: ENGINE_VERSION, rule_modules: RULE_MODULES,
    knowledge_base: { guidelines, terms, approved_facts: facts, approved_claims: claims, regulation_packs: st.packs || ['wcag', 'asci', 'cpa', 'fssai', 'euai'] },
    content: { channel: item.channel, kind: item.kind, version: n, risk: item.risk, ai_generated: !!item.ai_generated, content_hash_norm: normHash(version.body) },
    findings: { open_at_approval_by_severity: bySev, open_at_approval: findings.filter((f) => f.status === 'open').length, fixed: count('accepted') + count('edited'), dismissed_by_author: count('dismissed'), overridden_by_reviewers: count('override') },
    ai: { external_calls: ledger.filter((l) => l.sent_external).length, confidential_mode: !!st.confidential_mode },
    approval: workflow
      ? { type: 'configured_workflow', name: workflow.name, steps: workflow.steps.map((s) => ({ name: s.name, required_approvals: s.min_approvals, approvals: (s.approvals || []).map((a) => ({ role: a.role, at: a.at })) })) }
      : { type: 'risk_tier', risk: item.risk, approvals: (approvals.length ? approvals : decisions.map((d) => ({ role: (roles.get(d.user_id) || {}).role, at: d.created_at }))) },
  };
}

async function issue(orgId, itemId, versionN, hash, userId, extra = {}) {
  const existing = await db.findOne('certificates', { item_id: itemId, version_n: versionN, revoked: 0 });
  if (existing) return existing;
  const item = await db.get('items', itemId);
  const version = await db.findOne('versions', { item_id: itemId, n: versionN });
  const snapshot = JSON.stringify(await buildSnapshot(item, version, extra));
  const c = { org_id: orgId, item_id: itemId, version_n: versionN, content_hash: hash, verification_code: newCode(), snapshot, sig_v: 2 };
  c.signature = signV2(c);
  const id = await db.insert('certificates', { ...c, issued_by: userId, issued_at: db.now(), revoked: 0 });
  return db.get('certificates', id);
}

// Verify that `text` is exactly the content that was approved (organisation-scoped; used by the gate API).
async function verify(orgId, { text, hash, itemId }) {
  const h = typeof hash === 'string' && hash ? hash : sha256(text || '');
  const certs = await db.find('certificates', { org_id: orgId, content_hash: h, revoked: 0 }, { sort: { id: -1 } });
  for (const c of certs) {
    if (itemId && c.item_id !== Number(itemId)) continue;
    if (signatureOk(c)) {
      return { valid: true, content_hash: h, certificate: { id: c.id, item_id: c.item_id, version: c.version_n, issued_at: c.issued_at, verification_code: c.verification_code || null } };
    }
  }
  let reason = 'No clearance certificate exists for this exact content.';
  if (itemId && await db.findOne('certificates', { org_id: orgId, item_id: Number(itemId), revoked: 0 })) {
    reason = 'This content differs from the approved version. It was changed after approval and must be reviewed again.';
  }
  return { valid: false, content_hash: h, reason };
}

async function revoke(orgId, itemId, userId, reason) {
  const certs = await db.find('certificates', { org_id: orgId, item_id: itemId, revoked: 0 });
  for (const c of certs) await db.update('certificates', c.id, { revoked: 1, revoked_at: db.now(), revoked_by: userId, revoked_reason: String(reason || '').slice(0, 300) });
  return certs.length;
}

// Public lookup (no login): returns only what a partner needs. Never the content, author names or internal ids.
async function publicView(rawCode) {
  const n = normCode(rawCode);
  if (n.length !== 12) return null;
  const c = await db.findOne('certificates', { verification_code: codeFromNorm(n) });
  if (!c) return null;
  const [org, item, newer, issueEntry] = await Promise.all([
    db.get('orgs', c.org_id), db.get('items', c.item_id),
    db.findOne('versions', { item_id: c.item_id, n: c.version_n + 1 }),
    db.findOne('audit_log', { org_id: c.org_id, action: 'certificate.issue', entity_id: c.item_id }, { sort: { id: -1 } }),
  ]);
  const st = org ? db.json(org.settings, {}) : {};
  const snap = db.json(c.snapshot, null);
  const status = c.revoked ? 'revoked' : (!signatureOk(c) ? 'invalid' : 'valid');
  return {
    code: c.verification_code, status, signature_valid: signatureOk(c), issued_at: c.issued_at, revoked_at: c.revoked ? c.revoked_at || null : null,
    organisation: org ? org.name : null, title: st.public_verify && st.public_verify.show_title && item ? item.title : null,
    version: c.version_n, newer_version_exists: !!newer, content_hash: c.content_hash,
    checks: snap, integrity: c.sig_v === 2 ? 'full' : 'core-only', audit_anchor: issueEntry ? issueEntry.hash : null,
  };
}

// Old certificates (before the public page) get a code and a reconstructed summary. Their original signature stays valid.
async function backfill() {
  const missing = (await db.find('certificates', {})).filter((c) => !c.verification_code);
  for (const c of missing) {
    try {
      const item = await db.get('items', c.item_id), version = await db.findOne('versions', { item_id: c.item_id, n: c.version_n });
      if (!item || !version) continue;
      const snapshot = JSON.stringify(await buildSnapshot(item, version, { reconstructed: true }));
      await db.update('certificates', c.id, { verification_code: newCode(), snapshot, sig_v: 1 });
    } catch (e) { console.error('certificate backfill failed:', e.message); }
  }
  return missing.length;
}

module.exports = { issue, verify, sign, signV2, signatureOk, revoke, publicView, backfill, normHash, normCode, codeFromNorm, newCode };
