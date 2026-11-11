// Hosted-LLM path against a mock Gemini/Groq server: redaction, verified quotes, ledger, confidential mode, breaker.
process.env.NODE_ENV = 'test';
process.env.DB_DRIVER = 'memory';
process.env.SEED_DEMO = 'false';
const http = require('http');
const test = require('node:test');
const assert = require('node:assert');
const config = require('../src/config');

let mock, base, received = [], mode = 'ok';
test.before(async () => {
  mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ url: req.url, headers: req.headers, body: JSON.parse(body || '{}') });
      if (mode === 'down') { res.statusCode = 500; return res.end('{}'); }
      const prompt = req.url.includes('generateContent') ? body && JSON.parse(body).contents[0].parts[0].text : JSON.parse(body).messages[0].content;
      const out = /Rewrite this sentence/.test(prompt) ? { text: 'Join us and enjoy our festive blend.' } : /exactly this JSON/.test(prompt) ? { ok: true }
        : { issues: [{ quote: 'totally mind-bending vibes', clause: 'VOICE-3', why: 'Hype wording' }, { quote: 'this phrase is invented', clause: 'VOICE-3', why: 'fabricated' }, { quote: 'calm morning', clause: 'NOPE-9', why: 'unknown clause' }] };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.url.includes('generateContent') ? { candidates: [{ content: { parts: [{ text: '```json\n' + JSON.stringify(out) + '\n```' }] } }] } : { choices: [{ message: { content: JSON.stringify(out) } }] }));
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${mock.address().port}`;
  config.llmBaseUrl = base; config.geminiKey = 'test-key'; config.llmProvider = 'gemini';
});
test.after(() => mock.close());

let cached;
const setup = () => (cached = cached || realSetup());
const realSetup = async () => {
  const db = require('../src/db');
  await db.connect();
  const { seedDemo } = require('../src/seed');
  const { orgId } = await seedDemo();
  const org = await db.get('orgs', orgId);
  const s = JSON.parse(org.settings);
  return { db, orgId, s };
};

test('Gemini: redacted text only, fabricated or unciteable output dropped, ledger marks external use', async () => {
  const { db, orgId, s } = await setup();
  await db.update('orgs', orgId, { settings: JSON.stringify({ ...s, llm: { enabled: true, nuance: true, rewrite: true } }) });
  const { loadContext, analyze } = require('../src/engine');
  const ctx = await loadContext(orgId, { body: 'Mail priya@example.com about Project Aurora. We serve totally mind-bending vibes at dawn.', intent: 'Invite people', channel: 'social' });
  const res = await analyze(ctx);
  const sent = JSON.stringify(received[0].body);
  assert.ok(!/priya@example\.com|Aurora/.test(sent), 'personal data and confidential terms are redacted');
  assert.equal(received[0].headers['x-goog-api-key'], 'test-key');
  const llmF = res.findings.filter((f) => f.rule === 'llm.nuance');
  assert.equal(llmF.length, 1, 'only the verifiable quote survives');
  assert.equal(llmF[0].source.code, 'VOICE-3');
  const ev = res.events.find((e) => e.service === 'gemini');
  assert.equal(ev.sent_external, 1);
  assert.ok(ev.redactions >= 1, 'confidential term was masked');
});

test('Confidential Mode blocks the hosted model completely', async () => {
  const { db, orgId, s } = await setup();
  await db.update('orgs', orgId, { settings: JSON.stringify({ ...s, confidential_mode: true, llm: { enabled: true } }) });
  const before = received.length;
  const { loadContext, analyze } = require('../src/engine');
  const res = await analyze(await loadContext(orgId, { body: 'We serve totally mind-bending vibes at dawn.', intent: 'Invite people', channel: 'social' }));
  assert.equal(received.length, before, 'no request left the server');
  assert.ok(res.events.some((e) => e.purpose === 'blocked'));
});

test('Groq adapter, connection test and the circuit breaker', async () => {
  const llm = require('../src/engine/llm');
  config.llmProvider = 'groq'; config.groqKey = 'g-key';
  const ok = await llm.testConnection();
  assert.equal(ok.ok, true);
  assert.equal(ok.provider, 'groq');
  assert.match(received[received.length - 1].url, /openai\/v1\/chat\/completions/);
  assert.equal(received[received.length - 1].headers.authorization, 'Bearer g-key');
  mode = 'down';
  const bad = await llm.testConnection();
  assert.equal(bad.ok, false);
  assert.match(bad.error, /HTTP 500/);
  mode = 'ok';
  config.llmProvider = 'none';
  assert.equal(llm.providerInfo().configured, false);
});
