// Demo data: a fictional brand ("NovaBrew Coffee"), seven demo users and a realistic spread of content in every workflow state.
// Run:  npm run seed            (only seeds an empty database)
//       npm run seed -- --reset (wipes everything and reseeds)
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('./db');
const { seedRegs, seedStarter, seedDemoBrand, DEFAULT_SETTINGS, dayOffset } = require('./seedData');
const config = require('./config');
const llm = require('./engine/llm');
const items = require('./services/items');
const workflow = require('./services/workflow');

const PASSWORD = 'Demo@1234';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmt = (offset) => { const d = new Date(Date.now() + offset * 86400000); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };

async function reset() { await db.clearAll(); }

const HTML_NEWSLETTER = `<html>
<body style="font-family: 'Comic Sans MS', cursive; color:#333">
<h1>Winter at NovaBrew</h1>
<h3 style="color:#E91E63">Warm up with our festive blend</h3>
<p style="color:#bbbbbb">Our new roast is the best coffee you will taste this winter, and it is better than other brands.</p>
<img src="https://example.com/hero.jpg">
<img src="https://example.com/logo.png" alt="NovaBrew logo" width="300" height="200">
<p><a href="https://novabrew.test/winter">Click here</a> to see the festive menu.</p>
</body>
</html>`;

function specs() {
  return [
    { title: 'Festive launch caption', author: 'creator', channel: 'social', kind: 'text', intent: 'Announce the new roast and the festive offer',
      body: "Our new roast is India's #1 coffee, now 30% off this festive offer! Don't miss out!!! Visit Nova Brew today.", age: 1, flow: ['submit'] },
    { title: 'Diwali offer post (fixed from suggestions)', author: 'creator', channel: 'social', kind: 'text', intent: 'Announce the festive offer on whole-bean packs',
      body: `Our artisanal festive roast is here! Enjoy a festive offer of 25% off whole-bean packs until ${fmt(10)}. Hurry!!`, age: 6, flow: ['fix', 'submit', 'approve:reviewer'] },
    { title: 'Winter newsletter email', author: 'kabir', channel: 'email', kind: 'html', intent: 'Invite subscribers to try the winter blend',
      body: HTML_NEWSLETTER, age: 3, flow: ['submit', 'changes:reviewer:Please fix the colours, fonts, logo ratio and add alt text before we can send this.'] },
    { title: 'Blog: why small-batch matters', author: 'kabir', channel: 'blog', kind: 'markdown', intent: 'Explain why small-batch roasting tastes better', ai: true, aiTool: 'ChatGPT',
      body: "# Why small-batch matters\n\nIn today's fast-paced world, coffee lovers want something real. Let's delve into the craft behind every cup, because small-batch roasting is a game-changer for flavour and the roaster controls every single variable from the first crack through to the cooling tray and the final cupping session before packing.\n\n![](https://example.com/roaster.jpg)\n\n[Click here](https://novabrew.test/roasting) to learn more.", age: 2, flow: [] },
    { title: 'Hindi festive caption', author: 'creator', channel: 'social', kind: 'text', intent: 'Wish customers a happy festive season',
      body: 'इस त्योहार पर NovaBrew की सस्ता और स्वादिष्ट कॉफ़ी का आनंद लें। festive offer पर 20% की छूट।', age: 4, flow: [] },
    { title: 'Winter campaign copy (agency)', author: 'agency', channel: 'paid-ad', kind: 'text', intent: 'Promote winter delivery and our sustainability',
      body: 'NovaBrew is carbon neutral and sustainably sourced. Get free shipping above ₹399 and free delivery on your first order. Our 250g pack is only ₹299.', age: 2, flow: ['submit'] },
    { title: 'Press note: wellness claims', author: 'agency', channel: 'press-release', kind: 'text', intent: 'Announce a wellness-focused blend',
      body: 'Our new blend is clinically proven to boost immunity and guaranteed to cure fatigue. It is better than other brands and gives 100% natural energy.', age: 9, flow: ['submit', 'reject:approver:These health claims have no evidence. Please rewrite with legal review.'] },
    { title: 'Weekend brew guide', author: 'creator', channel: 'social', kind: 'text', intent: 'Share a simple weekend brewing tip',
      body: 'Slow Saturday mornings call for a gentle pour-over. Grind fresh, use water just off the boil and enjoy the quiet. #CoffeeMoments', age: 12, flow: ['submit', 'approve:reviewer'] },
    { title: 'Leaf Green blend launch', author: 'kabir', channel: 'social', kind: 'text', intent: 'Introduce the Leaf Green blend and price',
      body: 'Meet the Leaf Green blend: sustainably sourced and roasted in small batches. The 250g bag costs ₹349. A gentle start to your morning.', age: 14, flow: ['submit', 'approve:reviewer'] },
    { title: 'Cheap and cheerful Friday offer', author: 'creator', channel: 'social', kind: 'text', intent: 'Promote Friday coffee deal',
      body: 'Cheap coffee every Friday!! Bring a friend and share the joy!', age: 16, flow: ['dismiss:tone.exclaim:Friday posts are meant to be playful', 'submit', 'changes:reviewer:Please remove the word cheap.'] },
    { title: 'Midweek reel script', author: 'kabir', channel: 'social', kind: 'text', intent: 'Invite people to try our midweek reel contest',
      body: 'Join the reel contest!! Tell us your best brew story!! We cannot wait to hear it!', age: 18, flow: ['dismiss:tone.exclaim:Contest posts need more energy', 'submit', 'approve:reviewer'] },
    { title: 'New-year hashtag post', author: 'creator', channel: 'social', kind: 'text', intent: 'Start the new year with NovaBrew',
      body: 'Start the year slowly with a warm cup. #newyearnewcoffee #slowmornings', age: 20, flow: ['dismiss:a11y.hashtag:Hashtag is a campaign tag we already own', 'submit', 'approve:reviewer'] },
    { title: 'Cheap beans explainer', author: 'creator', channel: 'blog', kind: 'text', intent: 'Explain how we keep prices fair',
      body: 'We keep prices fair without cutting corners. Many people ask why our coffee is not cheap, and the answer is simple: we pay farmers well.', age: 22, flow: [] },
    { title: 'Coffee addicts welcome', author: 'kabir', channel: 'social', kind: 'text', intent: 'Welcome new followers',
      body: 'Welcome, coffee addicts! Our small-batch roasts are made for you.', age: 25, flow: [] },
  ];
}

async function seedDemo() {
  await seedRegs();
  const llmOn = llm.providerInfo().configured;
  const orgId = await db.insert('orgs', { name: 'NovaBrew Coffee', api_key: 'bs_demo_' + crypto.randomBytes(12).toString('hex'), settings: JSON.stringify({ ...DEFAULT_SETTINGS, llm: { ...DEFAULT_SETTINGS.llm, enabled: llmOn }, confidential_terms: ['Project Aurora'] }), created_at: db.now() });
  await seedStarter(orgId);
  await seedDemoBrand(orgId);

  const hash = await bcrypt.hash(PASSWORD, 10);
  const mk = async (key, name, role) => {
    const id = await db.insert('users', { org_id: orgId, email: `${key}@novabrew.test`, name, password_hash: hash, role, created_at: db.now() });
    return { id, org_id: orgId, name, role, email: `${key}@novabrew.test` };
  };
  const U = {
    admin: await mk('admin', 'Asha Admin', 'admin'), creator: await mk('creator', 'Riya Creator', 'creator'), kabir: await mk('kabir', 'Kabir Writer', 'creator'),
    reviewer: await mk('reviewer', 'Rahul Reviewer', 'reviewer'), approver: await mk('approver', 'Meera Approver', 'approver'),
    agency: await mk('agency', 'Studio Agency', 'agency'), auditor: await mk('auditor', 'Anil Auditor', 'auditor'),
  };
  // Round 3: the "legal" group and one ready-made approval workflow, so the demo shows configurable chains from the first minute.
  await db.update('users', U.reviewer.id, { groups: ['legal'] });
  await db.update('users', U.approver.id, { groups: ['legal'] });
  await db.insert('workflows', {
    org_id: orgId, name: 'Health claims: legal review, then brand approver', description: 'Any health claim goes to the legal group first, then to an approver.', active: 1, priority: 90,
    match: JSON.stringify({ channels: [], risks: [], claim_types: ['health'], categories: [], ai_generated: false }),
    steps: JSON.stringify([
      { name: 'Legal review', assignee_role: 'reviewer', assignee_group: 'legal', min_approvals: 1, sla_hours: 24, escalate_role: 'approver', escalate_group: '' },
      { name: 'Brand approver sign-off', assignee_role: 'approver', assignee_group: '', min_approvals: 1, sla_hours: 24, escalate_role: 'admin', escalate_group: '' },
    ]),
    created_by: U.admin.id, created_at: db.now(), updated_at: db.now(),
  });
  let firstItemId = null;

  for (const s of specs()) {
    const author = U[s.author];
    let item = await items.createItem({ orgId, user: author, title: s.title, channel: s.channel, kind: s.kind, intent: s.intent, body: s.body, ai_generated: !!s.ai, ai_tool: s.aiTool || null });
    if (!firstItemId) firstItemId = item.id;
    const fresh = () => db.get('items', item.id);
    for (const step of s.flow) {
      item = await fresh();
      const [op, a, b] = step.split(':');
      if (op === 'fix') {
        for (let i = 0; i < 12; i++) {
          const f = (await db.find('findings', { item_id: item.id, version_n: item.current_version, status: 'open', advisory: 0 }, { sort: { id: 1 } })).find((x) => JSON.parse(x.suggestions).length);
          if (!f) break;
          item = await items.applyFinding(await fresh(), f, author, { level: 'minimal' });
        }
      } else if (op === 'submit') await workflow.submit(await fresh(), author);
      else if (op === 'dismiss') {
        for (const f of await db.find('findings', { item_id: item.id, version_n: item.current_version, rule: a, status: 'open' })) await items.dismissFinding(await fresh(), f, author, b);
      } else if (op === 'approve') {
        const who = U[a];
        try { await workflow.decide(await fresh(), who, { decision: 'approve', override_reason: 'Reviewed manually; acceptable for this channel.' }); } catch (e) { /* ignore */ }
        if ((await fresh()).status === 'submitted') { try { await workflow.decide(await fresh(), U.approver, { decision: 'approve', override_reason: 'Approved after review.' }); } catch (e) { /* ignore */ } }
      } else if (op === 'changes') await workflow.decide(await fresh(), U[a], { decision: 'request_changes', reason: b });
      else if (op === 'reject') await workflow.decide(await fresh(), U[a], { decision: 'reject', reason: b });
    }
    // Spread timestamps over the past weeks so trend charts look realistic (the audit log keeps true times so its hash chain stays valid).
    const shift = (t, days, hours = 0) => new Date(new Date(t).getTime() - days * 86400000 + hours * 3600000).toISOString();
    const jobs = [['items', { id: item.id }, 'created_at'], ['items', { id: item.id }, 'updated_at'], ['versions', { item_id: item.id }, 'created_at'], ['findings', { item_id: item.id }, 'created_at']];
    for (const [coll, filter, col] of jobs) {
      for (const r of await db.find(coll, filter)) await db.update(coll, { id: r.id }, { [col]: shift(r[col], s.age) });
    }
    for (const r of await db.find('finding_events', { item_id: item.id })) await db.update('finding_events', { id: r.id }, { ts: shift(r.ts, s.age, 3) });
    for (const r of await db.find('decisions', { item_id: item.id })) await db.update('decisions', { id: r.id }, { created_at: shift(r.created_at, s.age, 6 + (item.id % 20)) });
  }

  await db.insert('comments', { item_id: firstItemId, author_id: U.reviewer.id, body: 'The "#1" claim needs evidence from marketing before this can go out. @creator can you share the source?', created_at: db.now() });
  await db.insert('comments', { item_id: firstItemId, author_id: U.creator.id, body: 'I will ask for the ranking report. For now I will remove the claim.', created_at: db.now() });
  return { orgId, users: Object.values(U).map((u) => u.email), password: PASSWORD };
}

async function main() {
  config.validate();
  await db.connect();
  if (process.argv.includes('--reset')) await reset();
  if ((await db.count('orgs')) > 0) { console.log('Database already has data. Use "npm run seed -- --reset" to wipe and reseed.'); return; }
  const r = await seedDemo();
  console.log(`Seeded demo organisation #${r.orgId}. Sign in with any of these (password ${r.password}):\n  ${r.users.join('\n  ')}`);
}

if (require.main === module) main().then(() => db.close()).then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
module.exports = { seedDemo, PASSWORD };
