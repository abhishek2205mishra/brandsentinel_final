// Printable review report: what was checked, every finding with its evidence, who decided what, and the clearance certificate.
const db = require('../db');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = (t) => (t ? new Date(t).toUTCString().replace('GMT', 'UTC') : '');

async function renderReport(item) {
  const version = await db.findOne('versions', { item_id: item.id, n: item.current_version });
  const [findings, decisions, certs, org] = await Promise.all([
    db.find('findings', { item_id: item.id, version_n: item.current_version }, { sort: { id: 1 } }),
    db.find('decisions', { item_id: item.id }, { sort: { id: 1 } }),
    db.find('certificates', { item_id: item.id, revoked: 0 }, { sort: { id: -1 }, limit: 1 }),
    db.get('orgs', item.org_id),
  ]);
  const users = await db.mapByIds('users', [item.author_id, ...decisions.map((d) => d.user_id)], ['name', 'role']);
  const real = findings.filter((f) => !f.advisory);
  const adv = findings.filter((f) => f.advisory);
  const cert = certs[0];
  const row = (f) => `<tr><td class="sev ${esc(f.severity)}">${esc(f.severity)}</td><td>${esc(f.category)}</td><td>${esc(f.message)}${f.matched ? `<div class="m">Flagged text: <code>${esc(f.matched)}</code></div>` : ''}</td><td><b>${esc(f.source_code || '')}</b>${f.source_quote ? `<div class="m">${esc(f.source_quote)}</div>` : ''}</td><td>${esc(f.status)}${f.status_reason ? `<div class="m">${esc(f.status_reason)}</div>` : ''}</td></tr>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Review report: ${esc(item.title)}</title>
<style>body{font:14px/1.5 system-ui,Segoe UI,Arial,sans-serif;color:#1f2937;max-width:900px;margin:24px auto;padding:0 16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:26px 0 8px;border-bottom:1px solid #e5e7eb;padding-bottom:4px}
.meta{color:#6b7280}.box{background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px;white-space:pre-wrap;word-break:break-word}
table{width:100%;border-collapse:collapse}th,td{border:1px solid #e5e7eb;padding:6px 8px;text-align:left;vertical-align:top;font-size:13px}th{background:#f3f4f6}
.m{color:#6b7280;font-size:12px}code{background:#f3f4f6;padding:0 3px;border-radius:3px}.sev{font-weight:700;text-transform:capitalize}.high{color:#b91c1c}.medium{color:#b45309}.low{color:#1d4ed8}
.ok{color:#047857;font-weight:600}.hash{font-family:ui-monospace,monospace;font-size:12px;word-break:break-all}
@media print{body{margin:0}a{color:inherit}}</style></head><body>
<h1>Brand review report</h1>
<div class="meta">${esc(org && org.name)} · generated ${esc(when(new Date().toISOString()))}</div>
<h2>Content</h2>
<p><b>${esc(item.title)}</b> · ${esc(item.channel)} · status <b>${esc(item.status)}</b> · risk <b>${esc(item.risk)}</b> · version ${item.current_version}<br>
Author: ${esc((users.get(item.author_id) || {}).name)} · Purpose: ${esc(item.intent)}${item.ai_generated ? ` · AI-assisted (${esc(item.ai_tool || 'tool not named')})` : ''}</p>
<div class="box">${esc(version && version.body)}</div>
<p class="hash">SHA-256: ${esc(version && version.content_hash)}</p>
<h2>Findings (${real.length})</h2>
${real.length ? `<table><thead><tr><th>Severity</th><th>Area</th><th>Issue</th><th>Evidence (source)</th><th>Outcome</th></tr></thead><tbody>${real.map(row).join('')}</tbody></table>` : '<p class="ok">No evidence-backed issues were found.</p>'}
${adv.length ? `<h2>Advisory notes (${adv.length})</h2><p class="meta">No approved source backs these, so they are suggestions only.</p><table><tbody>${adv.map(row).join('')}</tbody></table>` : ''}
<h2>Decisions</h2>
${decisions.length ? `<table><thead><tr><th>When</th><th>Who</th><th>Decision</th><th>Version</th><th>Reason</th></tr></thead><tbody>${decisions.map((d) => `<tr><td>${esc(when(d.created_at))}</td><td>${esc((users.get(d.user_id) || {}).name)} (${esc((users.get(d.user_id) || {}).role)})</td><td>${esc(d.decision)}</td><td>${d.version_n}</td><td>${esc(d.reason || '')}${d.override_reason ? `<div class="m">Override: ${esc(d.override_reason)}</div>` : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="meta">No decisions yet.</p>'}
<h2>Clearance certificate</h2>
${cert ? `<p class="ok">Issued ${esc(when(cert.issued_at))} for version ${cert.version_n}.</p>${cert.verification_code ? `<p>Public verification: <strong>${esc(cert.verification_code)}</strong> at ${esc((require('../config').publicUrl || '') + '/verify/' + cert.verification_code)}</p>` : ''}<p class="hash">Content hash: ${esc(cert.content_hash)}<br>Signature: ${esc(cert.signature)}</p>` : '<p class="meta">No certificate has been issued for this content.</p>'}
<p class="meta">This report supports review. It is not legal advice and can miss issues.</p>
</body></html>`;
}

module.exports = { renderReport };
