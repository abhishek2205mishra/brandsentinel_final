// Feedback calibration (Round 3). Every accept / edit / dismiss / override is a vote on whether a rule+clause pairing is useful
// FOR THIS ORGANISATION. Votes adjust confidence, and persistently noisy non-critical rules are demoted to advisory.
// Safety rails: claims / facts / provenance rules are protected (confidence is shown, but severity is never lowered), and an
// admin can switch calibration off or reset it. Bayesian (Beta) estimate with a 3:1 prior so a few clicks cannot swing it.
const db = require('../db');
const config = require('../config');

const PROTECTED = ['claims.', 'facts.', 'provenance.'];
const POS = new Set(['accepted', 'edited']);
const NEG = new Set(['dismissed', 'override']);
const PRIOR_POS = 3, PRIOR_N = 4;
const cache = new Map(); // orgId -> { at, table }
const TTL = 60000;

const isProtected = (rule) => PROTECTED.some((p) => String(rule).startsWith(p));
const estimate = (pos, neg) => (PRIOR_POS + pos) / (PRIOR_N + pos + neg);
function stateOf(rule, pos, neg) {
  const n = pos + neg, p = estimate(pos, neg);
  if (n < 5) return 'learning';
  if (p >= 0.8) return 'trusted';
  if (!isProtected(rule) && n >= 15 && p < 0.2) return 'silenced';
  if (!isProtected(rule) && n >= 8 && p < 0.35) return 'noisy';
  return 'mixed';
}

async function enabled(orgId, settings) {
  if (!config.calibrationEnabled) return false;
  const s = settings || db.json((await db.get('orgs', orgId)).settings, {});
  return !(s.calibration && s.calibration.enabled === false);
}

async function table(orgId, settings) {
  const hit = cache.get(orgId);
  if (hit && Date.now() - hit.at < TTL) return hit.table;
  const s = settings || db.json((await db.get('orgs', orgId)).settings, {});
  const since = s.calibration && s.calibration.reset_at ? String(s.calibration.reset_at) : '';
  const ev = await db.find('finding_events', { org_id: orgId, action: { $in: [...POS, ...NEG] } }, { project: ['rule', 'clause_code', 'action', 'ts'] });
  const t = new Map();
  for (const e of ev) {
    if (since && String(e.ts) < since) continue;
    if (!e.rule) continue;
    const k = `${e.rule}|${e.clause_code || ''}`;
    const r = t.get(k) || { rule: e.rule, clause: e.clause_code || '', pos: 0, neg: 0 };
    if (POS.has(e.action)) r.pos++; else r.neg++;
    t.set(k, r);
  }
  for (const r of t.values()) { r.p = +estimate(r.pos, r.neg).toFixed(3); r.state = stateOf(r.rule, r.pos, r.neg); }
  cache.set(orgId, { at: Date.now(), table: t });
  return t;
}

const invalidate = (orgId) => cache.delete(orgId);
const DOWN = { high: 'medium', medium: 'low', low: 'info', info: 'info' };

// Adjust findings in place. Returns how many were changed (for tests and the audit trail).
async function apply(ctx, findings) {
  if (ctx.useCalibration === false || !(await enabled(ctx.orgId, ctx.settings))) return 0;
  const t = await table(ctx.orgId, ctx.settings);
  let changed = 0;
  for (const f of findings) {
    if (f.ai_assisted) continue;
    const r = t.get(`${f.rule}|${(f.source && f.source.code) || ''}`);
    if (!r) continue;
    const base = f.confidence;
    const factor = Math.min(1.2, (0.5 + r.p) / 1.25); // prior (0.75) keeps confidence unchanged
    f.confidence = Math.min(0.98, +(base * factor).toFixed(2));
    f.calibration = { pos: r.pos, neg: r.neg, p: r.p, state: r.state, base_confidence: base };
    if (r.state === 'noisy' && !isProtected(f.rule)) f.severity = DOWN[f.severity] || f.severity;
    if (r.state === 'silenced' && !isProtected(f.rule)) { f.severity = 'info'; f.silenced_by_feedback = true; }
    if (f.confidence !== base || r.state === 'noisy' || r.state === 'silenced') changed++;
  }
  return changed;
}

async function summary(orgId) {
  const org = await db.get('orgs', orgId);
  const s = db.json(org.settings, {});
  const t = await table(orgId, s);
  const rows = [...t.values()].map((r) => ({ ...r, protected: isProtected(r.rule), n: r.pos + r.neg })).sort((a, b) => b.n - a.n);
  return { enabled: await enabled(orgId, s), reset_at: (s.calibration && s.calibration.reset_at) || null, prior: { positive: PRIOR_POS, total: PRIOR_N }, rows };
}

async function setSettings(orgId, patch) {
  const org = await db.get('orgs', orgId);
  const s = db.json(org.settings, {});
  s.calibration = { ...(s.calibration || {}), ...patch };
  await db.update('orgs', orgId, { settings: JSON.stringify(s) });
  invalidate(orgId);
  return s.calibration;
}

module.exports = { apply, summary, setSettings, invalidate, table, estimate, stateOf, isProtected };
