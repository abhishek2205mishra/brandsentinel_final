// Tone, language and readability. Every check is driven by an active guideline clause with a `rule` block,
// so a finding can always cite the clause that defines it. No clause -> no finding.
const { termRegex, sentences, hasDevanagari, matchCase } = require('../../util/text');
const { fleschKincaid } = require('../../util/readability');
const { finding, citeClause, clause, citeReg, alsoCites } = require('../helpers');

module.exports = function tone(ctx) {
  const out = [];
  const text = ctx.view;

  // 1. Exclamation marks
  const ex = clause(ctx, 'tone.exclaim');
  if (ex) {
    const max = ex.rule.max ?? 1;
    let seen = 0;
    const re = /!+/g;
    let m;
    while ((m = re.exec(text))) {
      const before = seen;
      seen += m[0].length;
      if (seen > max) {
        const keep = Math.max(0, max - before);
        const start = m.index + keep;
        out.push(finding({
          rule: 'tone.exclaim', category: 'tone', severity: 'low', confidence: 0.98,
          start, end: m.index + m[0].length, matched: m[0].slice(keep),
          message: `Too many exclamation marks (the voice guide allows ${max} per piece).`,
          source: citeClause(ex), fix: { minimal: '.', balanced: '.' },
        }));
      }
    }
  }

  // 2. SHOUTING (ALL CAPS words)
  const caps = clause(ctx, 'tone.caps');
  if (caps && !hasDevanagari(text)) {
    const allow = new Set((caps.rule.allow || []).map((w) => w.toUpperCase()));
    const re = /(?<![\p{L}\p{N}])[A-Z]{4,}(?![\p{L}\p{N}])/gu;
    let m;
    while ((m = re.exec(text))) {
      if (allow.has(m[0])) continue;
      const lower = m[0][0] + m[0].slice(1).toLowerCase();
      out.push(finding({
        rule: 'tone.caps', category: 'tone', severity: 'low', confidence: 0.9,
        start: m.index, end: m.index + m[0].length, matched: m[0],
        message: `"${m[0]}" is written in capitals, which reads as shouting and is hard for screen readers.`,
        source: citeClause(caps), also: alsoCites(ctx, []),
        fix: { minimal: lower, balanced: lower },
      }));
    }
  }

  // 3. Hype / pushy phrases
  const hype = clause(ctx, 'tone.hype');
  if (hype) {
    for (const p of hype.rule.phrases || []) {
      const phrase = typeof p === 'string' ? p : p.phrase;
      const repl = typeof p === 'string' ? '' : p.replacement || '';
      const re = termRegex(phrase);
      let m;
      while ((m = re.exec(text))) {
        out.push(finding({
          rule: 'tone.hype', category: 'tone', severity: 'low', confidence: 0.85,
          start: m.index, end: m.index + m[0].length, matched: m[0],
          message: `"${m[0]}" is pushy or hype language; the brand voice is calm and warm.`,
          source: citeClause(hype), fix: { minimal: matchCase(m[0], repl), balanced: '' },
        }));
      }
    }
  }

  // 4. Emoji budget
  const emo = clause(ctx, 'tone.emoji');
  if (emo) {
    const max = emo.rule.max ?? 2;
    const re = /\p{Extended_Pictographic}️?/gu;
    let n = 0, m;
    while ((m = re.exec(text))) {
      n++;
      if (n > max) {
        out.push(finding({
          rule: 'tone.emoji', category: 'tone', severity: 'low', confidence: 0.95,
          start: m.index, end: m.index + m[0].length, matched: m[0],
          message: `More than ${max} emoji in one piece.`, source: citeClause(emo), fix: { minimal: '', balanced: '' },
        }));
      }
    }
  }

  // 5. Very long sentences
  const sen = clause(ctx, 'tone.sentence');
  if (sen && !hasDevanagari(text)) {
    const maxWords = sen.rule.maxWords ?? 30;
    for (const s of sentences(text)) {
      const words = (s.text.match(/[\p{L}\p{N}'’-]+/gu) || []).length;
      if (words > maxWords) {
        const lead = s.text.length - s.text.trimStart().length;
        out.push(finding({
          rule: 'tone.sentence', category: 'tone', severity: 'low', confidence: 0.8,
          start: s.start + lead, end: s.end, matched: s.text.trim(),
          message: `This sentence has ${words} words; the style guide asks for ${maxWords} or fewer. Consider splitting it.`,
          source: citeClause(sen),
        }));
      }
    }
  }

  // 6. Reading level
  const gr = clause(ctx, 'tone.grade');
  if (gr && !hasDevanagari(text)) {
    const grade = fleschKincaid(text);
    const max = gr.rule.maxGrade ?? 10;
    if (grade !== null && grade > max) {
      const longest = sentences(text).sort((a, b) => b.text.length - a.text.length)[0];
      const lead = longest ? longest.text.length - longest.text.trimStart().length : 0;
      out.push(finding({
        rule: 'tone.grade', category: 'accessibility', severity: 'low', confidence: 0.75,
        start: longest ? longest.start + lead : -1, end: longest ? longest.end : -1, matched: longest ? longest.text.trim() : '',
        message: `Reading level is about grade ${grade}; the guideline targets grade ${max} or below. Shorter sentences and simpler words will help.`,
        source: citeClause(gr), also: alsoCites(ctx, ['WCAG-3.1.5']),
      }));
    }
  }

  // 7. Unreviewed AI boilerplate
  const bp = clause(ctx, 'tone.ai_boilerplate');
  if (bp) {
    for (const p of bp.rule.phrases || []) {
      const re = termRegex(p);
      let m;
      while ((m = re.exec(text))) {
        out.push(finding({
          rule: 'tone.ai_boilerplate', category: 'tone', severity: 'low', confidence: 0.8,
          start: m.index, end: m.index + m[0].length, matched: m[0],
          message: `"${m[0]}" is typical unedited AI boilerplate and does not sound like this brand.`,
          source: citeClause(bp), fix: { minimal: '', balanced: '' },
        }));
      }
    }
  }
  return out;
};
