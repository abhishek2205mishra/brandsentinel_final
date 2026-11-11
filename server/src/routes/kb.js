// Brand Knowledge Base: guidelines, terminology, Approved Facts Vault, Claim Ledger, Asset Library, regulatory packs, import.
const express = require('express');
const multer = require('multer');
const db = require('../db');
const { wrap, auth, role, httpError, num } = require('../middleware/auth');
const audit = require('../services/audit');
const { extractFile } = require('../engine/extract');
const { buildIndex, search } = require('../util/bm25');

const router = express.Router();
router.use(auth);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: require('../config').maxUploadMb * 1024 * 1024 } });

const TABLES = {
  guidelines: { fields: ['code', 'title', 'category', 'text', 'rule', 'severity', 'confidential', 'active', 'source_doc'], required: ['code', 'title', 'category', 'text'] },
  terms: { fields: ['banned', 'preferred', 'reason', 'lang', 'guideline_code'], required: ['banned'] },
  facts: { fields: ['subject', 'keywords', 'statement', 'value', 'valid_from', 'valid_until', 'evidence', 'owner', 'confidential'], required: ['subject', 'keywords', 'statement', 'value'] },
  claims: { fields: ['phrase', 'claim_type', 'evidence', 'valid_until', 'approved_by'], required: ['phrase', 'claim_type'] },
  assets: { fields: ['kind', 'name', 'data'], required: ['kind', 'name', 'data'] },
};

const SORT = { guidelines: { code: 1 }, terms: { banned: 1 }, facts: { subject: 1 }, claims: { phrase: 1 }, assets: { id: 1 } };

router.get('/', wrap(async (req, res) => {
  const org = req.user.org_id;
  const restricted = req.user.role === 'agency'; // agencies see a redacted view: no confidential items, no evidence
  const conf = restricted ? { confidential: 0 } : {};
  const [g, factsRaw, assets, terms, claims, regs] = await Promise.all([
    db.find('guidelines', { org_id: org, ...conf }, { sort: SORT.guidelines }),
    db.find('facts', { org_id: org, ...conf }, { sort: SORT.facts }),
    db.find('assets', { org_id: org }, { sort: { id: 1 } }),
    db.find('terms', { org_id: org }, { sort: SORT.terms }),
    restricted ? [] : db.find('claims', { org_id: org }, { sort: SORT.claims }),
    db.find('regs'),
  ]);
  const facts = restricted ? factsRaw.map((f) => ({ ...f, evidence: null, owner: null })) : factsRaw;
  regs.sort((a, b) => (a.pack + a.code).localeCompare(b.pack + b.code));
  res.json({
    guidelines: g.map((x) => ({ ...x, rule: db.json(x.rule) })), assets: assets.map((a) => ({ ...a, data: db.json(a.data, {}) })), facts,
    terms, claims, regs, redacted_view: restricted,
  });
}));

router.get('/search', wrap(async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  const rows = await db.find('guidelines', { org_id: req.user.org_id, active: 1, ...(req.user.role === 'agency' ? { confidential: 0 } : {}) });
  const org = await db.get('orgs', req.user.org_id);
  const settings = db.json(org.settings, {});
  const hits = await require('../engine/semantic').retrieve({ orgId: req.user.org_id, guidelines: rows, settings, events: [], useDense: req.user.role !== 'agency' }, q, { k: 8 });
  res.json(hits.map((h) => ({ code: h.doc.code, title: h.doc.title, category: h.doc.category, text: h.doc.text, score: Math.round(h.score * 1000) / 10, via: h.via })));
}));

function clean(table, body, { partial = false } = {}) {
  const spec = TABLES[table];
  const out = {};
  for (const f of spec.fields) {
    if (body[f] === undefined) continue;
    let v = body[f];
    if ((f === 'rule' || f === 'data') && v !== null && typeof v === 'object') v = JSON.stringify(v);
    if (f === 'rule' && (v === '' || v === null)) v = null;
    if ((f === 'rule' || f === 'data') && typeof v === 'string' && v) { try { JSON.parse(v); } catch { throw httpError(400, `"${f}" must be valid JSON.`); } }
    if (['confidential', 'active'].includes(f)) v = v ? 1 : 0;
    out[f] = typeof v === 'string' ? v.trim() : v;
  }
  if (!partial) for (const r of spec.required) if (out[r] === undefined || out[r] === '') throw httpError(400, `"${r}" is required.`);
  return out;
}

router.post('/:table', role('admin'), wrap(async (req, res) => {
  const { table } = req.params;
  if (!TABLES[table]) throw httpError(404, 'Unknown collection.');
  const row = { org_id: req.user.org_id, ...clean(table, req.body || {}) };
  if (table === 'guidelines') { row.updated_at = db.now(); row.version = 1; }
  else row.created_at = db.now();
  let id;
  try { id = await db.insert(table, row); } catch (e) { if (db.isDuplicate(e)) throw httpError(409, 'That code already exists.'); throw e; }
  await audit.log(req.user.org_id, req.user.id, `kb.${table}.create`, table, id, { code: row.code || row.subject || row.phrase || row.banned || row.name });
  res.status(201).json({ id });
}));

router.put('/:table/:id', role('admin'), wrap(async (req, res) => {
  const { table, id } = req.params;
  if (!TABLES[table]) throw httpError(404, 'Unknown collection.');
  const cur = await db.findOne(table, { id: num(id), org_id: req.user.org_id });
  if (!cur) throw httpError(404, 'Not found.');
  const patch = clean(table, req.body || {}, { partial: true });
  if (table === 'guidelines') { patch.updated_at = db.now(); patch.version = cur.version + 1; }
  try { await db.update(table, cur.id, patch); } catch (e) { if (db.isDuplicate(e)) throw httpError(409, 'That code already exists.'); throw e; }
  await audit.log(req.user.org_id, req.user.id, `kb.${table}.update`, table, cur.id, Object.keys(patch));
  res.json({ ok: true });
}));

router.delete('/:table/:id', role('admin'), wrap(async (req, res) => {
  const { table, id } = req.params;
  if (!TABLES[table]) throw httpError(404, 'Unknown collection.');
  const n = await db.remove(table, { id: num(id), org_id: req.user.org_id });
  if (!n) throw httpError(404, 'Not found.');
  await audit.log(req.user.org_id, req.user.id, `kb.${table}.delete`, table, num(id));
  res.json({ ok: true });
}));

// ---- Guideline import: split a PDF/DOCX/Markdown/text brand book into clauses, preview, then commit. ----
const CATEGORY_HINTS = [
  ['tone', /\b(tone|voice|style|language|exclamation|emoji|sentence|reading)\b/i],
  ['terminology', /\b(term|terminology|word|vocabulary|spelling|name)\b/i],
  ['claims', /\b(claim|legal|regulat|evidence|guarantee|superlative|compliance|advertis)\b/i],
  ['visual', /\b(colou?r|logo|font|typograph|image|photo|visual|layout|palette)\b/i],
  ['accessibility', /\b(access|alt text|contrast|screen reader|wcag)\b/i],
  ['provenance', /\b(\bai\b|generated|disclos)\b/i],
];
const PREFIX = { tone: 'VOICE', terminology: 'TERM', claims: 'CLAIM', visual: 'VIS', accessibility: 'ACC', provenance: 'AI', messaging: 'MSG' };

function splitClauses(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let cur = null;
  const heading = /^(?:#{1,4}\s+|\d+(?:\.\d+)*[.)]\s+|[A-Z][A-Za-z &/-]{2,50}:\s*$)/;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (heading.test(line) && line.length < 80) { cur = { title: line.replace(/^#{1,4}\s+|^\d+(?:\.\d+)*[.)]\s+|:\s*$/g, '').trim(), text: '' }; blocks.push(cur); }
    else if (cur) cur.text += (cur.text ? ' ' : '') + line.replace(/^[-*•]\s+/, '');
    else { cur = { title: line.slice(0, 60), text: '' }; blocks.push(cur); }
  }
  return blocks.filter((b) => b.text.length > 15 || b.title.length > 30).map((b) => ({ title: b.title.slice(0, 80), text: b.text || b.title }));
}

router.post('/import/preview', role('admin'), upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw httpError(400, 'Attach a guideline file (PDF, DOCX, Markdown or text).');
  const ex = await extractFile(req.file);
  const counters = {};
  const clauses = splitClauses(ex.body).map((b) => {
    const cat = (CATEGORY_HINTS.find(([, re]) => re.test(b.title + ' ' + b.text)) || ['messaging'])[0];
    counters[cat] = (counters[cat] || 0) + 1;
    return { code: `${PREFIX[cat]}-IMP${counters[cat]}`, title: b.title, category: cat, text: b.text, severity: 'medium', source_doc: req.file.originalname };
  });
  res.json({ file: req.file.originalname, clauses });
}));

router.post('/import/commit', role('admin'), wrap(async (req, res) => {
  const list = Array.isArray(req.body && req.body.clauses) ? req.body.clauses.slice(0, 500) : [];
  if (!list.length) throw httpError(400, 'No clauses to import.');
  const existing = new Set((await db.find('guidelines', { org_id: req.user.org_id }, { project: ['code'] })).map((g) => g.code));
  let added = 0;
  for (const c of list) {
    let code = String(c.code || 'IMP'), n = 1;
    const base = code;
    while (existing.has(code)) code = `${base}-${++n}`;
    existing.add(code);
    await db.insert('guidelines', { org_id: req.user.org_id, code, title: String(c.title || '').slice(0, 200), category: String(c.category || 'messaging'), text: String(c.text || ''), rule: null, severity: ['low', 'medium', 'high'].includes(c.severity) ? c.severity : 'medium', confidential: 0, active: 1, version: 1, source_doc: c.source_doc || null, updated_at: db.now() });
    added++;
  }
  await audit.log(req.user.org_id, req.user.id, 'kb.import', 'guidelines', null, { added });
  res.json({ added });
}));

module.exports = router;
