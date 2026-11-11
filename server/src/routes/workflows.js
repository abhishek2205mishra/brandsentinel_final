// Approval workflow designer (admins), SLA overview, and user groups / away cover.
const express = require('express');
const db = require('../db');
const { wrap, auth, role, httpError, num } = require('../middleware/auth');
const audit = require('../services/audit');
const sla = require('../services/sla');
const wf = require('../services/workflow');

const router = express.Router();
router.use(auth);

const CHANNELS = ['social', 'email', 'blog', 'web', 'paid-ad', 'press-release', 'internal'];
const RISKS = ['low', 'medium', 'high'];
const CLAIM_TYPES = ['financial', 'health', 'absolute', 'comparative', 'superlative', 'award', 'environmental', 'natural', 'statistic', 'expired'];
const CATEGORIES = ['claims', 'facts', 'terminology', 'tone', 'accessibility', 'visual', 'provenance', 'messaging'];
const STEP_ROLES = ['reviewer', 'approver', 'admin'];
const slug = (g) => String(g || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
const pick = (v, allowed) => (Array.isArray(v) ? [...new Set(v.filter((x) => allowed.includes(x)))] : []);

const TEMPLATES = [
  { key: 'health-legal', name: 'Health claims: legal review, then brand approver', description: 'Any health claim goes to the legal group first, then to an approver.', priority: 90,
    match: { claim_types: ['health'] }, steps: [{ name: 'Legal review', assignee_role: 'reviewer', assignee_group: 'legal', min_approvals: 1, sla_hours: 24, escalate_role: 'approver', escalate_group: '' }, { name: 'Brand approver sign-off', assignee_role: 'approver', assignee_group: '', min_approvals: 1, sla_hours: 24, escalate_role: 'admin', escalate_group: '' }] },
  { key: 'paid-ads', name: 'Paid ads: reviewer, then approver', description: 'Paid media spends money, so two steps with tighter timers.', priority: 50,
    match: { channels: ['paid-ad'] }, steps: [{ name: 'Reviewer check', assignee_role: 'reviewer', assignee_group: '', min_approvals: 1, sla_hours: 8, escalate_role: 'approver', escalate_group: '' }, { name: 'Approver sign-off', assignee_role: 'approver', assignee_group: '', min_approvals: 1, sla_hours: 8, escalate_role: 'admin', escalate_group: '' }] },
  { key: 'high-risk', name: 'High risk: two reviewers, then approver', description: 'Needs two different reviewers, then a senior sign-off.', priority: 60,
    match: { risks: ['high'] }, steps: [{ name: 'Two reviewers', assignee_role: 'reviewer', assignee_group: '', min_approvals: 2, sla_hours: 24, escalate_role: 'approver', escalate_group: '' }, { name: 'Approver sign-off', assignee_role: 'approver', assignee_group: '', min_approvals: 1, sla_hours: 24, escalate_role: 'admin', escalate_group: '' }] },
  { key: 'ai-content', name: 'AI-generated content: extra human check', description: 'Anything declared as AI-assisted gets a reviewer and an approver.', priority: 40,
    match: { ai_generated: true }, steps: [{ name: 'Human accuracy check', assignee_role: 'reviewer', assignee_group: '', min_approvals: 1, sla_hours: 24, escalate_role: 'approver', escalate_group: '' }, { name: 'Approver sign-off', assignee_role: 'approver', assignee_group: '', min_approvals: 1, sla_hours: 48, escalate_role: 'admin', escalate_group: '' }] },
];

function validate(b) {
  const name = String(b.name || '').trim().slice(0, 80);
  if (name.length < 3) throw httpError(400, 'Give the workflow a name (at least 3 characters).');
  const m = b.match || {};
  const match = { channels: pick(m.channels, CHANNELS), risks: pick(m.risks, RISKS), claim_types: pick(m.claim_types, CLAIM_TYPES), categories: pick(m.categories, CATEGORIES), ai_generated: m.ai_generated === true };
  const raw = Array.isArray(b.steps) ? b.steps : [];
  if (raw.length < 1 || raw.length > 6) throw httpError(400, 'A workflow needs between 1 and 6 steps.');
  const steps = raw.map((s, i) => {
    const nm = String(s.name || '').trim().slice(0, 60);
    if (!nm) throw httpError(400, `Step ${i + 1} needs a name.`);
    const r = STEP_ROLES.includes(s.assignee_role) ? s.assignee_role : '';
    const g = slug(s.assignee_group);
    if (!r && !g) throw httpError(400, `Step ${i + 1} ("${nm}") needs a role or a group.`);
    const sla = Math.max(0, Math.min(720, Number(s.sla_hours) || 0));
    const min = Math.max(1, Math.min(5, Math.round(Number(s.min_approvals) || 1)));
    const er = STEP_ROLES.includes(s.escalate_role) ? s.escalate_role : '';
    return { name: nm, assignee_role: r, assignee_group: g, min_approvals: min, sla_hours: sla, escalate_role: er, escalate_group: slug(s.escalate_group) };
  });
  return { name, description: String(b.description || '').trim().slice(0, 300), priority: Math.max(0, Math.min(1000, Math.round(Number(b.priority) || 50))), match, steps };
}

const present = (w) => ({ id: w.id, name: w.name, description: w.description, active: !!w.active, priority: w.priority, match: db.json(w.match, {}), steps: db.json(w.steps, []), created_at: w.created_at, updated_at: w.updated_at });

async function groupsOf(orgId) {
  const users = await db.find('users', { org_id: orgId });
  const g = new Map();
  for (const u of users) for (const x of (u.groups || [])) { const e = g.get(x) || []; e.push({ id: u.id, name: u.name, role: u.role }); g.set(x, e); }
  return [...g.entries()].map(([name, members]) => ({ name, members })).sort((a, b) => a.name.localeCompare(b.name));
}

// Warnings that help admins avoid chains that would get stuck.
async function lint(orgId, w) {
  const users = await db.find('users', { org_id: orgId });
  const out = [];
  w.steps.forEach((s, i) => {
    const pool = users.filter((u) => wf.REVIEW_ROLES.includes(u.role) && (wf.RANK[u.role] >= (wf.RANK[s.assignee_role] || 1)) && (!s.assignee_group || (u.groups || []).includes(s.assignee_group)));
    if (!pool.length) out.push(`Step ${i + 1} "${s.name}": nobody matches (role ${s.assignee_role || 'any'}, group ${s.assignee_group || 'any'}). Only admins could act on it.`);
    else if (pool.length < s.min_approvals) out.push(`Step ${i + 1} "${s.name}" needs ${s.min_approvals} approvals but only ${pool.length} eligible people exist.`);
  });
  return out;
}

router.get('/', wrap(async (req, res) => {
  if (!['admin', 'approver', 'auditor', 'reviewer'].includes(req.user.role)) throw httpError(403, 'Your role cannot view workflows.');
  const rows = (await db.find('workflows', { org_id: req.user.org_id }, { sort: { priority: -1, id: 1 } })).map(present);
  res.json({ workflows: rows, templates: TEMPLATES, groups: await groupsOf(req.user.org_id), options: { channels: CHANNELS, risks: RISKS, claim_types: CLAIM_TYPES, categories: CATEGORIES, roles: STEP_ROLES } });
}));

router.post('/', role('admin'), wrap(async (req, res) => {
  const v = validate(req.body || {});
  const id = await db.insert('workflows', { org_id: req.user.org_id, ...v, match: JSON.stringify(v.match), steps: JSON.stringify(v.steps), active: (req.body || {}).active === false ? 0 : 1, created_by: req.user.id, created_at: db.now(), updated_at: db.now() });
  await audit.log(req.user.org_id, req.user.id, 'workflow.create', 'workflow', id, { name: v.name, steps: v.steps.length });
  res.status(201).json({ id, warnings: await lint(req.user.org_id, v) });
}));

router.put('/:id', role('admin'), wrap(async (req, res) => {
  const w = await db.findOne('workflows', { id: num(req.params.id), org_id: req.user.org_id });
  if (!w) throw httpError(404, 'Workflow not found.');
  const v = validate(req.body || {});
  await db.update('workflows', w.id, { ...v, match: JSON.stringify(v.match), steps: JSON.stringify(v.steps), active: (req.body || {}).active === false ? 0 : 1, updated_at: db.now() });
  await audit.log(req.user.org_id, req.user.id, 'workflow.update', 'workflow', w.id, { name: v.name, steps: v.steps.length });
  res.json({ ok: true, warnings: await lint(req.user.org_id, v) });
}));

router.post('/:id/toggle', role('admin'), wrap(async (req, res) => {
  const w = await db.findOne('workflows', { id: num(req.params.id), org_id: req.user.org_id });
  if (!w) throw httpError(404, 'Workflow not found.');
  await db.update('workflows', w.id, { active: w.active ? 0 : 1, updated_at: db.now() });
  await audit.log(req.user.org_id, req.user.id, 'workflow.toggle', 'workflow', w.id, { active: !w.active });
  res.json({ active: !w.active });
}));

// Chains already running keep their own copy of the steps, so deleting a workflow never breaks content in review.
router.delete('/:id', role('admin'), wrap(async (req, res) => {
  const w = await db.findOne('workflows', { id: num(req.params.id), org_id: req.user.org_id });
  if (!w) throw httpError(404, 'Workflow not found.');
  await db.remove('workflows', w.id);
  await audit.log(req.user.org_id, req.user.id, 'workflow.delete', 'workflow', w.id, { name: w.name });
  res.json({ ok: true });
}));

// "Which workflow would this content use?": lets admins test a design before it matters.
router.post('/preview', role('admin'), wrap(async (req, res) => {
  const b = req.body || {};
  const fake = { id: -1, org_id: req.user.org_id, channel: CHANNELS.includes(b.channel) ? b.channel : 'social', risk: RISKS.includes(b.risk) ? b.risk : 'low', ai_generated: b.ai_generated ? 1 : 0, current_version: 0 };
  const claimTypes = pick(b.claim_types, CLAIM_TYPES);
  // selectWorkflow reads findings from the database; for a preview we pass them in directly.
  const all = (await db.find('workflows', { org_id: req.user.org_id, active: 1 })).map((w) => ({ ...w, match: db.json(w.match, {}), steps: db.json(w.steps, []) }));
  const found = claimTypes.map((t) => ({ rule: `claims.${t}`, category: 'claims' }));
  const ok = all.filter((w) => {
    const m = w.match || {};
    if ((m.channels || []).length && !m.channels.includes(fake.channel)) return false;
    if ((m.risks || []).length && !m.risks.includes(fake.risk)) return false;
    if (m.ai_generated === true && !fake.ai_generated) return false;
    if ((m.claim_types || []).length && !found.some((f) => m.claim_types.some((t) => f.rule === `claims.${t}`))) return false;
    if ((m.categories || []).length && !(m.categories.includes('claims') && found.length)) return false;
    return true;
  }).sort((a, b2) => (b2.priority || 0) - (a.priority || 0) || a.id - b2.id);
  res.json({ workflow: ok[0] ? present(ok[0]) : null, note: ok[0] ? null : 'No workflow matches, so the standard risk-tier approval (one reviewer; two people for high risk) applies.' });
}));

router.get('/sla', wrap(async (req, res) => {
  if (!['admin', 'approver', 'auditor', 'reviewer'].includes(req.user.role)) throw httpError(403, 'Your role cannot view this.');
  await sla.lazyTick();
  res.json(await sla.summary(req.user.org_id));
}));

// ---- groups and away cover
router.put('/users/:id/groups', role('admin'), wrap(async (req, res) => {
  const u = await db.findOne('users', { id: num(req.params.id), org_id: req.user.org_id });
  if (!u) throw httpError(404, 'User not found.');
  const groups = [...new Set((Array.isArray((req.body || {}).groups) ? req.body.groups : []).map(slug).filter(Boolean))].slice(0, 10);
  await db.update('users', u.id, { groups });
  await audit.log(req.user.org_id, req.user.id, 'user.groups', 'user', u.id, { groups });
  res.json({ groups });
}));

router.put('/me/away', wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.delegate_to_id) {
    await db.update('users', req.user.id, { away_delegate_id: null, away_until: null });
    await audit.log(req.user.org_id, req.user.id, 'user.away', 'user', req.user.id, { cleared: true });
    return res.json({ ok: true, away: null });
  }
  const to = await db.findOne('users', { id: num(b.delegate_to_id), org_id: req.user.org_id });
  if (!to || !wf.REVIEW_ROLES.includes(to.role)) throw httpError(400, 'Choose a reviewer, approver or admin to cover for you.');
  if (to.id === req.user.id) throw httpError(400, 'Choose someone else.');
  const until = new Date(b.until);
  if (isNaN(until) || until <= new Date()) throw httpError(400, 'Choose a date in the future for when you are back.');
  if (until.getTime() - Date.now() > 90 * 86400000) throw httpError(400, 'Away cover can last at most 90 days.');
  await db.update('users', req.user.id, { away_delegate_id: to.id, away_until: until.toISOString() });
  await audit.log(req.user.org_id, req.user.id, 'user.away', 'user', req.user.id, { delegate: to.id, until: until.toISOString() });
  res.json({ ok: true, away: { delegate_to_id: to.id, delegate_name: to.name, until: until.toISOString() } });
}));

module.exports = router;
