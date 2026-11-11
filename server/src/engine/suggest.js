// Turns a finding's machine-readable `fix` hints into up to three suggestions, each scored by Purpose Lock.
// Suggestions are proposals only: nothing is applied until a human accepts one.
const { intentScore } = require('./intent');

const NOTES = { minimal: 'Smallest possible change', balanced: 'Cleaner wording', rewrite: 'Sentence rewrite (AI-assisted)' };

function buildSuggestions(ctx, f) {
  if (!f.fix) return [];
  const seen = new Set();
  const out = [];
  for (const level of ['minimal', 'balanced', 'rewrite']) {
    const text = f.fix[level];
    if (text === undefined || seen.has(text)) continue;
    seen.add(text);
    const span = f.fix.rewrite_span && level === 'rewrite' ? f.fix.rewrite_span : { start: f.start, end: f.end };
    const s = { level, text, intent_preserved: intentScore(ctx, span, text), note: NOTES[level] };
    if (level === 'rewrite' && f.fix.rewrite_span) { s.start = span.start; s.end = span.end; s.ai = true; }
    out.push(s);
  }
  return out;
}

module.exports = { buildSuggestions };
