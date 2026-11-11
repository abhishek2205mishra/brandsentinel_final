// Terminology: banned / non-preferred terms from the approved terminology list (multilingual).
const { termRegex, matchCase } = require('../../util/text');
const { editDistance } = require('../../util/fuzzy');
const { finding, citeClause } = require('../helpers');

module.exports = function terminology(ctx) {
  const out = [];
  for (const t of ctx.terms) {
    const re = termRegex(t.banned);
    let m;
    while ((m = re.exec(ctx.view))) {
      if (t.preferred && m[0] === t.preferred) continue; // already correct (case-only variants of the brand name)
      const g = t.guideline_code && ctx.guidelines.find((x) => x.code === t.guideline_code);
      const source = g
        ? citeClause(g)
        : { type: 'terminology', code: `TERM-${t.id}`, quote: t.reason || `"${t.banned}" is not an approved term.` };
      const repl = t.preferred ? matchCase(m[0], t.preferred) : '';
      out.push(finding({
        rule: 'terminology.banned', category: 'terminology', severity: 'medium', confidence: 0.97,
        start: m.index, end: m.index + m[0].length, matched: m[0],
        message: `"${m[0]}" is not an approved term${t.preferred ? `; the brand uses "${t.preferred}"` : ''}.${t.reason ? ' ' + t.reason : ''}`,
        source, also: [`TERM-${t.id}`].filter((c) => c !== source.code),
        fix: { minimal: repl, balanced: repl },
      }));
    }
  }

  // Fuzzy pass: catches misspellings of approved/banned single-word terms ("Novabrw", "artisinal") that exact matching misses.
  const taken = out.map((f) => [f.start, f.end]);
  const words = [];
  const wre = /[\p{L}][\p{L}\p{N}'’-]*/gu;
  let w;
  while ((w = wre.exec(ctx.view))) words.push({ text: w[0], start: w.index, end: w.index + w[0].length });
  const seen = new Set();
  for (const t of ctx.terms) {
    const targets = [];
    if (t.preferred && !/\s/.test(t.preferred)) targets.push({ form: t.preferred, fixTo: t.preferred, kind: 'preferred' });
    if (t.preferred && /\s/.test(t.banned) === false) targets.push({ form: t.banned, fixTo: t.preferred, kind: 'banned' });
    else if (!t.preferred && !/\s/.test(t.banned)) targets.push({ form: t.banned, fixTo: '', kind: 'banned' });
    for (const tg of targets) {
      const f = tg.form.toLowerCase();
      if (f.length < 7 || /[^\x00-\x7f]/.test(f)) continue; // short or non-Latin words are too risky for fuzzy matching
      const max = f.length >= 11 ? 2 : 1;
      for (const wd of words) {
        const lw = wd.text.toLowerCase();
        if (lw === f || Math.abs(lw.length - f.length) > max) continue;
        if (taken.some(([a, b]) => wd.start < b && wd.end > a)) continue;
        if (seen.has(`${wd.start}`)) continue;
        if (editDistance(lw, f, max) > max) continue;
        // A word that is itself another approved/banned term is not a typo of this one.
        if (ctx.terms.some((o) => o !== t && (o.banned.toLowerCase() === lw || (o.preferred || '').toLowerCase() === lw))) continue;
        seen.add(`${wd.start}`);
        const g = t.guideline_code && ctx.guidelines.find((x) => x.code === t.guideline_code);
        const source = g ? citeClause(g) : { type: 'terminology', code: `TERM-${t.id}`, quote: t.reason || `"${t.banned}" is not an approved term.` };
        const repl = tg.fixTo ? matchCase(wd.text, tg.fixTo) : '';
        out.push(finding({
          rule: 'terminology.fuzzy', category: 'terminology', severity: 'low', confidence: 0.8,
          start: wd.start, end: wd.end, matched: wd.text,
          message: tg.kind === 'preferred'
            ? `"${wd.text}" looks like a misspelling of our approved term "${tg.form}".`
            : `"${wd.text}" looks like the non-approved term "${t.banned}"${t.preferred ? `; the brand uses "${t.preferred}"` : ''}.`,
          source, also: [`TERM-${t.id}`].filter((c) => c !== source.code),
          fix: { minimal: repl, balanced: repl },
        }));
      }
    }
  }
  return out;
};
