// Round 3 evaluation: baseline (v2.1 rules only) vs new (semantic layer + calibration) on the dev split, the held-out test split and
// the 60-sample legacy regression set. Category-level precision/recall. Usage: node eval/r3/run.js [--verbose] [--json out.json]
process.env.NODE_ENV = 'test'; process.env.DB_DRIVER = 'memory'; process.env.SEED_DEMO = 'false';
const db = require('../../src/db');
const { seedDemo } = require('../../src/seed');
const { loadContext, analyze } = require('../../src/engine');
const gold = require('./gold-r3.json');
const legacy = require('../gold.json').map((g) => ({ id: 'L' + g.id, split: 'legacy', group: 'legacy', text: g.text, expect: [...new Set(g.expect.map((r) => ({ a11y: 'accessibility' }[r.split('.')[0]] || r.split('.')[0])))], kind: g.kind, ai: g.ai }));

async function score(orgId, samples, opts) {
  const m = { tp: 0, fp: 0, fn: 0, cleanOk: 0, cleanN: 0 }; const groups = {}; const errs = [];
  for (const s of samples) {
    const ctx = await loadContext(orgId, { body: s.text, kind: s.kind || 'text', intent: 'Evaluation', channel: 'social', ai_generated: !!s.ai, ...opts });
    const res = await analyze(ctx);
    const got = new Set(res.findings.filter((f) => !f.advisory).map((f) => f.category));
    const exp = new Set(s.expect);
    const g = groups[s.group] || (groups[s.group] = { n: 0, tp: 0, fp: 0, fn: 0 }); g.n++;
    for (const c of exp) { if (got.has(c)) { m.tp++; g.tp++; } else { m.fn++; g.fn++; errs.push(`MISSED ${c}: ${s.text}`); } }
    for (const c of got) if (!exp.has(c)) { m.fp++; g.fp++; errs.push(`EXTRA ${c}: ${s.text}`); }
    if (!exp.size) { m.cleanN++; if (!got.size) m.cleanOk++; }
  }
  const p = m.tp / (m.tp + m.fp || 1), r = m.tp / (m.tp + m.fn || 1);
  return { n: samples.length, ...m, precision: +p.toFixed(3), recall: +r.toFixed(3), f1: +(2 * p * r / (p + r || 1)).toFixed(3), groups, errs };
}

async function main() {
  await db.connect(); const { orgId } = await seedDemo();
  const only = (process.argv.find((a) => a.startsWith('--splits=')) || '').slice(9);
  const sets = { 'legacy (60, regression)': legacy, 'dev (tuned on)': gold.filter((g) => g.split === 'dev'), 'TEST (held-out)': gold.filter((g) => g.split === 'test') };
  const out = {};
  for (const [name, samples] of Object.entries(sets)) {
    if (only && !only.split(',').some((x) => name.toLowerCase().startsWith(x))) continue;
    out[name] = { baseline: await score(orgId, samples, { useSemantic: false, useCalibration: false }), new: await score(orgId, samples, {}) };
  }
  return out;
}
const pct = (x) => (x * 100).toFixed(1) + '%';
if (require.main === module) {
  main().then((o) => {
    const verbose = process.argv.includes('--verbose');
    console.log('| Set | Samples | Baseline P | Baseline R | New P | New R | Baseline F1 | New F1 |\n|---|---|---|---|---|---|---|---|');
    for (const [k, v] of Object.entries(o)) console.log(`| ${k} | ${v.new.n} | ${pct(v.baseline.precision)} | ${pct(v.baseline.recall)} | ${pct(v.new.precision)} | ${pct(v.new.recall)} | ${v.baseline.f1} | ${v.new.f1} |`);
    const t = o['TEST (held-out)']; if (!t) { if (verbose) for (const [k, v] of Object.entries(o)) { console.log(`\n== ${k}: remaining errors (new)`); v.new.errs.forEach((e) => console.log('  ' + e)); } process.exit(0); }
    console.log('\nTEST by group (recall/precision counts: tp fp fn) baseline -> new');
    for (const g of Object.keys(t.new.groups)) { const a = t.baseline.groups[g], b = t.new.groups[g]; console.log(`  ${g.padEnd(20)} n=${String(b.n).padEnd(3)} base tp${a.tp} fp${a.fp} fn${a.fn}  ->  new tp${b.tp} fp${b.fp} fn${b.fn}`); }
    const cl = (k) => `${k.cleanOk}/${k.cleanN}`;
    console.log(`\nClean samples passing (no finding): baseline ${cl(t.baseline)} -> new ${cl(t.new)}`);
    if (verbose) for (const [k, v] of Object.entries(o)) { console.log(`\n== ${k}: remaining errors (new)`); v.new.errs.forEach((e) => console.log('  ' + e)); }
    const jf = process.argv.indexOf('--json'); if (jf > 0) require('fs').writeFileSync(process.argv[jf + 1], JSON.stringify(o, null, 1));
    process.exit(0);
  }).catch((e) => { console.error(e); process.exit(1); });
}
module.exports = { main };
