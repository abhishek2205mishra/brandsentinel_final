import { useCallback, useEffect, useState } from 'react';
import { api, apiUrl, getToken } from '../api';
import { useAuth } from '../auth';
import { Field, useToast, fmtDate, Badge, Empty } from '../components/ui';

function Keys() {
  const toast = useToast();
  const [d, setD] = useState(null);
  const [name, setName] = useState('Chrome extension');
  const [fresh, setFresh] = useState(null);
  const load = useCallback(() => api.get('/api/keys').then(setD).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);
  if (!d) return null;
  const create = async (e) => { e.preventDefault(); try { setFresh(await api.post('/api/keys', { name })); load(); } catch (ex) { toast(ex.message, 'err'); } };
  const revoke = async (k) => { if (!window.confirm(`Revoke "${k.name}"? Anything using it stops working immediately.`)) return; try { await api.del(`/api/keys/${k.id}`); toast('Key revoked.'); load(); } catch (ex) { toast(ex.message, 'err'); } };
  const copy = async () => { try { await navigator.clipboard.writeText(fresh.key); toast('Copied.'); } catch { toast('Select the key and copy it manually.', 'err'); } };
  const download = async () => {
    try {
      const r = await fetch(apiUrl('/api/keys/extension.zip'), { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!r.ok) throw new Error('The extension is not part of this deployment.');
      const a = document.createElement('a'); a.href = URL.createObjectURL(await r.blob()); a.download = 'brandsentinel-extension.zip'; a.click(); URL.revokeObjectURL(a.href);
    } catch (ex) { toast(ex.message, 'err'); }
  };
  return (
    <div className="card stack" style={{ maxWidth: 720 }}>
      <h2>Review at the source: browser extension</h2>
      <p className="small muted">The Chrome extension checks what you write in social, CMS and email editors and shows findings with their guideline citation, without leaving the page. It uses a personal key, so every check is recorded in your audit log under your name.</p>
      <ol className="small">
        <li><button type="button" className="btn sm" onClick={download}>Download the extension (.zip)</button> and unzip it.</li>
        <li>Open <span className="mono">chrome://extensions</span>, turn on Developer mode, choose “Load unpacked”, and pick the unzipped folder.</li>
        <li>Create a key below, then paste it with this server address ({window.location.origin}) into the extension popup.</li>
      </ol>
      {!d.allowed && <div className="notice warn">Your role cannot create keys.</div>}
      {d.allowed && (
        <form className="row" onSubmit={create}>
          <input aria-label="Key name" required value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 260 }} />
          <button className="btn primary">Create key</button>
        </form>)}
      {fresh && <div className="notice ok" role="status"><strong>Copy this key now. It is shown only once.</strong><div className="mono" style={{ wordBreak: 'break-all', margin: '6px 0' }}>{fresh.key}</div><button className="btn sm" onClick={copy}>Copy</button> <button className="btn sm" onClick={() => setFresh(null)}>I have copied it</button></div>}
      {d.keys.length === 0 ? <Empty>No keys yet.</Empty> : (
        <div className="table-wrap"><table><thead><tr><th>Name</th><th>Key</th><th>Created</th><th>Last used</th><th>Uses</th><th /></tr></thead>
          <tbody>{d.keys.map((k) => <tr key={k.id}><td>{k.name}</td><td className="mono">{k.prefix}…</td><td>{fmtDate(k.created_at)}</td><td>{k.last_used_at ? fmtDate(k.last_used_at) : 'never'}</td><td>{k.use_count ?? 0}</td><td>{k.revoked_at ? <Badge>revoked</Badge> : <button className="btn sm danger" onClick={() => revoke(k)}>Revoke</button>}</td></tr>)}</tbody></table></div>)}
    </div>
  );
}

function Notifications() {
  const { user } = useAuth();
  const toast = useToast();
  const [users, setUsers] = useState([]);
  const [on, setOn] = useState(user.email_notifications !== false);
  const [away, setAway] = useState(user.away || null);
  const [f, setF] = useState({ to: '', until: '' });
  useEffect(() => { api.get('/api/auth/users').then(setUsers).catch(() => {}); }, []);
  const staff = users.filter((u) => ['reviewer', 'approver', 'admin'].includes(u.role) && u.id !== user.id);
  const save = async (v) => { setOn(v); try { await api.put('/api/auth/me/prefs', { email_notifications: v }); toast(v ? 'Email notifications on.' : 'Email notifications off.'); } catch (e) { toast(e.message, 'err'); } };
  const setAwayCover = async (e) => {
    e.preventDefault();
    try { const r = await api.put('/api/workflows/me/away', { delegate_to_id: f.to, until: new Date(`${f.until}T23:59:00`).toISOString() }); setAway(r.away); toast('Away cover set.'); } catch (ex) { toast(ex.message, 'err'); }
  };
  const clear = async () => { try { await api.put('/api/workflows/me/away', {}); setAway(null); toast('Away cover cleared.'); } catch (ex) { toast(ex.message, 'err'); } };
  const reviewer = ['reviewer', 'approver', 'admin'].includes(user.role);
  return (
    <div className="card stack" style={{ maxWidth: 460 }}>
      <h2>Email and cover</h2>
      <label className="row"><input type="checkbox" checked={on} onChange={(e) => save(e.target.checked)} /> Email me when something needs my attention</label>
      {reviewer && (away ? (
        <div className="notice">Away: <strong>{away.delegate_name || (users.find((u) => u.id === away.delegate_to_id) || {}).name || 'a colleague'}</strong> covers your approval steps until {fmtDate(away.until)}. <button className="btn sm" onClick={clear}>I am back</button></div>
      ) : (
        <form className="stack" onSubmit={setAwayCover}>
          <h3>Going away?</h3>
          <Field label="Who covers for you"><select required value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })}><option value="">Choose…</option>{staff.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.role})</option>)}</select></Field>
          <Field label="Back on"><input type="date" required min={new Date(Date.now() + 86400000).toISOString().slice(0, 10)} value={f.until} onChange={(e) => setF({ ...f, until: e.target.value })} /></Field>
          <button className="btn">Set away cover</button>
        </form>))}
    </div>
  );
}

export default function Account() {
  const { user, org } = useAuth();
  const toast = useToast();
  const [f, setF] = useState({ current: '', next: '', again: '' });
  const [busy, setBusy] = useState(false);
  const save = async (e) => {
    e.preventDefault();
    if (f.next !== f.again) return toast('The new passwords do not match.', 'err');
    setBusy(true);
    try { await api.post('/api/auth/change-password', { current: f.current, next: f.next }); toast('Password changed.'); setF({ current: '', next: '', again: '' }); }
    catch (ex) { toast(ex.message, 'err'); }
    setBusy(false);
  };
  return (
    <>
      <div className="page-head"><div><h1>Your account</h1><p className="muted">{user.name} · {user.email} · {user.role} at {org && org.name}</p></div></div>
      <form className="card stack" onSubmit={save} style={{ maxWidth: 460 }}>
        <h2>Change password</h2>
        <Field label="Current password"><input type="password" required autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} /></Field>
        <Field label="New password" hint="At least 8 characters."><input type="password" required minLength={8} autoComplete="new-password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} /></Field>
        <Field label="Repeat new password"><input type="password" required minLength={8} autoComplete="new-password" value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} /></Field>
        <button className="btn primary" disabled={busy}>Update password</button>
      </form>
      <div className="stack" style={{ marginTop: 16 }}><Notifications /><Keys /></div>
    </>
  );
}
