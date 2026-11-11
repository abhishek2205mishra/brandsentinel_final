import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Loading, Empty, Badge, Modal, Field, Tabs, useToast, fmtDate } from '../components/ui';

const blankStep = () => ({ name: '', assignee_role: 'reviewer', assignee_group: '', min_approvals: 1, sla_hours: 24, escalate_role: 'approver', escalate_group: '' });
const blank = () => ({ name: '', description: '', priority: 50, active: true, match: { channels: [], risks: [], claim_types: [], categories: [], ai_generated: false }, steps: [blankStep()] });

function Multi({ label, options, value, onChange, hint }) {
  const toggle = (o) => onChange(value.includes(o) ? value.filter((x) => x !== o) : [...value, o]);
  return (
    <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend style={{ fontWeight: 700, fontSize: '.85rem' }}>{label}</legend>
      <div className="chips">{options.map((o) => <button type="button" key={o} className="chip" aria-pressed={value.includes(o)} onClick={() => toggle(o)}>{o}</button>)}</div>
      <small className="muted">{hint || 'Leave empty to match any.'}</small>
    </fieldset>
  );
}

function Editor({ initial, options, groups, onClose, onSaved }) {
  const toast = useToast();
  const [w, setW] = useState(initial);
  const [busy, setBusy] = useState(false);
  const set = (patch) => setW((x) => ({ ...x, ...patch }));
  const setStep = (i, patch) => set({ steps: w.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const move = (i, d) => { const a = [...w.steps]; const j = i + d; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; set({ steps: a }); };
  const save = async (e) => {
    e.preventDefault(); setBusy(true);
    try {
      const r = w.id ? await api.put(`/api/workflows/${w.id}`, w) : await api.post('/api/workflows', w);
      toast('Workflow saved.');
      (r.warnings || []).forEach((m) => toast(m, 'err'));
      onSaved();
    } catch (ex) { toast(ex.message, 'err'); }
    setBusy(false);
  };
  return (
    <Modal title={w.id ? 'Edit workflow' : 'New workflow'} onClose={onClose}>
      <form className="stack" onSubmit={save}>
        <Field label="Name"><input required minLength={3} value={w.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Health claims: legal review, then approver" /></Field>
        <Field label="Description (optional)"><input value={w.description || ''} onChange={(e) => set({ description: e.target.value })} /></Field>
        <h3>When does it apply?</h3>
        <Multi label="Channels" options={options.channels} value={w.match.channels} onChange={(v) => set({ match: { ...w.match, channels: v } })} />
        <Multi label="Risk levels" options={options.risks} value={w.match.risks} onChange={(v) => set({ match: { ...w.match, risks: v } })} />
        <Multi label="Claim types found in the content" options={options.claim_types} value={w.match.claim_types} onChange={(v) => set({ match: { ...w.match, claim_types: v } })} hint="For example “health” sends any content with a health claim down this chain." />
        <label className="row"><input type="checkbox" checked={!!w.match.ai_generated} onChange={(e) => set({ match: { ...w.match, ai_generated: e.target.checked } })} /> Only content declared as AI-generated</label>
        <Field label="Priority" hint="If several workflows match, the highest priority wins (then the most specific)."><input type="number" min="0" max="1000" value={w.priority} onChange={(e) => set({ priority: e.target.value })} style={{ maxWidth: 120 }} /></Field>
        <h3>Approval steps (in order)</h3>
        {w.steps.map((s, i) => (
          <div className="card stack" key={i} style={{ background: 'var(--surface-2)' }}>
            <div className="row between"><strong>Step {i + 1}</strong>
              <span className="row"><button type="button" className="btn sm" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move step up">↑</button><button type="button" className="btn sm" onClick={() => move(i, 1)} disabled={i === w.steps.length - 1} aria-label="Move step down">↓</button>
                <button type="button" className="btn sm danger" disabled={w.steps.length === 1} onClick={() => set({ steps: w.steps.filter((_, j) => j !== i) })}>Remove</button></span></div>
            <Field label="Step name"><input required value={s.name} onChange={(e) => setStep(i, { name: e.target.value })} placeholder="e.g. Legal review" /></Field>
            <div className="grid cols-3">
              <Field label="Minimum role"><select value={s.assignee_role} onChange={(e) => setStep(i, { assignee_role: e.target.value })}>{options.roles.map((r) => <option key={r}>{r}</option>)}</select></Field>
              <Field label="Group (optional)"><input list="bs-groups" value={s.assignee_group} onChange={(e) => setStep(i, { assignee_group: e.target.value })} placeholder="e.g. legal" /></Field>
              <Field label="Approvals needed"><input type="number" min="1" max="5" value={s.min_approvals} onChange={(e) => setStep(i, { min_approvals: e.target.value })} /></Field>
            </div>
            <div className="grid cols-3">
              <Field label="SLA (hours, 0 = none)"><input type="number" min="0" max="720" value={s.sla_hours} onChange={(e) => setStep(i, { sla_hours: e.target.value })} /></Field>
              <Field label="Escalate to role"><select value={s.escalate_role} onChange={(e) => setStep(i, { escalate_role: e.target.value })}><option value="">(admins only)</option>{options.roles.map((r) => <option key={r}>{r}</option>)}</select></Field>
              <Field label="Escalation group (optional)"><input list="bs-groups" value={s.escalate_group} onChange={(e) => setStep(i, { escalate_group: e.target.value })} /></Field>
            </div>
          </div>))}
        <datalist id="bs-groups">{groups.map((g) => <option key={g.name} value={g.name} />)}</datalist>
        <div className="row"><button type="button" className="btn" disabled={w.steps.length >= 6} onClick={() => set({ steps: [...w.steps, blankStep()] })}>+ Add step</button></div>
        <p className="small muted">Authors can never approve their own content, and one person cannot approve two steps of the same chain. Overdue steps escalate; nothing is ever approved automatically.</p>
        <div className="row"><button className="btn primary" disabled={busy}>Save workflow</button><button type="button" className="btn" onClick={onClose}>Cancel</button></div>
      </form>
    </Modal>
  );
}

function Preview({ options }) {
  const [q, setQ] = useState({ channel: 'social', risk: 'low', ai_generated: false, claim_types: [] });
  const [r, setR] = useState(null);
  const run = () => api.post('/api/workflows/preview', q).then(setR).catch(() => {});
  return (
    <div className="card stack">
      <h2>Which workflow would apply?</h2>
      <div className="row">
        <select aria-label="Channel" value={q.channel} onChange={(e) => setQ({ ...q, channel: e.target.value })}>{options.channels.map((c) => <option key={c}>{c}</option>)}</select>
        <select aria-label="Risk" value={q.risk} onChange={(e) => setQ({ ...q, risk: e.target.value })}>{options.risks.map((c) => <option key={c}>{c}</option>)}</select>
        <label className="row"><input type="checkbox" checked={q.ai_generated} onChange={(e) => setQ({ ...q, ai_generated: e.target.checked })} /> AI-generated</label>
      </div>
      <Multi label="Claim types present" options={options.claim_types} value={q.claim_types} onChange={(v) => setQ({ ...q, claim_types: v })} hint="Pick what the content contains." />
      <div><button className="btn" onClick={run}>Test</button></div>
      {r && <div className="notice">{r.workflow ? <>Would use <strong>{r.workflow.name}</strong>: {r.workflow.steps.map((s) => s.name).join(' → ')}</> : r.note}</div>}
    </div>
  );
}

export default function Workflows() {
  const { user } = useAuth();
  const toast = useToast();
  const isAdmin = user.role === 'admin';
  const [d, setD] = useState(null);
  const [sla, setSla] = useState(null);
  const [users, setUsers] = useState([]);
  const [tab, setTab] = useState('workflows');
  const [edit, setEdit] = useState(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => {
    api.get('/api/workflows').then(setD).catch((e) => setErr(e.message));
    api.get('/api/workflows/sla').then(setSla).catch(() => {});
    api.get('/api/auth/users').then(setUsers).catch(() => {});
  }, []);
  useEffect(load, [load]);
  if (err) return <div className="notice err">{err}</div>;
  if (!d) return <Loading />;

  const act = async (fn, msg) => { try { await fn(); if (msg) toast(msg); load(); } catch (e) { toast(e.message, 'err'); } };
  const setGroups = (u, text) => act(() => api.put(`/api/workflows/users/${u.id}/groups`, { groups: text.split(',').map((x) => x.trim()).filter(Boolean) }), 'Groups saved.');
  const staff = users.filter((u) => ['reviewer', 'approver', 'admin'].includes(u.role));

  return (
    <>
      <div className="page-head"><div><h1>Approval workflows</h1><p className="muted">Design who must approve what. Content that matches a workflow follows its chain with deadlines and escalation; everything else uses the standard risk-based approval.</p></div>
        {isAdmin && <button className="btn primary" onClick={() => setEdit(blank())}>+ New workflow</button>}</div>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'workflows', label: `Workflows (${d.workflows.length})` }, { id: 'sla', label: `Deadlines${sla && sla.overdue ? ` (${sla.overdue} overdue)` : ''}` }, { id: 'groups', label: 'Groups' }, ...(isAdmin ? [{ id: 'templates', label: 'Templates' }] : [])]} />

      {tab === 'workflows' && (
        <div className="stack">
          {d.workflows.length === 0 && <Empty>No workflows yet. {isAdmin ? 'Start from a template or create one.' : ''}</Empty>}
          {d.workflows.map((w) => (
            <div className="card stack" key={w.id}>
              <div className="row between"><div><h2 style={{ margin: 0 }}>{w.name} {w.active ? <Badge kind="ok">active</Badge> : <Badge>paused</Badge>}</h2>{w.description && <p className="small muted" style={{ margin: '4px 0 0' }}>{w.description}</p>}</div>
                {isAdmin && <div className="row"><button className="btn sm" onClick={() => setEdit({ ...w })}>Edit</button><button className="btn sm" onClick={() => act(() => api.post(`/api/workflows/${w.id}/toggle`), w.active ? 'Paused.' : 'Activated.')}>{w.active ? 'Pause' : 'Activate'}</button>
                  <button className="btn sm danger" onClick={() => window.confirm('Delete this workflow? Content already in review keeps its chain.') && act(() => api.del(`/api/workflows/${w.id}`), 'Deleted.')}>Delete</button></div>}</div>
              <div className="small"><strong>Applies to:</strong> {['channels', 'risks', 'claim_types', 'categories'].map((k) => (w.match[k] || []).length ? `${k.replace('_', ' ')}: ${w.match[k].join(', ')}` : null).filter(Boolean).concat(w.match.ai_generated ? ['AI-generated content'] : []).join(' · ') || 'everything'} <span className="muted">· priority {w.priority}</span></div>
              <ol className="small" style={{ margin: 0 }}>{w.steps.map((s, i) => <li key={i}><strong>{s.name}</strong>: {s.min_approvals}× {s.assignee_role}{s.assignee_group ? ` in group “${s.assignee_group}”` : ''}{s.sla_hours ? `, due in ${s.sla_hours} h` : ''}{s.escalate_role ? `, escalates to ${s.escalate_role}${s.escalate_group ? ` (${s.escalate_group})` : ''}` : ''}</li>)}</ol>
            </div>))}
          {isAdmin && <Preview options={d.options} />}
        </div>)}

      {tab === 'sla' && sla && (
        <div className="stack">
          <div className="card"><div className="row"><Badge>{sla.active} waiting</Badge><Badge kind={sla.overdue ? 'high' : 'ok'}>{sla.overdue} overdue</Badge></div>
            {sla.waiting.length === 0 ? <Empty>Nothing is waiting in an approval chain.</Empty> : (
              <div className="table-wrap"><table><thead><tr><th>Content</th><th>Workflow</th><th>Step</th><th>Due</th><th>Escalation</th></tr></thead>
                <tbody>{sla.waiting.map((x) => <tr key={x.item_id}><td><Link to={`/items/${x.item_id}`}>{x.title}</Link></td><td>{x.workflow}</td><td>{x.step}</td><td>{x.due_at ? fmtDate(x.due_at) : 'no deadline'} {x.overdue && <Badge kind="high">overdue</Badge>}</td><td>{x.escalation_level ? `level ${x.escalation_level}` : '—'}</td></tr>)}</tbody></table></div>)}</div>
          {sla.steps.length > 0 && <div className="card"><h2>How long steps take</h2><div className="table-wrap"><table><thead><tr><th>Step</th><th>Completed</th><th>Average hours</th><th>Escalated</th></tr></thead><tbody>{sla.steps.map((s) => <tr key={s.step}><td>{s.step}</td><td>{s.completed}</td><td>{s.avg_hours}</td><td>{s.escalated}</td></tr>)}</tbody></table></div></div>}
        </div>)}

      {tab === 'groups' && (
        <div className="card stack">
          <p className="small muted">Groups let a step go to a specific team (for example “legal”). Type group names separated by commas.</p>
          <div className="table-wrap"><table><thead><tr><th>Person</th><th>Role</th><th>Groups</th></tr></thead>
            <tbody>{staff.map((u) => <tr key={u.id}><td>{u.name}</td><td>{u.role}</td><td>{isAdmin ? <input key={(u.groups || []).join()} aria-label={`Groups for ${u.name}`} defaultValue={(u.groups || []).join(', ')} onBlur={(e) => e.target.value !== (u.groups || []).join(', ') && setGroups(u, e.target.value)} /> : (u.groups || []).join(', ') || '—'}</td></tr>)}</tbody></table></div>
        </div>)}

      {tab === 'templates' && (
        <div className="stack">{d.templates.map((t) => (
          <div className="card row between" key={t.key}><div><strong>{t.name}</strong><p className="small muted" style={{ margin: '4px 0 0' }}>{t.description}</p></div>
            <button className="btn" onClick={() => { setEdit({ ...blank(), ...t, match: { ...blank().match, ...t.match }, active: true }); }}>Use template</button></div>))}</div>)}

      {edit && <Editor initial={edit} options={d.options} groups={d.groups} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
    </>
  );
}
