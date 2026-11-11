// Governance insights: recurring mistakes, trends, reviewer load and the Guideline Health Radar (which rules are unclear).
const express = require('express');
const db = require('../db');
const { wrap, auth, role } = require('../middleware/auth');

const router = express.Router();
router.use(auth, role('admin', 'approver', 'reviewer', 'auditor'));

function ambiguityHint(rate, overrideRate, top) {
  if (rate >= 0.4) return `Often dismissed${top ? ` (typical reason: "${top}")` : ''}. Add a concrete example or a clear threshold, or narrow the scope of this rule.`;
  if (overrideRate >= 0.3) return 'Reviewers often override this rule. Decide whether it should allow documented exceptions.';
  if (rate >= 0.2) return 'Some creators disagree with this rule. Consider adding an example of acceptable and unacceptable wording.';
  return null;
}

router.get('/', wrap(async (req, res) => {
  const org = req.user.org_id;
  const seeAuthors = ['admin', 'auditor'].includes(req.user.role);

  const items = await db.find('items', { org_id: org });
  const itemById = new Map(items.map((i) => [i.id, i]));
  const tally = (list, key) => { const m = new Map(); for (const x of list) m.set(x[key], (m.get(x[key]) || 0) + 1); return [...m.entries()].map(([k, n]) => ({ [key]: k, n })); };
  const byStatus = tally(items, 'status');
  const byRisk = tally(items, 'risk');
  const totalItems = items.length;

  // Version-1 findings (real, evidence-backed) for every item: basis for first-pass quality and distinct-issue counts.
  const v1 = await db.find('findings', { org_id: org, version_n: 1, advisory: 0 });
  const withIssues = new Set(v1.map((f) => f.item_id));
  const firstPass = { total: items.length, clean: items.filter((i) => !withIssues.has(i.id)).length };

  const approvedIds = items.filter((i) => i.status === 'approved').map((i) => i.id);
  const approves = approvedIds.length ? await db.find('decisions', { item_id: { $in: approvedIds }, decision: 'approve' }) : [];
  const hrs = approves.map((d) => (new Date(d.created_at) - new Date(itemById.get(d.item_id).created_at)) / 3600000);
  const avgHours = hrs.length ? hrs.reduce((a, b) => a + b, 0) / hrs.length : null;

  const authorsById = await db.mapByIds('users', items.map((i) => i.author_id), ['name']);
  const issueRows = v1.filter((f) => itemById.has(f.item_id)).map((f) => {
    const i = itemById.get(f.item_id);
    return { category: f.category, rule: f.rule, source_code: f.source_code, fingerprint: f.fingerprint, matched: f.matched, item_id: f.item_id, channel: i.channel, author_id: i.author_id, author: (authorsById.get(i.author_id) || {}).name, day: String(f.created_at).slice(0, 10) };
  });

  const count = (key) => {
    const m = new Map();
    for (const r of issueRows) m.set(r[key], (m.get(r[key]) || 0) + 1);
    return [...m.entries()].map(([k, n]) => ({ key: k, n })).sort((a, b) => b.n - a.n);
  };

  // Recurring: the same fingerprint appearing in 2+ different items.
  const fp = new Map();
  for (const r of issueRows) {
    const e = fp.get(r.fingerprint) || { fingerprint: r.fingerprint, rule: r.rule, matched: r.matched, clause: r.source_code, items: new Set() };
    e.items.add(r.item_id);
    fp.set(r.fingerprint, e);
  }
  const recurring = [...fp.values()].filter((e) => e.items.size >= 2).map((e) => ({ rule: e.rule, matched: e.matched, clause: e.clause, items: e.items.size }))
    .sort((a, b) => b.items - a.items).slice(0, 8);

  const trendMap = new Map();
  for (const r of issueRows) trendMap.set(r.day, (trendMap.get(r.day) || 0) + 1);
  const trend = [];
  for (let i = 29; i >= 0; i--) { const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10); trend.push({ day: d, n: trendMap.get(d) || 0 }); }

  // Guideline Health Radar.
  const ev = await db.find('finding_events', { org_id: org, clause_code: { $ne: null } }, { project: ['clause_code', 'action', 'reason'] });
  const clauses = new Map();
  for (const e of ev) {
    const c = clauses.get(e.clause_code) || { code: e.clause_code, accepted: 0, edited: 0, dismissed: 0, override: 0, reasons: new Map() };
    if (c[e.action] !== undefined) c[e.action]++;
    if (e.action === 'dismissed' && e.reason) c.reasons.set(e.reason, (c.reasons.get(e.reason) || 0) + 1);
    clauses.set(e.clause_code, c);
  }
  const flagged = new Map();
  for (const r of issueRows) flagged.set(r.source_code, (flagged.get(r.source_code) || 0) + 1);
  const titles = new Map((await db.find('guidelines', { org_id: org }, { project: ['code', 'title'] })).map((g) => [g.code, g.title]));
  const radar = [...clauses.values()].map((c) => {
    const decided = c.accepted + c.edited + c.dismissed + c.override;
    const rate = decided ? c.dismissed / decided : 0;
    const overrideRate = decided ? c.override / decided : 0;
    const top = [...c.reasons.entries()].sort((a, b) => b[1] - a[1])[0];
    const score = decided >= 2 ? Math.round(Math.min(100, (rate + 0.5 * overrideRate) * 100)) : 0;
    return { code: c.code, title: titles.get(c.code) || '', flagged: flagged.get(c.code) || 0, decided, dismissed: c.dismissed, overridden: c.override, accepted: c.accepted + c.edited, ambiguity: score, top_reason: top ? top[0] : null, hint: decided >= 2 ? ambiguityHint(rate, overrideRate, top && top[0]) : null };
  }).sort((a, b) => b.ambiguity - a.ambiguity || b.flagged - a.flagged);

  const acts = tally(ev.filter((e) => ['accepted', 'edited', 'dismissed', 'override'].includes(e.action)), 'action');
  const events = await db.find('finding_events', { org_id: org, clause_code: null, action: { $in: ['accepted', 'edited', 'dismissed', 'override'] } }, { project: ['action'] });
  for (const e of events) { const f = acts.find((a) => a.action === e.action); if (f) f.n++; else acts.push({ action: e.action, n: 1 }); }
  const staff = await db.find('users', { org_id: org, role: { $in: ['reviewer', 'approver', 'admin'] } });
  const reviewerLoad = (await Promise.all(staff.map(async (u) => ({ name: u.name, role: u.role, decisions: await db.count('decisions', { user_id: u.id }) })))).sort((a, b) => b.decisions - a.decisions);
  const queue = items.filter((i) => i.status === 'submitted').length;

  let authors = null;
  if (seeAuthors) {
    const m = new Map();
    for (const r of issueRows) {
      const e = m.get(r.author_id) || { author: r.author, issues: 0, items: new Set(), fps: new Map() };
      e.issues++; e.items.add(r.item_id);
      const s = e.fps.get(r.fingerprint) || new Set(); s.add(r.item_id); e.fps.set(r.fingerprint, s);
      m.set(r.author_id, e);
    }
    authors = [...m.values()].map((e) => ({ author: e.author, items: e.items.size, issues: e.issues, repeated: [...e.fps.values()].filter((s) => s.size >= 2).length })).sort((a, b) => b.issues - a.issues);
  }

  res.json({
    totals: { items: totalItems, in_review: queue, first_pass_clean: firstPass.total ? Math.round((firstPass.clean / firstPass.total) * 100) : null, avg_hours_to_approval: avgHours ? Math.round(avgHours * 10) / 10 : null },
    byStatus, byRisk, categories: count('category'), rules: count('rule').slice(0, 10), channels: count('channel'),
    recurring, trend, radar, suggestionOutcomes: acts, reviewerLoad, authors,
  });
}));

// Feedback calibration: what the system has learned for this organisation, with admin controls.
const calibration = require('../services/calibration');
const audit = require('../services/audit');
router.get('/calibration', wrap(async (req, res) => res.json(await calibration.summary(req.user.org_id))));
router.post('/calibration/settings', role('admin'), wrap(async (req, res) => {
  const on = !!(req.body && req.body.enabled);
  await calibration.setSettings(req.user.org_id, { enabled: on });
  await audit.log(req.user.org_id, req.user.id, 'calibration.toggle', 'org', req.user.org_id, { enabled: on });
  res.json(await calibration.summary(req.user.org_id));
}));
router.post('/calibration/reset', role('admin'), wrap(async (req, res) => {
  await calibration.setSettings(req.user.org_id, { reset_at: db.now() });
  await audit.log(req.user.org_id, req.user.id, 'calibration.reset', 'org', req.user.org_id, {});
  res.json(await calibration.summary(req.user.org_id));
}));

module.exports = router;
