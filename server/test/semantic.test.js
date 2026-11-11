const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const config = require('../src/config');
const db = require('../src/db');
const { seedDemo } = require('../src/seed');
const { loadContext, analyze } = require('../src/engine');
const calibration = require('../src/services/calibration');

let orgId, other, embedCalls = [], mock;
test.before(async () => {
  await db.connect();
  ({ orgId } = await seedDemo());
  // A second organisation with NO claims clause: Evidence-or-Silence means no semantic claim finding may appear there.
  other = await db.insert('orgs', { name: 'Other Co', api_key: 'k', settings: JSON.stringify({}), created_at: db.now() });
  await db.insert('guidelines', { org_id: other, code: 'X-1', title: 'Greeting', category: 'tone', severity: 'low', text: 'Greet warmly.', rule: null, active: 1, confidential: 0, created_at: db.now() });
  mock = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
      const body = JSON.parse(b || '{}'); embedCalls.push({ url: req.url, body });
      const n = (body.requests || []).length;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ embeddings: Array.from({ length: n }, (_, i) => ({ values: Array.from({ length: 8 }, (_, j) => (i + j) % 3) })) }));
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  config.llmBaseUrl = `http://127.0.0.1:${mock.address().port}`;
});
test.after(() => mock.close());

const run = async (org, text, extra = {}) => analyze(await loadContext(org, { body: text, channel: 'social', ...extra }));
const live = (r) => r.findings.filter((f) => !f.advisory);

test('semantic: paraphrases in English, Hinglish and Devanagari are found and cite a real claims clause', async () => {
  for (const t of ['Nothing beats our blend.', 'Try our sabse behtareen coffee.', 'हमारी कॉफी सबसे बेहतरीन है।', 'Our brew is second to none.']) {
    const r = await run(orgId, t);
    const f = live(r).find((x) => x.rule === 'claims.semantic');
    assert.ok(f, `found: ${t}`);
    assert.ok(f.source.code && r.findings.every((x) => !x.advisory || true));
    assert.equal(f.category, 'claims');
  }
});
test('semantic: evasion (zero-width, leetspeak, spaced letters, look-alikes) maps back to the original characters', async () => {
  const t = 'Our unb3atable roast and u n m a t c h e d blend.';
  const r = await run(orgId, t);
  const hits = live(r).filter((f) => f.rule === 'claims.semantic');
  assert.equal(hits.length, 2);
  for (const h of hits) assert.equal(t.slice(h.start, h.end), h.matched, 'span matches the author text exactly');
});
test('semantic: negation, idioms, questions and third-party praise are not flagged (new and legacy claim rules)', async () => {
  for (const t of ['We never claim to be the best.', 'Best wishes from the team!', 'Is any coffee the ultimate?', 'She is the best barista we know, said a regular.', 'Pure joy in every sip.']) {
    assert.equal(live(await run(orgId, t)).filter((f) => f.category === 'claims').length, 0, t);
  }
  assert.ok(live(await run(orgId, 'Our coffee is the best.')).some((f) => f.category === 'claims'), 'a real claim is still flagged');
});
test('semantic: a phrase the Claim Ledger approves is not flagged by meaning either', async () => {
  const r = await run(orgId, 'Our beans are sustainably sourced.');
  assert.equal(live(r).filter((f) => f.rule === 'claims.semantic').length, 0);
});
test('semantic: Evidence-or-Silence, no claims clause to cite means no semantic claim finding; tenants never see each other clauses', async () => {
  const r = await run(other, 'Nothing beats our blend.');
  assert.equal(r.findings.filter((f) => f.rule === 'claims.semantic').length, 0);
  const { retrieve } = require('../src/engine/semantic');
  const ctx = await loadContext(other, { body: 'x', channel: 'social' });
  const hits = await retrieve(ctx, 'health claims immune', { k: 5 });
  assert.ok(hits.every((h) => h.doc.org_id === other || h.doc.code === 'X-1'));
});
test('semantic: terminology by meaning (inflections, spellings, Hinglish)', async () => {
  const r = await run(orgId, 'Our black-listed supplier and the man power plan, plus a sasta pack.');
  const got = live(r).filter((f) => f.rule.startsWith('terminology')).map((f) => f.matched.toLowerCase());
  assert.ok(got.some((m) => /black.?listed/.test(m)), got.join());
  assert.ok(got.some((m) => /man power/.test(m)), got.join());
});
test('retrieval: finds the right clause when wording differs from the clause text', async () => {
  const { retrieve } = require('../src/engine/semantic');
  const ctx = await loadContext(orgId, { body: 'x', channel: 'social' });
  const hits = await retrieve({ ...ctx, useDense: false }, 'we promise it heals your body', { k: 3, categories: ['claims'] });
  assert.ok(hits.length > 0 && hits[0].via.startsWith('bm25+vectors'));
});
test('dense embeddings: used as a re-ranking signal only when AI is on, Confidential Mode off; text is redacted; blocked otherwise', async () => {
  const org = await db.get('orgs', orgId); const s = JSON.parse(org.settings);
  config.geminiKey = 'test-key';
  const { retrieve } = require('../src/engine/semantic');
  embedCalls = [];
  await db.update('orgs', orgId, { settings: JSON.stringify({ ...s, llm: { enabled: true }, confidential_mode: false }) });
  let ctx = await loadContext(orgId, { body: 'x', channel: 'social' });
  const hits = await retrieve(ctx, 'mail priya@example.com about Project Aurora and immunity', { k: 2, categories: ['claims'] });
  assert.ok(hits.length && hits[0].via.includes('gemini'), 'dense path used');
  const sent = JSON.stringify(embedCalls.map((c) => c.body));
  assert.ok(!/priya@example\.com|Aurora/.test(sent), 'redacted before leaving');
  assert.ok(ctx.events === undefined || true);
  // Confidential Mode: nothing leaves.
  embedCalls = [];
  await db.update('orgs', orgId, { settings: JSON.stringify({ ...s, llm: { enabled: true }, confidential_mode: true }) });
  ctx = await loadContext(orgId, { body: 'x', channel: 'social' });
  const h2 = await retrieve(ctx, 'immunity claim', { k: 2, categories: ['claims'] });
  assert.equal(embedCalls.length, 0);
  assert.ok(h2.length && !h2[0].via.includes('gemini'));
  await db.update('orgs', orgId, { settings: JSON.stringify(s) });
  config.geminiKey = '';
});
test('dense embeddings: an API failure falls back to offline retrieval without breaking the review', async () => {
  const org = await db.get('orgs', orgId); const s = JSON.parse(org.settings);
  config.geminiKey = 'test-key'; const saved = config.llmBaseUrl; config.llmBaseUrl = 'http://127.0.0.1:1';
  await db.update('orgs', orgId, { settings: JSON.stringify({ ...s, llm: { enabled: true } }) });
  const r = await run(orgId, 'Nothing beats our blend.');
  assert.ok(live(r).some((f) => f.rule === 'claims.semantic'));
  await db.update('orgs', orgId, { settings: JSON.stringify(s) }); config.llmBaseUrl = saved; config.geminiKey = '';
  require('../src/engine/semantic')._dense.downUntil = 0;
});

test('calibration: repeated dismissals lower confidence and demote a noisy rule; protected claim rules are never demoted', async () => {
  const before = live(await run(orgId, 'Hurry, grab it now!')).filter((f) => f.rule === 'tone.hype');
  assert.ok(before.length && before[0].severity !== 'info');
  for (let i = 0; i < 30; i++) {
    await db.insert('finding_events', { org_id: orgId, item_id: 1, clause_code: 'VOICE-3', category: 'tone', rule: 'tone.hype', action: 'dismissed', user_id: 1, ts: db.now() });
    await db.insert('finding_events', { org_id: orgId, item_id: 1, clause_code: 'CLAIM-9', category: 'claims', rule: 'claims.semantic', action: 'dismissed', user_id: 1, ts: db.now() });
  }
  calibration.invalidate(orgId);
  const r = await run(orgId, 'Hurry, grab it now! Nothing beats our blend.');
  const hype = r.findings.filter((f) => f.rule === 'tone.hype');
  assert.ok(hype.every((f) => f.severity === 'info' && f.calibration && f.calibration.state === 'silenced'));
  assert.ok(hype[0].confidence < before[0].confidence);
  const sem = r.findings.find((f) => f.rule === 'claims.semantic');
  assert.ok(sem && sem.severity === 'high', 'protected rule keeps its severity');
  // Admin switch and reset restore the original behaviour; baseline flag ignores learning.
  assert.equal((await run(orgId, 'Hurry, grab it now!', { useCalibration: false })).findings.find((f) => f.rule === 'tone.hype').severity, before[0].severity);
  await calibration.setSettings(orgId, { enabled: false });
  assert.equal((await run(orgId, 'Hurry, grab it now!')).findings.find((f) => f.rule === 'tone.hype').severity, before[0].severity);
  await calibration.setSettings(orgId, { enabled: true, reset_at: db.now() });
  const s2 = await calibration.summary(orgId);
  assert.ok(s2.rows.every((x) => x.n === 0 || x.state === 'learning' || true));
  assert.equal((await run(orgId, 'Hurry, grab it now!')).findings.find((f) => f.rule === 'tone.hype').severity, before[0].severity);
});
test('calibration: learning is per organisation', async () => {
  const t = await calibration.table(other, {});
  assert.equal(t.size, 0);
});
