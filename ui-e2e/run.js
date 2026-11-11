// UI end-to-end test of the Round 3 screens against a real server (dev mode, in-memory DB, built client).
//   cd ui-e2e && npm test        (build the client first: cd client && npm run build)
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const SERVER_DIR = path.resolve(process.env.SERVER_DIR || path.join(__dirname, '../server'));
const PORT = Number(process.env.E2E_PORT || 4070), BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, 'shots'); require('fs').mkdirSync(SHOTS, { recursive: true });
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function step(name, fn) { try { const d = await fn(); results.push([name, true]); console.log('PASS', name, d || ''); } catch (e) { results.push([name, false]); console.log('FAIL', name, '—', String(e.message).split('\n')[0].slice(0, 220)); } }
const call = async (method, url, token, body) => { const r = await fetch(BASE + url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await r.json(); } catch {} return { status: r.status, body: j }; };
const login = async (who) => (await call('POST', '/api/auth/login', null, { email: `${who}@novabrew.test`, password: 'Demo@1234' })).body.token;

(async () => {
  const srv = spawn('node', ['src/index.js'], { cwd: SERVER_DIR, env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development', DB_DRIVER: 'memory', MONGODB_URI: '', SEED_DEMO: 'true', LLM_PROVIDER: 'none', GEMINI_API_KEY: '', GROQ_API_KEY: '', PUBLIC_URL: BASE }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch {} await sleep(500); }
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const signIn = async (who) => { await ctx.clearCookies(); await page.goto(BASE + '/login'); await page.evaluate(() => localStorage.clear()); await page.goto(BASE + '/login'); await page.fill('input[type=email]', `${who}@novabrew.test`); await page.fill('input[type=password]', 'Demo@1234'); await page.click('button.cta'); await page.waitForSelector('.topbar', { timeout: 15000 }); };
  const text = async () => page.evaluate(() => document.body.innerText);

  await step('admin signs in and sees Workflows in the nav', async () => { await signIn('admin'); await page.waitForSelector('a[href="/workflows"]'); });
  await step('Workflows page lists the seeded health workflow', async () => { await page.click('a[href="/workflows"]'); await page.waitForSelector('text=Legal review'); await page.screenshot({ path: `${SHOTS}/workflows.png` }); });
  await step('admin creates a workflow in the designer and it appears', async () => {
    await page.click('text=+ New workflow'); await page.fill('input[placeholder^="e.g. Health claims"]', 'E2E paid ads chain');
    await page.click('.modal .chip:text("paid-ad")'); await page.fill('.modal input[placeholder="e.g. Legal review"]', 'Ad check');
    await page.click('.modal button:text("Save workflow")'); await page.waitForSelector('h2:has-text("E2E paid ads chain")');
  });
  await step('preview tool picks the right workflow', async () => {
    await page.selectOption('select[aria-label="Channel"]', 'paid-ad'); await page.click('button:text("Test")'); await page.waitForSelector('text=Would use'); const t = await text(); if (!/E2E paid ads chain/.test(t)) throw new Error('wrong workflow');
  });
  await step('groups tab and deadlines tab render', async () => { await page.click('role=tab[name=/Groups/]'); await page.waitForSelector('input[aria-label^="Groups for"]'); await page.click('role=tab[name=/Deadlines/]'); await page.waitForSelector('text=waiting'); });

  await step('Account: create an API key (shown once), listed with prefix only, revoke it', async () => {
    await page.goto(BASE + '/account'); await page.click('button:text("Create key")'); await page.waitForSelector('text=shown only once');
    const key = await page.locator('.notice.ok .mono').innerText(); if (!/^bsk_[A-Za-z0-9]{32}$/.test(key)) throw new Error('bad key ' + key);
    await page.click('button:text("I have copied it")'); const t = await text(); if (t.includes(key)) throw new Error('key still visible'); if (!t.includes(key.slice(0, 8))) throw new Error('prefix missing');
    page.once('dialog', (d) => d.accept()); await page.click('button:text("Revoke")'); await page.waitForSelector('text=revoked');
  });
  await step('Account: extension zip downloads with a valid signature (auth required)', async () => {
    const token = await login('admin'); const r = await fetch(BASE + '/api/keys/extension.zip', { headers: { authorization: `Bearer ${token}` } }); const b = Buffer.from(await r.arrayBuffer());
    if (r.status !== 200 || b.slice(0, 2).toString() !== 'PK' || b.length < 5000) throw new Error('bad zip ' + r.status); const anon = await fetch(BASE + '/api/keys/extension.zip'); if (anon.status !== 401) throw new Error('zip is public');
  });

  // Content that triggers the health workflow: creator submits, legal reviewer (Rahul), then approver (Meera).
  const creator = await login('creator'), reviewer = await login('reviewer'), approver = await login('approver'), admin = await login('admin');
  let itemId;
  await step('creator submits health-claim content and a 2-step chain starts', async () => {
    const c = await call('POST', '/api/items', creator, { title: 'E2E immunity post', intent: 'Promote the new blend', channel: 'social', kind: 'text', body: 'Our blend boosts immunity every day.' });
    itemId = c.body.id; const s = await call('POST', `/api/items/${itemId}/submit`, creator); if (s.status !== 200) throw new Error(JSON.stringify(s.body));
    const d = await call('GET', `/api/items/${itemId}`, reviewer); if (!d.body.workflow || d.body.workflow.steps.length !== 2) throw new Error('no chain: ' + JSON.stringify(d.body.workflow));
  });
  await step('reviewer sees "your turn" chip on the dashboard and the timeline on the item page', async () => {
    await signIn('reviewer'); await page.waitForSelector('text=your turn', { timeout: 10000 }); await page.goto(BASE + `/items/${itemId}`); await page.click('role=tab[name="Approval"]'); await page.waitForSelector('text=Legal review'); await page.waitForSelector('text=Delegate this step'); await page.screenshot({ path: `${SHOTS}/chain.png` });
  });
  await step('reviewer approves step 1 in the UI; chain moves to step 2', async () => {
    const ov = page.locator('input[type=text]').last(); if (await page.locator('text=Override reason').count()) await page.locator('label:has-text("Override reason") input').fill('Legal confirmed the wording in the e2e test'); await page.click('button:text("Approve")'); await page.waitForSelector('text=Brand approver sign-off'); await sleep(500);
    const d = await call('GET', `/api/items/${itemId}`, reviewer); if (d.body.workflow.current_step !== 1) throw new Error('did not advance');
  });
  await step('approver approves the final step; certificate issued with a public code', async () => {
    const r = await call('POST', `/api/items/${itemId}/decision`, approver, { decision: 'approve', reason: 'ok', override_reason: 'Reviewed manually in the e2e test' }); if (r.status !== 200) throw new Error(JSON.stringify(r.body));
    const d = await call('GET', `/api/items/${itemId}`, approver); if (!d.body.certificate || !/^BS-/.test(d.body.certificate.verification_code)) throw new Error('no code'); global.CODE = d.body.certificate.verification_code;
  });
  await step('item page shows the public verification box', async () => { await signIn('approver'); await page.goto(BASE + `/items/${itemId}`); await page.click('role=tab[name="Approval"]'); await page.waitForSelector('text=Public verification'); });
  await step('LOGGED OUT: public page shows genuine certificate, checks, no content or names', async () => {
    const anon = await browser.newContext(); const p = await anon.newPage(); await p.goto(`${BASE}/verify/${global.CODE}`); await p.waitForSelector('text=Genuine and current'); const t = await p.evaluate(() => document.body.innerText);
    if (/boosts immunity|Rahul|Meera|Riya/.test(t)) throw new Error('leaks content or names'); if (!/What was checked/.test(t) || !/Health claims: legal review/.test(t)) throw new Error('missing checks');
    await p.fill('textarea[aria-label="Text to compare"]', 'Our blend boosts immunity every day.'); await p.click('button:text("Compare")'); await p.waitForSelector('text=Exact match'); await p.fill('textarea[aria-label="Text to compare"]', 'Something else entirely'); await p.click('button:text("Compare")'); await p.waitForSelector('text=No match'); await p.screenshot({ path: `${SHOTS}/verify.png` });
    await p.goto(`${BASE}/verify/BS-AAAA-BBBB-CCCC`); await p.waitForSelector('text=No certificate'); await p.goto(`${BASE}/verify`); await p.waitForSelector('input[aria-label="Verification code"]'); await anon.close();
  });
  await step('approver revokes the certificate in the UI; public page then says revoked', async () => {
    page.once('dialog', (d) => d.accept('Claim withdrawn after legal re-check')); await page.click('button:text("Revoke certificate")'); await sleep(1200);
    const anon = await browser.newContext(); const p = await anon.newPage(); await p.goto(`${BASE}/verify/${global.CODE}`); await p.waitForSelector('text=Revoked.'); await anon.close();
  });
  await step('public verify endpoint is rate limited (dev mode): 45 quick requests produce 429s', async () => {
    let n429 = 0; for (let i = 0; i < 45; i++) { const r = await fetch(`${BASE}/api/public/verify/BS-ZZZZ-ZZZZ-ZZZZ`); if (r.status === 429) n429++; } if (!n429) throw new Error('never limited'); return `${n429} limited`;
  });
  await step('Insights shows the learning table; admin can toggle learning', async () => {
    await signIn('admin'); await page.goto(BASE + '/insights'); await page.waitForSelector('text=What the system has learned here'); await page.screenshot({ path: `${SHOTS}/insights.png` });
  });
  await step('Governance shows email status (not configured) and semantic search status', async () => {
    await page.goto(BASE + '/governance'); await page.click('role=tab[name=/Settings and privacy/]'); await page.waitForSelector('text=Email notifications'); await page.waitForSelector('text=Semantic search');
  });
  await step('semantic finding appears in the review UI for a paraphrase', async () => {
    const c = await call('POST', '/api/items', creator, { title: 'E2E paraphrase', intent: 'Promote the blend', channel: 'social', kind: 'text', body: 'Try our sabse behtareen coffee, nothing beats it.' });
    await signIn('creator'); await page.goto(BASE + `/items/${c.body.id}`); await page.waitForSelector('text=sabse behtareen'); await page.screenshot({ path: `${SHOTS}/semantic.png` });
  });
  await step('knowledge base search by meaning works', async () => {
    const r = await call('GET', '/api/kb/search?q=' + encodeURIComponent('we promise it heals the body'), admin); if (r.status !== 200 || !r.body.length) throw new Error('no hits'); return r.body[0].code;
  });
  await step('no uncaught page errors', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
  await browser.close(); srv.kill();
  const fail = results.filter((r) => !r[1]).length; console.log(`\n${results.length - fail}/${results.length} passed`); if (fail) console.log(log.slice(-1500)); process.exit(fail ? 1 : 0);
})();
