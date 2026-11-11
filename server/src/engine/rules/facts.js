// Approved Facts Vault checks: wrong values, expired facts, and offer dates that have already passed.
const { termRegex, sentences, MONTHS } = require('../../util/text');
const { finding, clause, citeClause } = require('../helpers');

const norm = (s) => s.toLowerCase().replace(/rs\.?|inr/g, '₹').replace(/[\s,]/g, '');
const PERCENT = /\d+(?:\.\d+)?\s?%/g;
const MONEY = /(?:₹|rs\.?\s?|inr\s?|\$)\s?\d[\d,]*(?:\.\d+)?/gi;

const valueType = (v) => (/%/.test(v) ? 'percent' : /₹|rs|inr|\$/i.test(v) ? 'money' : null);

module.exports = function facts(ctx) {
  const out = [];
  const sents = sentences(ctx.view);

  for (const f of ctx.facts) {
    const kws = f.keywords.split(',').map((k) => k.trim()).filter(Boolean);
    const expired = f.valid_until && new Date(f.valid_until) < ctx.today;
    const factSource = { type: 'fact', code: `FACT-${f.id}`, quote: `${f.statement}${f.evidence ? ` (evidence: ${f.evidence})` : ''}${f.valid_until ? `, valid until ${f.valid_until}` : ''}` };

    for (const s of sents) {
      let kwMatch = null;
      for (const k of kws) { const m = termRegex(k).exec(s.text); if (m) { kwMatch = { m, k }; break; } }
      if (!kwMatch) continue;
      const abs = s.start + kwMatch.m.index;

      if (expired) {
        out.push(finding({
          rule: 'facts.expired', category: 'facts', severity: 'high', confidence: 0.9,
          start: abs, end: abs + kwMatch.m[0].length, matched: kwMatch.m[0],
          message: `The approved fact "${f.subject}" was only valid until ${f.valid_until}. This content may be out of date; confirm the current value with ${f.owner || 'the fact owner'}.`,
          source: factSource,
        }));
        continue;
      }

      const vt = valueType(f.value);
      if (!vt) continue;
      const re = vt === 'percent' ? PERCENT : MONEY;
      const found = [...s.text.matchAll(re)];
      if (!found.length) continue;
      const wanted = norm(f.value);
      if (found.some((x) => norm(x[0]) === wanted)) continue;
      const bad = found[0];
      out.push(finding({
        rule: 'facts.conflict', category: 'facts', severity: 'high', confidence: 0.9,
        start: s.start + bad.index, end: s.start + bad.index + bad[0].length, matched: bad[0],
        message: `The content says "${bad[0].trim()}" but the approved value for "${f.subject}" is "${f.value}".`,
        source: factSource, fix: { minimal: f.value, balanced: f.value },
      }));
    }
  }

  // Offer / validity dates that are already in the past.
  const dates = clause(ctx, 'facts.dates');
  if (dates) {
    const mon = Object.keys(MONTHS).join('|');
    const re = new RegExp(`(?:until|till|through|ends?(?:\\s+on)?|expires?(?:\\s+on)?|valid\\s+(?:until|till|through))\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s+(${mon})[a-z]*\\.?(?:,?\\s+(\\d{4}))?`, 'gi');
    let m;
    while ((m = re.exec(ctx.view))) {
      const year = m[3] ? Number(m[3]) : ctx.today.getUTCFullYear();
      const d = new Date(Date.UTC(year, MONTHS[m[2].toLowerCase().slice(0, 3)], Number(m[1]), 23, 59));
      if (d < ctx.today) {
        const dateText = m[0].replace(/^[a-z\s]+?(?=\d)/i, '');
        const dStart = m.index + m[0].length - dateText.length;
        out.push(finding({
          rule: 'facts.stale_date', category: 'facts', severity: 'high', confidence: 0.85,
          start: dStart, end: m.index + m[0].length, matched: dateText,
          message: `"${dateText}" has already passed. Publishing an expired offer date damages trust.`,
          source: citeClause(dates),
        }));
      }
    }
  }
  return out;
};
