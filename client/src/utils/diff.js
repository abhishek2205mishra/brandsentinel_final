// Word-level diff (longest common subsequence) used for the revision-history comparison view.
export function diffWords(a, b) {
  const x = a.split(/(\s+)/).filter((t) => t !== '');
  const y = b.split(/(\s+)/).filter((t) => t !== '');
  const n = x.length, m = y.length;
  if (n * m > 4_000_000) return [{ t: 'del', v: a }, { t: 'ins', v: b }]; // too large for a fine-grained diff
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  const push = (t, v) => { const last = out[out.length - 1]; if (last && last.t === t) last.v += v; else out.push({ t, v }); };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { push('eq', x[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) push('del', x[i++]);
    else push('ins', y[j++]);
  }
  while (i < n) push('del', x[i++]);
  while (j < m) push('ins', y[j++]);
  return out;
}
