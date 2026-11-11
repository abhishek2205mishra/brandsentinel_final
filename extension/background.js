// BrandSentinel service worker.
//  - The ONLY place that knows the API key and talks to your BrandSentinel server.
//  - Relays messages between editor frames (which can be iframes, e.g. TinyMCE) and the top frame that draws the UI.
'use strict';

const DEFAULTS = { serverUrl: '', apiKey: '', channel: 'social', autoCheck: true, deep: false, debugOpenShadow: false };

// Content scripts run next to arbitrary web pages: keep the key out of their reach.
const lockStorage = () => { try { chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }); } catch { /* older Chrome */ } };
chrome.runtime.onInstalled.addListener(lockStorage);
lockStorage();

async function getSettings() {
  const s = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...s };
}

function normUrl(u) {
  try { const x = new URL(String(u || '').trim()); if (!/^https?:$/.test(x.protocol)) return ''; return x.origin + x.pathname.replace(/\/+$/, ''); } catch { return ''; }
}

// One call to the server with friendly errors for every failure a writer can hit.
async function api(method, path, body, override) {
  const s = override || await getSettings();
  const base = normUrl(s.serverUrl);
  if (!base || !s.apiKey) return { ok: false, status: 0, code: 'not_configured', error: 'Connect BrandSentinel first: click the extension icon and add your server address and API key.' };
  const host = new URL(base).host;
  let res;
  try {
    res = await fetch(base + path, {
      method, headers: { 'x-api-key': s.apiKey, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(45000),
    });
  } catch (e) {
    return { ok: false, status: 0, code: 'network', error: `Could not reach ${host}. On Render's free plan the server sleeps after 15 idle minutes: wait about a minute and try again.` };
  }
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (res.ok) return { ok: true, status: res.status, data };
  const retry = Number(res.headers.get('retry-after') || (data && data.retry_after) || 0) || 0;
  const msgs = {
    401: 'BrandSentinel rejected this API key. Create a new key on your Account page and paste it into the extension.',
    403: (data && data.error) || 'Your role is not allowed to do this.',
    413: (data && data.error) || 'That text is too long for an inline check.',
    429: `Slow down: this key's request limit was reached.${retry ? ` Try again in ${retry} s.` : ' Try again in a minute.'}`,
  };
  return { ok: false, status: res.status, retry, error: msgs[res.status] || (res.status >= 500 ? `BrandSentinel had a problem (HTTP ${res.status}). Try again in a moment.` : (data && data.error) || `Unexpected response (HTTP ${res.status}).`) };
}

async function handle(msg, sender) {
  switch (msg && msg.t) {
    case 'settings': {
      const s = await getSettings();
      // Never include the key: this goes to content scripts.
      return { configured: !!(normUrl(s.serverUrl) && s.apiKey), channel: s.channel, autoCheck: s.autoCheck, deep: s.deep, serverUrl: normUrl(s.serverUrl), openShadow: !!s.debugOpenShadow };
    }
    case 'api': {
      const s = await getSettings();
      if (msg.op === 'check') return api('POST', '/api/gate/check', msg.body);
      if (msg.op === 'save') {
        const r = await api('POST', '/api/gate/save', msg.body);
        if (r.ok && r.data && r.data.url && r.data.url.startsWith('/')) r.data.url = normUrl(s.serverUrl) + r.data.url;
        return r;
      }
      if (msg.op === 'me') return api('GET', '/api/gate/me');
      return { ok: false, error: 'Unknown operation.' };
    }
    case 'test': return api('GET', '/api/gate/me', null, { serverUrl: msg.serverUrl, apiKey: msg.apiKey });
    case 'ev': // editor frame -> top frame
      if (sender.tab) chrome.tabs.sendMessage(sender.tab.id, { t: 'ev', ev: msg.ev, data: msg.data, frameId: sender.frameId }, { frameId: 0 }).catch(() => {});
      return null;
    case 'cmd': // top frame -> one editor frame
      if (!sender.tab) return { ok: false };
      try { return await chrome.tabs.sendMessage(sender.tab.id, { t: 'cmd', cmd: msg.cmd, data: msg.data }, { frameId: msg.frameId }) || { ok: false, reason: 'gone' }; }
      catch { return { ok: false, reason: 'gone' }; }
    default: return null;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true;
});
