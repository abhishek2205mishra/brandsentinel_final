// Review workflow: submit -> approval -> clearance certificate.
//
// Two modes, chosen when an item is submitted:
//  1. Default (risk tiers), unchanged since v1:
//       low / medium : one reviewer, approver or admin approval
//       high         : two different people, at least one approver or admin
//  2. Configured approval chain (Round 3): an admin designs workflows per channel / risk / claim type. The best matching
//     active workflow becomes an ordered chain of steps, each with an assignee (role and/or group), a number of required
//     approvals, an SLA timer and an escalation target. Delegation and out-of-office cover are supported.
// In both modes: authors can never approve their own work, approving with unresolved high-severity findings needs a written
// override reason, and every action is written to the audit log.
const db = require('../db');
const audit = require('./audit');
const cert = require('./certificate');
const { notify, usersWithRoles } = require('./notify');
const { event } = require('./items');

const REVIEW_ROLES = ['reviewer', 'approver', 'admin'];
const RANK = { reviewer: 1, approver: 2, admin: 3 };
const fail = (status, msg, extra) => { const e = new Error(msg); e.status = status; Object.assign(e, extra); return e; };

// ---- serialise chain updates per item (one Render instance; the tick and requests must not overwrite each other)
const locks = new Map();
function withLock(itemId, fn) {
  const run = (locks.get(itemId) || Promise.resolve()).then(fn);
  locks.set(itemId, run.catch(() => {}));
  return run;
}

// ---- workflow definitions
const parseWf = (w) => ({ ...w, match: db.json(w.match, {}), steps: db.json(w.steps, []) });
const asList = (v) => (Array.isArray(v) ? v : []);

async function selectWorkflow(item) {
  const all = (await db.find('workflows', { org_id: item.org_id, active: 1 })).map(parseWf);
  if (!all.length) return null;
  const found = (await db.find('findings', { item_id: item.id, version_n: item.current_version, advisory: 0 }))
    .filter((f) => ['open', 'dismissed'].includes(f.status)); // dismissing a finding must not dodge its approval chain
  const matches = all.filter((w) => {
    const m = w.match || {};
    if (asList(m.channels).length && !m.channels.includes(item.channel)) return false;
    if (asList(m.risks).length && !m.risks.includes(item.risk)) return false;
    if (m.ai_generated === true && !item.ai_generated) return false;
    if (asList(m.claim_types).length && !found.some((f) => m.claim_types.some((t) => f.rule === `claims.${t}`))) return false;
    if (asList(m.categories).length && !found.some((f) => m.categories.includes(f.category))) return false;
    return true;
  });
  if (!matches.length) return null;
  const spec = (w) => ['channels', 'risks', 'claim_types', 'categories'].reduce((n, k) => n + (asList((w.match || {})[k]).length ? 1 : 0), 0) + (w.match && w.match.ai_generated ? 1 : 0);
  matches.sort((a, b) => (b.priority || 0) - (a.priority || 0) || spec(b) - spec(a) || a.id - b.id);
  return matches[0];
}

const chainOf = async (item) => {
  const c = await db.findOne('item_workflows', { item_id: item.id, version_n: item.current_version, status: 'active' });
  return c ? { ...c, steps: db.json(c.steps, []) } : null;
};
const saveChain = (c, patch = {}) => db.update('item_workflows', c.id, { steps: JSON.stringify(c.steps), current_step: c.current_step, updated_at: db.now(), ...patch });

// ---- who may act on a step
const roleOk = (userRole, need) => !!RANK[userRole] && RANK[userRole] >= (RANK[need] || 1);
const inGroup = (u, g) => !g || (Array.isArray(u.groups) && u.groups.includes(g));
const qualifiesPrimary = (u, s) => REVIEW_ROLES.includes(u.role) && roleOk(u.role, s.assignee_role || 'reviewer') && inGroup(u, s.assignee_group);
const qualifiesEscalation = (u, s) => REVIEW_ROLES.includes(u.role) && (s.escalate_role || s.escalate_group) && roleOk(u.role, s.escalate_role || 'reviewer') && inGroup(u, s.escalate_group);
const awayActive = (u) => u.away_delegate_id && u.away_until && new Date(u.away_until) > new Date();

function groundsSync(user, step, item, steps, users) {
  if (user.id === item.author_id) return { ok: false, why: 'You cannot review your own content.' };
  if (!REVIEW_ROLES.includes(user.role)) return { ok: false, why: 'Your role cannot review content.' };
  const full = users.find((u) => u.id === user.id) || user;
  const earlier = steps.slice(0, step.index).flatMap((s) => s.approvals.map((a) => a.user_id));
  if (earlier.includes(user.id)) return { ok: false, why: 'You already approved an earlier step. Another person must approve this one (separation of duties).' };
  if (user.role === 'admin') return { ok: true, as: 'admin' };
  if (qualifiesPrimary(full, step)) return { ok: true, as: 'assignee' };
  if ((step.delegated || []).some((d) => d.to === user.id)) return { ok: true, as: 'delegate' };
  if (users.some((u) => u.away_delegate_id === user.id && awayActive(u) && qualifiesPrimary(u, step))) return { ok: true, as: 'cover' };
  if ((step.escalation_level || 0) >= 1 && qualifiesEscalation(full, step)) return { ok: true, as: 'escalation' };
  const need = [step.assignee_role ? `the ${step.assignee_role} role` : null, step.assignee_group ? `the "${step.assignee_group}" group` : null].filter(Boolean).join(' and ') || 'the reviewer role';
  return { ok: false, why: `This step ("${step.name}") is assigned to ${need}.` };
}
async function actingGrounds(user, step, item, chain) {
  return groundsSync(user, step, item, chain.steps, await db.find('users', { org_id: item.org_id }));
}

// People who should be told a step needs them (and, if nobody is in the group, the admins).
async function stepAudience(item, step, { escalated = false } = {}) {
  const users = await db.find('users', { org_id: item.org_id });
  let list = users.filter((u) => u.id !== item.author_id && qualifiesPrimary(u, step));
  list = list.concat(users.filter((u) => u.id !== item.author_id && (step.delegated || []).some((d) => d.to === u.id)));
  for (const u of users) if (awayActive(u) && list.some((x) => x.id === u.id)) { const d = users.find((x) => x.id === u.away_delegate_id); if (d && d.id !== item.author_id) list.push(d); }
  if (escalated) list = list.concat(users.filter((u) => u.id !== item.author_id && qualifiesEscalation(u, step)));
  let ids = [...new Set(list.map((u) => u.id))];
  if (!ids.length || escalated) ids = [...new Set([...ids, ...users.filter((u) => u.role === 'admin' && u.id !== item.author_id).map((u) => u.id)])];
  return ids;
}

const hoursFromNow = (h) => new Date(Date.now() + h * 3600000).toISOString();
function activate(step) {
  step.status = 'active'; step.activated_at = db.now();
  step.due_at = step.sla_hours > 0 ? hoursFromNow(step.sla_hours) : null;
  step.reminded_at = null; step.escalated_at = null; step.escalation_level = 0;
}

// ---- submit
async function submit(item, user) {
  if (!['draft', 'changes_requested'].includes(item.status)) throw fail(400, `Cannot submit an item that is "${item.status}".`);
  if (user.id !== item.author_id && user.role !== 'admin') throw fail(403, 'Only the author can submit this item.');
  await db.update('items', item.id, { status: 'submitted', updated_at: db.now() });
  await audit.log(item.org_id, user.id, 'item.submit', 'item', item.id, { risk: item.risk, version: item.current_version });

  const wf = await selectWorkflow(item);
  if (!wf) {
    await notify(item.org_id, await usersWithRoles(item.org_id, REVIEW_ROLES), `"${item.title}" was submitted for review (${item.risk} risk).`, `/items/${item.id}`);
    return { mode: 'risk_tier' };
  }
  await db.update('item_workflows', { item_id: item.id, status: 'active' }, { status: 'cancelled', updated_at: db.now() });
  const steps = wf.steps.map((s, i) => ({
    index: i, name: s.name, assignee_role: s.assignee_role || '', assignee_group: s.assignee_group || '', min_approvals: s.min_approvals || 1, sla_hours: s.sla_hours || 0,
    escalate_role: s.escalate_role || '', escalate_group: s.escalate_group || '', status: 'waiting', approvals: [], delegated: [], activated_at: null, due_at: null, completed_at: null,
    reminded_at: null, escalated_at: null, escalation_level: 0,
  }));
  activate(steps[0]);
  const id = await db.insert('item_workflows', { org_id: item.org_id, item_id: item.id, version_n: item.current_version, workflow_id: wf.id, workflow_name: wf.name, status: 'active', current_step: 0, steps: JSON.stringify(steps), created_at: db.now(), updated_at: db.now() });
  await audit.log(item.org_id, user.id, 'workflow.start', 'item', item.id, { workflow: wf.name, workflow_id: wf.id, steps: steps.length });
  await notify(item.org_id, await stepAudience(item, steps[0]), `"${item.title}" needs your review: step 1 of ${steps.length}, ${steps[0].name}${steps[0].sla_hours ? ` (due in ${steps[0].sla_hours}h)` : ''}.`, `/items/${item.id}`);
  return { mode: 'workflow', workflow: wf.name, chain_id: id };
}

// ---- decide
async function decide(item, user, body) {
  const chain = await chainOf(item);
  if (chain) return withLock(item.id, () => decideStep(item, user, body));
  return decideLegacy(item, user, body);
}

function checkBasics(item, user, { decision, reason }) {
  if (!REVIEW_ROLES.includes(user.role)) throw fail(403, 'Your role cannot review content.');
  if (item.status !== 'submitted') throw fail(400, 'This item is not waiting for review.');
  if (user.id === item.author_id) throw fail(403, 'You cannot review your own content.');
  if (!['approve', 'request_changes', 'reject'].includes(decision)) throw fail(400, 'Unknown decision.');
  if (decision !== 'approve' && !(reason || '').trim()) throw fail(400, 'Please explain your decision so the author knows what to do.');
}

async function openHighCheck(item, user, override_reason) {
  const n = item.current_version;
  const openHigh = await db.find('findings', { item_id: item.id, version_n: n, status: 'open', advisory: 0, severity: 'high' });
  if (openHigh.length && !(override_reason || '').trim()) {
    throw fail(409, `${openHigh.length} high-severity finding(s) are still open. Resolve them, or approve with a written override reason.`, { open_high: openHigh.map((f) => f.id) });
  }
  return openHigh;
}

async function finish(item, user, decision, reason) {
  if (decision === 'request_changes') {
    await db.update('items', item.id, { status: 'changes_requested', updated_at: db.now() });
    await notify(item.org_id, [item.author_id], `Changes requested on "${item.title}": ${reason}`, `/items/${item.id}`);
    return { status: 'changes_requested' };
  }
  await db.update('items', item.id, { status: 'rejected', updated_at: db.now() });
  await notify(item.org_id, [item.author_id], `"${item.title}" was rejected: ${reason}`, `/items/${item.id}`);
  return { status: 'rejected' };
}

async function issueCertificate(item, user, extra) {
  const n = item.current_version;
  const version = await db.findOne('versions', { item_id: item.id, n });
  const c = await cert.issue(item.org_id, item.id, n, version.content_hash, user.id, extra);
  await db.update('items', item.id, { status: 'approved', updated_at: db.now() });
  await audit.log(item.org_id, user.id, 'certificate.issue', 'item', item.id, { certificate_id: c.id, version: n, code: c.verification_code });
  await notify(item.org_id, [item.author_id], `"${item.title}" is approved and cleared for publication.`, `/items/${item.id}`);
  return c;
}

// ---- mode 1: risk tiers (unchanged behaviour)
async function decideLegacy(item, user, { decision, reason, override_reason }) {
  checkBasics(item, user, { decision, reason });
  const n = item.current_version;
  if (decision === 'approve') {
    const openHigh = await openHighCheck(item, user, override_reason);
    if (await db.findOne('decisions', { item_id: item.id, version_n: n, user_id: user.id, decision: 'approve' })) throw fail(400, 'You have already approved this version.');
    for (const f of openHigh) await event(item, f, 'override', override_reason, user.id);
  }
  await db.insert('decisions', { item_id: item.id, version_n: n, user_id: user.id, decision, reason: reason || null, override_reason: override_reason || null, created_at: db.now() });
  await audit.log(item.org_id, user.id, `decision.${decision}`, 'item', item.id, { version: n, reason, override_reason });
  if (decision !== 'approve') return finish(item, user, decision, reason);

  const approveRows = await db.find('decisions', { item_id: item.id, version_n: n, decision: 'approve' });
  const roleOf = await db.mapByIds('users', approveRows.map((d) => d.user_id), ['role']);
  const approvals = approveRows.map((d) => ({ user_id: d.user_id, role: (roleOf.get(d.user_id) || {}).role }));
  const distinct = new Set(approvals.map((a) => a.user_id));
  const needed = item.risk === 'high' ? 2 : 1;
  const hasSenior = approvals.some((a) => ['approver', 'admin'].includes(a.role));
  const satisfied = distinct.size >= needed && (item.risk !== 'high' || hasSenior);
  if (!satisfied) {
    const missing = distinct.size < needed ? `${needed - distinct.size} more approval(s)` : 'an approver or admin sign-off';
    await notify(item.org_id, await usersWithRoles(item.org_id, ['approver', 'admin']), `"${item.title}" needs ${missing}.`, `/items/${item.id}`);
    return { status: 'submitted', waiting_for: missing };
  }
  const c = await issueCertificate(item, user, {});
  return { status: 'approved', certificate: c };
}

// ---- mode 2: configured chain
async function decideStep(item, user, { decision, reason, override_reason }) {
  const chain = await chainOf(item);
  if (!chain) return decideLegacy(item, user, { decision, reason, override_reason });
  checkBasics(item, user, { decision, reason });
  const n = item.current_version;
  const step = chain.steps[chain.current_step];
  const grounds = await actingGrounds(user, step, item, chain);
  if (!grounds.ok) throw fail(403, grounds.why);

  let openHigh = [];
  if (decision === 'approve') {
    openHigh = await openHighCheck(item, user, override_reason);
    if (step.approvals.some((a) => a.user_id === user.id)) throw fail(400, 'You have already approved this step.');
    for (const f of openHigh) await event(item, f, 'override', override_reason, user.id);
  }
  await db.insert('decisions', { item_id: item.id, version_n: n, user_id: user.id, decision, reason: reason || null, override_reason: override_reason || null, step_index: step.index, step_name: step.name, acted_as: grounds.as, created_at: db.now() });
  await audit.log(item.org_id, user.id, `decision.${decision}`, 'item', item.id, { version: n, reason, override_reason, step: step.name, acted_as: grounds.as });

  if (decision !== 'approve') {
    chain.steps[step.index].status = decision === 'reject' ? 'rejected' : 'changes_requested';
    await saveChain(chain, { status: decision === 'reject' ? 'rejected' : 'changes_requested' });
    return finish(item, user, decision, reason);
  }

  step.approvals.push({ user_id: user.id, role: user.role, at: db.now(), acted_as: grounds.as });
  if (step.approvals.length < step.min_approvals) {
    await saveChain(chain);
    const missing = `${step.min_approvals - step.approvals.length} more approval(s) for "${step.name}"`;
    await notify(item.org_id, await stepAudience(item, step), `"${item.title}" needs ${missing}.`, `/items/${item.id}`);
    return { status: 'submitted', waiting_for: missing, step: step.name };
  }
  step.status = 'approved'; step.completed_at = db.now();
  const next = chain.steps[step.index + 1];
  if (next) {
    activate(next);
    chain.current_step = next.index;
    await saveChain(chain);
    await audit.log(item.org_id, user.id, 'workflow.advance', 'item', item.id, { from: step.name, to: next.name });
    await notify(item.org_id, await stepAudience(item, next), `"${item.title}" needs your review: step ${next.index + 1} of ${chain.steps.length}, ${next.name}${next.sla_hours ? ` (due in ${next.sla_hours}h)` : ''}.`, `/items/${item.id}`);
    return { status: 'submitted', waiting_for: `step ${next.index + 1}: ${next.name}`, step: next.name };
  }
  await saveChain(chain, { status: 'approved' });
  const c = await issueCertificate(item, user, { workflow: { name: chain.workflow_name, steps: chain.steps } });
  return { status: 'approved', certificate: c };
}

// ---- delegation
async function delegate(item, user, toUserId, reason) {
  return withLock(item.id, async () => {
    const chain = await chainOf(item);
    if (!chain || item.status !== 'submitted') throw fail(400, 'This item has no active approval step to delegate.');
    const step = chain.steps[chain.current_step];
    const g = await actingGrounds(user, step, item, chain);
    if (!g.ok) throw fail(403, g.why);
    const to = await db.findOne('users', { id: Number(toUserId), org_id: item.org_id });
    if (!to) throw fail(404, 'That user was not found.');
    if (!REVIEW_ROLES.includes(to.role)) throw fail(400, 'You can only delegate to a reviewer, approver or admin.');
    if (to.id === item.author_id) throw fail(400, 'You cannot delegate to the author of the content.');
    if (to.id === user.id) throw fail(400, 'Choose someone else.');
    step.delegated = (step.delegated || []).concat([{ from: user.id, to: to.id, at: db.now(), reason: String(reason || '').slice(0, 200) }]);
    await saveChain(chain);
    await audit.log(item.org_id, user.id, 'workflow.delegate', 'item', item.id, { step: step.name, to: to.id, reason });
    await notify(item.org_id, [to.id], `${user.name} asked you to review "${item.title}" (${step.name}).`, `/items/${item.id}`);
    return { ok: true, step: step.name, to: to.name };
  });
}

async function nudge(item, user) {
  const chain = await chainOf(item);
  if (!chain) throw fail(400, 'This item is not in a configured approval chain.');
  if (user.id !== item.author_id && user.role !== 'admin') throw fail(403, 'Only the author or an admin can send a reminder.');
  const step = chain.steps[chain.current_step];
  if (step.nudged_at && Date.now() - new Date(step.nudged_at).getTime() < 4 * 3600000) throw fail(429, 'A reminder was already sent in the last 4 hours.');
  step.nudged_at = db.now(); await saveChain(chain);
  await notify(item.org_id, await stepAudience(item, step), `Reminder: "${item.title}" is waiting for ${step.name}.`, `/items/${item.id}`);
  await audit.log(item.org_id, user.id, 'workflow.nudge', 'item', item.id, { step: step.name });
  return { ok: true };
}

// What the UI needs to draw the chain and the right buttons for the viewer.
async function describe(item, user) {
  const chains = await db.find('item_workflows', { item_id: item.id }, { sort: { id: -1 }, limit: 1 });
  const c = chains[0];
  if (!c) return null;
  const steps = db.json(c.steps, []);
  const ids = steps.flatMap((s) => [...s.approvals.map((a) => a.user_id), ...(s.delegated || []).map((d) => d.to)]);
  const names = await db.mapByIds('users', ids, ['name']);
  const active = c.status === 'active' && item.status === 'submitted';
  const cur = steps[c.current_step];
  const grounds = active && cur ? await actingGrounds(user, cur, item, { steps }) : { ok: false };
  const now = Date.now();
  return {
    id: c.id, workflow: c.workflow_name, status: c.status, version_n: c.version_n, current_step: c.current_step, can_act: !!grounds.ok, acting_as: grounds.as || null,
    steps: steps.map((s) => ({
      index: s.index, name: s.name, status: s.status, assignee_role: s.assignee_role, assignee_group: s.assignee_group, min_approvals: s.min_approvals, sla_hours: s.sla_hours,
      due_at: s.due_at, overdue: !!(s.due_at && s.status === 'active' && new Date(s.due_at).getTime() < now), escalation_level: s.escalation_level || 0, completed_at: s.completed_at,
      approvals: s.approvals.map((a) => ({ name: (names.get(a.user_id) || {}).name, role: a.role, at: a.at, acted_as: a.acted_as })),
      delegated: (s.delegated || []).map((d) => ({ to: (names.get(d.to) || {}).name, at: d.at, reason: d.reason })),
    })),
  };
}

// Batch info for the content list / dashboard: where each submitted item is in its chain and whether this viewer can act.
async function queueInfo(orgId, user, itemRows) {
  const ids = itemRows.filter((i) => i.status === 'submitted').map((i) => i.id);
  const out = new Map();
  if (!ids.length) return out;
  const [chains, users] = await Promise.all([db.find('item_workflows', { item_id: { $in: ids }, status: 'active' }), db.find('users', { org_id: orgId })]);
  const byItem = new Map(itemRows.map((i) => [i.id, i]));
  for (const c of chains) {
    const item = byItem.get(c.item_id);
    if (!item || c.version_n !== item.current_version) continue;
    const steps = db.json(c.steps, []);
    const step = steps[c.current_step];
    if (!step) continue;
    out.set(c.item_id, { workflow: c.workflow_name, step: step.name, step_no: c.current_step + 1, steps: steps.length, due_at: step.due_at, overdue: !!(step.due_at && new Date(step.due_at).getTime() < Date.now()), escalation_level: step.escalation_level || 0, awaiting_me: groundsSync(user, step, item, steps, users).ok });
  }
  return out;
}

module.exports = { queueInfo, submit, decide, delegate, nudge, describe, selectWorkflow, stepAudience, chainOf, withLock, saveChain, REVIEW_ROLES, RANK, activate };
