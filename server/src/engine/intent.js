// Purpose Lock: scores how well a suggested edit preserves what the creator was trying to say.
// Anchors = numbers, proper nouns and key words the creator referenced in their stated intent.
// Score = anchor coverage (70%) + content-word overlap with the original (30%), penalised if too much text is lost.
const { sentences, tokens, contentWords } = require('../util/text');

function applyReplacement(body, start, end, repl) {
  let before = body.slice(0, start);
  let after = body.slice(end);
  if (repl === '' && start !== end) {
    if (/[ \t]$/.test(before) && /^[ \t]/.test(after)) after = after.replace(/^[ \t]+/, '');
    else if (/[ \t]$/.test(before) && /^[.,;:!?]/.test(after)) before = before.replace(/[ \t]+$/, '');
    else if (before === '') after = after.replace(/^[ \t]+/, '');
    if ((before === '' || /[.!?]\s*$/.test(before)) && /^[a-z]/.test(after)) after = after[0].toUpperCase() + after.slice(1);
  }
  return before + repl + after;
}

function properNouns(text) {
  const out = new Set();
  for (const s of sentences(text)) {
    (s.text.match(/\S+/g) || []).slice(1).forEach((w) => {
      const c = w.replace(/[^\p{L}\p{N}'’]/gu, '').replace(/’/g, "'");
      if (/^\p{Lu}\p{L}{2,}/u.test(c)) out.add(c.toLowerCase());
    });
  }
  return out;
}

function intentScore(ctx, span, repl) {
  const before = ctx.view;
  const after = applyReplacement(before, span.start, span.end, repl);
  const outside = before.slice(0, span.start) + ' ' + before.slice(span.end);
  const spanTokens = new Set(tokens(before.slice(span.start, span.end)));
  const beforeTokens = new Set(tokens(before));

  const anchors = new Set();
  (outside.match(/[₹$]?\d[\d,]*(?:\.\d+)?%?/g) || []).forEach((n) => anchors.add(n.toLowerCase().replace(/,/g, '')));
  properNouns(outside).forEach((p) => anchors.add(p));
  contentWords(ctx.intent || '').filter((w) => beforeTokens.has(w)).forEach((w) => anchors.add(w));
  const list = [...anchors].filter((a) => !spanTokens.has(a));

  const afterTokens = new Set(tokens(after).map((t) => t.replace(/,/g, '')));
  const kept = list.filter((a) => afterTokens.has(a)).length;
  const coverage = list.length ? kept / list.length : 1;

  const a = new Set(contentWords(before));
  const b = new Set(contentWords(after));
  const inter = [...a].filter((w) => b.has(w)).length;
  const union = new Set([...a, ...b]).size || 1;
  const jaccard = inter / union;

  const lenPenalty = after.length < before.length * 0.6 ? 0.8 : 1;
  const score = (0.7 * coverage + 0.3 * Math.min(1, jaccard + 0.1)) * lenPenalty;
  return Math.round(Math.max(0, Math.min(1, score)) * 100) / 100;
}

module.exports = { applyReplacement, intentScore };
