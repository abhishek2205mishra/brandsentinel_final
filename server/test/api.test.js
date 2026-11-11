// End-to-end test of the whole workflow against an in-memory database.
process.env.NODE_ENV = 'test';
process.env.DB_DRIVER = process.env.DB_DRIVER || 'memory';
process.env.SEED_DEMO = 'false';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { PNG } = require('pngjs');

const { app } = require('../src/index');
const { seedDemo, PASSWORD } = require('../src/seed');
const db = require('../src/db');
const audit = require('../src/services/audit');

let base, server;
const tokens = {};

async function call(method, url, { token, body, form } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(base + url, { method, headers, body: payload });
  let data = null;
  try { data = await res.json(); } catch { /* not json */ }
  return { status: res.status, data };
}
const login = async (who) => {
  if (!tokens[who]) tokens[who] = (await call('POST', '/api/auth/login', { body: { email: `${who}@novabrew.test`, password: PASSWORD } })).data.token;
  return tokens[who];
};

test.before(async () => {
  const config = require('../src/config');
  if (config.dbDriver === 'mongo' && !/_test$/.test(config.mongoDb)) throw new Error('Refusing to run tests against a database whose name does not end in _test (set MONGODB_DB=brandsentinel_test).');
  await db.connect();
  await db.clearAll();
  await seedDemo();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); await db.close(); });

test('login works and bad password is rejected', async () => {
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'creator@novabrew.test', password: 'nope' } })).status, 401);
  assert.ok(await login('creator'));
});

test('creator creates content, gets cited findings and intent-scored suggestions', async () => {
  const t = await login('creator');
  const r = await call('POST', '/api/items', { token: t, body: { title: 'Test caption', channel: 'social', kind: 'text', intent: 'Announce the festive offer', body: "Our roast is India's #1 coffee, now 30% off this festive offer!!! Visit Nova Brew." } });
  assert.equal(r.status, 201);
  assert.equal(r.data.risk, 'high');
  const d = (await call('GET', `/api/items/${r.data.id}`, { token: t })).data;
  const rules = d.findings.map((f) => f.rule);
  for (const want of ['claims.superlative', 'facts.conflict', 'tone.exclaim', 'terminology.banned']) assert.ok(rules.includes(want), `missing ${want}`);
  for (const f of d.findings) assert.ok(f.source_code, 'every finding must cite a source');
  const fact = d.findings.find((f) => f.rule === 'facts.conflict');
  assert.equal(fact.suggestions[0].text, '20%');
  assert.ok(fact.suggestions[0].intent_preserved > 0.8);
});

test('missing intent is rejected', async () => {
  const t = await login('creator');
  const r = await call('POST', '/api/items', { token: t, body: { title: 'x', intent: '', body: 'hello' } });
  assert.equal(r.status, 400);
});

test('accepting a suggestion creates a new version; dismissing needs a reason and survives re-check', async () => {
  const t = await login('creator');
  const id = (await call('POST', '/api/items', { token: t, body: { title: 'Versioning', channel: 'social', kind: 'text', intent: 'Invite friends to the Friday contest', body: 'Join the contest!! Share your story!' } })).data.id;
  let d = (await call('GET', `/api/items/${id}`, { token: t })).data;
  const ex = d.findings.find((f) => f.rule === 'tone.exclaim');
  assert.equal((await call('POST', `/api/items/${id}/findings/${ex.id}/dismiss`, { token: t, body: { reason: '' } })).status, 400);
  assert.equal((await call('POST', `/api/items/${id}/findings/${ex.id}/dismiss`, { token: t, body: { reason: 'Contest posts need energy' } })).status, 200);
  // Edit something else: the dismissed issue should stay dismissed on the new version.
  const edit = await call('POST', `/api/items/${id}/versions`, { token: t, body: { body: 'Join the contest!! Share your brew story!', note: 'tweak' } });
  assert.equal(edit.data.current_version, 2);
  d = (await call('GET', `/api/items/${id}`, { token: t })).data;
  assert.ok(d.findings.filter((f) => f.rule === 'tone.exclaim').every((f) => f.status === 'dismissed'));
  assert.equal(d.versions.length, 2);
});

test('role-based approval: high risk needs two people, override reason, and issues a certificate', async () => {
  const creator = await login('creator'), reviewer = await login('reviewer'), approver = await login('approver');
  const id = (await call('POST', '/api/items', { token: creator, body: { title: 'High risk', channel: 'paid-ad', kind: 'text', intent: 'Promote our coffee', body: 'Our coffee is clinically proven to boost immunity.' } })).data.id;
  assert.equal((await call('POST', `/api/items/${id}/decision`, { token: reviewer, body: { decision: 'approve' } })).status, 400, 'not submitted yet');
  assert.equal((await call('POST', `/api/items/${id}/submit`, { token: creator })).status, 200);
  assert.equal((await call('POST', `/api/items/${id}/decision`, { token: creator, body: { decision: 'approve' } })).status, 403, 'creators cannot approve');
  const blocked = await call('POST', `/api/items/${id}/decision`, { token: reviewer, body: { decision: 'approve' } });
  assert.equal(blocked.status, 409, 'open high findings need an override reason');
  const first = await call('POST', `/api/items/${id}/decision`, { token: reviewer, body: { decision: 'approve', override_reason: 'Legal confirmed evidence offline.' } });
  assert.equal(first.data.status, 'submitted');
  assert.ok(first.data.waiting_for);
  const second = await call('POST', `/api/items/${id}/decision`, { token: approver, body: { decision: 'approve', override_reason: 'Agree with reviewer.' } });
  assert.equal(second.data.status, 'approved');
  const d = (await call('GET', `/api/items/${id}`, { token: creator })).data;
  assert.ok(d.certificate);
  // Gate: exact content verifies, edited content does not.
  const key = (await db.get('orgs', 1)).api_key;
  const ok = await fetch(base + '/api/gate/verify', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify({ text: d.version.body, item_id: id }) }).then((r) => r.json());
  assert.equal(ok.valid, true);
  const bad = await fetch(base + '/api/gate/verify', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify({ text: d.version.body + ' Buy now.', item_id: id }) }).then((r) => r.json());
  assert.equal(bad.valid, false);
  assert.match(bad.reason, /changed after approval/);
});

test('request changes needs a reason; authors cannot review their own work', async () => {
  const reviewer = await login('reviewer');
  const id = (await call('POST', '/api/items', { token: reviewer, body: { title: 'Reviewer own', channel: 'social', kind: 'text', intent: 'Say hello to customers', body: 'Hello from the team.' } })).data.id;
  await call('POST', `/api/items/${id}/submit`, { token: reviewer });
  assert.equal((await call('POST', `/api/items/${id}/decision`, { token: reviewer, body: { decision: 'approve' } })).status, 403);
});

test('agency users only see their own content and a redacted knowledge base', async () => {
  const agency = await login('agency');
  const list = (await call('GET', '/api/items', { token: agency })).data;
  assert.ok(list.length > 0 && list.every((i) => i.author_name === 'Studio Agency'));
  const kb = (await call('GET', '/api/kb', { token: agency })).data;
  assert.ok(kb.redacted_view);
  assert.ok(!kb.facts.some((f) => f.confidential), 'confidential facts hidden');
  assert.ok(kb.facts.every((f) => f.evidence === null));
  assert.equal(kb.claims.length, 0);
  assert.equal((await call('GET', '/api/items/1', { token: agency })).status, 403, "cannot open another author's item");
  assert.equal((await call('POST', '/api/kb/terms', { token: agency, body: { banned: 'x' } })).status, 403);
});

test('auditor is read-only', async () => {
  const a = await login('auditor');
  assert.equal((await call('GET', '/api/items', { token: a })).status, 200);
  assert.equal((await call('POST', '/api/items', { token: a, body: { title: 'x', intent: 'hello there', body: 'hi' } })).status, 403);
  assert.equal((await call('GET', '/api/admin/audit', { token: a })).status, 200);
});

test('tenant isolation: a second organisation cannot see the first', async () => {
  const reg = await call('POST', '/api/auth/register-org', { body: { orgName: 'Other Co', name: 'Olive Owner', email: 'olive@other.test', password: 'Password123' } });
  assert.equal(reg.status, 201);
  const t = reg.data.token;
  assert.equal((await call('GET', '/api/items/1', { token: t })).status, 404);
  assert.equal((await call('GET', '/api/items', { token: t })).data.length, 0);
  const kb = (await call('GET', '/api/kb', { token: t })).data;
  assert.ok(kb.guidelines.length > 5, 'starter pack is created');
  assert.equal(kb.facts.length, 0);
  assert.ok(kb.terms.every((t) => t.guideline_code === 'INC-1'), 'only the inclusive-language starter terms');
});

test('knowledge base: admin edits a rule, engine follows (evidence-or-silence)', async () => {
  const admin = await login('admin'), creator = await login('creator');
  const kb = (await call('GET', '/api/kb', { token: admin })).data;
  const g = kb.guidelines.find((x) => x.code === 'VOICE-1');
  await call('PUT', `/api/kb/guidelines/${g.id}`, { token: admin, body: { active: false } });
  const id = (await call('POST', '/api/items', { token: creator, body: { title: 'No clause', channel: 'social', kind: 'text', intent: 'Cheer on the team', body: 'Go team!!! Go!!!' } })).data.id;
  const d = (await call('GET', `/api/items/${id}`, { token: creator })).data;
  assert.ok(!d.findings.some((f) => f.rule === 'tone.exclaim'), 'no active clause, so no finding');
  await call('PUT', `/api/kb/guidelines/${g.id}`, { token: admin, body: { active: true } });
});

test('image upload: palette, logo ratio and missing alt text are detected', async () => {
  const t = await login('creator');
  const png = new PNG({ width: 100, height: 80 });
  for (let i = 0; i < png.data.length; i += 4) { png.data[i] = 255; png.data[i + 1] = 0; png.data[i + 2] = 170; png.data[i + 3] = 255; }
  const buf = PNG.sync.write(png);
  const form = new FormData();
  form.append('title', 'Poster'); form.append('channel', 'social'); form.append('intent', 'Promote the festive poster'); form.append('declaredLogo', 'true');
  form.append('file', new Blob([buf], { type: 'image/png' }), 'poster.png');
  const r = await fetch(base + '/api/items', { method: 'POST', headers: { authorization: `Bearer ${t}` }, body: form });
  assert.equal(r.status, 201);
  const id = (await r.json()).id;
  const d = (await call('GET', `/api/items/${id}`, { token: t })).data;
  const rules = d.findings.map((f) => f.rule);
  for (const want of ['visual.palette_image', 'visual.logo_distorted', 'visual.logo_small', 'a11y.alt_missing']) assert.ok(rules.includes(want), `missing ${want}: ${rules}`);
  const file = await fetch(`${base}/api/items/${id}/file?token=${t}`);
  assert.equal(file.status, 200);
});

test('insights, ledger and audit chain', async () => {
  const admin = await login('admin');
  const ins = (await call('GET', '/api/insights', { token: admin })).data;
  assert.ok(ins.totals.items >= 14 && ins.radar.length > 0 && ins.authors);
  const creator = await login('creator');
  assert.equal((await call('GET', '/api/insights', { token: creator })).status, 403);

  // This assertion must be deterministic across developer machines: some environments
  // seed demo data with AI enabled when a provider key is configured. We therefore
  // disable AI explicitly and assert the delta for a fresh review is zero external calls.
  const org = await db.get('orgs', 1);
  const st = db.json(org.settings, {});
  await db.update('orgs', 1, { settings: JSON.stringify({ ...st, llm: { ...(st.llm || {}), enabled: false } }) });

  const before = (await call('GET', '/api/admin/ledger', { token: admin })).data.totals.external;
  const id = (await call('POST', '/api/items', { token: creator, body: { title: 'Rules only', channel: 'social', kind: 'text', intent: 'Invite people to try the blend', body: 'Try our festive blend this weekend.' } })).data.id;
  assert.ok(id);
  const after = (await call('GET', '/api/admin/ledger', { token: admin })).data.totals.external;
  assert.equal(after - before, 0, 'rules-only mode never sends data out');

  const a = (await call('GET', '/api/admin/audit', { token: admin })).data;
  assert.equal(a.chain.ok, true);
  const victim = (await db.find('audit_log', { org_id: 1, detail: { $ne: null } }, { sort: { id: 1 }, limit: 1 }))[0];
  await db.update('audit_log', victim.id, { detail: 'tampered' });
  assert.equal((await audit.verifyChain(1)).ok, false, 'tampering is detected');
});

test('public gate API reviews content with an API key', async () => {
  const key = (await db.get('orgs', 1)).api_key;
  const no = await fetch(base + '/api/gate/review', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(no.status, 401);
  const r = await fetch(base + '/api/gate/review', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify({ title: 'Agency draft', text: 'The best coffee, guaranteed!' }) }).then((x) => x.json());
  assert.ok(r.findings.some((f) => f.category === 'claims'));
});

test('guideline import previews clauses from a text brand book', async () => {
  const admin = await login('admin');
  const form = new FormData();
  form.append('file', new Blob(['# Voice\nBe warm and calm. Avoid slang in every message.\n\n# Colours\nUse the approved palette and never recolour the logo anywhere.'], { type: 'text/markdown' }), 'brandbook.md');
  const r = await fetch(base + '/api/kb/import/preview', { method: 'POST', headers: { authorization: `Bearer ${admin}` }, body: form }).then((x) => x.json());
  assert.equal(r.clauses.length, 2);
  assert.equal(r.clauses[0].category, 'tone');
  assert.equal(r.clauses[1].category, 'visual');
});

test('NoSQL operator injection is neutralised', async () => {
  const bad = await call('POST', '/api/auth/login', { body: { email: { $ne: '' }, password: { $ne: '' } } });
  assert.equal(bad.status, 401);
  const t = await login('reviewer');
  const r = await call('GET', '/api/items?status[$ne]=zzz&q[$regex]=.*', { token: t });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.data));
  const gate = await fetch(base + '/api/gate/verify', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': '{"$ne":""}' }, body: '{"text":"x"}' });
  assert.equal(gate.status, 401);
});

test('audit chain stays valid under concurrent writers', async () => {
  const org = 777; // fresh organisation: an earlier test deliberately tampers with org 1's log
  await Promise.all(Array.from({ length: 12 }, (_, i) => audit.log(org, null, 'test.concurrent', 'x', i)));
  const v = await audit.verifyChain(org);
  assert.equal(v.ok, true);
  assert.equal(v.checked, 12);
});

test('fuzzy terminology catches misspellings of the brand name', async () => {
  const t = await login('creator');
  const id = (await call('POST', '/api/items', { token: t, body: { title: 'Typo', channel: 'social', kind: 'text', intent: 'Welcome new followers', body: 'Welcome to Novabrw, our small-batch roastery.' } })).data.id;
  const d = (await call('GET', `/api/items/${id}`, { token: t })).data;
  const f = d.findings.find((x) => x.rule === 'terminology.fuzzy');
  assert.ok(f, 'fuzzy finding present');
  assert.equal(f.suggestions[0].text, 'NovaBrew');
  assert.ok(f.source_code);
});

test('review report is generated and escapes content', async () => {
  const t = await login('creator');
  const id = (await call('POST', '/api/items', { token: t, body: { title: 'Report <b>x</b>', channel: 'social', kind: 'text', intent: 'Say hello to customers', body: 'Hello <script>alert(1)</script> world' } })).data.id;
  const res = await fetch(`${base}/api/items/${id}/report?token=${t}`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Brand review report/);
  assert.ok(!html.includes('<script>alert'), 'content is escaped');
  assert.equal((await fetch(`${base}/api/items/${id}/report`)).status, 401);
});

test('change password requires the current password', async () => {
  const reg = await call('POST', '/api/auth/register-org', { body: { orgName: 'Pw Co', name: 'Pat', email: 'pat@pw.test', password: 'Password123' } });
  const t = reg.data.token;
  assert.equal((await call('POST', '/api/auth/change-password', { token: t, body: { current: 'wrong', next: 'NewPassword1' } })).status, 400);
  assert.equal((await call('POST', '/api/auth/change-password', { token: t, body: { current: 'Password123', next: 'short' } })).status, 400);
  assert.equal((await call('POST', '/api/auth/change-password', { token: t, body: { current: 'Password123', next: 'NewPassword1' } })).status, 200);
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'pat@pw.test', password: 'NewPassword1' } })).status, 200);
});

test('health, system status and malformed JSON handling', async () => {
  const h = await fetch(base + '/api/health').then((r) => r.json());
  assert.equal(h.ok, true);
  const admin = await login('admin');
  const sys = (await call('GET', '/api/admin/system', { token: admin })).data;
  assert.equal(sys.database.ok, true);
  assert.equal((await call('GET', '/api/admin/system', { token: await login('creator') })).status, 403);
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad json' });
  assert.equal(res.status, 400);
});
