// Public gate API for agencies, CMS plugins, the Chrome extension and other AI tools.
// Authenticated with  x-api-key:  a personal key (bsk_...) that acts as that user, or the legacy organisation key.
//   GET  /api/gate/me      -> who am I, limits, features
//   POST /api/gate/check   -> inline check of text (nothing stored; an audit entry is written)
//   POST /api/gate/save    -> check and keep it as a content item in BrandSentinel (personal keys)
//   POST /api/gate/review  -> review content before delivering it (creates an item)
//   POST /api/gate/verify  -> check that content is exactly what was approved
const express = require('express');
const db = require('../db');
const config = require('../config');
const { wrap, httpError } = require('../middleware/auth');
const items = require('../services/items');
const cert = require('../services/certificate');
const keys = require('../services/apikeys');
const audit = require('../services/audit');
const ledger = require('../services/ledger');
const { loadContext, analyze, ENGINE_VERSION } = require('../engine');
const { sha256 } = require('../util/text');
const llm = require('../engine/llm');

const router = express.Router();
const CHANNELS = ['social', 'email', 'blog', 'web', 'paid-ad', 'press-release', 'internal'];
const KINDS = ['text', 'markdown', 'html'];

const apiAuth = wrap(async (req, res, next) => {
  const g = await keys.resolve(req.headers['x-api-key']);
  if (!g) return res.status(401).json({ error: 'Missing or invalid x-api-key.' });
  const t = keys.take(g.keyId, g.limit);
  res.setHeader('X-RateLimit-Limit', String(g.limit));
  if (!t.ok) { res.setHeader('Retry-After', String(t.retryAfter)); return res.status(429).json({ error: t.reason, retry_after: t.retryAfter }); }
  res.setHeader('X-RateLimit-Remaining', String(t.remaining));
  req.gate = g; req.org = g.org;
  next();
});
router.use(apiAuth);

const clean = (b) => {
  const text = typeof b.text === 'string' ? b.text : '';
  if (!text.trim()) throw httpError(400, 'text is required.');
  return {
    text, kind: KINDS.includes(b.kind) ? b.kind : 'text', channel: CHANNELS.includes(b.channel) ? b.channel : 'social',
    intent: String(b.intent || 'Written in the browser').slice(0, 300), ai_generated: !!b.ai_generated,
  };
};
const source = (b) => {
  const s = (b && typeof b.source === 'object' && b.source) || {};
  return { host: String(s.host || '').slice(0, 120), editor: String(s.editor || '').slice(0, 60), title: String(s.title || '').slice(0, 120) };
};
const presentFinding = (f, i) => ({
  id: i, rule: f.rule, category: f.category, severity: f.severity, confidence: f.confidence, start: f.start, end: f.end, matched: f.matched, message: f.message,
  source: f.source ? { type: f.source.type, code: f.source.code, quote: f.source.quote } : null, also: f.also || [],
  suggestions: (f.suggestions || []).map((s) => ({ level: s.level, text: s.text, intent_preserved: s.intent_preserved, note: s.note, ...(s.start !== undefined ? { start: s.start, end: s.end } : {}) })),
});

// Rare audit entries for automatic checks (at most one per key per minute); explicit checks are always recorded.
const lastAuto = new Map();
const shouldLog = (keyId, record) => {
  if (record) return true;
  const t = Date.now();
  if (t - (lastAuto.get(keyId) || 0) < 60000) return false;
  lastAuto.set(keyId, t); return true;
};

router.get('/me', wrap(async (req, res) => {
  const org = await db.get('orgs', req.org.id);
  const settings = db.json(org.settings, {});
  res.json({
    organisation: req.org.name, user: req.gate.user ? { name: req.gate.user.name, role: req.gate.user.role } : null,
    key: req.gate.key, legacy_key: req.gate.legacy,
    limits: { per_minute: req.gate.limit, per_day: config.gateDailyCap, max_chars: config.gateMaxChars },
    ai: { enabled: !!(settings.llm && settings.llm.enabled) && !settings.confidential_mode, confidential_mode: !!settings.confidential_mode },
    engine: ENGINE_VERSION, server_time: db.now(),
  });
}));

router.post('/check', wrap(async (req, res) => {
  const b = req.body || {};
  const c = clean(b);
  if (c.text.length > config.gateMaxChars) throw httpError(413, `Text is too long for an inline check (${config.gateMaxChars} characters max). Use /api/gate/save instead.`);
  const ctx = await loadContext(req.org.id, { body: c.text, kind: c.kind, intent: c.intent, channel: c.channel, ai_generated: c.ai_generated, meta: {} });
  // Inline checks use the rules engine only (fast, free, private). The optional AI pass runs only on an explicit deep check.
  if (!b.deep) ctx.settings = { ...ctx.settings, llm: { ...(ctx.settings.llm || {}), enabled: false } };
  const r = await analyze(ctx);
  await ledger.record(req.org.id, null, r.events);
  const live = r.findings.filter((f) => !f.advisory);
  const src = source(b);
  const hash = sha256(c.text);
  if (shouldLog(req.gate.keyId, b.record !== false && !b.auto)) {
    await audit.log(req.org.id, req.gate.user ? req.gate.user.id : null, 'ext.check', 'gate', req.gate.key ? req.gate.key.id : null, {
      host: src.host, editor: src.editor, content_hash: hash, chars: c.text.length, findings: live.length, high: live.filter((f) => f.severity === 'high').length,
      risk: r.risk, deep: !!b.deep, auto: !!b.auto, key: req.gate.key ? req.gate.key.prefix : 'org-key',
    });
  }
  res.json({
    content_hash: hash, risk: r.risk, engine: r.engine.version, findings: live.map(presentFinding), advisory_hidden: r.findings.length - live.length,
    supported_claims: r.supported_claims, stats: r.stats, ai_used: r.events.some((e) => e.sent_external),
  });
}));

router.post('/save', wrap(async (req, res) => {
  if (!req.gate.user) throw httpError(403, 'Saving content needs a personal API key (create one on your Account page).');
  const b = req.body || {};
  const c = clean(b);
  if (c.text.length > 200000) throw httpError(400, 'Content is too long (200,000 characters max).');
  const src = source(b);
  const title = String(b.title || src.title || 'Written in the browser').slice(0, 200);
  const item = await items.createItem({ orgId: req.org.id, user: req.gate.user, title, channel: c.channel, kind: c.kind, intent: c.intent, body: c.text, ai_generated: c.ai_generated, source: 'extension' });
  await audit.log(req.org.id, req.gate.user.id, 'ext.save', 'item', item.id, { host: src.host, editor: src.editor, key: req.gate.key.prefix });
  res.status(201).json({ item_id: item.id, risk: item.risk, status: item.status, url: config.publicUrl ? `${config.publicUrl}/items/${item.id}` : `/items/${item.id}` });
}));

router.post('/review', wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.text || !b.title) throw httpError(400, 'title and text are required.');
  if (String(b.text).length > 200000) throw httpError(400, 'Content is too long (200,000 characters max).');
  const owner = req.gate.user || await db.findOne('users', { org_id: req.org.id, role: 'admin' }, { sort: { id: 1 } });
  const item = await items.createItem({
    orgId: req.org.id, user: owner, title: String(b.title).slice(0, 200), channel: b.channel || 'web', kind: ['text', 'markdown', 'html'].includes(b.kind) ? b.kind : 'text',
    intent: String(b.intent || 'Submitted via the gate API'), body: String(b.text), ai_generated: !!b.ai_generated, ai_tool: b.ai_tool || null, source: 'api',
  });
  const rows = await db.find('findings', { item_id: item.id, version_n: 1 }, { sort: { id: 1 } });
  const findings = rows.map((f) => ({ id: f.id, rule: f.rule, category: f.category, severity: f.severity, matched: f.matched, message: f.message, source_code: f.source_code, suggestions: db.json(f.suggestions, []), advisory: !!f.advisory }));
  res.status(201).json({ item_id: item.id, risk: item.risk, status: item.status, findings, next: 'A human reviewer must approve this item before a clearance certificate is issued.' });
}));

router.post('/verify', wrap(async (req, res) => {
  const { text, hash, item_id } = req.body || {};
  if (typeof text !== 'string' && typeof hash !== 'string') throw httpError(400, 'Send the exact text (or its sha256 hash) you intend to publish.');
  res.json(await cert.verify(req.org.id, { text, hash, itemId: item_id }));
}));

module.exports = router;
