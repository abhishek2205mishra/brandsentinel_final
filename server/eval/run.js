// Evaluation: runs the engine over a labelled gold set and reports precision / recall per rule family.
// Usage: npm run eval   (exits non-zero if quality drops below the thresholds)
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.DB_DRIVER = process.env.DB_DRIVER || 'memory';
process.env.SEED_DEMO = 'false';
const gold = require('./gold.json');
const db = require('../src/db');
const { seedDemo } = require('../src/seed');
const { loadContext, analyze } = require('../src/engine');

async function evaluate({ verbose = true } = {}) {
  await db.connect();
  const { orgId } = await seedDemo();
  let tp = 0, fp = 0, fn = 0, cleanOk = 0, cleanTotal = 0;
  const misses = [];
  for (const g of gold) {
    const ctx = await loadContext(orgId, { body: g.text, kind: g.kind || 'text', intent: 'Evaluation sample', channel: 'social', ai_generated: !!g.ai });
    const res = await analyze(ctx);
    const got = new Set(res.findings.filter((f) => !f.advisory).map((f) => f.rule));
    const exp = new Set(g.expect);
    for (const r of exp) (got.has(r) ? tp++ : (fn++, misses.push(`#${g.id} MISSED ${r}`)));
    for (const r of got) if (!exp.has(r)) { fp++; misses.push(`#${g.id} EXTRA  ${r}  (${g.text.slice(0, 50)})`); }
    if (!exp.size) { cleanTotal++; if (!got.size) cleanOk++; }
  }
  const precision = tp / (tp + fp || 1), recall = tp / (tp + fn || 1);
  const out = { samples: gold.length, tp, fp, fn, precision: +precision.toFixed(3), recall: +recall.toFixed(3), clean_pass: `${cleanOk}/${cleanTotal}`, misses };
  if (verbose) { console.log(JSON.stringify({ ...out, misses: undefined }, null, 2)); misses.forEach((m) => console.log('  ' + m)); }
  return out;
}

if (require.main === module) {
  evaluate().then((r) => { if (r.precision < 0.85 || r.recall < 0.8) { console.error('Quality below threshold (precision >= 0.85, recall >= 0.80).'); process.exit(1); } process.exit(0); });
}
module.exports = { evaluate };
