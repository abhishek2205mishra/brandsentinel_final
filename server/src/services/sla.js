// SLA timers and escalation for configured approval chains.
//   75% of the SLA used  -> reminder to the people assigned to the step
//   SLA passed           -> escalation level 1: the escalation role/group (and admins) are told, they may act, a second window starts
//   second window passed -> escalation level 2: admins are told again (nothing is ever approved automatically)
// tick() runs on a timer (every SLA_TICK_MINUTES) and lazily when people open the dashboard, so it still works if the free
// Render instance slept for a while.
const db = require('../db');
const config = require('../config');
const audit = require('./audit');
const email = require('./email');
const { notify } = require('./notify');
const wf = require('./workflow');

async function processChain(c, now) {
  const item = await db.get('items', c.item_id);
  if (!item || item.status !== 'submitted') return { skipped: true };
  return wf.withLock(item.id, async () => {
    const fresh = await db.get('item_workflows', c.id);
    if (!fresh || fresh.status !== 'active') return {};
    const chain = { ...fresh, steps: db.json(fresh.steps, []) };
    const step = chain.steps[chain.current_step];
    if (!step || step.status !== 'active' || !step.due_at || !(step.sla_hours > 0)) return {};
    const due = new Date(step.due_at).getTime();
    const started = new Date(step.activated_at).getTime();
    const out = {};
    if (now >= due) {
      const level = (step.escalation_level || 0) + 1;
      if (level > 2) return {};
      step.escalation_level = level; step.escalated_at = new Date(now).toISOString();
      step.due_at = new Date(now + step.sla_hours * 3600000).toISOString();
      await wf.saveChain(chain);
      const ids = await wf.stepAudience(item, step, { escalated: true });
      const text = level === 1
        ? `Overdue: "${item.title}" has waited more than ${step.sla_hours}h at "${step.name}". You can now act on it.`
        : `Still overdue: "${item.title}" is stuck at "${step.name}" after escalation. Please decide or reassign.`;
      await notify(item.org_id, ids, text, `/items/${item.id}`);
      await audit.log(item.org_id, null, 'workflow.escalate', 'item', item.id, { step: step.name, level, sla_hours: step.sla_hours });
      out.escalated = level;
    } else if (!step.reminded_at && now >= started + 0.75 * step.sla_hours * 3600000) {
      step.reminded_at = new Date(now).toISOString();
      await wf.saveChain(chain);
      await notify(item.org_id, await wf.stepAudience(item, step), `Due soon: "${item.title}" is waiting for ${step.name} (due ${new Date(step.due_at).toUTCString().replace('GMT', 'UTC')}).`, `/items/${item.id}`);
      out.reminded = true;
    }
    return out;
  });
}

async function tick(now = Date.now()) {
  const chains = await db.find('item_workflows', { status: 'active' });
  const summary = { checked: chains.length, reminded: 0, escalated: 0 };
  for (const c of chains) {
    try {
      const r = await processChain(c, now);
      if (r.reminded) summary.reminded++;
      if (r.escalated) summary.escalated++;
    } catch (e) { console.error('SLA tick failed for chain', c.id, e.message); }
  }
  return summary;
}

let last = 0;
async function lazyTick() {
  if (Date.now() - last < 30000) return;
  last = Date.now();
  await tick().catch(() => {});
}

let timer = null;
function startTimer() {
  if (timer || !(config.slaTickMinutes > 0)) return;
  timer = setInterval(() => { tick().catch(() => {}); email.processQueue().catch(() => {}); }, config.slaTickMinutes * 60000);
  timer.unref();
}
const stopTimer = () => { if (timer) { clearInterval(timer); timer = null; } };

// Dashboard numbers: what is waiting, what is late, how long steps take.
async function summary(orgId) {
  const chains = (await db.find('item_workflows', { org_id: orgId })).map((c) => ({ ...c, steps: db.json(c.steps, []) }));
  const now = Date.now();
  const active = chains.filter((c) => c.status === 'active');
  const items = await db.mapByIds('items', active.map((c) => c.item_id), ['title', 'status']);
  const waiting = active.filter((c) => (items.get(c.item_id) || {}).status === 'submitted').map((c) => {
    const s = c.steps[c.current_step];
    return { item_id: c.item_id, title: (items.get(c.item_id) || {}).title, workflow: c.workflow_name, step: s.name, due_at: s.due_at, overdue: !!(s.due_at && new Date(s.due_at).getTime() < now), escalation_level: s.escalation_level || 0 };
  });
  const done = chains.flatMap((c) => c.steps.filter((s) => s.completed_at && s.activated_at).map((s) => ({ name: s.name, hours: (new Date(s.completed_at) - new Date(s.activated_at)) / 3600000, breached: !!(s.escalation_level), wf: c.workflow_name })));
  const byStep = new Map();
  for (const d of done) { const e = byStep.get(d.name) || { step: d.name, n: 0, hours: 0, breached: 0 }; e.n++; e.hours += d.hours; e.breached += d.breached ? 1 : 0; byStep.set(d.name, e); }
  return {
    active: waiting.length, overdue: waiting.filter((w) => w.overdue).length, waiting: waiting.sort((a, b) => (b.overdue - a.overdue) || String(a.due_at).localeCompare(String(b.due_at))).slice(0, 20),
    steps: [...byStep.values()].map((e) => ({ step: e.step, completed: e.n, avg_hours: +(e.hours / e.n).toFixed(1), escalated: e.breached })),
  };
}

module.exports = { tick, lazyTick, startTimer, stopTimer, summary };
