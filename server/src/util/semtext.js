// Text normalisation and fuzzy token matching for the semantic layer. Everything here is offline, deterministic and free.
// normalise(): removes tricks people (or AI tools) use to slip claims past keyword rules, while keeping an index map back to
// the original text so findings still point at the exact characters the author wrote.

const ZERO_WIDTH = /[​-‏⁠﻿­‪-‮]/;
// Look-alike letters from other alphabets (Cyrillic, Greek) mapped to Latin.
const HOMOGLYPH = { 'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'һ': 'h', 'ԁ': 'd', 'ɡ': 'g', 'ο': 'o', 'α': 'a', 'ε': 'e', 'ι': 'i', 'ν': 'v', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'κ': 'k' };
const LEET = { '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't', '$': 's', '@': 'a', '!': 'i' };

function normalise(view) {
  // pass 1: 1:1 character clean-up, dropping invisible characters
  let out = [], idx = [];
  for (let i = 0; i < view.length; i++) {
    let c = view[i];
    if (ZERO_WIDTH.test(c)) continue;
    const lower = c.toLowerCase();
    c = HOMOGLYPH[lower] || (lower.length === 1 ? lower : c);
    const k = c.normalize('NFKC'); // full-width letters, ligatures
    if (k.length === 1) c = k;
    out.push(c); idx.push(i);
  }
  // pass 2: "b e s t", "g.u.a.r.a.n.t.e.e.d" -> "best", "guaranteed" (4+ single letters separated by space . - _ *)
  const s1 = out.join('');
  const keep = new Array(s1.length).fill(true);
  const re = /(?<![\p{L}\p{N}])(?:[\p{L}][ .\-_*]){3,}[\p{L}](?![\p{L}\p{N}])/gu;
  let m;
  while ((m = re.exec(s1))) for (let j = m.index; j < m.index + m[0].length; j++) if (/[ .\-_*]/.test(s1[j]) && (j - m.index) % 2 === 1) keep[j] = false;
  const o2 = [], i2 = [];
  for (let j = 0; j < s1.length; j++) if (keep[j]) { o2.push(s1[j]); i2.push(idx[j]); }
  // pass 3: leetspeak inside words that contain letters ("unb3atable", "gu4ranteed"); same length
  let s2 = o2.join('');
  s2 = s2.replace(/[\p{L}\p{N}$@!]+/gu, (w) => {
    const letters = (w.match(/\p{L}/gu) || []).length;
    if (letters < 2 || /^\d+%?$/.test(w)) return w;
    return w.replace(/[01345$@7!]/g, (ch, off) => (off === 0 && /^\d/.test(ch) && letters < 3 ? ch : LEET[ch] || ch));
  });
  return { text: s2, map: i2 };
}

// Words (letters, marks such as Devanagari vowel signs, digits). Returns tokens with their span in the normalised text.
function tokenise(text) {
  const out = [];
  const re = /[\p{L}\p{M}\p{N}]+(?:['’][\p{L}]+)?|#\d+|%/gu;
  let m;
  while ((m = re.exec(text))) out.push({ t: m[0].replace(/['’]/g, ''), start: m.index, end: m.index + m[0].length });
  return out;
}

const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'is', 'are', 'was', 'be', 'in', 'on', 'for', 'with', 'and', 'or', 'at', 'it', 'its', 'that', 'this', 'than', 'as', 'by', 'from', 'your', 'you', 'ke', 'ki', 'ka', 'hai', 'hain', 'ho', 'ek', 'mein', 'me', 'se', 'ko', 'ye', 'yeh', 'ka', 'का', 'की', 'के', 'है', 'हैं', 'में', 'से', 'को', 'यह']);

const KEEP = new Set(['number', 'water', 'butter', 'better', 'matter', 'power', 'paper', 'never', 'other', 'after', 'under', 'every', 'tower', 'flower', 'letter', 'master', 'poster', 'order', 'folder', 'leader', 'offer', 'user', 'dinner', 'summer', 'winter', 'prefer', 'answer', 'partner', 'customer', 'member', 'computer', 'discover', 'carbon', 'season', 'reason', 'organic']);
const stem = (w) => {
  if (w.length <= 3 || KEEP.has(w)) return w;
  let r = w.replace(/(ies)$/, 'y').replace(/(ing|ed|ly)$/, '').replace(/(sses)$/, 'ss');
  r = r.replace(/(est|er)$/, (m, g, off, str) => (off >= 4 ? '' : m));
  return r.replace(/(es|s)$/, (m, g, off, str) => (str.length - m.length >= 3 ? '' : m));
};
const grams = (w) => { const p = `_${w}_`; const s = new Set(); for (let i = 0; i < p.length - 2; i++) s.add(p.slice(i, i + 3)); return s; };
const gcache = new Map();
const g3 = (w) => { let g = gcache.get(w); if (!g) { g = grams(w); if (gcache.size > 20000) gcache.clear(); gcache.set(w, g); } return g; };

// Similarity of two tokens in [0,1]: 1 = same word, ~0.9 = inflection or spelling variant, 0 = different.
function tokSim(a, b) {
  if (a === b) return 1;
  if (/^\d/.test(a) || /^\d/.test(b) || a.length < 4 || b.length < 4) return 0;
  const sa = stem(a), sb = stem(b);
  if (sa === sb) return 0.95;
  if (Math.abs(a.length - b.length) > 3) return 0;
  const ga = g3(sa), gb = g3(sb);
  let common = 0;
  for (const x of ga) if (gb.has(x)) common++;
  const dice = (2 * common) / (ga.size + gb.size);
  return dice >= 0.72 ? dice : 0;
}

module.exports = { normalise, tokenise, tokSim, stem, STOP, g3 };
