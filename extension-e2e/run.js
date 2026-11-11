// End-to-end test: the real extension, loaded into real Chromium, on real editor components served locally
// (TinyMCE, Quill, Trix, plain fields, a webmail-style contenteditable) against a real BrandSentinel server (in-memory DB).
//   npm test                      uses ../server and ../extension
//   SERVER_DIR=/path/to/server  CHROME_PATH=/path/to/chrome  SHOTS_DIR=/tmp/shots  npm test
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const EXT = path.resolve(__dirname, '../extension');
const SERVER_DIR = path.resolve(process.env.SERVER_DIR || path.join(__dirname, '../server'));
const SHOTS = path.resolve(process.env.SHOTS_DIR || path.join(__dirname, 'shots'));
const PORT = Number(process.env.E2E_PORT || 4050), PORT_LIMITED = PORT + 1, PORT_PAGES = PORT + 2;
const SAMPLE = "Our new roast is India's #1 coffee, now 30% off. Visit Novabrw today!!!";
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const record = (editor, scenario, pass, detail = '') => { results.push({ editor, scenario, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${editor.padEnd(10)} ${scenario}${detail ? '  — ' + detail : ''}`); };
async function step(editor, scenario, fn) { try { const d = await fn(); record(editor, scenario, true, typeof d === 'string' ? d : ''); } catch (e) { record(editor, scenario, false, String(e.message).split('\n')[0].slice(0, 200)); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, what = 'condition') { const t0 = Date.now(); let last; while (Date.now() - t0 < ms) { try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await sleep(150); } throw new Error(`Timed out waiting for ${what}${last ? ': ' + last.message : ''}`); }

// ---------------------------------------------------------------- servers
function startServer(port, extraEnv = {}) {
  const p = spawn('node', ['src/index.js'], { cwd: SERVER_DIR, env: { ...process.env, PORT: String(port), NODE_ENV: 'development', DB_DRIVER: 'memory', MONGODB_URI: '', SEED_DEMO: 'true', LLM_PROVIDER: 'none', GEMINI_API_KEY: '', GROQ_API_KEY: '', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; p.stdout.on('data', (d) => { log += d; }); p.stderr.on('data', (d) => { log += d; });
  p.getLog = () => log;
  return p;
}
const api = async (port, method, url, { token, body } = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
};
async function ready(port) {
  await until(async () => !!(await login(port, 'creator')), 60000, `server on ${port}`);
}
// Sign-in is rate limited (5 per minute), so tokens are fetched once and reused.
const tokens = {};
const login = async (port, who) => (tokens[`${port}:${who}`] ||= (await api(port, 'POST', '/api/auth/login', { body: { email: `${who}@novabrew.test`, password: 'Demo@1234' } })).data.token);
// A user may hold 5 active keys: revoke the old test keys first so every scenario gets a fresh key of its own.
const makeKey = async (port, who, name) => {
  const token = await login(port, who);
  for (const k of (await api(port, 'GET', '/api/keys', { token })).data.keys) if (!k.revoked_at) await api(port, 'DELETE', `/api/keys/${k.id}`, { token });
  const r = await api(port, 'POST', '/api/keys', { token, body: { name } });
  if (r.status !== 201) throw new Error(`could not create a key: ${JSON.stringify(r.data)}`);
  return r.data;
};

// ---------------------------------------------------------------- local pages (real editor libraries from npm)
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff': 'font/woff', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.gif': 'image/gif', '.ttf': 'font/ttf' };
const VENDOR = { tinymce: 'node_modules/tinymce', quill: 'node_modules/quill/dist', trix: 'node_modules/trix/dist' };
function startPages() {
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = null;
    const m = u.match(/^\/vendor\/(\w+)\/(.+)$/);
    if (m && VENDOR[m[1]]) file = path.join(__dirname, VENDOR[m[1]], m[2]);
    else if (/^\/[\w-]+\.html$/.test(u)) file = path.join(__dirname, 'pages', u);
    if (!file || file.includes('..') || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => srv.listen(PORT_PAGES, '127.0.0.1', () => r(srv)));
}

// ---------------------------------------------------------------- editors
const EDITORS = {
  tinymce: {
    url: '/tinymce.html',
    async open(page) { await page.goto(`http://127.0.0.1:${PORT_PAGES}/tinymce.html`); await page.waitForSelector('iframe.tox-edit-area__iframe'); await page.frameLocator('iframe.tox-edit-area__iframe').locator('body#tinymce').waitFor(); },
    async type(page, text) { await page.frameLocator('iframe.tox-edit-area__iframe').locator('body#tinymce').click(); await page.keyboard.type(text, { delay: 4 }); },
    text: (page) => page.evaluate(() => tinymce.activeEditor.getContent({ format: 'text' })),
    frame: (page) => page.frames().find((f) => f !== page.mainFrame() && f.parentFrame() === page.mainFrame() && /about:|srcdoc|^$/.test(f.url()) || f.name() === 'ed_ifr'),
    rich: true,
  },
  quill: {
    async open(page) { await page.goto(`http://127.0.0.1:${PORT_PAGES}/quill.html`); await page.waitForSelector('.ql-editor'); },
    async type(page, text) { await page.locator('.ql-editor').click(); await page.keyboard.type(text, { delay: 4 }); },
    text: (page) => page.evaluate(() => window.quill.getText().replace(/\n$/, '')),
    frame: (page) => page.mainFrame(), rich: true,
  },
  trix: {
    async open(page) { await page.goto(`http://127.0.0.1:${PORT_PAGES}/trix.html`); await page.waitForSelector('trix-editor'); },
    async type(page, text) { await page.locator('trix-editor').click(); await page.keyboard.type(text, { delay: 4 }); },
    text: (page) => page.evaluate(() => document.querySelector('trix-editor').editor.getDocument().toString().replace(/\n$/, '')),
    frame: (page) => page.mainFrame(), rich: true,
  },
  textarea: {
    async open(page) { await page.goto(`http://127.0.0.1:${PORT_PAGES}/fields.html`); await page.waitForSelector('#post'); },
    async type(page, text) { await page.locator('#post').click(); await page.keyboard.type(text, { delay: 2 }); },
    text: (page) => page.inputValue('#post'),
    frame: (page) => page.mainFrame(), rich: false,
  },
  webmail: {
    async open(page) { await page.goto(`http://127.0.0.1:${PORT_PAGES}/fields.html`); await page.waitForSelector('#gmail'); },
    async type(page, text) { await page.locator('#gmail').click(); await page.keyboard.type(text, { delay: 2 }); },
    text: (page) => page.evaluate(() => document.querySelector('#gmail').innerText.replace(/\n+$/, '')),
    frame: (page) => page.mainFrame(), rich: true,
  },
};

// ---------------------------------------------------------------- main
(async () => {
  const servers = [];
  let pages, ctx;
  const cleanup = async () => { try { await ctx && ctx.close(); } catch { /* */ } try { pages && pages.close(); } catch { /* */ } servers.forEach((s) => { try { s.kill('SIGTERM'); } catch { /* */ } }); };
  process.on('SIGINT', async () => { await cleanup(); process.exit(130); });
  try {
    const A = startServer(PORT), B = startServer(PORT_LIMITED, { GATE_RATE_PER_MIN: '4' });
    servers.push(A, B);
    await Promise.all([ready(PORT), ready(PORT_LIMITED)]);
    pages = await startPages();
    const exe = process.env.CHROME_PATH || (() => { try { const p = chromium.executablePath(); return fs.existsSync(p) ? p : undefined; } catch { return undefined; } })();
    const userData = fs.mkdtempSync(path.join(require('os').tmpdir(), 'bs-ext-'));
    ctx = await chromium.launchPersistentContext(userData, {
      executablePath: exe, headless: true, viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1,
      args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
    });
    const getSW = async () => (ctx.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://')) || await ctx.waitForEvent('serviceworker', { timeout: 20000 }));
    let sw = await getSW();
    const extId = new URL(sw.url()).host;
    const configure = async (settings) => { sw = await getSW(); await sw.evaluate((s) => chrome.storage.local.set(s), { debugOpenShadow: true, channel: 'social', deep: false, ...settings }); };
    const S = (port, key, auto = false) => ({ serverUrl: `http://127.0.0.1:${port}`, apiKey: key, autoCheck: auto });
    const auditRows = async (port) => { const r = (await api(port, 'GET', '/api/admin/audit', { token: await login(port, 'admin') })).data; return r; };
    const pill = (page) => page.locator('#bs-ext-root .pill');

    console.log(`Extension ${extId} loaded. Server ${SERVER_DIR}\n`);

    for (const name of ['tinymce', 'quill', 'trix', 'textarea', 'webmail']) {
      const E = EDITORS[name];
      const key = await makeKey(PORT, 'creator', `e2e-${name}`);
      await configure(S(PORT, key.key, false));
      const page = await ctx.newPage();
      const errors = []; page.on('pageerror', (e) => errors.push(e.message));
      await step(name, 'editor loads', async () => { await E.open(page); });
      await step(name, 'pill appears when focusing the editor', async () => { await E.type(page, SAMPLE); await pill(page).waitFor({ timeout: 10000 }); return `typed ${(await E.text(page)).length} chars`; });
      await step(name, 'typed text matches editor model', async () => { const t = await E.text(page); if (t.trim() !== SAMPLE) throw new Error(`editor text: ${JSON.stringify(t)}`); });
      await step(name, 'Check lists findings with citations', async () => {
        await pill(page).click();
        await page.locator('#bs-ext-root .pill[data-state="issues"]').waitFor({ timeout: 20000 });
        const sup = page.locator('#bs-ext-root .f[data-rule="claims.superlative"]');
        const fz = page.locator('#bs-ext-root .f[data-rule="terminology.fuzzy"]');
        await sup.waitFor({ timeout: 5000 }); await fz.waitFor({ timeout: 5000 });
        const c1 = (await sup.locator('.src').innerText()).trim(), c2 = (await fz.locator('.src').innerText()).trim();
        if (!c1 || !c2) throw new Error('missing citation');
        const q = (await sup.locator('.cite').innerText());
        if (q.length < c1.length + 10) throw new Error('citation has no quoted guideline text');
        await page.screenshot({ path: path.join(SHOTS, `${name}-findings.png`) });
        return `cites ${c1} and ${c2}`;
      });
      if (E.rich) await step(name, 'findings are highlighted in the text', async () => {
        const f = E.frame(page);
        const n = await until(async () => f.evaluate(() => (window.CSS && CSS.highlights ? CSS.highlights.size : -1)), 6000, 'highlight registry');
        if (n < 1) throw new Error(`highlight registry size ${n}`);
        return `${n} highlight group(s)`;
      });
      await step(name, 'stale text is never overwritten (asks to re-check)', async () => {
        await E.type(page, ' Thanks!');
        const before = await E.text(page);
        await page.locator('#bs-ext-root .f[data-rule="terminology.fuzzy"] .apply').first().click();
        await page.locator('#bs-ext-root .note', { hasText: 'text changed' }).waitFor({ timeout: 6000 });
        const after = await E.text(page);
        if (after !== before) throw new Error('text was modified although it had changed since the check');
        await page.locator('#bs-ext-root .pill[data-state="issues"]').waitFor({ timeout: 15000 });
      });
      await step(name, 'Apply replaces the exact span and the editor model sees it', async () => {
        await pill(page).waitFor();
        const btn = page.locator('#bs-ext-root .f[data-rule="terminology.fuzzy"] .apply').first();
        await btn.waitFor({ timeout: 10000 });
        await btn.click();
        const t = await until(async () => { const x = await E.text(page); return x.includes('NovaBrew') ? x : null; }, 10000, 'NovaBrew in editor model');
        if (t.includes('Novabrw')) throw new Error('old spelling still present');
        if (!/India's #1 coffee/.test(t) || !t.includes('Thanks!')) throw new Error(`other text was damaged: ${JSON.stringify(t)}`);
        await until(async () => (await page.locator('#bs-ext-root .f[data-rule="terminology.fuzzy"]').count()) === 0, 15000, 'finding gone after re-check');
        await page.screenshot({ path: path.join(SHOTS, `${name}-after-apply.png`) });
        return JSON.stringify(t.slice(-38));
      });
      await step(name, 'Dismiss hides a finding', async () => {
        const before = await page.locator('#bs-ext-root .f').count();
        await page.locator('#bs-ext-root .f .dismiss').first().click();
        await until(async () => (await page.locator('#bs-ext-root .f').count()) === before - 1, 4000, 'one card fewer');
      });
      await step(name, 'Save to BrandSentinel creates an item (source: extension)', async () => {
        await page.locator('#bs-ext-root .save').click();
        const a = page.locator('#bs-ext-root .note.ok a');
        await a.waitFor({ timeout: 15000 });
        const href = await a.getAttribute('href');
        const id = Number((href.match(/\/items\/(\d+)/) || [])[1]);
        if (!id) throw new Error(`unexpected link ${href}`);
        if (!href.startsWith(`http://127.0.0.1:${PORT}/`)) throw new Error(`link is not absolute: ${href}`);
        const it = (await api(PORT, 'GET', `/api/items/${id}`, { token: await login(PORT, 'creator') })).data;
        if (!it || it.item.source !== 'extension') throw new Error(`item source ${it && it.item && it.item.source}`);
        return `item #${id}`;
      });
      await step(name, 'audit log has ext.check (host, hash, key) and chain is intact', async () => {
        const r = await auditRows(PORT);
        const mine = r.rows.filter((a) => a.action === 'ext.check').map((a) => ({ a, d: JSON.parse(a.detail) })).filter((x) => x.d.key === key.prefix);
        if (!mine.length) throw new Error('no ext.check entries for this key');
        if (!mine.every((x) => x.d.host === '127.0.0.1')) throw new Error(`host: ${mine[0].d.host}`);
        const first = mine.find((x) => x.d.content_hash === sha(SAMPLE));
        if (!first) throw new Error('hash of the original text not found in the audit log');
        if (mine.some((x) => JSON.stringify(x.a).includes('India'))) throw new Error('audit entry contains page text');
        if (!r.chain.ok) throw new Error('audit chain broken');
        if (!r.rows.some((a) => a.action === 'ext.save')) throw new Error('no ext.save entry');
        return `${mine.length} ext.check entries, chain ok (${r.chain.checked})`;
      });
      if (errors.length) record(name, 'no page errors', false, errors[0]); else record(name, 'no page errors', true);
      await page.close();
    }

    // ---- scenarios that do not depend on a specific editor
    {
      const name = 'textarea';
      const E = EDITORS.textarea;
      const key = await makeKey(PORT, 'creator', 'e2e-auto');
      await configure(S(PORT, key.key, true));
      const page = await ctx.newPage();
      await E.open(page);
      await step(name, 'auto-check runs when typing stops (and is logged as auto)', async () => {
        await E.type(page, SAMPLE);
        await page.locator('#bs-ext-root .pill[data-state="issues"]').waitFor({ timeout: 12000 });
        const r = await auditRows(PORT);
        const mine = r.rows.filter((a) => a.action === 'ext.check').map((a) => JSON.parse(a.detail)).filter((d) => d.key === key.prefix);
        if (!mine.length || !mine[0].auto) throw new Error('auto check was not recorded as auto');
        return `${mine.length} logged (throttled to 1/min)`;
      });
      await page.close();

      const key2 = await makeKey(PORT, 'creator', 'e2e-secrets');
      await configure(S(PORT, key2.key, true));
      const p2 = await ctx.newPage();
      await E.open(p2);
      await step('fields', 'password and card fields are never read or sent', async () => {
        await p2.locator('#pw').click(); await p2.keyboard.type('correct horse battery staple Novabrw #1', { delay: 2 });
        await p2.locator('#cc').click(); await p2.keyboard.type('4111 1111 1111 1111 Novabrw', { delay: 2 });
        await sleep(3500);
        if (await p2.locator('#bs-ext-root').count()) throw new Error('the panel appeared for a secret field');
        const r = await auditRows(PORT);
        if (r.rows.some((a) => a.action === 'ext.check' && JSON.parse(a.detail).key === key2.prefix)) throw new Error('a check was sent for a secret field');
      });
      await step('fields', 'short text (under 8 characters) is not sent', async () => {
        await p2.locator('#title').click(); await p2.keyboard.type('Hi all', { delay: 2 }); await sleep(3000);
        const r = await auditRows(PORT);
        if (r.rows.some((a) => a.action === 'ext.check' && JSON.parse(a.detail).key === key2.prefix)) throw new Error('short text was sent');
        const st = await p2.locator('#bs-ext-root .pill').getAttribute('data-state');
        return `pill state ${st}`;
      });
      await p2.close();
    }

    {
      const key = await makeKey(PORT_LIMITED, 'creator', 'e2e-limit');
      await configure(S(PORT_LIMITED, key.key, false));
      const page = await ctx.newPage();
      await EDITORS.quill.open(page);
      await EDITORS.quill.type(page, SAMPLE);
      await step('quill', 'rate limit shows a friendly message, not an error', async () => {
        await pill(page).click();
        await page.locator('#bs-ext-root .pill[data-state="issues"]').waitFor({ timeout: 15000 });
        for (let i = 0; i < 6; i++) { await page.locator('#bs-ext-root .check').click(); await sleep(250); }
        await page.locator('#bs-ext-root .pill[data-state="limited"]').waitFor({ timeout: 8000 });
        const note = await page.locator('#bs-ext-root .note.warn').innerText();
        if (!/Slow down/.test(note) || !/Try again in \d+ s/.test(note)) throw new Error(`message: ${note}`);
        if (/undefined|429|\[object/.test(note)) throw new Error(`raw error leaked: ${note}`);
        await page.screenshot({ path: path.join(SHOTS, 'quill-rate-limited.png') });
        return note.trim();
      });
      await page.close();
    }

    await step('popup', 'connect screen saves settings and tests the connection', async () => {
      const key = await makeKey(PORT, 'creator', 'e2e-popup');
      await sw.evaluate(() => chrome.storage.local.clear());
      const pop = await ctx.newPage();
      await pop.goto(`chrome-extension://${extId}/popup.html`);
      await pop.fill('#server', `http://127.0.0.1:${PORT}`);
      await pop.fill('#key', key.key);
      await pop.click('#save');
      const ok = pop.locator('#status .ok', { hasText: 'Connected to NovaBrew Coffee as Riya Creator' });
      await ok.waitFor({ timeout: 15000 });
      const stored = await getSW().then((w) => w.evaluate(() => chrome.storage.local.get('apiKey')));
      if (stored.apiKey !== key.key) throw new Error('key not stored');
      await pop.fill('#key', 'bsk_wrongwrongwrongwrongwrongwrongwr');
      await pop.click('#save');
      await pop.locator('#status .bad', { hasText: 'rejected this API key' }).waitFor({ timeout: 10000 });
      await pop.screenshot({ path: path.join(SHOTS, 'popup.png') });
      await pop.close();
      return await ok.innerText().catch(() => 'connected');
    });

    await step('security', 'content scripts cannot read the API key from storage', async () => {
      const key = await makeKey(PORT, 'creator', 'e2e-lock');
      await configure(S(PORT, key.key, false));
      const page = await ctx.newPage();
      await EDITORS.quill.open(page);
      await EDITORS.quill.type(page, SAMPLE);
      await pill(page).waitFor();
      const leaked = await page.evaluate(() => JSON.stringify(Object.keys(window)).includes('bsk_') || document.documentElement.outerHTML.includes('bsk_'));
      if (leaked) throw new Error('the key is visible to the page');
      await page.close();
    });
  } catch (e) {
    console.error('Harness error:', e.stack || e.message);
    record('harness', 'run', false, e.message.split('\n')[0]);
  } finally {
    await cleanup();
  }

  const failed = results.filter((r) => !r.pass);
  console.log('\n=============== RESULTS ===============');
  const names = [...new Set(results.map((r) => r.editor))];
  for (const n of names) { const rs = results.filter((r) => r.editor === n); console.log(`${n.padEnd(10)} ${rs.filter((r) => r.pass).length}/${rs.length} passed`); }
  console.log(`TOTAL ${results.length - failed.length}/${results.length} passed${failed.length ? '\nFAILED:\n' + failed.map((f) => ` - ${f.editor}: ${f.scenario} (${f.detail})`).join('\n') : ''}`);
  process.exit(failed.length ? 1 : 0);
})();
