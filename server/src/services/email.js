// Email delivery over HTTPS APIs only (free tiers: Brevo 300/day, Resend 100/day). Render's free plan blocks SMTP ports,
// so SMTP is deliberately not used. Mail is queued in the database and retried with back-off, so a slow or failing
// provider never slows down or breaks an approval.
const db = require('../db');
const config = require('../config');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const BACKOFF_MIN = [1, 5, 30]; // minutes before attempts 2, 3, 4
const MAX_ATTEMPTS = 4;

const enabled = () => config.emailProvider !== 'none' && !!config.emailFrom && (config.emailProvider === 'brevo' ? !!config.brevoKey : config.emailProvider === 'resend' ? !!config.resendKey : false);
const info = () => ({
  provider: config.emailProvider, configured: enabled(), from: config.emailFrom || null,
  problem: config.emailProvider === 'none' ? 'No email provider is configured (set BREVO_API_KEY or RESEND_API_KEY, and EMAIL_FROM).' : !config.emailFrom ? 'EMAIL_FROM is not set.' : !enabled() ? 'The provider API key is missing.' : null,
});

function render(subject, text, link) {
  const url = link ? (/^https?:\/\//.test(link) ? link : (config.publicUrl || '') + link) : '';
  const button = url ? `<p style="margin:22px 0 4px"><a href="${esc(url)}" style="background:#6d28d9;color:#fff;text-decoration:none;padding:11px 20px;border-radius:10px;font-weight:600;display:inline-block">Open in BrandSentinel</a></p>` : '';
  return `<!doctype html><html><body style="margin:0;background:#f4f3fb;font-family:Segoe UI,Arial,sans-serif;color:#1f2937"><div style="max-width:540px;margin:0 auto;padding:24px 16px">
<div style="font-weight:700;font-size:18px;color:#6d28d9;margin-bottom:14px">BrandSentinel</div>
<div style="background:#fff;border-radius:14px;padding:24px;border:1px solid #e5e7eb"><h2 style="margin:0 0 10px;font-size:17px">${esc(subject)}</h2><p style="margin:0;line-height:1.55;font-size:15px">${esc(text)}</p>${button}</div>
<p style="color:#6b7280;font-size:12px;margin:14px 4px">You get this because you use BrandSentinel. You can turn email notifications off on your Account page.</p></div></body></html>`;
}

async function deliver(row) {
  const html = render(row.subject, row.body, row.link);
  if (config.emailProvider === 'brevo') {
    const res = await fetch((config.emailBaseUrl || 'https://api.brevo.com') + '/v3/smtp/email', {
      method: 'POST', headers: { 'api-key': config.brevoKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender: { name: config.emailFromName, email: config.emailFrom }, to: [{ email: row.to_email, name: row.to_name || undefined }], subject: row.subject, htmlContent: html, textContent: row.body }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Brevo ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return;
  }
  if (config.emailProvider === 'resend') {
    const res = await fetch((config.emailBaseUrl || 'https://api.resend.com') + '/emails', {
      method: 'POST', headers: { authorization: `Bearer ${config.resendKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: `${config.emailFromName} <${config.emailFrom}>`, to: [row.to_email], subject: row.subject, html, text: row.body }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return;
  }
  throw new Error('No email provider configured.');
}

// Queue one email. Never throws: email problems must not break the action that caused them.
async function enqueue({ orgId, userId = null, to, name = null, subject, text, link = null, kind = 'notification' }) {
  try {
    if (!enabled()) return null;
    const org = await db.get('orgs', orgId);
    const st = org ? db.json(org.settings, {}) : {};
    if (st.email && st.email.enabled === false) return null;
    if (userId) {
      const u = await db.get('users', userId);
      if (!u || u.email_notifications === false || u.org_id !== orgId) return null;
      to = u.email; name = u.name;
    }
    if (!to) return null;
    const id = await db.insert('email_outbox', {
      org_id: orgId, user_id: userId, to_email: to, to_name: name, subject: String(subject).slice(0, 150), body: String(text).slice(0, 1500), link, kind,
      status: 'queued', attempts: 0, last_error: null, provider: config.emailProvider, created_at: db.now(), next_try_at: db.now(), sent_at: null,
    });
    setImmediate(() => processQueue(5).catch(() => {}));
    return id;
  } catch (e) { console.error('email enqueue failed:', e.message); return null; }
}

const enqueueForUsers = (orgId, userIds, text, link, kind) =>
  Promise.all([...new Set(userIds.filter(Boolean))].map((uid) => enqueue({ orgId, userId: uid, subject: text.length > 90 ? text.slice(0, 87) + '…' : text, text, link, kind })));

// Runs are serialised so a send triggered by a new message and the timer never overlap or double-send.
let chain = Promise.resolve();
function processQueue(limit = 20) {
  const run = chain.then(() => processOnce(limit));
  chain = run.catch(() => {});
  return run;
}
async function processOnce(limit) {
  if (!enabled()) return { sent: 0, failed: 0 };
  let sent = 0, failed = 0;
  const due = await db.find('email_outbox', { status: 'queued', next_try_at: { $lte: db.now() } }, { sort: { id: 1 }, limit });
  for (const row of due) {
    try {
      await deliver(row);
      await db.update('email_outbox', row.id, { status: 'sent', sent_at: db.now(), attempts: row.attempts + 1, last_error: null });
      sent++;
    } catch (e) {
      const attempts = row.attempts + 1;
      const dead = attempts >= MAX_ATTEMPTS;
      await db.update('email_outbox', row.id, { status: dead ? 'failed' : 'queued', attempts, last_error: String(e.message).slice(0, 300), next_try_at: new Date(Date.now() + BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)] * 60000).toISOString() });
      failed++;
    }
  }
  return { sent, failed };
}

async function stats(orgId) {
  const since = new Date(Date.now() - 86400000).toISOString();
  const rows = await db.find('email_outbox', { org_id: orgId, created_at: { $gte: since } }, { sort: { id: -1 }, limit: 200 });
  const c = (s) => rows.filter((r) => r.status === s).length;
  return { last_24h: { queued: c('queued'), sent: c('sent'), failed: c('failed') }, recent: rows.slice(0, 15).map((r) => ({ id: r.id, to: r.to_email, subject: r.subject, status: r.status, attempts: r.attempts, last_error: r.last_error, created_at: r.created_at })) };
}

module.exports = { enabled, info, enqueue, enqueueForUsers, processQueue, stats, render };
