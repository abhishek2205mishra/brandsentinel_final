const crypto = require('crypto');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Unicode-aware "whole word" matcher (works for Hindi/Marathi too, unlike \b).
function termRegex(term, flags = 'giu') {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(term.trim()).replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}_])`, flags);
}

// Keep HTML offsets intact: blank out tags/scripts with spaces of the same length,
// so text rules can run on the visible text while offsets still map to the original HTML.
function visibleText(body, isHtml) {
  const blank = (m) => ' '.repeat(m.length);
  let out = body;
  if (isHtml) {
    out = out.replace(/<(script|style)[\s\S]*?<\/\1>/gi, blank).replace(/<!--[\s\S]*?-->/g, blank).replace(/<[^>]*>/g, blank);
  }
  // URLs and email addresses are not prose: never check brand names, tone or claims inside them.
  return out.replace(/(?:https?:\/\/|www\.)[^\s)>\]"']+/gi, blank).replace(/(?<![\w@.-])(?:[A-Za-z0-9-]+\.)+(?:com|in|org|net|co|io|app|shop|store|test|dev|ai)(?![\p{L}\p{N}-])(?:\/[^\s)>\]"']*)?/gu, blank).replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, blank);
}

const hasDevanagari = (s) => /[ऀ-ॿ]/.test(s);
const detectLang = (s) => {
  const dev = (s.match(/[ऀ-ॿ]/g) || []).length;
  const lat = (s.match(/[A-Za-z]/g) || []).length;
  if (dev > 0 && lat > 0) return 'mixed';
  return dev > 0 ? 'hi' : 'en';
};

function sentences(text) {
  const out = [];
  const re = /[^.!?\n।]+[.!?।]*/g;
  let m;
  while ((m = re.exec(text))) {
    const t = m[0];
    if (t.trim().length) out.push({ text: t, start: m.index, end: m.index + t.length });
  }
  return out;
}

const STOP = new Set('a an and are as at be been but by for from has have in is it its of on or our so that the their them then there these they this to was we were will with you your us now new get'.split(' '));
const tokens = (s) => (s.toLowerCase().replace(/’/g, "'").match(/[\p{L}\p{N}%₹#.']+/gu) || []).map((t) => t.replace(/^[.'#]+|[.']+$/g, '')).filter(Boolean);
const contentWords = (s) => tokens(s).filter((t) => t.length > 2 && !STOP.has(t));

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// Case-preserving replacement helper.
function matchCase(src, repl) {
  if (!repl) return repl;
  if (src === src.toUpperCase() && src.length > 1) return repl.toUpperCase();
  if (src[0] && src[0] === src[0].toUpperCase() && src[0] !== src[0].toLowerCase()) return repl[0].toUpperCase() + repl.slice(1);
  return repl;
}

module.exports = { sha256, escapeRe, termRegex, visibleText, hasDevanagari, detectLang, sentences, tokens, contentWords, MONTHS, matchCase, STOP };
