// Content items: create (text or file), review findings, edit/versions, comments, submit, approve.
const express = require('express');
const multer = require('multer');
const db = require('../db');
const config = require('../config');
const { renderReport } = require('../services/report');
const { wrap, auth, role, httpError, num, limiter } = require('../middleware/auth');
const { extractFile } = require('../engine/extract');
const items = require('../services/items');
const workflow = require('../services/workflow');
const audit = require('../services/audit');
const { notify } = require('../services/notify');
const sla = require('../services/sla');
const cert = require('../services/certificate');

const router = express.Router();
router.use(auth);
// Auditors are read-only everywhere.
router.use((req, res, next) => (req.method !== 'GET' && req.user.role === 'auditor' ? res.status(403).json({ error: 'Auditors have read-only access.' }) : next()));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadMb * 1024 * 1024 } });

const CHANNELS = ['social', 'email', 'blog', 'web', 'paid-ad', 'press-release', 'internal'];
const KINDS = ['text', 'markdown', 'html'];
const OWN_ONLY = ['creator', 'agency'];

async function getItem(req) {
  const it = await db.findOne('items', { id: num(req.params.id), org_id: req.user.org_id });
  if (!it) throw httpError(404, 'Content not found.');
  if (OWN_ONLY.includes(req.user.role) && it.author_id !== req.user.id) throw httpError(403, 'You can only open your own content.');
  return it;
}
const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const str = (v) => (typeof v === 'string' ? v : '');

router.get('/', wrap(async (req, res) => {
  const filter = { org_id: req.user.org_id };
  if (OWN_ONLY.includes(req.user.role) || req.query.mine === '1') filter.author_id = req.user.id;
  if (str(req.query.status)) filter.status = str(req.query.status);
  if (str(req.query.risk)) filter.risk = str(req.query.risk);
  if (str(req.query.q)) filter.title = { $regex: escRe(str(req.query.q).slice(0, 80)), $options: 'i' };
  const rows = await db.find('items', filter, { sort: { updated_at: -1 }, limit: 300 });
  const ids = rows.map((r) => r.id);
  const [open, authors] = await Promise.all([
    ids.length ? db.find('findings', { item_id: { $in: ids }, status: 'open', advisory: 0 }, { project: ['item_id', 'version_n', 'severity'] }) : [],
    db.mapByIds('users', rows.map((r) => r.author_id), ['name']),
  ]);
  const cur = new Map(rows.map((r) => [r.id, r.current_version]));
  const stats = new Map();
  for (const f of open) {
    if (f.version_n !== cur.get(f.item_id)) continue;
    const e = stats.get(f.item_id) || { open: 0, high: 0 };
    e.open++; if (f.severity === 'high') e.high++;
    stats.set(f.item_id, e);
  }
  await sla.lazyTick();
  const chain = await workflow.queueInfo(req.user.org_id, req.user, rows);
  res.json(rows.map((r) => ({ ...r, author_name: (authors.get(r.author_id) || {}).name, open_findings: (stats.get(r.id) || {}).open || 0, open_high: (stats.get(r.id) || {}).high || 0, ...(chain.has(r.id) ? { chain: chain.get(r.id) } : {}) })));
}));

// Create from JSON (text/markdown/html) or multipart (file upload).
router.post('/', limiter(60 * 1000, 30, 'You are submitting content too quickly. Please wait a moment.'), role('admin', 'creator', 'agency', 'reviewer', 'approver'), upload.single('file'), wrap(async (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim().slice(0, 200);
  const intent = String(b.intent || '').trim();
  const channel = CHANNELS.includes(b.channel) ? b.channel : 'social';
  if (!title) throw httpError(400, 'Please give the content a title.');
  if (intent.length < 5) throw httpError(400, 'Please describe what this content is meant to achieve (its purpose). Suggestions will keep it intact.');

  let kind = b.kind || 'text', body = String(b.body || ''), meta = {}, file;
  if (req.file) {
    const ex = await extractFile(req.file);
    kind = ex.kind; body = ex.body; meta = ex.meta; file = req.file;
    if (kind === 'image') {
      meta.alt = String(b.alt || '').trim();
      meta.declaredLogo = b.declaredLogo === 'true' || b.declaredLogo === true;
      if (!body && b.caption) body = String(b.caption);
    }
  } else {
    if (!KINDS.includes(kind)) throw httpError(400, `kind must be one of ${KINDS.join(', ')} or upload a file.`);
    if (!body.trim()) throw httpError(400, 'The content is empty.');
  }
  if (body.length > 200000) throw httpError(400, 'Content is too long (200,000 characters max).');

  const item = await items.createItem({
    orgId: req.user.org_id, user: req.user, title, channel, kind, intent, body, meta, file,
    ai_generated: b.ai_generated === true || b.ai_generated === 'true', ai_tool: b.ai_tool || null,
  });
  res.status(201).json({ id: item.id, risk: item.risk });
}));

router.get('/:id', wrap(async (req, res) => {
  const it = await getItem(req);
  const n = num(req.query.v) > 0 ? num(req.query.v) : it.current_version;
  const version = await db.findOne('versions', { item_id: it.id, n });
  if (!version) throw httpError(404, 'Version not found.');
  const meta = db.json(version.meta, {});
  const rows = await db.find('findings', { item_id: it.id, version_n: n }, { sort: { id: 1 } });
  const findings = rows.sort((a, b) => ((a.start < 0) - (b.start < 0)) || a.start - b.start || a.id - b.id).map((f) => ({
    ...f, suggestions: db.json(f.suggestions, []), also_cites: db.json(f.also_cites, []), advisory: !!f.advisory, ai_assisted: !!f.ai_assisted,
  }));
  const [vrows, crows, drows, certs] = await Promise.all([
    db.find('versions', { item_id: it.id }, { sort: { n: -1 } }),
    db.find('comments', { item_id: it.id }, { sort: { id: 1 } }),
    db.find('decisions', { item_id: it.id }, { sort: { id: 1 } }),
    db.find('certificates', { item_id: it.id, revoked: 0 }, { sort: { id: -1 }, limit: 1 }),
  ]);
  const users = await db.mapByIds('users', [it.author_id, ...vrows.map((v) => v.created_by), ...crows.map((c) => c.author_id), ...drows.map((d) => d.user_id)], ['name', 'role']);
  const versions = vrows.map((v) => ({ n: v.n, created_at: v.created_at, note: v.note, content_hash: v.content_hash, by: (users.get(v.created_by) || {}).name || null }));
  const comments = crows.map((c) => ({ ...c, author_name: (users.get(c.author_id) || {}).name, author_role: (users.get(c.author_id) || {}).role }));
  const decisions = drows.map((d) => ({ ...d, user_name: (users.get(d.user_id) || {}).name, user_role: (users.get(d.user_id) || {}).role }));
  const c = certs[0];
  const certificate = c ? { id: c.id, version_n: c.version_n, content_hash: c.content_hash, signature: c.signature, issued_at: c.issued_at, verification_code: c.verification_code || null } : null;
  const chainInfo = await workflow.describe(it, req.user);
  const { analysis, ...metaRest } = meta;
  res.json({
    item: { ...it, ai_generated: !!it.ai_generated, author_name: (users.get(it.author_id) || {}).name },
    version: { n: version.n, body: version.body, content_hash: version.content_hash, note: version.note, created_at: version.created_at, has_file: !!version.file_name, meta: metaRest },
    analysis: analysis || null, findings, versions, comments, decisions, certificate,
    required_approvals: it.risk === 'high' ? 2 : 1, workflow: chainInfo,
  });
}));

// Edit content -> new version -> re-check. Dismissed findings are carried over when the same issue remains.
router.post('/:id/versions', wrap(async (req, res) => {
  const it = await getItem(req);
  if (it.status === 'approved' && req.user.role !== 'admin') throw httpError(400, 'Approved content is locked. Create a new version only if you intend to re-submit it for review.');
  if (req.user.id !== it.author_id && req.user.role !== 'admin') throw httpError(403, 'Only the author or an admin can edit this content.');
  const body = String((req.body && req.body.body) ?? '');
  if (!body.trim() && it.kind !== 'image') throw httpError(400, 'The content is empty.');
  const meta = {};
  if (it.kind === 'image' && req.body.alt !== undefined) meta.alt = String(req.body.alt);
  const updated = await items.addVersion(it, req.user, body, String(req.body.note || 'Edited by author'), meta);
  res.json({ id: updated.id, current_version: updated.current_version, risk: updated.risk });
}));

router.post('/:id/findings/:fid/accept', wrap(async (req, res) => {
  const it = await getItem(req);
  const f = await db.findOne('findings', { id: num(req.params.fid), item_id: it.id });
  if (!f || f.version_n !== it.current_version) throw httpError(400, 'That finding belongs to an older version.');
  if (f.status !== 'open') throw httpError(400, 'That finding was already handled.');
  if (it.status === 'approved') throw httpError(400, 'Approved content is locked.');
  const out = await items.applyFinding(it, f, req.user, { level: req.body.level, text: typeof req.body.text === 'string' ? req.body.text : undefined });
  res.json({ current_version: out.current_version, risk: out.risk });
}));

router.post('/:id/findings/:fid/dismiss', wrap(async (req, res) => {
  const it = await getItem(req);
  const f = await db.findOne('findings', { id: num(req.params.fid), item_id: it.id });
  if (!f || f.version_n !== it.current_version) throw httpError(400, 'That finding belongs to an older version.');
  const reason = String((req.body && req.body.reason) || '').trim();
  if (reason.length < 3) throw httpError(400, 'Please give a short reason. It helps us learn which guidelines are unclear.');
  await items.dismissFinding(it, f, req.user, reason);
  res.json({ ok: true });
}));

router.post('/:id/findings/:fid/reopen', wrap(async (req, res) => {
  const it = await getItem(req);
  const f = await db.findOne('findings', { id: num(req.params.fid), item_id: it.id });
  if (!f || f.status !== 'dismissed') throw httpError(400, 'Only dismissed findings can be reopened.');
  await items.reopenFinding(it, f, req.user);
  res.json({ ok: true });
}));

router.post('/:id/comments', wrap(async (req, res) => {
  const it = await getItem(req);
  const body = String((req.body && req.body.body) || '').trim().slice(0, 4000);
  if (!body) throw httpError(400, 'Write a comment first.');
  const fid = req.body.finding_id ? num(req.body.finding_id) : null;
  const id = await db.insert('comments', { item_id: it.id, finding_id: fid > 0 ? fid : null, author_id: req.user.id, body, created_at: db.now() });
  const mentions = [...body.matchAll(/@([\w.]+)/g)].map((m) => m[1].toLowerCase());
  const people = await db.find('users', { org_id: req.user.org_id }, { project: ['id', 'email', 'name'] });
  const mentioned = people.filter((u) => mentions.includes(u.email.split('@')[0].toLowerCase()) || mentions.includes(u.name.split(' ')[0].toLowerCase())).map((u) => u.id);
  const others = (await db.find('comments', { item_id: it.id }, { project: ['author_id'] })).map((c) => c.author_id);
  await notify(req.user.org_id, [it.author_id, ...mentioned, ...others].filter((u) => u !== req.user.id), `${req.user.name} commented on "${it.title}"`, `/items/${it.id}`);
  await audit.log(req.user.org_id, req.user.id, 'comment.create', 'item', it.id);
  res.status(201).json({ id });
}));

router.post('/:id/submit', wrap(async (req, res) => {
  const it = await getItem(req);
  await workflow.submit(it, req.user);
  res.json({ ok: true });
}));

router.post('/:id/decision', wrap(async (req, res) => {
  const it = await getItem(req);
  res.json(await workflow.decide(it, req.user, req.body || {}));
}));

router.post('/:id/delegate', wrap(async (req, res) => {
  const it = await getItem(req);
  res.json(await workflow.delegate(it, req.user, (req.body || {}).to_user_id, (req.body || {}).reason));
}));

router.post('/:id/nudge', wrap(async (req, res) => {
  const it = await getItem(req);
  res.json(await workflow.nudge(it, req.user));
}));

// Withdraw a clearance certificate (for example when a claim turns out to be wrong). The public page then shows "revoked".
router.post('/:id/certificate/revoke', role('admin', 'approver'), wrap(async (req, res) => {
  const it = await getItem(req);
  const reason = String((req.body || {}).reason || '').trim();
  if (reason.length < 5) throw httpError(400, 'Please explain why the certificate is being revoked.');
  const n = await cert.revoke(it.org_id, it.id, req.user.id, reason);
  if (!n) throw httpError(404, 'This item has no active certificate.');
  await db.update('items', it.id, { status: 'changes_requested', updated_at: db.now() });
  await audit.log(it.org_id, req.user.id, 'certificate.revoke', 'item', it.id, { reason });
  await notify(it.org_id, [it.author_id], `The clearance for "${it.title}" was withdrawn: ${reason}`, `/items/${it.id}`);
  res.json({ ok: true });
}));

// MongoDB returns stored bytes as a BSON Binary; the in-memory store keeps a Buffer.
const toBuffer = (d) => (Buffer.isBuffer(d) ? d : Buffer.from((d.buffer || d).subarray(0, d.position ?? undefined)));
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf' };

// Original uploaded file (used for image preview and downloads). Stored in the database.
router.get('/:id/file', wrap(async (req, res) => {
  const it = await getItem(req);
  const v = await db.findOne('versions', { item_id: it.id, n: num(req.query.v) > 0 ? num(req.query.v) : it.current_version });
  if (!v || !v.file_name) throw httpError(404, 'No file for this version.');
  const f = await db.findOne('files', { key: v.file_name, org_id: it.org_id });
  if (!f) throw httpError(404, 'File missing.');
  const buf = toBuffer(f.data);
  const ext = f.name.split('.').pop().toLowerCase();
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
  if (!MIME[ext]) res.setHeader('Content-Disposition', `attachment; filename="${f.name}"`);
  res.send(buf);
}));

// Printable review report (HTML): findings with their evidence, decisions, certificate. Use the browser's "Save as PDF".
router.get('/:id/report', wrap(async (req, res) => {
  const it = await getItem(req);
  const html = await renderReport(it);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  res.send(html);
}));

module.exports = router;
