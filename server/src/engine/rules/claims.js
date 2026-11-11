// Promotional claim analysis. Extracts each claim, classifies it, and checks the approved Claim Ledger.
//  - approved + in date  -> supported (no finding, listed in the report)
//  - approved but expired -> "evidence expired" finding
//  - not in ledger        -> "unsupported claim" finding citing the claims policy and the regulatory packs
const { finding, citeClause, citeReg, alsoCites, clause, nonOverlapping } = require('../helpers');

const L = '(?<![\\p{L}\\p{N}])';
const R = '(?![\\p{L}\\p{N}])';
const PREFIX = "(?:(?:the|our|india['’]s|world['’]s|asia['’]s)\\s+)*";

// Order = priority. Overlapping lower-priority matches are dropped.
const PATTERNS = [
  { type: 'financial', severity: 'high', conf: 0.92, soft: '', re: new RegExp(`${L}(?:(?:guaranteed|assured|fixed)\\s+returns?|double\\s+your\\s+(?:money|investment)|risk[\\s-]free\\s+returns?|no[\\s-]risk\\s+investment|get\\s+rich)${R}`, 'giu') },
  { type: 'health', severity: 'high', conf: 0.9, soft: '', re: new RegExp(`${L}(?:cures?|treats?\\s+(?:diabetes|cancer|arthritis|acne|asthma)|clinically\\s+(?:proven|tested)|scientifically\\s+proven|dermatologist[\\s-](?:tested|approved|recommended)|miracle|doctor[\\s-]recommended|boosts?\\s+immunity|detox(?:ifies|ify)?|anti[\\s-]cancer|weight[\\s-]loss|prevents?\\s+(?:disease|covid|cancer))${R}`, 'giu') },
  { type: 'absolute', severity: 'high', conf: 0.88, soft: '', re: new RegExp(`${L}(?:guaranteed?|100\\s?%\\s?(?:safe|effective|guaranteed)|risk[\\s-]free|no\\s+side[\\s-]effects?|zero\\s+(?:risk|side[\\s-]effects?)|lifetime\\s+guarantee|100\\s?%\\s?satisfaction|instant(?:ly)?\\s+results?|works?\\s+every\\s+time|never\\s+fails?)${R}`, 'giu') },
  { type: 'comparative', severity: 'high', conf: 0.85, soft: '', re: new RegExp(`${L}(?:(?:better|cheaper|faster|stronger|healthier|tastier|safer)\\s+than\\s+(?:other|any|all|the\\s+rest|competit\\w+)(?:\\s+\\w+)?|than\\s+competitors|beats?\\s+(?:all|every|other)\\s+\\w+)${R}`, 'giu') },
  { type: 'superlative', severity: 'high', conf: 0.9, soft: 'a trusted', re: new RegExp(`${L}${PREFIX}(?:#\\s?1|no\\.?\\s?1|number[\\s-]?(?:one|1)|largest|fastest|cheapest|leading|top[\\s-]rated|unrivall?ed)${R}`, 'giu') },
  { type: 'superlative', severity: 'medium', conf: 0.7, soft: 'a great', re: new RegExp(`${L}(?<!(?:your|my|their|his|her)\\s)(?<!wish(?:es)?\\s+(?:you\\s+|everyone\\s+|all\\s+)?the\\s+very\\s)${PREFIX}(?:best[\\s-]in[\\s-]class|best|finest|ultimate|unbeatable|unmatched|world[\\s-]class|perfect)${R}(?!\\s+(?:wishes|regards|of luck))`, 'giu') },
  { type: 'award', severity: 'medium', conf: 0.75, soft: '', re: new RegExp(`${L}(?:award[\\s-]winning|(?:most|top)[\\s-]awarded|multiple[\\s-]award(?:s|ed)|as\\s+seen\\s+on\\s+tv)${R}`, 'giu') },
  { type: 'environmental', severity: 'medium', conf: 0.85, soft: '', re: new RegExp(`${L}(?:eco[\\s-]friendly|carbon[\\s-](?:neutral|negative)|planet[\\s-]friendly|100\\s?%\\s?(?:recyclable|biodegradable|sustainable)|sustainabl[ey]|zero[\\s-]waste|plastic[\\s-]free)${R}`, 'giu') },
  { type: 'natural', severity: 'medium', conf: 0.7, soft: '', re: new RegExp(`${L}(?:100\\s?%\\s?(?:natural|organic)|all[\\s-]natural|organic)${R}`, 'giu') },
  { type: 'statistic', severity: 'medium', conf: 0.75, soft: '', re: /(?<![\p{L}\p{N}])(?:\d{1,3}(?:\.\d+)?\s?%\s+(?:of|more|less|faster|cheaper|better)\b|\d+\s+out\s+of\s+\d+)/giu },
];

module.exports = function claims(ctx) {
  const policy = clause(ctx, 'claims.policy');
  const primaryReg = citeReg(ctx, 'ASCI-1');
  const source = policy ? citeClause(policy) : primaryReg;
  const result = { findings: [], supported: [] };
  if (!source) return result; // evidence-or-silence: nothing to cite, so no claim findings

  const also = alsoCites(ctx, ['ASCI-1', 'CPA-2.28', 'FSSAI-CLAIMS']).filter((c) => c !== source.code);

  let hits = [];
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(ctx.view))) hits.push({ p, m, start: m.index, end: m.index + m[0].length });
  }
  hits = nonOverlapping(hits, (h) => [h.start, h.end]).sort((a, b) => a.start - b.start);

  for (const h of hits) {
    // Match the ledger entry that overlaps THIS claim (not just anything in the same sentence).
    const hitText = h.m[0].toLowerCase();
    const ledger = ctx.claims.find((c) => { const p = c.phrase.toLowerCase(); return p.includes(hitText) || hitText.includes(p); });
    if (ledger) {
      const expired = ledger.valid_until && new Date(ledger.valid_until) < ctx.today;
      if (!expired) { result.supported.push({ text: h.m[0], type: h.p.type, ledger_id: ledger.id, evidence: ledger.evidence }); continue; }
      result.findings.push(finding({
        rule: 'claims.expired', category: 'claims', severity: 'high', confidence: 0.95,
        start: h.start, end: h.end, matched: h.m[0],
        message: `The evidence for "${ledger.phrase}" expired on ${ledger.valid_until}. Renew the evidence in the Claim Ledger or remove the claim.`,
        source: { type: 'claim_ledger', code: `CLAIM-${ledger.id}`, quote: `${ledger.phrase}: ${ledger.evidence || 'no evidence recorded'} (valid until ${ledger.valid_until})` },
        also: [source.code, ...also],
        fix: { minimal: '', balanced: '' },
      }));
      continue;
    }
    const soft = h.p.soft;
    result.findings.push(finding({
      rule: `claims.${h.p.type}`, category: 'claims', severity: h.p.severity, confidence: h.p.conf,
      start: h.start, end: h.end, matched: h.m[0],
      message: `"${h.m[0]}" is a ${h.p.type} claim with no approved evidence in the Claim Ledger. Add evidence, soften the wording, or remove it.`,
      source, also,
      fix: soft ? { minimal: soft } : { minimal: '' },
    }));
  }
  return result;
};
