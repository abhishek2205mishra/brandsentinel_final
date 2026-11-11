// Tiny BM25 retriever: free, offline replacement for paid embedding APIs.
// Used to find the guideline clauses most relevant to a piece of content (and to ground the optional LLM).
const { contentWords } = require('./text');

function buildIndex(docs) {
  const N = docs.length || 1;
  const toks = docs.map((d) => contentWords(d.text));
  const df = new Map();
  toks.forEach((t) => new Set(t).forEach((w) => df.set(w, (df.get(w) || 0) + 1)));
  const avgdl = toks.reduce((n, t) => n + t.length, 0) / N || 1;
  return { docs, toks, df, avgdl, N };
}

function search(index, query, k = 5) {
  const q = contentWords(query);
  const k1 = 1.4, b = 0.75;
  const scores = index.docs.map((doc, i) => {
    const t = index.toks[i];
    const tf = new Map();
    t.forEach((w) => tf.set(w, (tf.get(w) || 0) + 1));
    let s = 0;
    for (const w of new Set(q)) {
      const f = tf.get(w);
      if (!f) continue;
      const n = index.df.get(w) || 0;
      const idf = Math.log(1 + (index.N - n + 0.5) / (n + 0.5));
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * t.length) / index.avgdl)));
    }
    return { doc, score: s };
  });
  return scores.filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
}

module.exports = { buildIndex, search };
