// BrandSentinel content script. Runs in every frame.
//  - "Agent" (every frame): notices the focused text box, reads its text, applies a fix, highlights a finding.
//  - "Controller" (top frame only): draws the pill and panel (closed shadow DOM) and talks to the background worker.
// Nothing is sent anywhere until the writer clicks Check (or turns on auto-check). Password and card fields are never read.
(() => {
  'use strict';
  if (window.__bsLoaded) return;
  window.__bsLoaded = true;

  const IS_TOP = window.top === window;
  const MIN_CHARS = 8;
  const IDLE_MS = 1500;
  const BLOCK = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TR', 'UL']);
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  const send = (m) => { try { return chrome.runtime.sendMessage(m).catch(() => null); } catch { return Promise.resolve(null); } };

  /* ------------------------------------------------------------------ agent */
  let cur = null; // { root, kind: 'field' | 'ce' }
  let idleTimer = null;

  function eligible(t) {
    if (!t || t.nodeType !== 1) return null;
    const tag = t.tagName;
    const hint = `${t.name || ''} ${t.id || ''} ${t.autocomplete || ''}`;
    if (tag === 'TEXTAREA') {
      if (t.readOnly || t.disabled || /cc-|pass|card|cvv|otp|iban/i.test(hint)) return null;
      return { root: t, kind: 'field' };
    }
    if (tag === 'INPUT') {
      const ty = (t.type || 'text').toLowerCase();
      if (!['text', 'search'].includes(ty) || t.readOnly || t.disabled || /cc-|pass|card|cvv|otp|iban|ssn/i.test(hint)) return null;
      return { root: t, kind: 'field' };
    }
    if (t.isContentEditable) {
      let r = t;
      while (r.parentElement && r.parentElement.isContentEditable) r = r.parentElement;
      return { root: r, kind: 'ce' };
    }
    return null;
  }

  function editorName(c) {
    const r = c.root;
    const m = (sel) => { try { return r.matches(sel) || !!r.closest(sel); } catch { return false; } };
    const h = location.hostname;
    if (m('.ql-editor')) return 'quill';
    if (r.tagName === 'TRIX-EDITOR' || m('trix-editor')) return 'trix';
    if (r.classList.contains('mce-content-body') || r.id === 'tinymce') return 'tinymce';
    if (m('.ck-editor__editable')) return 'ckeditor';
    if (m('.ProseMirror')) return 'prosemirror';
    if (m('.public-DraftEditor-content')) return 'draftjs';
    if (m('[data-slate-editor]')) return 'slate';
    if (m('.block-editor-rich-text__editable, .editor-styles-wrapper')) return 'gutenberg';
    if (/mail\.google\./.test(h)) return 'gmail';
    if (/linkedin\./.test(h)) return 'linkedin';
    if (/(^|\.)(x|twitter)\.com$/.test(h)) return 'x';
    return c.kind === 'field' ? (r.tagName === 'TEXTAREA' ? 'textarea' : 'input') : 'contenteditable';
  }

  // Text of a rich editor with a map from text offsets back to DOM text nodes. Blocks and <br> become "\n".
  function extract(root) {
    let out = '';
    const segs = [];
    const walk = (n) => {
      for (let c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) {
          const v = c.nodeValue.replace(/[\r\n ]/g, ' '); // same length as the node: offsets stay 1:1
          if (!v) continue;
          segs.push({ node: c, start: out.length, len: v.length });
          out += v;
        } else if (c.nodeType === 1) {
          const tag = c.tagName;
          if (tag === 'BR') { out += '\n'; continue; }
          if (SKIP.has(tag)) continue;
          const blk = BLOCK.has(tag);
          if (blk && out && !out.endsWith('\n')) out += '\n';
          walk(c);
          if (blk && out && !out.endsWith('\n')) out += '\n';
        }
      }
    };
    walk(root);
    out = out.replace(/\n+$/, ''); // trailing block breaks are not part of what the writer typed
    return { text: out, segs };
  }
  const read = (c) => (c.kind === 'field' ? { text: c.root.value, segs: null } : extract(c.root));

  function point(segs, pos, isEnd) {
    for (const s of segs) {
      if (isEnd ? (pos > s.start && pos <= s.start + s.len) : (pos >= s.start && pos < s.start + s.len)) return [s.node, pos - s.start];
    }
    return null;
  }
  function rangeFor(c, segs, start, end) {
    const a = point(segs, start, false), b = point(segs, end, true);
    if (!a || !b) return null;
    const r = c.root.ownerDocument.createRange();
    try { r.setStart(a[0], a[1]); r.setEnd(b[0], b[1]); } catch { return null; }
    return r;
  }

  // Highlights for rich editors use the CSS Custom Highlight API: nothing is added to the writer's document content.
  let sheetAdded = false;
  const HL = { high: 'bs-high', medium: 'bs-medium', low: 'bs-low' };
  function ensureSheet() {
    if (sheetAdded) return;
    sheetAdded = true;
    const css = '::highlight(bs-high){background:rgba(239,68,68,.28);text-decoration:underline wavy #ef4444;}::highlight(bs-medium){background:rgba(245,158,11,.28);text-decoration:underline wavy #f59e0b;}::highlight(bs-low){background:rgba(59,130,246,.22);text-decoration:underline wavy #3b82f6;}';
    try { const s = new CSSStyleSheet(); s.replaceSync(css); document.adoptedStyleSheets = [...document.adoptedStyleSheets, s]; }
    catch { const st = document.createElement('style'); st.textContent = css; (document.head || document.documentElement).appendChild(st); }
  }
  function clearHighlights() { try { Object.values(HL).forEach((k) => CSS.highlights.delete(k)); } catch { /* unsupported */ } }

  const agentCmds = {
    getText() {
      if (!cur || !cur.root.isConnected) return { ok: false, reason: 'no-editor' };
      return { ok: true, text: read(cur).text, editor: editorName(cur) };
    },
    highlight({ spans, expect }) {
      clearHighlights();
      if (!cur || cur.kind !== 'ce' || !window.CSS || !CSS.highlights || typeof Highlight === 'undefined') return { ok: true, n: 0 };
      const r = read(cur);
      if (r.text !== expect) return { ok: false, reason: 'changed' };
      ensureSheet();
      const by = { high: [], medium: [], low: [] };
      for (const s of spans) { const rg = rangeFor(cur, r.segs, s.start, s.end); if (rg) (by[s.sev] || by.low).push(rg); }
      let n = 0;
      for (const [sev, list] of Object.entries(by)) if (list.length) { CSS.highlights.set(HL[sev], new Highlight(...list)); n += list.length; }
      return { ok: true, n };
    },
    reveal({ start, end, expect }) {
      if (!cur || !cur.root.isConnected) return { ok: false, reason: 'no-editor' };
      const r = read(cur);
      if (r.text !== expect) return { ok: false, reason: 'changed' };
      window.focus();
      if (cur.kind === 'field') { cur.root.focus({ preventScroll: false }); cur.root.setSelectionRange(start, end); return { ok: true }; }
      const rg = rangeFor(cur, r.segs, start, end);
      if (!rg) return { ok: false, reason: 'unmapped' };
      cur.root.focus({ preventScroll: true });
      const sel = cur.root.ownerDocument.getSelection(); sel.removeAllRanges(); sel.addRange(rg);
      const el = rg.startContainer.parentElement; if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' });
      return { ok: true };
    },
    apply({ start, end, expect, repl }) {
      if (!cur || !cur.root.isConnected) return { ok: false, reason: 'no-editor' };
      const r = read(cur);
      if (r.text !== expect.full || r.text.slice(start, end) !== expect.span) return { ok: false, reason: 'changed' };
      const doc = cur.root.ownerDocument;
      window.focus();
      cur.root.focus({ preventScroll: true });
      const run = () => { try { return repl === '' ? doc.execCommand('delete') : doc.execCommand('insertText', false, repl); } catch { return false; } };
      const landed = () => { const t = read(cur).text; return t.slice(0, start) + repl === t.slice(0, start + repl.length) && t.length === r.text.length - (end - start) + repl.length; };
      if (cur.kind === 'field') {
        cur.root.setSelectionRange(start, end);
        run();
        if (!landed()) { // fall back for fields that ignore execCommand
          cur.root.value = r.text; cur.root.setRangeText(repl, start, end, 'end');
          cur.root.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: repl }));
        }
      } else {
        const rg = rangeFor(cur, r.segs, start, end);
        if (!rg) return { ok: false, reason: 'unmapped' };
        const sel = doc.getSelection(); sel.removeAllRanges(); sel.addRange(rg);
        run();
      }
      clearHighlights();
      return landed() ? { ok: true } : { ok: false, reason: 'blocked' };
    },
    clear() { clearHighlights(); return { ok: true }; },
  };

  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (!msg) return false;
    if (msg.t === 'cmd' && agentCmds[msg.cmd]) { try { reply(agentCmds[msg.cmd](msg.data || {})); } catch (e) { reply({ ok: false, reason: 'error', error: String(e) }); } return false; }
    if (msg.t === 'ev' && IS_TOP) { onEvent(msg); }
    return false;
  });

  function touch(e) {
    const path = e.composedPath ? e.composedPath() : [e.target];
    let found = eligible(path[0]);
    if (!found && e.target && e.target.nodeType === 9 && document.designMode === 'on') found = { root: document.body, kind: 'ce' };
    if (!found) return;
    if (!cur || cur.root !== found.root) {
      cur = found;
      send({ t: 'ev', ev: 'focus', data: { editor: editorName(cur) } });
    }
    if (e.type === 'input') {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => send({ t: 'ev', ev: 'idle' }), IDLE_MS);
    }
  }
  const attach = () => { for (const t of ['focusin', 'input', 'click']) document.addEventListener(t, touch, true); };
  attach();
  // Editors such as TinyMCE rewrite their iframe with document.open(), which drops listeners: re-attach (a no-op when still attached).
  if (!IS_TOP && /^about:/.test(location.href)) setInterval(attach, 1000);

  /* ------------------------------------------------------------- controller */
  if (!IS_TOP) return;

  const S = { frameId: null, editor: '', status: 'idle', result: null, text: '', open: false, hidden: false, msg: '', saved: null, dismissed: new Set(), token: 0, limitUntil: 0, deep: false, settings: null };
  let ui = null;

  const h = (tag, props, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
    return el;
  };
  const sendCmd = (cmd, data) => send({ t: 'cmd', frameId: S.frameId, cmd, data }).then((r) => r || { ok: false, reason: 'gone' });

  const CSS_TEXT = `
:host{all:initial}*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{position:fixed;right:16px;bottom:16px;z-index:2147483647;display:flex;flex-direction:column;align-items:flex-end;gap:10px;font-size:13px;line-height:1.45;color:#ece9ff}
button{font:inherit;cursor:pointer}
.pill{display:flex;align-items:center;gap:8px;padding:9px 15px;border-radius:999px;border:1px solid rgba(255,255,255,.22);background:linear-gradient(135deg,#7c3aed,#4f46e5 55%,#0891b2);color:#fff;font-weight:650;box-shadow:0 10px 30px rgba(76,29,149,.5);transition:transform .15s,box-shadow .15s}
.pill:hover{transform:translateY(-1px) scale(1.03);box-shadow:0 12px 34px rgba(124,58,237,.65)}
.dot{width:9px;height:9px;border-radius:50%;background:#fff;flex:none}
.pill[data-state=checking] .dot{animation:pulse 1s infinite}.pill[data-sev=high] .dot{background:#f87171}.pill[data-sev=medium] .dot{background:#fbbf24}.pill[data-sev=low] .dot{background:#60a5fa}.pill[data-state=clear] .dot{background:#4ade80}.pill[data-state=limited] .dot,.pill[data-state=error] .dot,.pill[data-state=setup] .dot{background:#fbbf24}
@keyframes pulse{50%{opacity:.25}}
.x{margin-left:4px;opacity:.7;background:none;border:0;color:#fff;padding:0 2px;font-size:15px}
.panel{width:390px;max-height:min(72vh,660px);display:flex;flex-direction:column;overflow:hidden;border-radius:18px;background:rgba(19,15,38,.97);border:1px solid rgba(255,255,255,.12);box-shadow:0 24px 60px rgba(0,0,0,.5)}
.hd{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.08)}
.hd b{font-size:14px;flex:1}.badge{padding:2px 9px;border-radius:999px;font-size:11px;font-weight:700;text-transform:uppercase;background:rgba(255,255,255,.1)}
.badge.high{background:rgba(239,68,68,.25);color:#fecaca}.badge.medium{background:rgba(245,158,11,.25);color:#fde68a}.badge.low{background:rgba(34,197,94,.22);color:#bbf7d0}
.btn{padding:6px 11px;border-radius:10px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.07);color:#fff}.btn:hover{background:rgba(255,255,255,.15)}
.btn.pri{background:linear-gradient(135deg,#7c3aed,#4f46e5);border-color:transparent;font-weight:600}.btn.sm{padding:3px 9px;font-size:12px}
.bar{display:flex;align-items:center;gap:10px;padding:8px 14px;border-bottom:1px solid rgba(255,255,255,.08);color:#c9c4ee;font-size:12px}.bar label{display:flex;gap:6px;align-items:center;flex:1}
.body{overflow:auto;padding:10px 12px;display:flex;flex-direction:column;gap:10px}
.note{padding:9px 11px;border-radius:12px;background:rgba(255,255,255,.07);color:#d8d4f5}.note.warn{background:rgba(245,158,11,.16);color:#fde68a}.note.ok{background:rgba(34,197,94,.16);color:#bbf7d0}
.f{padding:10px 11px;border-radius:14px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);border-left:4px solid #60a5fa}.f.high{border-left-color:#ef4444}.f.medium{border-left-color:#f59e0b}
.cat{font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#a5a0d6}.m{margin:3px 0}
code{padding:1px 5px;border-radius:6px;background:rgba(255,255,255,.12);font-family:ui-monospace,Consolas,monospace;font-size:12px;word-break:break-word}
.cite{margin:6px 0;padding:6px 9px;border-radius:10px;background:rgba(34,211,238,.09);border:1px solid rgba(34,211,238,.25);font-size:12px;color:#c9f4fb}.cite b{color:#67e8f9}
.row{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}.apply{text-align:left;max-width:100%;border-color:rgba(124,58,237,.7);background:rgba(124,58,237,.25)}
a{color:#67e8f9}
@media (max-width:480px){.panel{width:calc(100vw - 32px)}}`;

  async function ensureUI() {
    if (ui) return;
    S.settings = S.settings || await send({ t: 'settings' });
    const host = document.createElement('div');
    host.id = 'bs-ext-root';
    host.setAttribute('data-bs-ignore', '');
    const root = host.attachShadow({ mode: S.settings && S.settings.openShadow ? 'open' : 'closed' });
    root.append(h('style', null, CSS_TEXT));
    const wrap = h('div', { class: 'wrap' });
    root.append(wrap);
    // Keep the writer's cursor in the editor when clicking our buttons.
    wrap.addEventListener('mousedown', (e) => { if (e.target.closest('button') && !e.target.closest('input')) e.preventDefault(); });
    (document.documentElement || document.body).appendChild(host);
    ui = { host, wrap };
  }

  const SEV = { high: 3, medium: 2, low: 1, info: 0 };
  const visible = () => (S.result ? S.result.findings.filter((f) => !S.dismissed.has(`${f.rule}:${f.matched}`)) : []);

  function render() {
    if (!ui) return;
    ui.wrap.textContent = '';
    if (S.hidden) return;
    const list = visible();
    const worst = list.reduce((m, f) => (SEV[f.severity] > SEV[m] ? f.severity : m), 'info');
    const st = !S.settings || !S.settings.configured ? 'setup' : S.status === 'done' ? (list.length ? 'issues' : 'clear') : S.status;
    const label = { setup: 'Connect', idle: 'Check', checking: 'Checking…', issues: `${list.length} issue${list.length === 1 ? '' : 's'}`, clear: 'All clear', limited: 'Paused', error: 'Retry' }[st];

    if (S.open) ui.wrap.append(panel(list, st));
    ui.wrap.append(h('button', { class: 'pill', 'data-state': st, 'data-sev': st === 'issues' ? worst : null, 'data-count': String(list.length), 'aria-label': `BrandSentinel: ${label}`, onclick: onPill },
      h('span', { class: 'dot' }), 'BrandSentinel · ', h('span', { class: 'lbl' }, label),
      h('button', { class: 'x', 'aria-label': 'Hide BrandSentinel', title: 'Hide until the next text box', onclick: (e) => { e.stopPropagation(); S.hidden = true; S.open = false; sendCmd('clear'); render(); } }, '×')));
  }

  function panel(list, st) {
    const r = S.result;
    const body = [];
    if (st === 'setup') body.push(h('div', { class: 'note warn' }, 'Connect BrandSentinel first: click the BrandSentinel icon in the Chrome toolbar, add your server address and API key, then press Test connection.'));
    else if (S.msg) body.push(h('div', { class: `note ${st === 'limited' || st === 'error' ? 'warn' : ''}`, role: 'status' }, S.msg));
    if (S.saved) body.push(h('div', { class: 'note ok' }, 'Saved to BrandSentinel. ', h('a', { href: S.saved, target: '_blank', rel: 'noopener' }, 'Open it for review')));
    if (st === 'clear') body.push(h('div', { class: 'note ok' }, 'No problems found against your approved guidelines.'));
    if (r && r.advisory_hidden) body.push(h('div', { class: 'note' }, `${r.advisory_hidden} possible issue${r.advisory_hidden === 1 ? '' : 's'} had no approved source and ${r.advisory_hidden === 1 ? 'was' : 'were'} not shown.`));
    const sorted = [...list].sort((a, b) => SEV[b.severity] - SEV[a.severity] || a.start - b.start);
    for (const f of sorted) body.push(card(f));
    return h('div', { class: 'panel', role: 'dialog', 'aria-label': 'BrandSentinel findings' },
      h('div', { class: 'hd' }, h('b', null, 'BrandSentinel'), r ? h('span', { class: `badge ${r.risk}` }, `${r.risk} risk`) : null,
        h('button', { class: 'btn sm check', onclick: () => runCheck({ auto: false }) }, r ? 'Re-check' : 'Check'),
        h('button', { class: 'btn sm', 'aria-label': 'Close panel', onclick: () => { S.open = false; render(); } }, '×')),
      h('div', { class: 'bar' },
        h('label', null, h('input', { type: 'checkbox', class: 'deep', checked: S.deep, onchange: (e) => { S.deep = e.target.checked; } }), 'Deep check (uses the AI assistant, slower)'),
        h('button', { class: 'btn sm save', onclick: save }, 'Save to BrandSentinel')),
      h('div', { class: 'body' }, body));
  }

  function card(f) {
    const quote = f.source && f.source.quote ? (f.source.quote.length > 170 ? f.source.quote.slice(0, 170) + '…' : f.source.quote) : '';
    return h('div', { class: `f ${f.severity}`, 'data-rule': f.rule },
      h('div', { class: 'cat' }, `${f.severity} · ${f.category}`),
      h('div', { class: 'm' }, f.message),
      f.matched ? h('div', null, 'Flagged: ', h('code', null, f.matched)) : null,
      f.source ? h('div', { class: 'cite' }, h('b', { class: 'src' }, f.source.code), quote ? ` · “${quote}”` : '') : null,
      h('div', { class: 'row' },
        f.suggestions.map((s) => h('button', { class: 'btn sm apply', 'data-level': s.level, title: s.note || '', onclick: () => applyFix(f, s) },
          s.text === '' ? 'Remove it' : `Use “${s.text.length > 60 ? s.text.slice(0, 60) + '…' : s.text}”`)),
        f.start >= 0 ? h('button', { class: 'btn sm show', onclick: () => sendCmd('reveal', { start: f.start, end: f.end, expect: S.text }) }, 'Show in text') : null,
        h('button', { class: 'btn sm dismiss', onclick: () => dismiss(f) }, 'Dismiss')));
  }

  async function dismiss(f) {
    S.dismissed.add(`${f.rule}:${f.matched}`);
    await pushHighlights();
    render();
  }

  async function pushHighlights() {
    if (!S.result) return;
    await sendCmd('highlight', { spans: visible().filter((f) => f.start >= 0).map((f) => ({ start: f.start, end: f.end, sev: f.severity })), expect: S.text });
  }

  async function runCheck({ auto }) {
    if (!S.settings || !S.settings.configured) { S.settings = await send({ t: 'settings' }); }
    if (!S.settings || !S.settings.configured) { S.status = 'setup'; S.open = true; render(); return; }
    if (auto && Date.now() < S.limitUntil) return;
    const my = ++S.token;
    S.status = 'checking'; S.msg = ''; S.saved = null; render();
    const g = await sendCmd('getText');
    if (my !== S.token) return;
    if (!g.ok) { S.status = 'idle'; S.msg = 'Click into the text box you are writing in, then check again.'; render(); return; }
    S.editor = g.editor;
    if (g.text.trim().length < MIN_CHARS) { S.status = 'idle'; S.result = null; S.msg = `Write a little more (at least ${MIN_CHARS} characters) to check.`; await sendCmd('clear'); render(); return; }
    const r = await send({ t: 'api', op: 'check', body: { text: g.text, kind: 'text', channel: S.settings.channel, intent: `Written in the browser (${location.hostname})`, auto, record: !auto, deep: S.deep, source: { host: location.hostname, editor: g.editor, title: document.title } } });
    if (my !== S.token) return;
    if (!r || !r.ok) {
      const limited = r && r.status === 429;
      S.status = limited ? 'limited' : 'error';
      S.msg = (r && r.error) || 'Something went wrong. Try again.';
      if (limited) S.limitUntil = Date.now() + (r.retry || 60) * 1000;
      if (!auto || limited) S.open = true;
      render(); return;
    }
    S.result = r.data; S.text = g.text; S.status = 'done';
    await pushHighlights();
    render();
  }

  async function applyFix(f, s) {
    const a = s.start !== undefined ? s.start : f.start, b = s.end !== undefined ? s.end : f.end;
    const r = await sendCmd('apply', { start: a, end: b, repl: s.text, expect: { full: S.text, span: S.text.slice(a, b) } });
    if (!r.ok) {
      const changed = r.reason === 'changed';
      S.msg = changed ? 'The text changed since the last check, so nothing was replaced. Re-checking now…' : 'This editor did not accept the change. Edit the text by hand using “Show in text”.';
      render();
      if (changed) { await runCheck({ auto: true }); S.msg = 'The text changed since the last check, so nothing was replaced. The results below are refreshed: apply the fix again.'; render(); }
      return;
    }
    S.msg = 'Fix applied.';
    await runCheck({ auto: true });
    S.msg = S.status === 'done' ? 'Fix applied.' : S.msg;
    render();
  }

  async function save() {
    const g = await sendCmd('getText');
    if (!g.ok || g.text.trim().length < MIN_CHARS) { S.msg = `Write at least ${MIN_CHARS} characters before saving.`; render(); return; }
    S.msg = 'Saving…'; render();
    const r = await send({ t: 'api', op: 'save', body: { text: g.text, kind: 'text', channel: S.settings.channel, title: (document.title || location.hostname).slice(0, 120), intent: `Written in the browser (${location.hostname})`, source: { host: location.hostname, editor: g.editor, title: document.title } } });
    if (r && r.ok) { S.msg = ''; S.saved = r.data.url; } else S.msg = (r && r.error) || 'Could not save.';
    render();
  }

  async function onPill() {
    S.settings = await send({ t: 'settings' });
    S.open = !S.open;
    render();
    if (S.open && S.settings && S.settings.configured && !S.result && S.status !== 'checking') runCheck({ auto: false });
  }

  async function onEvent(m) {
    if (m.ev === 'focus') {
      S.settings = await send({ t: 'settings' });
      await ensureUI();
      if (S.frameId !== m.frameId || S.editor !== m.data.editor) { S.result = null; S.status = 'idle'; S.msg = ''; S.saved = null; S.dismissed = new Set(); S.token++; }
      S.frameId = m.frameId; S.editor = m.data.editor; S.hidden = false; S.deep = S.deep || !!(S.settings && S.settings.deep);
      render();
    } else if (m.ev === 'idle') {
      S.settings = S.settings || await send({ t: 'settings' });
      if (S.settings && S.settings.configured && S.settings.autoCheck && m.frameId === S.frameId) { await ensureUI(); runCheck({ auto: true }); }
    }
  }
})();
