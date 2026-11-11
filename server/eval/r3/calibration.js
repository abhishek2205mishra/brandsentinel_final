// Calibration experiment (simulated reviewer feedback). Org A's reviewers dismiss "hype" tone findings 9 times in 10 but accept claim findings.
// Measures how many hype findings still reach creators as live warnings before/after learning, and that claim findings are never demoted.
process.env.NODE_ENV = 'test'; process.env.DB_DRIVER = 'memory'; process.env.SEED_DEMO = 'false';
const db = require('../../src/db'); const { seedDemo } = require('../../src/seed');
const { loadContext, analyze } = require('../../src/engine'); const calibration = require('../../src/services/calibration');
const TEXTS = ['Hurry, grab it now!', 'Act now, only today.', 'Mind-blowing roast, last chance to buy.', 'Our unbeatable roast boosts immunity.', 'A mind-blowing amazing deal on cold brew.'];
async function live(orgId, rule) {
  let n = 0, conf = 0, c = 0;
  for (const t of TEXTS) { const r = await analyze(await loadContext(orgId, { body: t, channel: 'social' })); for (const f of r.findings.filter((x) => x.rule.startsWith(rule))) { c++; conf += f.confidence; if (!f.advisory && f.severity !== 'info') n++; } }
  return { live: n, total: c, avg_conf: c ? +(conf / c).toFixed(2) : null };
}
(async () => {
  await db.connect(); const { orgId } = await seedDemo();
  const before = { hype: await live(orgId, 'tone.hype'), claims: await live(orgId, 'claims.') };
  const steps = [0, 5, 10, 20, 40]; const rows = [];
  let done = 0;
  for (const n of steps) {
    while (done < n) { // 9 dismissals : 1 accept
      const act = done % 10 === 9 ? 'accepted' : 'dismissed';
      await db.insert('finding_events', { org_id: orgId, item_id: 1, clause_code: 'VOICE-3', category: 'tone', rule: 'tone.hype', action: act, user_id: 1, ts: db.now() });
      await db.insert('finding_events', { org_id: orgId, item_id: 1, clause_code: 'CLAIM-1', category: 'claims', rule: 'claims.superlative', action: 'dismissed', user_id: 1, ts: db.now() });
      done++; }
    calibration.invalidate(orgId);
    rows.push({ feedback_events: n, hype: await live(orgId, 'tone.hype'), claims: await live(orgId, 'claims.') });
  }
  console.log('Simulated feedback: tone.hype dismissed ~90%; claims.superlative ALSO dismissed 100% (to test the safety rail)\n');
  console.log('| Feedback events | Hype findings shown as live warnings | Hype avg confidence | Claim findings shown live | Claim avg confidence |\n|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.feedback_events} | ${r.hype.live}/${r.hype.total} | ${r.hype.avg_conf} | ${r.claims.live}/${r.claims.total} | ${r.claims.avg_conf} |`);
  const s = await calibration.summary(orgId); console.log('\nLearned table:'); s.rows.forEach((r) => console.log(`  ${r.rule} | ${r.clause} | pos ${r.pos} neg ${r.neg} p=${r.p} ${r.state}${r.protected ? ' (protected)' : ''}`));
  const last = rows[rows.length - 1];
  process.exit(last.claims.live === before.claims.live && last.hype.live < before.hype.live ? 0 : 1);
})();
