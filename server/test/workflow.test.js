// Round 3 / improvement 3: configurable approval chains, delegation, SLA + escalation, email delivery, public verification.
process.env.NODE_ENV = 'test';
process.env.DB_DRIVER = process.env.DB_DRIVER || 'memory';
process.env.SEED_DEMO = 'false';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const bcrypt = require('bcryptjs');
const { app } = require('../src/index');
const { seedDemo, PASSWORD } = require('../src/seed');
const db = require('../src/db');
const config = require('../src/config');
const audit = require('../src/services/audit');
const sla = require('../src/services/sla');
const email = require('../src/services/email');
const certSvc = require('../src/services/certificate');

let base, server;
const jwt = {};
async function call(method, url, { token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch { /* none */ }
  return { status: res.status, data };
}
const login = async (who) => (jwt[who] ||= (await call('POST', '/api/auth/login', { body: { email: `${who}@novabrew.test`, password: PASSWORD } })).data.token);
const uid = async (who) => (await db.findOne('users', { email: `${who}@novabrew.test` })).id;
const HEALTH = 'Our new blend is clinically proven to boost immunity.';
async function newItem(body = HEALTH, channel = 'social', who = 'creator') {
  const r = await call('POST', '/api/items', { token: await login(who), body: { title: 'WF test ' + Math.random().toString(36).slice(2, 7), channel, kind: 'text', intent: 'Tell people about our blend', body } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.id;
}
async function submit(id, who = 'creator') { assert.equal((await call('POST', `/api/items/${id}/submit`, { token: await login(who) })).status, 200); }
const decide = async (id, who, body = {}) => call('POST', `/api/items/${id}/decision`, { token: await login(who), body: { decision: 'approve', override_reason: 'Checked evidence offline.', ...body } });
const detail = async (id, who = 'admin') => (await call('GET', `/api/items/${id}`, { token: await login(who) })).data;
const chainRow = async (id) => { const c = (await db.find('item_workflows', { item_id: id }, { sort: { id: -1 } }))[0]; return { ...c, steps: JSON.parse(c.steps) }; };
const setSteps = (c, steps, patch = {}) => db.update('item_workflows', c.id, { steps: JSON.stringify(steps), ...patch });

test.before(async () => {
  await db.connect(); await db.clearAll(); await seedDemo();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); await db.close(); });

test('only admins design workflows; input is validated', async () => {
  const good = { name: 'Press releases need legal', steps: [{ name: 'Legal', assignee_role: 'reviewer', assignee_group: 'legal', sla_hours: 12 }], match: { channels: ['press-release'] } };
  assert.equal((await call('POST', '/api/workflows', { token: await login('reviewer'), body: good })).status, 403);
  assert.equal((await call('POST', '/api/workflows', { token: await login('admin'), body: { ...good, name: 'x' } })).status, 400);
  assert.equal((await call('POST', '/api/workflows', { token: await login('admin'), body: { ...good, steps: [] } })).status, 400);
  assert.equal((await call('POST', '/api/workflows', { token: await login('admin'), body: { ...good, steps: [{ name: 'No assignee' }] } })).status, 400);
  const ok = await call('POST', '/api/workflows', { token: await login('admin'), body: good });
  assert.equal(ok.status, 201);
  const list = (await call('GET', '/api/workflows', { token: await login('admin') })).data;
  assert.ok(list.workflows.length >= 2 && list.templates.length >= 3 && list.groups.some((g) => g.name === 'legal'));
  await call('DELETE', `/api/workflows/${ok.data.id}`, { token: await login('admin') });
});

test('a lint warning appears when a step has nobody who can act', async () => {
  const r = await call('POST', '/api/workflows', { token: await login('admin'), body: { name: 'Needs finance group', steps: [{ name: 'Finance', assignee_role: 'reviewer', assignee_group: 'finance' }], match: { claim_types: ['financial'] }, active: false } });
  assert.equal(r.status, 201);
  assert.ok(r.data.warnings[0].includes('nobody matches'));
  await call('DELETE', `/api/workflows/${r.data.id}`, { token: await login('admin') });
});

test('content without a matching workflow keeps the standard risk-tier approval', async () => {
  const id = await newItem('Slow mornings call for a gentle pour-over.');
  await submit(id);
  assert.equal(await db.count('item_workflows', { item_id: id }), 0);
  const r = await decide(id, 'reviewer', { override_reason: undefined });
  assert.equal(r.data.status, 'approved');
});

test('a health claim starts the legal chain; the right people act in the right order', async () => {
  const id = await newItem();
  await submit(id);
  const d = await detail(id);
  assert.equal(d.workflow.workflow, 'Health claims: legal review, then brand approver');
  assert.equal(d.workflow.steps[0].status, 'active');
  assert.ok(d.workflow.steps[0].due_at, 'SLA timer started');

  // The author, an auditor and a reviewer outside the legal group cannot act on step 1.
  const kabir = await call('POST', `/api/items/${id}/decision`, { token: await login('creator'), body: { decision: 'approve' } });
  assert.equal(kabir.status, 403);
  await db.insert('users', { org_id: 1, email: 'other.reviewer@novabrew.test', name: 'Outside Reviewer', password_hash: await bcrypt.hash(PASSWORD, 4), role: 'reviewer', created_at: db.now() });
  const outside = await call('POST', '/api/auth/login', { body: { email: 'other.reviewer@novabrew.test', password: PASSWORD } });
  const blocked = await call('POST', `/api/items/${id}/decision`, { token: outside.data.token, body: { decision: 'approve', override_reason: 'x' } });
  assert.equal(blocked.status, 403);
  assert.match(blocked.data.error, /legal/);

  const first = await decide(id, 'reviewer');
  assert.equal(first.data.status, 'submitted');
  assert.match(first.data.waiting_for, /Brand approver/);
  // Separation of duties: the person who did step 1 cannot also do step 2.
  const again = await decide(id, 'approver'); // Meera is in the legal group too, but did not do step 1: she may act
  assert.equal(again.data.status, 'approved');
  const done = await detail(id);
  assert.ok(done.certificate.verification_code);
  assert.equal(done.workflow.status, 'approved');
});

test('separation of duties: one person cannot approve two steps', async () => {
  const id = await newItem();
  await submit(id);
  assert.equal((await decide(id, 'approver')).data.status, 'submitted'); // Meera (legal) passes step 1
  const second = await decide(id, 'approver');
  assert.equal(second.status, 403);
  assert.match(second.data.error, /separation of duties/);
  assert.equal((await decide(id, 'admin')).data.status, 'approved'); // an admin completes step 2
});

test('rejecting at any step ends the chain and returns the item to its author', async () => {
  const id = await newItem();
  await submit(id);
  assert.equal((await decide(id, 'reviewer', { decision: 'request_changes', reason: '' })).status, 400, 'reason required');
  const r = await decide(id, 'reviewer', { decision: 'request_changes', reason: 'Remove the immunity claim.' });
  assert.equal(r.data.status, 'changes_requested');
  assert.equal((await detail(id)).workflow.status, 'changes_requested');
  // After the author edits and resubmits, a fresh chain starts for the new version.
  const d = await detail(id, 'creator');
  const v = await call('POST', `/api/items/${id}/versions`, { token: await login('creator'), body: { body: HEALTH + ' Enjoy it.', note: 'tweak' } });
  assert.equal(v.status, 200);
  await submit(id);
  const d2 = await detail(id);
  assert.equal(d2.workflow.version_n, d.item.current_version + 1);
  assert.equal(d2.workflow.steps[0].status, 'active');
});

test('a step can require several approvals from different people', async () => {
  const mk = await call('POST', '/api/workflows', { token: await login('admin'), body: { name: 'Press: two reviewers', priority: 99, match: { channels: ['press-release'] }, steps: [{ name: 'Two reviewers', assignee_role: 'reviewer', min_approvals: 2, sla_hours: 24 }] } });
  const id = await newItem('We are opening a new roastery in Pune next spring.', 'press-release');
  await submit(id);
  assert.equal((await detail(id)).workflow.workflow, 'Press: two reviewers');
  const a = await decide(id, 'reviewer');
  assert.equal(a.data.status, 'submitted');
  assert.match(a.data.waiting_for, /1 more approval/);
  assert.equal((await decide(id, 'reviewer')).status, 400, 'the same person cannot count twice');
  assert.equal((await decide(id, 'approver')).data.status, 'approved');
  await call('DELETE', `/api/workflows/${mk.data.id}`, { token: await login('admin') });
});

test('delegation: an assignee hands the step to a colleague, who can then act', async () => {
  const id = await newItem();
  await submit(id);
  const helper = await db.findOne('users', { email: 'other.reviewer@novabrew.test' });
  const helperToken = (await call('POST', '/api/auth/login', { body: { email: helper.email, password: PASSWORD } })).data.token;
  assert.equal((await call('POST', `/api/items/${id}/decision`, { token: helperToken, body: { decision: 'approve', override_reason: 'x' } })).status, 403);
  assert.equal((await call('POST', `/api/items/${id}/delegate`, { token: helperToken, body: { to_user_id: helper.id } })).status, 403, 'an outsider cannot delegate');
  assert.equal((await call('POST', `/api/items/${id}/delegate`, { token: await login('reviewer'), body: { to_user_id: await uid('creator') } })).status, 400, 'cannot delegate to a creator');
  assert.equal((await call('POST', `/api/items/${id}/delegate`, { token: await login('reviewer'), body: { to_user_id: helper.id, reason: 'On a call' } })).status, 200);
  const r = await call('POST', `/api/items/${id}/decision`, { token: helperToken, body: { decision: 'approve', override_reason: 'Legal pre-cleared.' } });
  assert.equal(r.data.status, 'submitted');
  assert.ok((await db.find('decisions', { item_id: id })).some((x) => x.acted_as === 'delegate'));
  assert.ok((await db.find('audit_log', { org_id: 1 })).some((a) => a.action === 'workflow.delegate'));
});

test('away cover: while a legal reviewer is away, their cover person can act', async () => {
  const cover = await db.findOne('users', { email: 'other.reviewer@novabrew.test' });
  const until = new Date(Date.now() + 3 * 86400000).toISOString();
  assert.equal((await call('PUT', '/api/workflows/me/away', { token: await login('reviewer'), body: { delegate_to_id: cover.id, until: new Date(Date.now() - 1000).toISOString() } })).status, 400, 'date must be in the future');
  assert.equal((await call('PUT', '/api/workflows/me/away', { token: await login('reviewer'), body: { delegate_to_id: await uid('creator'), until } })).status, 400, 'cover must be able to review');
  assert.equal((await call('PUT', '/api/workflows/me/away', { token: await login('reviewer'), body: { delegate_to_id: cover.id, until } })).status, 200);
  const id = await newItem();
  await submit(id);
  const t = (await call('POST', '/api/auth/login', { body: { email: cover.email, password: PASSWORD } })).data.token;
  assert.equal((await call('POST', `/api/items/${id}/decision`, { token: t, body: { decision: 'approve', override_reason: 'Covering for Rahul.' } })).data.status, 'submitted');
  assert.ok((await db.find('decisions', { item_id: id })).some((x) => x.acted_as === 'cover'));
  await call('PUT', '/api/workflows/me/away', { token: await login('reviewer'), body: {} });
  assert.equal((await db.get('users', await uid('reviewer'))).away_delegate_id, null);
});

test('SLA: a reminder at 75%, escalation when overdue, then a second escalation to admins', async () => {
  const id = await newItem();
  await submit(id);
  let c = await chainRow(id);
  const t0 = new Date(c.steps[0].activated_at).getTime();
  const hours = c.steps[0].sla_hours; // 24

  await sla.tick(t0 + 10 * 3600000);
  assert.equal((await chainRow(id)).steps[0].reminded_at, null, 'too early for a reminder');
  const legal = await uid('reviewer');
  const mine = () => db.count('notifications', { user_id: legal, link: `/items/${id}` });
  const n0 = await mine();
  await sla.tick(t0 + 19 * 3600000);
  assert.ok((await chainRow(id)).steps[0].reminded_at, 'reminder sent at 75%');
  assert.equal(await mine() - n0, 1);
  await sla.tick(t0 + 19.5 * 3600000);
  assert.equal(await mine() - n0, 1, 'only one reminder');

  const adminId = await uid('admin');
  const nBefore = await db.count('notifications', { user_id: adminId });
  await sla.tick(t0 + (hours + 1) * 3600000);
  c = await chainRow(id);
  assert.equal(c.steps[0].escalation_level, 1);
  assert.ok(await db.count('notifications', { user_id: adminId }) > nBefore, 'admins hear about the escalation');
  const d = await detail(id, 'approver');
  assert.equal(d.workflow.steps[0].escalation_level, 1);

  // Second window passes: level 2, and never an automatic approval.
  const due2 = new Date(c.steps[0].due_at).getTime();
  await sla.tick(due2 + 3600000);
  assert.equal((await chainRow(id)).steps[0].escalation_level, 2);
  await sla.tick(due2 + 99 * 3600000);
  assert.equal((await chainRow(id)).steps[0].escalation_level, 2, 'level 2 is the last');
  assert.equal((await db.get('items', id)).status, 'submitted', 'nothing is approved automatically');
  assert.ok((await db.find('audit_log', { org_id: 1 })).filter((a) => a.action === 'workflow.escalate').length >= 2);
});

test('SLA escalation lets the escalation role act on a step that was limited to a group', async () => {
  const mk = await call('POST', '/api/workflows', { token: await login('admin'), body: { name: 'Finance only', priority: 95, match: { channels: ['internal'] }, steps: [{ name: 'Finance check', assignee_role: 'reviewer', assignee_group: 'finance', sla_hours: 2, escalate_role: 'approver' }] } });
  const id = await newItem('Internal note about our margins this quarter.', 'internal');
  await submit(id);
  assert.equal((await decide(id, 'approver')).status, 403, 'approver is not in the finance group');
  const c = await chainRow(id);
  await sla.tick(new Date(c.steps[0].activated_at).getTime() + 3 * 3600000);
  assert.equal((await decide(id, 'approver')).data.status, 'approved', 'after escalation the approver may act');
  assert.ok((await db.find('decisions', { item_id: id })).some((x) => x.acted_as === 'escalation'));
  await call('DELETE', `/api/workflows/${mk.data.id}`, { token: await login('admin') });
});

test('the SLA overview and dashboard queue info reflect overdue work', async () => {
  const id = await newItem();
  await submit(id);
  const c = await chainRow(id);
  const steps = c.steps; steps[0].due_at = new Date(Date.now() - 3600000).toISOString();
  await setSteps(c, steps);
  const s = (await call('GET', '/api/workflows/sla', { token: await login('admin') })).data;
  assert.ok(s.waiting.some((w) => w.item_id === id));
  const list = (await call('GET', '/api/items', { token: await login('reviewer') })).data;
  const row = list.find((x) => x.id === id);
  assert.ok(row.chain && row.chain.awaiting_me === true && row.chain.step === 'Legal review');
  const creatorView = (await call('GET', '/api/items', { token: await login('creator') })).data.find((x) => x.id === id);
  assert.equal(creatorView.chain.awaiting_me, false);
});

test('nudge reminds the current assignees at most every 4 hours; only author/admin', async () => {
  const id = await newItem();
  await submit(id);
  assert.equal((await call('POST', `/api/items/${id}/nudge`, { token: await login('reviewer') })).status, 403);
  assert.equal((await call('POST', `/api/items/${id}/nudge`, { token: await login('creator') })).status, 200);
  assert.equal((await call('POST', `/api/items/${id}/nudge`, { token: await login('creator') })).status, 429);
});

// ---------------------------------------------------------------- email
async function withMailServer(fn, { status = 200 } = {}) {
  const got = [];
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { got.push({ url: req.url, headers: req.headers, body: JSON.parse(b || '{}') }); res.statusCode = status; res.end(status === 200 ? '{"messageId":"1"}' : '{"message":"boom"}'); }); });
  await new Promise((r) => srv.listen(0, r));
  const saved = { p: config.emailProvider, k: config.brevoKey, r: config.resendKey, f: config.emailFrom, b: config.emailBaseUrl };
  config.emailBaseUrl = `http://127.0.0.1:${srv.address().port}`;
  config.emailFrom = 'noreply@brand.test';
  try { return await fn(got); } finally { Object.assign(config, { emailProvider: saved.p, brevoKey: saved.k, resendKey: saved.r, emailFrom: saved.f, emailBaseUrl: saved.b }); srv.close(); }
}

test('email: nothing is queued when no provider is configured', async () => {
  config.emailProvider = 'none';
  const before = await db.count('email_outbox');
  const id = await newItem(); await submit(id);
  assert.equal(await db.count('email_outbox'), before);
  assert.equal(email.info().configured, false);
});

test('email (Brevo): workflow notifications are delivered over HTTPS with the right payload', async () => {
  await withMailServer(async (got) => {
    config.emailProvider = 'brevo'; config.brevoKey = 'brevo-test-key';
    const id = await newItem(); await submit(id);
    await email.processQueue(50);
    const mine = got.filter((g) => g.url === '/v3/smtp/email');
    assert.ok(mine.length >= 1, 'at least the legal reviewers were emailed');
    const m = mine[0];
    assert.equal(m.headers['api-key'], 'brevo-test-key');
    assert.equal(m.body.sender.email, 'noreply@brand.test');
    assert.ok(m.body.to[0].email.endsWith('@novabrew.test'));
    assert.match(m.body.htmlContent, /Open in BrandSentinel/);
    assert.ok(!m.body.htmlContent.includes('<script'), 'content is escaped');
    const rows = await db.find('email_outbox', { status: 'sent' });
    assert.ok(rows.length >= 1);
  });
});

test('email (Resend): same queue, Resend request format', async () => {
  await withMailServer(async (got) => {
    config.emailProvider = 'resend'; config.resendKey = 're_test';
    const id = await newItem(); await submit(id);
    await email.processQueue(50);
    const m = got.find((g) => g.url === '/emails');
    assert.ok(m);
    assert.equal(m.headers.authorization, 'Bearer re_test');
    assert.match(m.body.from, /noreply@brand\.test/);
  });
});

test('email: failures are retried with back-off and eventually marked failed; they never break the approval', async () => {
  await withMailServer(async () => {
    config.emailProvider = 'brevo'; config.brevoKey = 'k';
    const id = await newItem(); await submit(id); // does not throw even though mail will fail
    await email.processQueue(50);
    const q = (await db.find('email_outbox', { status: 'queued' }))[0];
    assert.ok(q && q.attempts >= 1 && q.last_error && q.next_try_at > db.now(), 'scheduled for a later retry');
    for (let i = 0; i < 5; i++) { await db.update('email_outbox', { status: 'queued' }, { next_try_at: db.now() }); await email.processQueue(50); }
    assert.ok((await db.count('email_outbox', { status: 'failed' })) >= 1);
    assert.equal((await db.get('items', id)).status, 'submitted');
  }, { status: 500 });
});

test('email: users can opt out, and the admin test endpoint reports delivery', async () => {
  await withMailServer(async (got) => {
    config.emailProvider = 'brevo'; config.brevoKey = 'k';
    await call('PUT', '/api/auth/me/prefs', { token: await login('reviewer'), body: { email_notifications: false } });
    const n0 = got.length;
    const id = await newItem(); await submit(id); await email.processQueue(50);
    assert.ok(!got.slice(n0).some((g) => g.body.to[0].email === 'reviewer@novabrew.test'), 'opted-out user gets no email');
    await call('PUT', '/api/auth/me/prefs', { token: await login('reviewer'), body: { email_notifications: true } });
    const t = await call('POST', '/api/admin/email/test', { token: await login('admin') });
    assert.equal(t.data.ok, true);
    const st = (await call('GET', '/api/admin/email', { token: await login('admin') })).data;
    assert.equal(st.provider, 'brevo'); assert.ok(st.last_24h.sent >= 1);
    assert.equal((await call('GET', '/api/admin/email', { token: await login('creator') })).status, 403);
  });
});

// ---------------------------------------------------------------- public verification
async function approvedItem() {
  const id = await newItem(); await submit(id);
  await decide(id, 'reviewer'); await decide(id, 'admin');
  const d = await detail(id);
  assert.equal(d.item.status, 'approved');
  return { id, d, code: d.certificate.verification_code };
}
const pub = async (path, body) => { const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); let data = null; try { data = await r.json(); } catch { /* svg */ } return { status: r.status, data, res: r }; };

test('public verification: no login, shows authenticity and what was checked, but never content or people', async () => {
  const { code, d } = await approvedItem();
  assert.match(code, /^BS-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const r = await pub(`/api/public/verify/${code}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'valid');
  assert.equal(r.data.signature_valid, true);
  assert.equal(r.data.organisation, 'NovaBrew Coffee');
  assert.ok(r.data.checks.rule_modules.includes('claims'));
  assert.equal(r.data.checks.approval.type, 'configured_workflow');
  assert.equal(r.data.checks.approval.steps.length, 2);
  assert.ok(r.data.audit_anchor);
  const raw = JSON.stringify(r.data);
  for (const leak of ['Riya', 'Rahul', 'Asha', 'creator@', HEALTH, 'item_id', 'org_id', d.item.title]) assert.ok(!raw.includes(leak), `must not leak "${leak}"`);
  assert.equal(r.data.title, null, 'titles are hidden unless the organisation opts in');
  // lowercase / unformatted codes work
  assert.equal((await pub(`/api/public/verify/${code.toLowerCase().replace(/-/g, '')}`)).data.status, 'valid');
});

test('public verification: unknown codes, wrong lengths and junk are 404 and do not leak', async () => {
  for (const c of ['BS-AAAA-BBBB-CCCC', 'nonsense', '%7B%22%24ne%22%3A1%7D', 'A'.repeat(40)]) assert.equal((await pub(`/api/public/verify/${c}`)).status, 404);
});

test('public verification: paste text to confirm it is exactly what was approved', async () => {
  const { code } = await approvedItem();
  assert.equal((await pub(`/api/public/verify/${code}/check`, { text: HEALTH })).data.exact_match, true);
  const wording = (await pub(`/api/public/verify/${code}/check`, { text: '  ' + HEALTH.replace(/ /g, '   ') + '\n' })).data;
  assert.equal(wording.match, true); assert.equal(wording.wording_match, true); assert.equal(wording.exact_match, false);
  const bad = (await pub(`/api/public/verify/${code}/check`, { text: HEALTH + ' Buy now!' })).data;
  assert.equal(bad.match, false);
  assert.equal((await pub(`/api/public/verify/${code}/check`, { text: '' })).status, 400);
});

test('public verification: tampering with the certificate is detected', async () => {
  const { code, id } = await approvedItem();
  const c = await db.findOne('certificates', { verification_code: code });
  const snap = JSON.parse(c.snapshot); snap.findings.overridden_by_reviewers = 0;
  await db.update('certificates', c.id, { snapshot: JSON.stringify(snap) });
  assert.equal((await pub(`/api/public/verify/${code}`)).data.status, 'invalid', 'edited summary breaks the signature');
  await db.update('certificates', c.id, { snapshot: c.snapshot });
  assert.equal((await pub(`/api/public/verify/${code}`)).data.status, 'valid');
  await db.update('certificates', c.id, { content_hash: 'f'.repeat(64) });
  assert.equal((await pub(`/api/public/verify/${code}`)).data.status, 'invalid');
  await db.update('certificates', c.id, { content_hash: c.content_hash });
  assert.ok(id);
});

test('revoking a certificate shows REVOKED publicly and blocks the gate verify', async () => {
  const { code, id } = await approvedItem();
  assert.equal((await call('POST', `/api/items/${id}/certificate/revoke`, { token: await login('creator'), body: { reason: 'because' } })).status, 403);
  assert.equal((await call('POST', `/api/items/${id}/certificate/revoke`, { token: await login('admin'), body: { reason: 'no' } })).status, 400);
  assert.equal((await call('POST', `/api/items/${id}/certificate/revoke`, { token: await login('admin'), body: { reason: 'Claim evidence withdrawn by the lab.' } })).status, 200);
  const r = await pub(`/api/public/verify/${code}`);
  assert.equal(r.data.status, 'revoked');
  assert.equal((await pub(`/api/public/verify/${code}/check`, { text: HEALTH })).data.match, false);
  const key = (await db.get('orgs', 1)).api_key;
  const g = await fetch(base + '/api/gate/verify', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify({ text: HEALTH }) }).then((x) => x.json());
  assert.equal(g.valid && g.certificate.item_id === id, false);
});

test('a newer version is flagged on the public page; the QR code is an SVG pointing at the page', async () => {
  const { code, id } = await approvedItem();
  assert.equal((await call('POST', `/api/items/${id}/versions`, { token: await login('admin'), body: { body: HEALTH + ' Updated.', note: 'edit' } })).status, 200);
  assert.equal((await pub(`/api/public/verify/${code}`)).data.newer_version_exists, true);
  const q = await fetch(base + `/api/public/verify/${code}/qr.svg`);
  assert.equal(q.status, 200);
  assert.match(q.headers.get('content-type'), /^image\/svg\+xml/);
  assert.match(await q.text(), /^<svg/);
});

test('old certificates (before Round 3) receive a code on startup and stay valid', async () => {
  const id = await newItem('Plain note for legacy certificate.'); await submit(id); await decide(id, 'reviewer', { override_reason: undefined });
  const c = await db.findOne('certificates', { item_id: id });
  // simulate a v2.1 certificate
  await db.update('certificates', c.id, { verification_code: undefined, snapshot: undefined, sig_v: undefined, signature: certSvc.sign(c.org_id, c.item_id, c.version_n, c.content_hash) });
  await db.update('certificates', c.id, { verification_code: null });
  assert.ok((await certSvc.backfill()) >= 1);
  const fresh = await db.get('certificates', c.id);
  assert.ok(fresh.verification_code);
  const r = await pub(`/api/public/verify/${fresh.verification_code}`);
  assert.equal(r.data.status, 'valid');
  assert.equal(r.data.integrity, 'core-only');
  assert.equal(r.data.checks.reconstructed, true);
});

test('tenant isolation: another organisation cannot see or use this organisation workflows', async () => {
  const reg = await call('POST', '/api/auth/register-org', { body: { orgName: 'Rival Co', name: 'Rita', email: 'rita@rival.test', password: 'Rita@12345' } });
  const t = reg.data.token;
  assert.equal((await call('GET', '/api/workflows', { token: t })).data.workflows.length, 0);
  const wf1 = (await db.find('workflows', { org_id: 1 }))[0];
  assert.equal((await call('PUT', `/api/workflows/${wf1.id}`, { token: t, body: { name: 'hijack', steps: [{ name: 's', assignee_role: 'reviewer' }] } })).status, 404);
  assert.equal((await call('DELETE', `/api/workflows/${wf1.id}`, { token: t })).status, 404);
  // Their own content is unaffected by NovaBrew's health workflow.
  const it = await call('POST', '/api/items', { token: t, body: { title: 'Rival', channel: 'social', kind: 'text', intent: 'Tell people', body: HEALTH } });
  await call('POST', `/api/items/${it.data.id}/submit`, { token: t });
  assert.equal(await db.count('item_workflows', { item_id: it.data.id }), 0);
});

test('the audit log stays intact after all of the above', async () => {
  const v = await audit.verifyChain(1);
  assert.equal(v.ok, true, JSON.stringify(v));
  const actions = new Set((await db.find('audit_log', { org_id: 1 })).map((a) => a.action));
  for (const a of ['workflow.start', 'workflow.advance', 'workflow.escalate', 'workflow.delegate', 'workflow.create', 'certificate.issue', 'certificate.revoke']) assert.ok(actions.has(a), `audit has ${a}`);
});
