// Semantic layer (Round 3). Finds claims and terms by MEANING, not exact wording, and retrieves the right guideline clause to cite.
//
//  * Paraphrase clusters (English, romanised Hindi "Hinglish", Devanagari): "nothing beats us", "unrivalled", "sabse behtareen"
//    are matched with stem-aware fuzzy matching, so inflections and spelling variants count too.
//  * Evasion-proof: zero-width characters, look-alike letters, "b e s t", leetspeak ("unb3atable") are normalised first.
//  * Guards that keep it quiet: negation ("we never claim to be the best"), idioms ("best wishes"), and sentences that are
//    not about the brand or its product.
//  * Evidence-or-silence still rules: every semantic finding cites a real clause of this organisation's guidelines (chosen by
//    hybrid retrieval), and a phrase the Claim Ledger already approves is never flagged.
//  * Retrieval = BM25 + offline concept vectors, fused with reciprocal-rank fusion. When the AI assistant is on and Confidential
//    Mode is off, Gemini embeddings (free tier) are added as a third signal; they only re-rank, they never create findings.
const config = require('../config');
const db = require('../db');
const { buildIndex, search } = require('../util/bm25');
const { normalise, tokenise, tokSim, stem, STOP, g3 } = require('../util/semtext');
const { sentences, hasDevanagari } = require('../util/text');
const { finding, citeClause } = require('./helpers');

// ---------------------------------------------------------------- paraphrase clusters
// type = claim family (same names as the regex rules), sev/conf = defaults, self = needs a brand/product reference nearby.
const CLUSTERS = [
  { type: 'superlative', sev: 'high', conf: 0.82, self: true, soft: 'a trusted', say: 'a superlative or "best" claim', phrases: [
    'unbeatable', 'unmatched', 'unrivalled', 'unrivaled', 'unparalleled', 'peerless', 'incomparable', 'second to none', 'nothing beats', 'nothing comes close', 'no one does it better', 'no one roasts better',
    'best in class', 'class leading', 'world class', 'top notch', 'finest', 'supreme', 'ultimate', 'unsurpassed', 'in a league of its own', 'head and shoulders above', 'the gold standard', 'number one', 'the very best', 'the best you can buy', 'like no other',
    'sabse accha', 'sabse achha', 'sabse behtareen', 'sabse best', 'sabse badhiya', 'number ek', 'no 1', 'सबसे अच्छा', 'सबसे अच्छी', 'सबसे बेहतरीन', 'सबसे बढ़िया', 'नंबर एक', 'नंबर 1', 'बेमिसाल', 'लाजवाब'] },
  { type: 'comparative', sev: 'high', conf: 0.8, self: true, soft: '', say: 'an implied comparison with competitors', phrases: [
    'beats the competition', 'outperforms', 'outclasses', 'leaves others behind', 'better than the rest', 'better than other brands', 'better than any other', 'superior to', 'miles ahead', 'streets ahead', 'far better than', 'unlike other brands', 'unlike the others', 'unlike our competitors', 'no other brand', 'ahead of the competition', 'beats every other', 'doesnt compare',
    'doosron se behtar', 'baki sab se behtar', 'sabse aage', 'दूसरों से बेहतर', 'बाकी सबसे बेहतर', 'सबसे आगे'] },
  { type: 'absolute', sev: 'high', conf: 0.82, self: false, soft: '', say: 'an absolute promise', phrases: [
    'never fails', 'works every time', 'every single time', 'zero risk', 'risk free', 'foolproof', 'fail proof', 'always works', '100 percent sure', 'cannot go wrong', 'no side effects', 'guaranteed results', 'guaranteed to work', 'results guaranteed', 'completely safe', 'absolutely safe', 'no questions asked',
    'pakka guarantee', 'guarantee ke saath', 'kabhi fail nahi', 'bilkul safe', 'पक्की गारंटी', 'गारंटी के साथ', 'बिल्कुल सुरक्षित', 'कभी फेल नहीं'] },
  { type: 'health', sev: 'high', conf: 0.85, self: false, soft: '', say: 'a health or medical claim', phrases: [
    'boosts immunity', 'boost your immunity', 'supports immunity', 'supports your immune system', 'strengthens immunity', 'detoxifies', 'detox your body', 'flushes toxins', 'melts fat', 'burns fat', 'fat burner', 'helps you lose weight', 'weight loss',
    'lowers cholesterol', 'lowers blood pressure', 'controls diabetes', 'reverses diabetes', 'prevents disease', 'prevents cancer', 'fights cancer', 'cures', 'cure for', 'heals', 'treats', 'anti ageing', 'anti aging', 'turns back the clock', 'doctor recommended', 'doctors recommend', 'clinically tested', 'medically proven', 'miracle cure', 'relieves anxiety', 'cures fatigue', 'boosts metabolism',
    'ilaaj', 'bimari door', 'rog door', 'वज़न घटाए', 'इम्युनिटी बढ़ाए', 'इलाज', 'बीमारी दूर', 'कैंसर से बचाव', 'मधुमेह नियंत्रित'] },
  { type: 'financial', sev: 'high', conf: 0.85, self: false, soft: '', say: 'a financial promise', phrases: [
    'double your money', 'guaranteed returns', 'assured returns', 'assured profit', 'risk free returns', 'get rich', 'passive income', 'earn without effort', 'no risk investment', 'multiply your savings', 'fixed returns guaranteed', 'paise double',
    'पैसे दोगुने', 'पक्का मुनाफा', 'गारंटीड रिटर्न'] },
  { type: 'environmental', sev: 'medium', conf: 0.75, self: true, soft: '', say: 'an environmental claim', phrases: [
    'planet friendly', 'earth friendly', 'kind to the planet', 'kind to the earth', 'zero waste', 'guilt free', 'climate positive', 'net zero', 'carbon free', 'eco safe', 'eco friendly', 'eco conscious', 'green choice', '100 percent green', 'saves the planet', 'good for the planet', 'sustainable', 'sustainably sourced', 'plastic free', 'zero emissions',
    'paryavaran ke liye achha', 'पर्यावरण के अनुकूल', 'पर्यावरण अनुकूल', 'प्लास्टिक मुक्त'] },
  { type: 'natural', sev: 'medium', conf: 0.75, self: true, soft: '', say: 'a purity or "natural" claim', phrases: [
    'pure and natural', 'all natural', 'completely natural', 'totally natural', 'chemical free', 'nothing artificial', 'no artificial', 'no preservatives', 'preservative free', 'free from chemicals', 'free of additives', 'straight from nature', 'nature made', 'as nature intended', 'farm fresh', 'unprocessed', 'pure',
    'bilkul natural', 'puri tarah natural', 'shuddh', 'kudrati', 'पूरी तरह प्राकृतिक', 'बिल्कुल प्राकृतिक', '100 प्राकृतिक', 'शुद्ध', 'केमिकल मुक्त', 'कोई प्रिज़र्वेटिव नहीं'] },
  { type: 'award', sev: 'medium', conf: 0.72, self: true, soft: '', say: 'an award or ranking claim', phrases: [
    'voted best', 'voted favourite', 'voted favorite', 'most loved', 'most trusted', 'most popular', 'most awarded', 'award winner', 'winner of', 'crowned best', 'rated number one', 'ranked first', 'top rated', 'customer favourite', 'customers favourite', 'bestselling', 'best selling', 'no 1 choice', 'sabse zyada pasand', 'सबसे ज़्यादा पसंद', 'सबसे भरोसेमंद', 'सबसे लोकप्रिय'] },
  { type: 'statistic', sev: 'medium', conf: 0.72, self: false, soft: '', say: 'an unsupported statistic or "proof" claim', phrases: [
    'scientifically proven', 'proven by science', 'studies show', 'research shows', 'experts agree', 'experts say', 'tests prove', 'laboratory tested', 'most people prefer', 'most customers prefer', 'nine out of ten', 'majority of customers', 'proven results', 'backed by science', 'research backed',
    'vaigyanik roop se sabit', 'वैज्ञानिक रूप से सिद्ध', 'शोध बताते हैं', 'विशेषज्ञ मानते हैं'] },
];

// Words around a window that make a sentence "about us": brand, product, or a first-person marketing voice.
const SELF = new Set(['we', 'our', 'us', 'ours', 'my', 'this', 'these', 'try', 'buy', 'order', 'get', 'enjoy', 'taste', 'experience', 'introducing', 'meet', 'discover', 'hum', 'humare', 'humara', 'humari', 'hamara', 'hamare', 'hamari', 'apna', 'hamaari', 'हम', 'हमारा', 'हमारे', 'हमारी', 'product', 'brand', 'blend', 'roast', 'brew', 'coffee', 'pack', 'bag', 'beans', 'cup', 'range', 'collection', 'offer', 'service', 'quality', 'flavour', 'flavor', 'aroma', 'formula', 'recipe', 'drink', 'tea', 'cold', 'latte', 'espresso', 'skincare', 'supplement', 'capsule', 'tablet', 'oil', 'powder', 'shake', 'juice', 'snack', 'ingredients', 'packaging', 'wellness', 'investment', 'plan', 'scheme', 'app', 'platform', 'results', 'कॉफ़ी', 'कॉफी', 'स्वाद', 'ब्रांड', 'उत्पाद']);
const NEG = new Set(['not', 'never', 'no', 'nor', 'neither', 'without', 'isnt', 'arent', 'dont', 'doesnt', 'cannot', 'cant', 'wont', 'nahi', 'nahin', 'na', 'mat', 'nai', 'नहीं', 'न', 'मत']);
const NEG_VERBS = new Set(['claim', 'claims', 'claiming', 'promise', 'promises', 'say', 'says', 'saying', 'pretend', 'pretending', 'avoid', 'avoids', 'stop', 'refuse', 'refuses', 'banned']);
const IDIOMS = [/wish(?:es)? (?:you|them|him|her|everyone) (?:all )?(?:the )?(?:very )?best/, /best (?:wishes|regards|of luck|friend|friends|effort|efforts|practice|practices|before|seller of)/, /do (?:our|your|my) best/, /at best/, /to the best of/, /personal best/, /pure (?:joy|bliss|delight|magic|chaos)/, /(?:purely|pure) (?:coincidence|luck)/, /ultimate (?:guide|checklist|list|frisbee)/, /number one (?:fan|rule|priority)/, /sustainable (?:growth|development|business|finance|pace)/, /(?:the )?finest (?:details|print)/];

const norm = (s) => tokenise(normalise(String(s).toLowerCase()).text).map((t) => t.t);
const content = (toks) => toks.filter((t) => !STOP.has(t));

// Compile exemplars once per process.
let COMPILED = null;
function compiled() {
  if (COMPILED) return COMPILED;
  COMPILED = CLUSTERS.map((c) => ({ ...c, ex: c.phrases.map((p) => content(norm(p))).filter((x) => x.length) }));
  return COMPILED;
}

// Slide each exemplar over the content tokens of a sentence. Returns the best match per (cluster) with its span.
function matchCluster(cl, toks) {
  const ct = [];
  toks.forEach((tk, i) => { if (!STOP.has(tk.t)) ct.push({ ...tk, pos: i }); });
  const cands = [];
  for (const ex of cl.ex) {
    const k = ex.length;
    for (let i = 0; i + k <= ct.length; i++) {
      let sum = 0, ok = true;
      for (let j = 0; j < k; j++) {
        const s = tokSim(ex[j], ct[i + j].t);
        if (s < 0.7 && !(ex[j] === ct[i + j].t)) { ok = false; break; }
        sum += s;
      }
      if (!ok) continue;
      const score = sum / k;
      if (score < (k === 1 ? 0.9 : 0.85)) continue;
      // a single very short/generic token must match exactly
      if (k === 1 && ex[0].length < 5 && score < 1) continue;
      const cand = { cl, score: score + Math.min(k, 3) * 0.01, first: ct[i], last: ct[i + k - 1], k };
      cands.push(cand);
    }
  }
  // greedy: best score first, skip overlaps, so one sentence can carry several distinct claims of the same family
  cands.sort((a, b) => b.score - a.score);
  const out = [];
  for (const c of cands) if (!out.some((o) => c.first.pos <= o.last.pos && c.last.pos >= o.first.pos)) out.push(c);
  return out;
}

const negated = (toks, firstPos) => {
  for (let j = Math.max(0, firstPos - 3); j < firstPos; j++) if (NEG.has(toks[j].t)) return true;
  // "we do not claim to be the best": a negator followed by a claim verb earlier in the clause
  const before = toks.slice(Math.max(0, firstPos - 6), firstPos).map((t) => t.t);
  return before.some((t) => NEG.has(t)) && before.some((t) => NEG_VERBS.has(t));
};
const OTHER = new Set(['she', 'he', 'her', 'his', 'him', 'they', 'them', 'their', 'rival', 'rivals', 'competitor', 'competitors', 'competition', 'friend', 'colleague', 'student', 'teacher', 'barista', 'baristas', 'regular', 'ceo', 'founder', 'runner', 'woh', 'unka', 'unki', 'wo', 'वह', 'उसकी', 'उनका', 'उनकी', 'प्रतियोगी']);
const STRONG = new Set(['we', 'our', 'us', 'ours', 'my', 'hum', 'humare', 'humara', 'humari', 'hamara', 'hamare', 'hamari', 'हम', 'हमारा', 'हमारे', 'हमारी']);
const ATTRIB = /\b(?:said|says|according to|claims? that|calls? (?:it|themselves)|call themselves|boasts?)\b/;
// Cuts the sentence at ; : and dashes so a claim made by someone else in another clause does not taint ours.
const clauseOf = (toks, firstPos, text) => {
  const m = toks[firstPos]; if (!m) return toks;
  const cuts = [...text.matchAll(/[;:\u2014]|\s-\s/g)].map((x) => x.index);
  const before = cuts.filter((c) => c < m.start).pop() ?? -1, after = cuts.find((c) => c >= m.end) ?? Infinity;
  return toks.filter((t) => t.start > before && t.start < after);
};
// Is the claim someone else's (third person, a quoted rival, "she is the best barista")? Looks at the nearest subject before the match.
function notOurs(clauseToks, firstStart, text) {
  const before = clauseToks.filter((t) => t.start < firstStart);
  for (let i = before.length - 1; i >= 0; i--) { const w = before[i].t; if (STRONG.has(w)) return false; if (OTHER.has(w)) return true; }
  const cl = text.slice(clauseToks.length ? clauseToks[0].start : 0, firstStart).toLowerCase();
  return ATTRIB.test(cl);
}
const aboutUs = () => true;

// Words that mean "this is about our own brand": the organisation's name and approved terms.
function brandWords(ctx) {
  const w = new Set();
  for (const t of ctx.terms || []) if (t.preferred) norm(t.preferred).forEach((x) => w.add(x));
  for (const f of ctx.facts || []) norm(f.subject || '').forEach((x) => w.add(x));
  if (ctx.orgName) norm(ctx.orgName).forEach((x) => w.add(x));
  return w;
}

// ---------------------------------------------------------------- hybrid retrieval
const dims = 512;
function vec(text) {
  const v = new Float32Array(dims);
  for (const t of content(norm(text))) {
    const s = stem(t);
    const add = (key, wgt) => { let h = 2166136261; for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); } v[(h >>> 0) % dims] += wgt; };
    add('w:' + s, 1.4);
    for (const g of g3(s)) add('g:' + g, 0.35);
  }
  let n = 0; for (let i = 0; i < dims; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1; for (let i = 0; i < dims; i++) v[i] /= n;
  return v;
}
const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

// Optional dense embeddings (Gemini). Used only to re-rank; never to create findings. Respects Confidential Mode and redaction.
const dense = { downUntil: 0, calls: 0 };
const denseReady = (ctx) => config.semanticEnabled && config.embeddingProvider !== 'off' && !!(config.geminiKey) && Date.now() > dense.downUntil
  && !!(ctx.settings && ctx.settings.llm && ctx.settings.llm.enabled) && !ctx.settings.confidential_mode && ctx.useDense !== false;
async function embed(ctx, texts, purpose) {
  const { redact } = require('../util/redact');
  const clean = texts.map((t) => redact(String(t).slice(0, 2000), ctx.settings.confidential_terms || []));
  const base = config.llmBaseUrl || 'https://generativelanguage.googleapis.com';
  const res = await fetch(`${base}/v1beta/models/${config.embeddingModel}:batchEmbedContents`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': config.geminiKey },
    body: JSON.stringify({ requests: clean.map((c) => ({ model: `models/${config.embeddingModel}`, content: { parts: [{ text: c.text }] }, taskType: purpose === 'doc' ? 'RETRIEVAL_DOCUMENT' : 'RETRIEVAL_QUERY' })) }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Embedding API ${res.status}`);
  const out = (await res.json()).embeddings.map((e) => Float32Array.from(e.values));
  dense.calls++;
  ctx.events && ctx.events.push({ service: 'gemini-embeddings', model: config.embeddingModel, purpose: 'semantic-retrieval', redactions: clean.reduce((n, c) => n + (c.count || 0), 0), sent_external: 1, chars: clean.reduce((n, c) => n + c.text.length, 0) });
  return out;
}

// Rank this organisation's guidelines for a query. categories narrows the pool (for example only "claims" clauses).
// Query expansion by meaning: if the query matches a paraphrase cluster, add that family's own vocabulary, so a clause that never uses the
// query's words ("heals", "nothing beats us") is still found through the family it belongs to ("health claim", "superlative claim").
function expand(query) {
  const toks = tokenise(normalise(String(query).toLowerCase()).text);
  const add = [];
  for (const cl of compiled()) if (matchCluster(cl, toks).length) add.push(`${cl.type} ${cl.say} claim evidence approved`);
  return add.length ? `${query} ${add.join(' ')}` : query;
}

async function retrieve(ctx, query, { k = 3, categories = null, useDense = true } = {}) {
  const rawQuery = query; query = expand(query);
  let pool = (ctx.guidelines || []).filter((g) => g.active !== 0);
  if (categories) pool = pool.filter((g) => categories.includes(g.category));
  if (!pool.length) return [];
  const docs = pool.map((g) => ({ g, text: `${g.title}. ${g.text}` }));
  const bm = search(buildIndex(docs.map((d, i) => ({ id: i, text: d.text }))), query, pool.length).map((r) => r.doc.id);
  const qv = vec(query);
  const lex = docs.map((d, i) => [i, cos(qv, vec(d.text))]).sort((a, b) => b[1] - a[1]).map((x) => x[0]);
  const lists = [bm, lex];
  let via = 'bm25+vectors';
  if (useDense && denseReady(ctx)) {
    try {
      const gv = await clauseVectors(ctx, pool);
      const [q] = await embed(ctx, [query], 'query');
      lists.push(pool.map((g, i) => [i, cos(q, gv[i])]).sort((a, b) => b[1] - a[1]).map((x) => x[0]));
      via = 'bm25+vectors+gemini';
    } catch (e) { dense.downUntil = Date.now() + 60000; }
  }
  const score = new Map();
  for (const l of lists) l.forEach((id, rank) => score.set(id, (score.get(id) || 0) + 1 / (60 + rank)));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([i, s]) => ({ doc: pool[i], score: s, via }));
}

// Clause vectors are cached in the database (confidential clauses are never sent out).
async function clauseVectors(ctx, pool) {
  const crypto = require('crypto');
  const out = new Array(pool.length);
  const need = [];
  for (let i = 0; i < pool.length; i++) {
    const g = pool[i];
    const hash = crypto.createHash('sha1').update(`${config.embeddingModel}|${g.title}|${g.text}`).digest('hex');
    const row = await db.findOne('embeddings', { org_id: ctx.orgId, key: `g:${g.code}` });
    if (row && row.hash === hash) out[i] = Float32Array.from(JSON.parse(row.vec));
    else if (g.confidential) out[i] = vec(`${g.title}. ${g.text}`).map((x) => x); // never sent externally; falls back to offline vector length mismatch handled below
    else need.push({ i, g, hash, row });
  }
  if (need.length) {
    const vs = await embed(ctx, need.map((n) => `${n.g.title}. ${n.g.text}`), 'doc');
    for (let j = 0; j < need.length; j++) {
      const n = need[j]; out[n.i] = vs[j];
      const rec = { org_id: ctx.orgId, key: `g:${n.g.code}`, hash: n.hash, vec: JSON.stringify(Array.from(vs[j])), created_at: db.now() };
      if (n.row) await db.update('embeddings', n.row.id, rec); else await db.insert('embeddings', rec);
    }
  }
  const len = (out.find((v) => v && v.length !== dims) || {}).length;
  for (let i = 0; i < out.length; i++) if (!out[i] || (len && out[i].length !== len)) out[i] = new Float32Array(len || dims);
  return out;
}

// ---------------------------------------------------------------- analysis
const SEV_UP = { low: 'low', medium: 'medium', high: 'high' };

async function analyzeSemantic(ctx, existing) {
  const result = { findings: [], events: [] };
  if (!config.semanticEnabled || ctx.useSemantic === false) return result;
  const claimsClauses = (ctx.guidelines || []).filter((g) => g.category === 'claims' && g.active !== 0);
  const pool = claimsClauses.length ? claimsClauses : [];
  const taken = existing.filter((f) => f.category === 'claims' || f.category === 'terminology').map((f) => [f.start, f.end]);
  const overlaps = (s, e) => taken.some(([a, b]) => s < b && e > a);
  const extra = brandWords(ctx);

  // Normalise the whole text once; map every match back to the author's original characters.
  const n = normalise(ctx.view);
  const sents = sentences(n.text).slice(0, 600);
  const toOrig = (i, end) => (end ? (n.map[Math.max(0, i - 1)] ?? ctx.view.length - 1) + 1 : (n.map[i] ?? 0));
  const ledger = (ctx.claims || []).map((c) => ({ c, toks: content(norm(c.phrase)) })).filter((x) => x.toks.length);

  for (const s of sents) {
    const toks = tokenise(s.text).map((t) => ({ ...t, start: t.start + s.start, end: t.end + s.start }));
    if (toks.length < 2) continue;
    const lowered = s.text.toLowerCase();
    if (IDIOMS.some((re) => re.test(lowered)) || /\?\s*$/.test(s.text.trim())) continue;
    for (const cl of compiled()) {
      for (const m of matchCluster(cl, toks)) {
      const fi = toks.findIndex((t) => t.start === m.first.start);
      if (negated(toks, fi)) continue;
      if (notOurs(clauseOf(toks, fi, n.text), m.first.start, n.text)) continue;
      const start = toOrig(m.first.start, false);
      let end = toOrig(m.last.end, true);
      while (end > start && /\s/.test(ctx.view[end - 1])) end--;
      if (overlaps(start, end)) continue;
      const matched = ctx.view.slice(start, end);
      // A phrase the Claim Ledger already approves (with valid evidence) is supported, not flagged.
      const approved = ledger.find(({ c, toks: lt }) => (!c.valid_until || new Date(c.valid_until) >= ctx.today) && lt.every((w) => toks.some((t) => tokSim(w, t.t) >= 0.9)) && (c.type ? c.type === cl.type : true));
      if (approved) continue;
      const top = pool.length ? await retrieve(ctx, `${s.text} ${cl.say}`, { k: 1, categories: ['claims'] }) : [];
      const policy = (top[0] && top[0].doc) || null;
      if (!policy) continue; // evidence-or-silence: no claims clause to cite, no finding
      taken.push([start, end]);
      result.findings.push(finding({
        rule: 'claims.semantic', category: 'claims', severity: SEV_UP[cl.sev], confidence: Math.min(0.95, +(cl.conf * (0.9 + 0.1 * Math.min(1, m.score))).toFixed(2)),
        start, end, matched,
        message: `"${matched}" reads as ${cl.say} (${cl.type}) even though the wording differs from a standard claim. It has no approved evidence in the Claim Ledger. Add evidence, soften the wording, or remove it.`,
        source: citeClause(policy), also: [],
        fix: cl.soft ? { minimal: cl.soft, balanced: cl.soft } : { minimal: '', balanced: '' },
        extra: { semantic: { cluster: cl.type, score: +m.score.toFixed(2), retrieved_via: top[0].via } },
      }));
      }
    }
  }

  // Terminology by meaning: close relatives of banned words (inflections, spellings, Hinglish) of the organisation's own terms.
  const termHits = new Set(existing.filter((f) => f.rule && f.rule.startsWith('terminology')).map((f) => f.start));
  const tokAll = tokenise(n.text);
  for (const t of ctx.terms || []) {
    const bt = content(norm(t.banned));
    if (!bt.length || bt.length > 3) continue;
    const syn = (THESAURUS[stem(bt.join(' '))] || THESAURUS[bt.join(' ')] || []).map((p) => content(norm(p)));
    for (const variant of [bt, ...syn]) {
      const k = variant.length;
      for (let i = 0; i + k <= tokAll.length; i++) {
        let ok = true, sum = 0;
        for (let j = 0; j < k; j++) { const sc = tokSim(variant[j], tokAll[i + j].t); if (sc < 0.9) { ok = false; break; } sum += sc; }
        if (!ok) continue;
        const start = toOrig(tokAll[i].start, false), end = toOrig(tokAll[i + k - 1].end, true);
        if (overlaps(start, end) || termHits.has(start)) continue;
        const matched = ctx.view.slice(start, end);
        if (t.preferred && matched.toLowerCase() === t.preferred.toLowerCase()) continue;
        if (negated(tokAll, i)) continue;
        const g = t.guideline_code && ctx.guidelines.find((x) => x.code === t.guideline_code);
        const source = g ? citeClause(g) : { type: 'terminology', code: `TERM-${t.id}`, quote: t.reason || `"${t.banned}" is not an approved term.` };
        taken.push([start, end]); termHits.add(start);
        const repl = t.preferred || '';
        result.findings.push(finding({
          rule: 'terminology.semantic', category: 'terminology', severity: 'medium', confidence: 0.8, start, end, matched,
          message: `"${matched}" is another form of the banned term "${t.banned}"${t.preferred ? `; the brand uses "${t.preferred}"` : ''}.${t.reason ? ' ' + t.reason : ''}`,
          source, also: [`TERM-${t.id}`].filter((c) => c !== source.code), fix: { minimal: repl, balanced: repl },
        }));
      }
    }
  }
  return result;
}

// Close relatives of commonly banned words. Keys are stems; values are alternative spellings, forms and Hinglish.
const THESAURUS = {
  cheap: ['inexpensive', 'dirt cheap', 'low cost', 'budget', 'sasta', 'sasti', 'सस्ता', 'सस्ती'],
  addict: ['addicts', 'junkie', 'junkies', 'hooked', 'नशेड़ी'],
  manpower: ['man power', 'man hours', 'manning'],
  blacklist: ['black list', 'black listed', 'blacklisted'],
  whitelist: ['white list', 'white listed', 'whitelisted'],
  chairman: ['chair man', 'chairmen'],
  mankind: ['man kind'],
  housewives: ['housewife', 'house wife', 'house wives'],
  handicapped: ['handicap', 'crippled', 'cripple', 'lame'],
  'wheelchair bound': ['confined to a wheelchair', 'wheelchair confined', 'wheelchair bound'],
  crazy: ['insane', 'mad', 'psycho', 'lunatic', 'pagal', 'पागल'],
  guys: ['you guys', 'hey guys'],
};

// Applied to the older regex claim rules too: "we never claim to be the best", "best wishes", "she is the best barista" are not claims.
function shouldSuppress(ctx, f) {
  if (!config.semanticEnabled || ctx.useSemantic === false) return false;
  if (!f.rule || !f.rule.startsWith('claims.') || f.start < 0) return false;
  const view = ctx.view;
  const ss = sentences(view).find((x) => f.start >= x.start && f.start < x.start + x.text.length + 1) || { start: 0, text: view };
  const lowered = normalise(ss.text.toLowerCase()).text;
  if (IDIOMS.some((re) => re.test(lowered)) || /\?\s*$/.test(ss.text.trim())) return true;
  const toks = tokenise(ss.text.toLowerCase()).map((t) => ({ ...t, start: t.start + ss.start, end: t.end + ss.start }));
  const fi = toks.findIndex((t) => t.end > f.start);
  if (fi < 0) return false;
  return negated(toks, fi) || notOurs(clauseOf(toks, fi, view), toks[fi].start, view);
}

const info = () => ({
  enabled: config.semanticEnabled, retrieval: dense.downUntil > Date.now() ? 'bm25+vectors (dense paused)' : (config.geminiKey && config.embeddingProvider !== 'off' ? 'bm25+vectors, +Gemini embeddings when AI is on' : 'bm25+vectors'),
  clusters: CLUSTERS.length, exemplars: CLUSTERS.reduce((n, c) => n + c.phrases.length, 0), embedding_model: config.embeddingModel, dense_calls: dense.calls,
});

module.exports = { analyzeSemantic, retrieve, info, shouldSuppress, CLUSTERS, normalise, _dense: dense };
