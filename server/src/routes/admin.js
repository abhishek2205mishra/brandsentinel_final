// Governance & privacy controls: audit log, AI disclosure ledger, settings, API key, data export and retention.
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const { wrap, auth, role, httpError } = require('../middleware/auth');
const audit = require('../services/audit');
const llm = require('../engine/llm');
const email = require('../services/email');
const sla = require('../services/sla');

const router = express.Router();
router.use(auth);

// Visible to every signed-in user: what AI / external services this workspace uses.
router.get('/ai-notice', wrap(async (req, res) => {
  const org = await db.get('orgs', req.user.org_id);
  const s = db.json(org.settings, {});
  const llmOn = !!(s.llm && s.llm.enabled);
  const info = llm.providerInfo();
  const usable = llmOn && info.configured;
  const blocked = usable && !!s.confidential_mode;
  res.json({
    rules_engine: 'Deterministic rules, retrieval and parsers run inside this server. No content leaves it.',
    llm: { enabled: llmOn, configured: info.configured, provider: info.provider, model: info.model, blocked_by_confidential_mode: blocked },
    confidential_mode: !!s.confidential_mode,
    external_services: usable && !blocked ? [info.host] : [],
    redaction: 'Emails, phone numbers, card and ID numbers, API keys and your confidential terms are masked before any text goes to a language model.',
    human_control: 'AI never publishes or edits content on its own. Every suggestion needs a person to accept it, and every approval is by a person.',
    limits: 'This tool supports review. It is not legal advice and can miss issues or flag false positives.',
  });
}));

router.get('/audit', role('admin', 'auditor', 'approver'), wrap(async (req, res) => {
  const rows = await db.find('audit_log', { org_id: req.user.org_id }, { sort: { id: -1 }, limit: 200 });
  const names = await db.mapByIds('users', rows.map((r) => r.user_id), ['name']);
  res.json({
    rows: rows.map((a) => ({ id: a.id, ts: a.ts, action: a.action, entity: a.entity, entity_id: a.entity_id, detail: a.detail, hash: a.hash, user_name: (names.get(a.user_id) || {}).name || null })),
    chain: await audit.verifyChain(req.user.org_id),
  });
}));

router.get('/ledger', role('admin', 'auditor', 'approver'), wrap(async (req, res) => {
  const rows = await db.find('ai_ledger', { org_id: req.user.org_id }, { sort: { id: -1 }, limit: 200 });
  const titles = await db.mapByIds('items', rows.map((r) => r.item_id), ['title']);
  const all = await db.find('ai_ledger', { org_id: req.user.org_id }, { project: ['redactions', 'sent_external'] });
  res.json({
    rows: rows.map((l) => ({ ...l, title: (titles.get(l.item_id) || {}).title || null })),
    totals: { calls: all.length, external: all.reduce((a, r) => a + (r.sent_external || 0), 0), redactions: all.reduce((a, r) => a + (r.redactions || 0), 0) },
  });
}));

router.get('/settings', role('admin', 'auditor'), wrap(async (req, res) => {
  const org = await db.get('orgs', req.user.org_id);
  const info = llm.providerInfo();
  res.json({ name: org.name, settings: db.json(org.settings, {}), api_key: req.user.role === 'admin' ? org.api_key : null, llm: info });
}));

router.put('/settings', role('admin'), wrap(async (req, res) => {
  const org = await db.get('orgs', req.user.org_id);
  const cur = db.json(org.settings, {});
  const b = req.body || {};
  const next = { ...cur };
  if (b.confidential_mode !== undefined) next.confidential_mode = !!b.confidential_mode;
  if (b.llm) next.llm = { ...(cur.llm || {}), enabled: !!b.llm.enabled, nuance: b.llm.nuance !== false, rewrite: b.llm.rewrite !== false };
  if (Array.isArray(b.confidential_terms)) next.confidential_terms = b.confidential_terms.map((t) => String(t).trim()).filter(Boolean).slice(0, 100);
  if (Array.isArray(b.packs)) next.packs = b.packs.filter((p) => ['wcag', 'asci', 'cpa', 'fssai', 'euai'].includes(p));
  if (b.retention_days !== undefined) next.retention_days = Math.max(7, Math.min(3650, Number(b.retention_days) || 365));
  await db.update('orgs', req.user.org_id, { settings: JSON.stringify(next) });
  await audit.log(req.user.org_id, req.user.id, 'settings.update', 'org', req.user.org_id, Object.keys(b));
  res.json({ settings: next });
}));

router.post('/api-key', role('admin'), wrap(async (req, res) => {
  const key = 'bs_' + crypto.randomBytes(18).toString('hex');
  await db.update('orgs', req.user.org_id, { api_key: key });
  await audit.log(req.user.org_id, req.user.id, 'apikey.rotate', 'org', req.user.org_id);
  res.json({ api_key: key });
}));

// System status for the person deploying: database reachable? AI provider configured and answering?
router.get('/system', role('admin'), wrap(async (req, res) => {
  let database = { driver: config.dbDriver, ok: false };
  try { await db.ping(); database.ok = true; } catch (e) { database.error = e.message; }
  res.json({ version: require('../../package.json').version, node: process.version, env: config.isProd ? 'production' : 'development', uptime_s: Math.round(process.uptime()), database, llm: llm.providerInfo(), registration_open: config.allowRegistration, email: email.info(), public_url: config.publicUrl || null, sla_timer_minutes: config.slaTickMinutes, semantic: require('../engine/semantic').info() });
}));

// Email delivery status (free HTTPS providers) and a test message to the signed-in admin.
router.get('/email', role('admin'), wrap(async (req, res) => {
  res.json({ ...email.info(), ...(await email.stats(req.user.org_id)) });
}));
router.post('/email/test', role('admin'), wrap(async (req, res) => {
  if (!email.enabled()) throw httpError(400, email.info().problem);
  const me = await db.get('users', req.user.id);
  const id = await email.enqueue({ orgId: req.user.org_id, to: me.email, name: me.name, subject: 'BrandSentinel test email', text: 'This is a test message. If you can read it, email delivery from your BrandSentinel deployment works.', link: '/governance', kind: 'test' });
  const r = await email.processQueue(20);
  const row = id ? await db.get('email_outbox', id) : null;
  await audit.log(req.user.org_id, req.user.id, 'email.test', 'org', req.user.org_id, { status: row && row.status });
  res.json({ ok: !!row && row.status === 'sent', status: row && row.status, error: row && row.last_error, to: me.email, ...r });
}));

router.post('/llm/test', role('admin'), wrap(async (req, res) => {
  const r = await llm.testConnection();
  await audit.log(req.user.org_id, req.user.id, 'llm.test', 'org', req.user.org_id, { ok: r.ok });
  res.json(r);
}));

// Data export (portability) and retention (delete old content on request).
router.get('/export', role('admin'), wrap(async (req, res) => {
  const org = req.user.org_id;
  const items = await db.find('items', { org_id: org });
  const ids = items.length ? items.map((i) => i.id) : [0];
  const byItem = { item_id: { $in: ids } };
  await audit.log(org, req.user.id, 'data.export', 'org', org);
  res.setHeader('Content-Disposition', 'attachment; filename="brandsentinel-export.json"');
  const [versions, findings, comments, decisions, guidelines, terms, facts, claims, assets, ai_ledger] = await Promise.all([
    db.find('versions', byItem), db.find('findings', byItem), db.find('comments', byItem), db.find('decisions', byItem),
    db.find('guidelines', { org_id: org }), db.find('terms', { org_id: org }), db.find('facts', { org_id: org }), db.find('claims', { org_id: org }),
    db.find('assets', { org_id: org }), db.find('ai_ledger', { org_id: org }),
  ]);
  res.json({ exported_at: db.now(), items, versions, findings, comments, decisions, guidelines, terms, facts, claims, assets, ai_ledger });
}));

router.post('/purge', role('admin'), wrap(async (req, res) => {
  const days = Number(req.body && req.body.older_than_days);
  if (!days || days < 7) throw httpError(400, 'Choose at least 7 days.');
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const old = (await db.find('items', { org_id: req.user.org_id, created_at: { $lt: cutoff }, status: { $in: ['approved', 'rejected'] } }, { project: ['id'] })).map((i) => i.id);
  for (const id of old) {
    for (const t of ['findings', 'versions', 'comments', 'decisions', 'certificates', 'files', 'item_workflows']) await db.remove(t, { item_id: id });
    await db.remove('items', id);
  }
  await audit.log(req.user.org_id, req.user.id, 'data.purge', 'org', req.user.org_id, { older_than_days: days, deleted: old.length });
  res.json({ deleted: old.length });
}));

router.get('/notifications', wrap(async (req, res) => {
  res.json(await db.find('notifications', { user_id: req.user.id }, { sort: { id: -1 }, limit: 30 }));
}));
router.post('/notifications/read', wrap(async (req, res) => {
  await db.update('notifications', { user_id: req.user.id }, { read: 1 });
  res.json({ ok: true });
}));

module.exports = router;
