// Redacts secrets and personal data before anything is sent to an optional LLM.
// Rule-based checks always run locally on the original text; only redacted text may leave the rules engine.
const PATTERNS = [
  ['EMAIL', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ['PHONE', /(?<!\d)(?:\+?\d{1,3}[\s-]?)?(?:\d[\s-]?){9,11}\d(?!\d)/g],
  ['CARD', /\b(?:\d[ -]?){13,16}\b/g],
  ['API_KEY', /\b(?:sk|pk|rk|AKIA|ghp|xox[baprs])[-_A-Za-z0-9]{16,}\b/g],
  ['AADHAAR', /\b\d{4}\s\d{4}\s\d{4}\b/g],
  ['PAN', /\b[A-Z]{5}\d{4}[A-Z]\b/g],
];

function redact(text, confidentialTerms = []) {
  let count = 0;
  let out = text;
  for (const [label, re] of PATTERNS) {
    out = out.replace(re, () => { count++; return `[${label}]`; });
  }
  for (const t of confidentialTerms.filter(Boolean)) {
    const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    out = out.replace(re, () => { count++; return '[CONFIDENTIAL]'; });
  }
  return { text: out, count };
}

module.exports = { redact };
