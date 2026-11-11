// Flesch-Kincaid grade level (English / Latin script). Heuristic syllable counter, no paid API.
function syllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const m = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '').match(/[aeiouy]{1,2}/g);
  return Math.max(1, m ? m.length : 1);
}

function fleschKincaid(text) {
  const sents = text.split(/[.!?]+/).filter((s) => /[A-Za-z]/.test(s));
  const words = text.match(/[A-Za-z']+/g) || [];
  if (words.length < 30 || !sents.length) return null; // too short to judge
  const syl = words.reduce((n, w) => n + syllables(w), 0);
  const grade = 0.39 * (words.length / sents.length) + 11.8 * (syl / words.length) - 15.59;
  return Math.round(grade * 10) / 10;
}

module.exports = { fleschKincaid, syllables };
