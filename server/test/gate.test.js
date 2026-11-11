// Round 3 / improvement 2: per-user API keys, rate limits and the inline check API used by the browser extension.
process.env.NODE_ENV = 'test';
process.env.DB_DRIVER = process.env.DB_DRIVER || 'memory';
process.env.SEED_DEMO = 'false';
const test = require('node:test');
const assert = require('node:assert');
const { app } = require('../src/index');
const { seedDemo, PASSWORD } = require('../src/seed');
const db = require('../src/db');
const config = require('../src/config');
const keys = require('../src/services/apikeys');
const audit = require('../src/services/audit');

let base, server;
const jwt = {};
async function call(method, url, { token, key, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (key) headers['x-api-key'] = key;
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch { /* none */ }
  return { status: res.status, data, headers: res.headers };
}
const login = async (who) => (jwt[who] ||= (await call('POST', '/api/auth/login', { body: { email: `${who}@novabrew.test`, password: PASSWORD } })).data.token);

test.before(async () => {
  await db.connect(); await db.clearAll(); await seedDemo();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); await db.close(); });
test.beforeEach(() => keys.resetLimits());

test('a user creates a personal key; it is shown once and stored only as a hash', async () => {
  const t = await login('creator');
  const r = await call('POST', '/api/keys', { token: t, body: { name: 'Chrome on laptop' } });
  assert.equal(r.status, 201);
  assert.match(r.data.key, /^bsk_[\w-]{32}$/);
  const row = await db.get('api_keys', r.data.id);
  assert.notEqual(row.key_hash, r.data.key);
  assert.ok(!JSON.stringify(row).includes(r.data.key), 'the plain key must never be stored');
  const list = (await call('GET', '/api/keys', { token: t })).data.keys;
  assert.equal(list.length, 1);
  assert.ok(!('key' in list[0]) && !('key_hash' in list[0]));
  r.data.key && (global.__key = r.data.key);
});

test('auditors cannot create keys, and key count is capped', async () => {
  assert.equal((await call('POST', '/api/keys', { token: await login('auditor'), body: {} })).status, 403);
  const t = await login('kabir');
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/api/keys', { token: t, body: { name: `k${i}` } })).status, 201);
  assert.equal((await call('POST', '/api/keys', { token: t, body: {} })).status, 400);
});

test('/me identifies the key owner', async () => {
  const r = await call('GET', '/api/gate/me', { key: global.__key });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.role, 'creator');
  assert.equal(r.data.organisation, 'NovaBrew Coffee');
  assert.equal(r.data.limits.per_minute, config.gateRatePerMin);
});

test('/check returns cited findings with offsets and suggestions, stores no item, and writes an audit entry', async () => {
  const before = await db.count('items');
  const text = "Our new roast is India's #1 coffee, now 30% off. Visit Novabrw today!!!";
  const r = await call('POST', '/api/gate/check', { key: global.__key, body: { text, channel: 'social', source: { host: 'mail.example.test', editor: 'compose' } } });
  assert.equal(r.status, 200);
  assert.equal(r.data.risk, 'high');
  assert.ok(r.data.findings.length >= 3);
  for (const f of r.data.findings) {
    assert.ok(f.source && f.source.code, 'evidence-or-silence: every finding cites a source');
    assert.equal(text.slice(f.start, f.end), f.matched);
  }
  assert.ok(r.data.findings.some((f) => f.rule === 'claims.superlative'));
  assert.ok(r.data.findings.some((f) => f.rule === 'terminology.fuzzy' && f.suggestions.length));
  assert.equal(await db.count('items'), before, 'inline checks must not create content items');
  const log = (await db.find('audit_log', { org_id: 1 })).filter((a) => a.action === 'ext.check');
  assert.equal(log.length, 1);
  const d = JSON.parse(log[0].detail);
  assert.equal(d.host, 'mail.example.test');
  assert.ok(!log[0].detail.includes('India'), 'the audit log keeps a hash, never the text');
  assert.equal((await audit.verifyChain(1)).ok, true);
});

test('automatic checks are logged at most once a minute per key', async () => {
  const n0 = (await db.find('audit_log', { org_id: 1 })).filter((a) => a.action === 'ext.check').length;
  for (let i = 0; i < 4; i++) await call('POST', '/api/gate/check', { key: global.__key, body: { text: `Auto check number ${i} of a calm sentence.`, auto: true } });
  const n1 = (await db.find('audit_log', { org_id: 1 })).filter((a) => a.action === 'ext.check').length;
  assert.equal(n1 - n0, 1);
});

test('clean text returns no findings; the AI pass is not used for inline checks', async () => {
  const r = await call('POST', '/api/gate/check', { key: global.__key, body: { text: 'Slow mornings call for a gentle pour-over.' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.findings.length, 0);
  assert.equal(r.data.ai_used, false);
});

test('per-key rate limit returns 429 with Retry-After, and other keys are unaffected', async () => {
  const other = (await call('POST', '/api/keys', { token: await login('reviewer'), body: {} })).data.key;
  const old = config.gateRatePerMin; config.gateRatePerMin = 3;
  try {
    for (let i = 0; i < 3; i++) assert.equal((await call('GET', '/api/gate/me', { key: global.__key })).status, 200);
    const blocked = await call('GET', '/api/gate/me', { key: global.__key });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
    assert.equal((await call('GET', '/api/gate/me', { key: other })).status, 200);
  } finally { config.gateRatePerMin = old; }
});

test('oversized text is rejected; empty text is rejected', async () => {
  assert.equal((await call('POST', '/api/gate/check', { key: global.__key, body: { text: 'x'.repeat(config.gateMaxChars + 1) } })).status, 413);
  assert.equal((await call('POST', '/api/gate/check', { key: global.__key, body: { text: '   ' } })).status, 400);
});

test('/save keeps the content as an item authored by the key owner', async () => {
  const r = await call('POST', '/api/gate/save', { key: global.__key, body: { text: 'Join the reel contest!! Tell us your best brew story!!', title: 'From the browser', source: { host: 'cms.example.test', editor: 'tinymce' } } });
  assert.equal(r.status, 201);
  const it = await db.get('items', r.data.item_id);
  assert.equal(it.source, 'extension');
  assert.equal((await db.get('users', it.author_id)).email, 'creator@novabrew.test');
  assert.ok((await db.find('audit_log', { org_id: 1 })).some((a) => a.action === 'ext.save'));
});

test('revoked keys stop working immediately; users cannot revoke other users keys; admins can', async () => {
  const k = (await call('POST', '/api/keys', { token: await login('approver'), body: { name: 'temp' } })).data;
  assert.equal((await call('GET', '/api/gate/me', { key: k.key })).status, 200);
  assert.equal((await call('DELETE', `/api/keys/${k.id}`, { token: await login('creator') })).status, 404);
  assert.equal((await call('DELETE', `/api/keys/${k.id}`, { token: await login('admin') })).status, 200);
  assert.equal((await call('GET', '/api/gate/me', { key: k.key })).status, 401);
});

test('a key stops working when its user loses access (role changed to auditor)', async () => {
  const k = (await call('POST', '/api/keys', { token: await login('agency'), body: {} })).data;
  assert.equal((await call('GET', '/api/gate/me', { key: k.key })).status, 200);
  await db.update('users', (await db.findOne('users', { email: 'agency@novabrew.test' })).id, { role: 'auditor' });
  assert.equal((await call('GET', '/api/gate/me', { key: k.key })).status, 401);
});

test('tenant isolation: a key only sees its own organisation knowledge base', async () => {
  const reg = await call('POST', '/api/auth/register-org', { body: { orgName: 'Other Co', name: 'Zed', email: 'zed@other.test', password: 'Zed@12345' } });
  const k = (await call('POST', '/api/keys', { token: reg.data.token, body: {} })).data.key;
  const text = 'Visit Novabrw today. Our blend is the best.';
  const mine = (await call('POST', '/api/gate/check', { key: global.__key, body: { text } })).data;
  const theirs = (await call('POST', '/api/gate/check', { key: k, body: { text } })).data;
  assert.ok(mine.findings.some((f) => f.rule === 'terminology.fuzzy'), 'NovaBrew key knows its brand name');
  assert.ok(!theirs.findings.some((f) => f.rule === 'terminology.fuzzy'), 'another organisation must not get NovaBrew brand findings');
});

test('the legacy organisation key and injection attempts behave as before', async () => {
  const orgKey = (await db.get('orgs', 1)).api_key;
  assert.equal((await call('GET', '/api/gate/me', { key: orgKey })).status, 200);
  assert.equal((await call('GET', '/api/gate/me', { key: '{"$ne":""}' })).status, 401);
  assert.equal((await call('GET', '/api/gate/me', { key: 'bsk_' + 'a'.repeat(32) })).status, 401);
  assert.equal((await call('GET', '/api/gate/me', {})).status, 401);
});

test('CORS: the gate API answers preflight for any origin; the rest of the API does not', async () => {
  const pre = await fetch(base + '/api/gate/check', { method: 'OPTIONS', headers: { origin: 'https://docs.example.test', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-api-key,content-type' } });
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  const other = await fetch(base + '/api/items', { headers: { origin: 'https://evil.test' } });
  assert.equal(other.headers.get('access-control-allow-origin'), null);
});

test('the extension download is a zip when the extension folder exists', async () => {
  const fs = require('fs'); const path = require('path');
  const dir = path.join(__dirname, '..', '..', 'extension');
  const existed = fs.existsSync(dir);
  if (!existed) { fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'manifest.json'), '{}'); }
  try {
    const res = await fetch(base + '/api/keys/extension.zip', { headers: { authorization: `Bearer ${await login('creator')}` } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/zip');
    const JSZip = require('jszip');
    const z = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    assert.ok(z.file('brandsentinel-extension/manifest.json'));
  } finally { if (!existed) fs.rmSync(dir, { recursive: true }); }
});
