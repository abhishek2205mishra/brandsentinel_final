// Content items, versions and findings. Shared by the HTTP routes, the public gate API and the seed script.
const path = require('path');
const db = require('../db');
const { sha256 } = require('../util/text');
const { loadContext, analyze } = require('../engine');
const { applyReplacement } = require('../engine/intent');
const audit = require('./audit');
const ledger = require('./ledger');

const safeName = (n) => path.basename(n).replace(/[^\w.\-]+/g, '_').slice(0, 80);

// Uploaded originals live in the database (hosting disks such as Render's are ephemeral).
async function saveFile(orgId, itemId, n, file) {
  const key = `${orgId}/${itemId}/${n}-${safeName(file.originalname)}`;
  await db.insert('files', { org_id: orgId, item_id: itemId, n, key, name: safeName(file.originalname), mime: file.mimetype || '', size: file.buffer.length, data: file.buffer, created_at: db.now() });
  return key;
}

async function runAnalysis(item, version) {
  const meta = db.json(version.meta, {});
  const ctx = await loadContext(item.org_id, {
    body: version.body, kind: item.kind, intent: item.intent, channel: item.channel, ai_generated: item.ai_generated,
    meta: { ...meta, aiTool: item.ai_tool },
  });
  const res = await analyze(ctx);

  const prev = await db.find('findings', { item_id: item.id, version_n: { $lt: version.n }, status: 'dismissed' }, { sort: { version_n: 1 } });
  const carried = new Map(prev.map((p) => [p.fingerprint, p]));

  await db.remove('findings', { item_id: item.id, version_n: version.n });
  await db.insertMany('findings', res.findings.map((f) => {
    const c = carried.get(f.fingerprint);
    return {
      org_id: item.org_id, item_id: item.id, version_n: version.n, fingerprint: f.fingerprint, rule: f.rule, category: f.category, severity: f.severity,
      confidence: f.confidence, start: f.start, end: f.end, matched: f.matched, message: f.message,
      source_type: f.source && f.source.type, source_code: f.source && f.source.code, source_quote: f.source && f.source.quote,
      also_cites: JSON.stringify(f.also || []), suggestions: JSON.stringify(f.suggestions || []),
      semantic: f.extra && f.extra.semantic ? JSON.stringify(f.extra.semantic) : null, calibration: f.calibration ? JSON.stringify(f.calibration) : null,
      advisory: f.advisory ? 1 : 0, ai_assisted: f.ai_assisted ? 1 : 0,
      status: c ? 'dismissed' : 'open', status_reason: c ? c.status_reason : null, decided_by: c ? c.decided_by : null, created_at: db.now(),
    };
  }));
  const analysis = { supported_claims: res.supported_claims, stats: res.stats, engine: res.engine, errors: res.errors };
  await db.update('versions', version.id, { meta: JSON.stringify({ ...meta, analysis }) });
  await db.update('items', item.id, { risk: res.risk, updated_at: db.now() });
  await ledger.record(item.org_id, item.id, res.events);
  return res;
}

async function createItem({ orgId, user, title, channel, kind, intent, body, meta = {}, file, ai_generated = false, ai_tool = null, source = 'web' }) {
  const itemId = await db.insert('items', {
    org_id: orgId, title, channel, kind, intent, ai_generated: ai_generated ? 1 : 0, ai_tool, status: 'draft', risk: 'low',
    author_id: user.id, source, current_version: 1, created_at: db.now(), updated_at: db.now(),
  });
  const fileName = file ? await saveFile(orgId, itemId, 1, file) : null;
  const vid = await db.insert('versions', {
    item_id: itemId, n: 1, body, meta: JSON.stringify(meta), file_name: fileName, created_by: user.id, note: 'Initial submission',
    content_hash: sha256(body), created_at: db.now(),
  });
  await audit.log(orgId, user.id, 'item.create', 'item', itemId, { title, kind, channel, source });
  const item = await db.get('items', itemId);
  await runAnalysis(item, await db.get('versions', vid));
  return await db.get('items', itemId);
}

async function addVersion(item, user, body, note, metaPatch = {}) {
  const cur = await db.findOne('versions', { item_id: item.id, n: item.current_version });
  const n = item.current_version + 1;
  const meta = { ...db.json(cur.meta, {}), ...metaPatch };
  delete meta.analysis;
  const vid = await db.insert('versions', {
    item_id: item.id, n, body, meta: JSON.stringify(meta), file_name: cur.file_name, created_by: user.id, note,
    content_hash: sha256(body), created_at: db.now(),
  });
  await db.update('items', item.id, { current_version: n, status: 'draft', updated_at: db.now() });
  await audit.log(item.org_id, user.id, 'version.create', 'item', item.id, { n, note });
  const fresh = await db.get('items', item.id);
  await runAnalysis(fresh, await db.get('versions', vid));
  return await db.get('items', item.id);
}

const event = async (item, finding, action, reason, userId) => {
  const r = await db.insert('finding_events', {
    org_id: item.org_id, item_id: item.id, clause_code: finding.source_code, category: finding.category, rule: finding.rule,
    action, reason: reason || null, user_id: userId, ts: db.now(),
  });
  require('./calibration').invalidate(item.org_id);
  return r;
};

// Apply a suggestion (or the creator's own edited text) to a finding. Creates a new version.
async function applyFinding(item, finding, user, { level, text }) {
  const suggestions = db.json(finding.suggestions, []);
  let repl, span = { start: finding.start, end: finding.end }, action = 'accepted';
  if (typeof text === 'string') { repl = text; action = 'edited'; }
  else {
    const s = suggestions.find((x) => x.level === level);
    if (!s) { const e = new Error('Suggestion not found'); e.status = 400; throw e; }
    repl = s.text;
    if (s.start !== undefined) span = { start: s.start, end: s.end };
  }
  if (span.start < 0) { const e = new Error('This finding has no text span to edit. Edit the content manually.'); e.status = 400; throw e; }
  const cur = await db.findOne('versions', { item_id: item.id, n: item.current_version });
  const body = applyReplacement(cur.body, span.start, span.end, repl);
  await db.update('findings', finding.id, { status: action, decided_by: user.id });
  await event(item, finding, action, null, user.id);
  return addVersion(item, user, body, `${action === 'edited' ? 'Edited' : 'Accepted'} fix for ${finding.rule}`);
}

async function dismissFinding(item, finding, user, reason) {
  await db.update('findings', finding.id, { status: 'dismissed', status_reason: reason, decided_by: user.id });
  await event(item, finding, 'dismissed', reason, user.id);
  await audit.log(item.org_id, user.id, 'finding.dismiss', 'finding', finding.id, { rule: finding.rule, reason });
}

async function reopenFinding(item, finding, user) {
  await db.update('findings', finding.id, { status: 'open', status_reason: null, decided_by: null });
  await event(item, finding, 'reopened', null, user.id);
}

module.exports = { createItem, addVersion, runAnalysis, applyFinding, dismissFinding, reopenFinding, event };
