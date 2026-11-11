import { useEffect, useState, useCallback } from 'react';
import { api, getToken, apiUrl } from '../api';
import { useAuth } from '../auth';
import { Loading, Tabs, Badge, Field, Empty, useToast, fmtDate } from '../components/ui';

function LlmStatus({ llm, admin }) {
  const toast = useToast();
  const [r, setR] = useState(null);
  const [busy, setBusy] = useState(false);
  const test = async () => { setBusy(true); try { setR(await api.post('/api/admin/llm/test')); } catch (e) { toast(e.message, 'err'); } setBusy(false); };
  return (
    <div className="small muted" style={{ margin: '4px 0 10px' }}>
      {llm.configured ? <>Provider <span className="mono">{llm.provider}</span>, model <span className="mono">{llm.model}</span>. Redacted text is sent to <span className="mono">{llm.host}</span>. If it is unreachable, BrandSentinel keeps using its rules.</> : <>No AI provider key is set on the server. Add <span className="mono">GEMINI_API_KEY</span> or <span className="mono">GROQ_API_KEY</span> to enable this.</>}
      {admin && llm.configured && <div style={{ marginTop: 6 }}><button className="btn sm" disabled={busy} onClick={test}>Test connection</button> {r && (r.ok ? <Badge kind="ok">working · {r.latency_ms} ms</Badge> : <Badge kind="high">{r.error || 'failed'}</Badge>)}</div>}
    </div>
  );
}

function SystemCard() {
  const [s, setS] = useState(null);
  useEffect(() => { api.get('/api/admin/system').then(setS).catch(() => {}); }, []);
  if (!s) return null;
  return (
    <section className="card">
      <h2>System status</h2>
      <div className="small">Database <Badge kind={s.database.ok ? 'ok' : 'high'}>{s.database.driver} · {s.database.ok ? 'connected' : 'down'}</Badge></div>
      {s.semantic && <div className="small" style={{ marginTop: 6 }}>Semantic search <Badge kind={s.semantic.enabled ? 'ok' : ''}>{s.semantic.enabled ? s.semantic.retrieval : 'off'}</Badge></div>}
      {s.public_url && <div className="small" style={{ marginTop: 6 }}>Public address <span className="mono">{s.public_url}</span></div>}
      <div className="small" style={{ marginTop: 6 }}>AI provider <Badge kind={s.llm.configured ? 'ok' : ''}>{s.llm.configured ? `${s.llm.provider} configured` : 'not configured'}</Badge></div>
      <p className="small muted" style={{ marginTop: 8 }}>Version {s.version} · {s.env} · Node {s.node} · up {Math.round(s.uptime_s / 60)} min · sign-up {s.registration_open ? 'open' : 'closed'}</p>
    </section>
  );
}

function EmailCard() {
  const toast = useToast();
  const [e, setE] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.get('/api/admin/email').then(setE).catch(() => {});
  useEffect(() => { load(); }, []);
  if (!e) return null;
  const test = async () => { setBusy(true); try { const r = await api.post('/api/admin/email/test'); toast(r.ok ? 'Test email sent. Check your inbox.' : (r.error || 'The test email could not be sent yet. It will be retried.'), r.ok ? 'ok' : 'err'); } catch (x) { toast(x.message, 'err'); } setBusy(false); load(); };
  return (
    <section className="card">
      <h2>Email notifications</h2>
      {e.configured ? <p className="small">Provider <Badge kind="ok">{e.provider}</Badge> · sending as <span className="mono">{e.from}</span>. Last 24 h: {e.last_24h.sent} sent, {e.last_24h.queued} waiting, {e.last_24h.failed} failed.</p>
        : <p className="small muted">{e.problem || 'Email is not configured.'} In-app notifications keep working. See the deployment guide to add a free Brevo or Resend key.</p>}
      {e.configured && <button className="btn sm" disabled={busy} onClick={test}>Send me a test email</button>}
    </section>
  );
}

function SettingsTab({ admin }) {
  const toast = useToast();
  const [s, setS] = useState(null);
  const [terms, setTerms] = useState('');
  const [days, setDays] = useState(365);
  const load = useCallback(() => api.get('/api/admin/settings').then((d) => { setS(d); setTerms((d.settings.confidential_terms || []).join('\n')); setDays(d.settings.retention_days || 365); }), []);
  useEffect(() => { load(); }, [load]);
  if (!s) return <Loading />;
  const st = s.settings;
  const save = (patch, msg = 'Saved.') => api.put('/api/admin/settings', patch).then(() => { toast(msg); load(); }).catch((e) => toast(e.message, 'err'));
  const packs = [['wcag', 'WCAG accessibility'], ['asci', 'ASCI advertising code'], ['cpa', 'Consumer Protection Act'], ['fssai', 'FSSAI food claims'], ['euai', 'EU AI Act transparency']];
  const origin = (import.meta.env.VITE_API_URL || window.location.origin.replace('5173', '4000')).replace(/\/$/, '');

  return (
    <div className="grid cols-2" style={{ alignItems: 'start' }}>
      <div className="stack">
        <section className="card">
          <h2>AI and confidentiality</h2>
          <label className="check"><input type="checkbox" disabled={!admin} checked={!!st.confidential_mode} onChange={(e) => save({ confidential_mode: e.target.checked })} /> Confidential Mode (block all external AI services)</label>
          <p className="small muted">With this on, no content can be sent to any external AI service, even if one is configured.</p>
          <label className="check"><input type="checkbox" disabled={!admin} checked={!!(st.llm && st.llm.enabled)} onChange={(e) => save({ llm: { ...st.llm, enabled: e.target.checked } })} /> Use the AI assistant (Gemini / Groq, redacted text only)</label>
          <LlmStatus llm={s.llm} admin={admin} />
          <Field label="Confidential terms (one per line)" hint="Masked as [CONFIDENTIAL] before any text can reach a language model (for example unreleased project names).">
            <textarea rows={4} disabled={!admin} value={terms} onChange={(e) => setTerms(e.target.value)} />
          </Field>
          {admin && <button className="btn" style={{ marginTop: 8 }} onClick={() => save({ confidential_terms: terms.split('\n') })}>Save terms</button>}
        </section>
        <section className="card">
          <h2>Regulatory packs in use</h2>
          {packs.map(([k, l]) => (
            <label className="check" key={k} style={{ margin: '6px 0' }}>
              <input type="checkbox" disabled={!admin} checked={(st.packs || []).includes(k)} onChange={(e) => save({ packs: e.target.checked ? [...(st.packs || []), k] : (st.packs || []).filter((x) => x !== k) })} /> {l}
            </label>))}
        </section>
      </div>
      <div className="stack">
        {admin && <SystemCard />}
        {admin && <EmailCard />}
        {s.api_key && (
          <section className="card">
            <h2>Gate API</h2>
            <p className="small muted">Lets agencies, CMS plugins and other AI tools check content before delivery, and verify a clearance certificate before publishing.</p>
            <div className="source"><div className="mono" style={{ wordBreak: 'break-all' }}>x-api-key: {s.api_key}</div></div>
            <pre className="content-box code" style={{ whiteSpace: 'pre-wrap', maxHeight: 240, marginTop: 10 }}>{`# Review content
curl -X POST ${origin}/api/gate/review \\
  -H "x-api-key: <key>" -H "content-type: application/json" \\
  -d '{"title":"Agency draft","text":"Our coffee is the best!"}'

# Verify before publishing
curl -X POST ${origin}/api/gate/verify \\
  -H "x-api-key: <key>" -H "content-type: application/json" \\
  -d '{"text":"<exact approved text>"}'`}</pre>
            {admin && <button className="btn" style={{ marginTop: 10 }} onClick={() => { if (window.confirm('Rotate the key? The old key stops working immediately.')) api.post('/api/admin/api-key').then(() => { toast('New key created.'); load(); }); }}>Rotate key</button>}
          </section>)}
        {admin && (
          <section className="card">
            <h2>Your data</h2>
            <p className="small muted">Export everything as JSON, or permanently delete approved or rejected content older than a number of days.</p>
            <div className="row">
              <button className="btn" onClick={async () => { const r = await fetch(apiUrl('/api/admin/export'), { headers: { Authorization: `Bearer ${getToken()}` } }); const b = await r.blob(); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'brandsentinel-export.json'; a.click(); }}>Export data</button>
              <input type="number" min={7} value={days} onChange={(e) => setDays(e.target.value)} aria-label="Days" style={{ width: 90 }} />
              <button className="btn danger" onClick={() => { if (window.confirm(`Permanently delete finished content older than ${days} days?`)) api.post('/api/admin/purge', { older_than_days: Number(days) }).then((r) => toast(`${r.deleted} item(s) deleted.`)).catch((e) => toast(e.message, 'err')); }}>Delete old content</button>
            </div>
          </section>)}
      </div>
    </div>
  );
}

function AuditTab() {
  const [d, setD] = useState(null);
  useEffect(() => { api.get('/api/admin/audit').then(setD); }, []);
  if (!d) return <Loading />;
  return (
    <>
      <div className={`notice ${d.chain.ok ? 'ok' : 'err'}`} style={{ marginBottom: 12 }}>
        {d.chain.ok ? `Audit chain verified: ${d.chain.checked} entries, none altered.` : `Audit chain broken at entry #${d.chain.broken_at}. The log may have been tampered with.`}
      </div>
      <div className="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th><th>Hash</th></tr></thead><tbody>
        {d.rows.map((r) => <tr key={r.id}><td>{fmtDate(r.ts)}</td><td>{r.user_name || 'system'}</td><td><Badge>{r.action}</Badge></td><td className="small mono" style={{ wordBreak: 'break-word' }}>{r.detail || ''}</td><td className="mono muted">{r.hash.slice(0, 10)}…</td></tr>)}</tbody></table></div>
    </>
  );
}

function LedgerTab() {
  const [d, setD] = useState(null);
  useEffect(() => { api.get('/api/admin/ledger').then(setD); }, []);
  if (!d) return <Loading />;
  return (
    <>
      <div className="grid cols-3" style={{ marginBottom: 14 }}>
        <div className="tile"><div className="num">{d.totals.calls}</div><div className="lbl">Processing events recorded</div></div>
        <div className="tile"><div className="num" style={{ color: d.totals.external ? 'var(--high)' : 'var(--ok)' }}>{d.totals.external}</div><div className="lbl">Sent to an external service</div></div>
        <div className="tile"><div className="num">{d.totals.redactions}</div><div className="lbl">Values redacted before AI use</div></div>
      </div>
      {d.rows.length === 0 ? <Empty>No events yet.</Empty> : (
        <div className="table-wrap"><table><thead><tr><th>When</th><th>Content</th><th>Service</th><th>Purpose</th><th>Redacted</th><th>External</th><th>Note</th></tr></thead><tbody>
          {d.rows.map((r) => <tr key={r.id}><td>{fmtDate(r.ts)}</td><td>{r.title || '–'}</td><td>{r.service}<div className="mono muted">{r.model}</div></td><td>{r.purpose}</td><td>{r.redactions}</td><td>{r.sent_external ? <Badge kind="high">yes</Badge> : <Badge kind="ok">no</Badge>}</td><td className="small">{r.note}</td></tr>)}</tbody></table></div>)}
    </>
  );
}

function UsersTab() {
  const toast = useToast();
  const { user } = useAuth();
  const [list, setList] = useState(null);
  const [f, setF] = useState({ name: '', email: '', password: '', role: 'creator' });
  const load = useCallback(() => api.get('/api/auth/users').then(setList), []);
  useEffect(() => { load(); }, [load]);
  const ROLES = ['admin', 'creator', 'reviewer', 'approver', 'agency', 'auditor'];
  const add = async (e) => { e.preventDefault(); try { await api.post('/api/auth/users', f); toast('User created.'); setF({ name: '', email: '', password: '', role: 'creator' }); load(); } catch (ex) { toast(ex.message, 'err'); } };
  if (!list) return <Loading />;
  return (
    <div className="grid cols-2" style={{ alignItems: 'start' }}>
      <section className="card"><h2>Team</h2>
        <div className="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th></tr></thead><tbody>
          {list.map((u) => <tr key={u.id}><td>{u.name}</td><td>{u.email}</td><td>
            <select aria-label={`Role for ${u.name}`} value={u.role} disabled={u.id === user.id} onChange={(e) => api.put(`/api/auth/users/${u.id}`, { role: e.target.value }).then(() => { toast('Role updated.'); load(); }).catch((x) => toast(x.message, 'err'))}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select></td></tr>)}</tbody></table></div></section>
      <form className="card stack" onSubmit={add}><h2>Add a person</h2>
        <Field label="Name"><input type="text" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Email"><input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Temporary password" hint="At least 8 characters."><input type="password" required minLength={8} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
        <Field label="Role"><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select></Field>
        <button className="btn primary">Create user</button></form>
    </div>
  );
}

export default function Governance() {
  const { user } = useAuth();
  const admin = user.role === 'admin';
  const [tab, setTab] = useState('ledger');
  const tabs = [{ id: 'ledger', label: 'AI disclosure ledger' }, { id: 'audit', label: 'Audit log' }, ...(admin || user.role === 'auditor' ? [{ id: 'settings', label: 'Settings and privacy' }] : []), ...(admin ? [{ id: 'users', label: 'People and roles' }] : [])];
  return (
    <>
      <div className="page-head"><div><h1>Governance</h1><p className="muted">Proof of what AI touched, who decided what, and the controls that protect confidential material.</p></div></div>
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'ledger' && <LedgerTab />}
      {tab === 'audit' && <AuditTab />}
      {tab === 'settings' && <SettingsTab admin={admin} />}
      {tab === 'users' && admin && <UsersTab />}
    </>
  );
}
