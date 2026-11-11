// Shared helpers for rule modules.
const SEVERITY_RANK = { info: 0, low: 1, medium: 2, high: 3 };

// Every finding must be able to cite a source (evidence-or-silence). `cite*` build that citation.
const citeClause = (g) => (g ? { type: 'guideline', code: g.code, quote: g.text } : null);
const citeReg = (ctx, code) => {
  const r = ctx.regs[code];
  return r && ctx.packs.has(r.pack) ? { type: 'regulation', code: r.code, quote: r.text } : null;
};
const alsoCites = (ctx, codes) => codes.map((c) => citeReg(ctx, c)).filter(Boolean).map((c) => c.code);

function finding(f) {
  return {
    start: -1, end: -1, matched: '', confidence: 0.9, fix: null, also: [], ai_assisted: false,
    ...f,
  };
}

// Find the active guideline clause that carries a machine-checkable rule of this type.
const clause = (ctx, type) => ctx.guidelines.find((g) => g.rule && g.rule.type === type);

// Merge a list of spans, dropping any that overlap an earlier (higher priority) span.
function nonOverlapping(list, getSpan) {
  const taken = [];
  const out = [];
  for (const item of list) {
    const [s, e] = getSpan(item);
    if (taken.some(([a, b]) => s < b && e > a)) continue;
    taken.push([s, e]);
    out.push(item);
  }
  return out;
}

module.exports = { SEVERITY_RANK, citeClause, citeReg, alsoCites, finding, clause, nonOverlapping };
