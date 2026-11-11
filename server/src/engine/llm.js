// OPTIONAL hosted LLM (free tiers of Google Gemini or Groq). Everything works without it.
// Safety design:
//  * only REDACTED text is ever sent (emails, phones, IDs, keys, your confidential terms are masked);
//  * the model must quote text verbatim and cite a clause we retrieved, otherwise its output is discarded;
//  * Confidential Mode blocks every call, because a hosted model is an external service;
//  * every call is written to the AI Disclosure Ledger by the caller;
//  * a circuit breaker stops calling a failing provider for a minute so reviews never slow down.
const config = require('../config');
const { redact } = require('../util/redact');
const { buildIndex, search } = require('../util/bm25');
const { sentences } = require('../util/text');
const { finding, citeClause } = require('./helpers');
const { intentScore } = require('./intent');

function providerInfo() {
  const p = config.llmProvider;
  if (p === 'gemini') return { provider: 'gemini', model: config.geminiModel, configured: !!config.geminiKey, host: new URL(config.llmBaseUrl || 'https://generativelanguage.googleapis.com').host };
  if (p === 'groq') return { provider: 'groq', model: config.groqModel, configured: !!config.groqKey, host: new URL(config.llmBaseUrl || 'https://api.groq.com').host };
  return { provider: 'none', model: null, configured: false, host: null };
}

const breaker = { fails: 0, until: 0 };
const open = () => Date.now() < breaker.until;
const failed = () => { if (++breaker.fails >= 3) { breaker.until = Date.now() + 60000; breaker.fails = 0; } };
const succeeded = () => { breaker.fails = 0; };
const resetBreaker = () => { breaker.fails = 0; breaker.until = 0; };

// Models sometimes wrap JSON in prose or code fences.
function parseJson(text) {
  const t = String(text || '').replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(t); } catch { /* try to extract */ }
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i >= 0 && j > i) return JSON.parse(t.slice(i, j + 1));
  throw new Error('Model did not return JSON');
}

async function call(prompt, timeout) {
  const info = providerInfo();
  let res;
  if (info.provider === 'gemini') {
    const base = config.llmBaseUrl || 'https://generativelanguage.googleapis.com';
    res = await fetch(`${base}/v1beta/models/${encodeURIComponent(config.geminiModel)}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.geminiKey },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1, responseMimeType: 'application/json' } }),
      signal: AbortSignal.timeout(timeout),
    });
  } else {
    const base = config.llmBaseUrl || 'https://api.groq.com';
    res = await fetch(`${base}/openai/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.groqKey}` },
      body: JSON.stringify({ model: config.groqModel, temperature: 0.1, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(timeout),
    });
  }
  return res;
}

async function generate(prompt, timeout = 25000) {
  const info = providerInfo();
  if (!info.configured) throw new Error('No AI provider is configured on the server');
  if (open()) throw new Error('AI provider temporarily paused after repeated errors');
  let res;
  try {
    res = await call(prompt, timeout);
    if ([429, 500, 502, 503, 504].includes(res.status)) { await new Promise((r) => setTimeout(r, 1200)); res = await call(prompt, timeout); }
  } catch (e) { failed(); throw new Error(`${info.provider} unreachable: ${e.message}`); }
  if (!res.ok) { failed(); throw new Error(`${info.provider} HTTP ${res.status}`); }
  const data = await res.json();
  const text = info.provider === 'gemini'
    ? (((data.candidates || [])[0] || {}).content || {}).parts?.map((p) => p.text).join('') || ''
    : ((((data.choices || [])[0] || {}).message) || {}).content || '';
  try { const out = parseJson(text); succeeded(); return out; } catch (e) { failed(); throw e; }
}

async function testConnection() {
  const info = providerInfo();
  if (!info.configured) return { ok: false, ...info, error: 'No AI provider key is set on the server (GEMINI_API_KEY or GROQ_API_KEY).' };
  resetBreaker();
  const t0 = Date.now();
  try { const out = await generate('Return exactly this JSON and nothing else: {"ok":true}', 15000); return { ok: out.ok === true, ...info, latency_ms: Date.now() - t0 }; }
  catch (e) { return { ok: false, ...info, error: e.message }; }
}

function gate(ctx) {
  const llm = (ctx.settings && ctx.settings.llm) || {};
  const info = providerInfo();
  if (!llm.enabled || !info.configured) return { ok: false };
  if (ctx.settings.confidential_mode) {
    return { ok: false, event: { service: info.provider, model: info.model, purpose: 'blocked', redactions: 0, sent_external: 0, note: 'Blocked by Confidential Mode: the AI provider is an external service.' } };
  }
  return { ok: true, external: true, llm, info };
}

async function nuanceReview(ctx, existing) {
  const g = gate(ctx);
  if (!g.ok) return { findings: [], events: g.event ? [g.event] : [] };
  if (g.llm.nuance === false) return { findings: [], events: [] };

  const toneClauses = ctx.guidelines.filter((x) => ['tone', 'messaging'].includes(x.category));
  const retrieved = (await require('./semantic').retrieve({ ...ctx, useDense: false }, ctx.view, { k: 6, categories: ['tone', 'messaging'] })).map((r) => r.doc);
  // Best lexical matches first, then the remaining tone/messaging clauses, so the model can cite any relevant rule.
  const pool = [...retrieved, ...toneClauses.filter((c) => !retrieved.some((r) => r.code === c.code))].slice(0, 12);
  if (!pool.length) return { findings: [], events: [] };

  const red = redact(ctx.view, ctx.settings.confidential_terms || []);
  const prompt = `You are a careful brand reviewer. Use ONLY these brand clauses:\n${pool.map((c) => `[${c.code}] ${c.text}`).join('\n')}\n\nReview the text below. Report only phrases that clearly violate a listed clause. Quote the phrase exactly as written and cite the clause code. If nothing violates, return {"issues":[]}.\nReturn JSON: {"issues":[{"quote":"...","clause":"CODE","why":"short reason"}]}\n\nText:\n"""${red.text.slice(0, 4000)}"""`;

  const event = { service: g.info.provider, model: g.info.model, purpose: 'tone-nuance', redactions: red.count, sent_external: g.external ? 1 : 0, note: `${red.text.length} characters sent (redacted)` };
  const findings = [];
  try {
    const out = await generate(prompt);
    for (const issue of (out.issues || []).slice(0, 5)) {
      const clause = pool.find((c) => c.code === issue.clause);
      const quote = String(issue.quote || '');
      const idx = quote ? ctx.view.indexOf(quote) : -1;
      if (!clause || idx < 0 || quote.length < 3) continue; // evidence-or-silence: unverifiable output is dropped
      if (existing.some((f) => f.start >= 0 && idx < f.end && idx + quote.length > f.start)) continue;
      findings.push(finding({
        rule: 'llm.nuance', category: clause.category === 'messaging' ? 'messaging' : 'tone', severity: 'low', confidence: 0.6,
        start: idx, end: idx + quote.length, matched: quote, ai_assisted: true,
        message: `AI-assisted: ${String(issue.why || 'May not match the brand voice.').slice(0, 200)}`,
        source: citeClause(clause),
      }));
    }
  } catch (e) { event.note = `AI unavailable: ${e.message}`; }
  return { findings, events: [event] };
}

// Sentence-level rewrite for serious findings. The result is only shown if Purpose Lock accepts it.
async function rewriteSuggestions(ctx, findings) {
  const g = gate(ctx);
  if (!g.ok || g.llm.rewrite === false) return { events: g.event ? [g.event] : [] };
  const targets = findings.filter((f) => f.start >= 0 && ['medium', 'high'].includes(f.severity) && f.category !== 'accessibility' && f.fix).slice(0, 4);
  if (!targets.length) return { events: [] };

  const sents = sentences(ctx.view);
  let sent = 0, redactions = 0;
  for (const f of targets) {
    const s = sents.find((x) => f.start >= x.start && f.start < x.end);
    if (!s) continue;
    const red = redact(s.text.trim(), ctx.settings.confidential_terms || []);
    redactions += red.count;
    try {
      const out = await generate(`Rewrite this sentence to fix the issue while keeping the same purpose, all numbers and all names. Do not add new claims. Issue: ${f.message}\nCreator's purpose: ${ctx.intent}\nSentence: "${red.text}"\nReturn JSON: {"text":"..."}`, 25000);
      sent++;
      const text = String(out.text || '').trim();
      const lead = s.text.length - s.text.trimStart().length;
      const span = { start: s.start + lead, end: s.end };
      if (!text || (f.matched && text.toLowerCase().includes(f.matched.toLowerCase()))) continue;
      const trailing = /[.!?]$/.test(text) ? '' : (/[.!?]$/.test(s.text.trim()) ? s.text.trim().slice(-1) : '');
      const full = text + trailing;
      if (intentScore(ctx, span, full) < 0.7) continue;
      f.fix = { ...f.fix, rewrite: full, rewrite_span: span };
    } catch { /* AI unavailable: keep rule-based suggestions only */ }
  }
  return { events: sent ? [{ service: g.info.provider, model: g.info.model, purpose: 'rewrite-suggestions', redactions, sent_external: g.external ? 1 : 0, note: `${sent} sentence(s) sent (redacted)` }] : [] };
}

module.exports = { nuanceReview, rewriteSuggestions, providerInfo, testConnection, resetBreaker };
