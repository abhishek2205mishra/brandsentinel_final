'use strict';
const $ = (id) => document.getElementById(id);
const norm = (u) => { try { const x = new URL(String(u).trim()); return /^https?:$/.test(x.protocol) ? x.origin + x.pathname.replace(/\/+$/, '') : ''; } catch { return ''; } };
const say = (kind, text) => { const s = $('status'); s.textContent = ''; if (!text) return; const d = document.createElement('span'); d.className = kind; d.textContent = text; s.append(d); };

async function load() {
  const s = await chrome.storage.local.get(['serverUrl', 'apiKey', 'channel', 'autoCheck', 'deep']);
  $('server').value = s.serverUrl || '';
  $('key').value = s.apiKey || '';
  $('channel').value = s.channel || 'social';
  $('auto').checked = s.autoCheck !== false;
  $('deep').checked = !!s.deep;
  if (s.serverUrl && s.apiKey) test(false);
}

async function test(announce = true) {
  const serverUrl = norm($('server').value), apiKey = $('key').value.trim();
  if (!serverUrl) return say('bad', 'Enter the address of your BrandSentinel server, for example https://your-app.onrender.com');
  if (!apiKey) return say('bad', 'Paste your API key (created on the Account page).');
  say('ok', 'Connecting… (a sleeping Render server can take up to a minute)');
  const r = await chrome.runtime.sendMessage({ t: 'test', serverUrl, apiKey });
  if (!r || !r.ok) return say('bad', (r && r.error) || 'Could not connect.');
  const d = r.data;
  say('ok', `Connected to ${d.organisation}${d.user ? ` as ${d.user.name} (${d.user.role})` : ''}. Limits: ${d.limits.per_minute}/min, ${d.limits.per_day}/day, ${d.limits.max_chars.toLocaleString()} characters per check.${d.ai.enabled ? ' AI assistant is on.' : ''}`);
}

$('save').addEventListener('click', async () => {
  const serverUrl = norm($('server').value);
  // Optional: lets the extension reach your server even if its CORS rules change. Declining is fine, so nothing waits for the answer.
  try { if (serverUrl) chrome.permissions.request({ origins: [new URL(serverUrl).origin + '/*'] }).catch(() => {}); } catch { /* not required */ }
  await chrome.storage.local.set({ serverUrl, apiKey: $('key').value.trim() });
  await test();
});
$('eye').addEventListener('click', () => { const k = $('key'); const show = k.type === 'password'; k.type = show ? 'text' : 'password'; $('eye').textContent = show ? 'Hide' : 'Show'; });
$('auto').addEventListener('change', () => chrome.storage.local.set({ autoCheck: $('auto').checked }));
$('deep').addEventListener('change', () => chrome.storage.local.set({ deep: $('deep').checked }));
$('channel').addEventListener('change', () => chrome.storage.local.set({ channel: $('channel').value }));
$('open').addEventListener('click', () => { const u = norm($('server').value); if (u) chrome.tabs.create({ url: u + '/account' }); else say('bad', 'Enter your server address first.'); });
$('off').addEventListener('click', async () => { await chrome.storage.local.remove(['apiKey']); $('key').value = ''; say('ok', 'The key was removed from this browser. Revoke it on your Account page too if it may have leaked.'); });
load();
