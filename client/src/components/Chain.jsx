import { useEffect, useState } from 'react';
import { api } from '../api';
import { Badge, Field, fmtDate, useToast } from './ui';

export const dueText = (due) => {
  if (!due) return 'no deadline';
  const ms = new Date(due).getTime() - Date.now();
  const h = Math.abs(ms) / 3600000;
  const t = h >= 48 ? `${Math.round(h / 24)} d` : h >= 1 ? `${Math.round(h)} h` : `${Math.max(1, Math.round(h * 60))} min`;
  return ms < 0 ? `overdue by ${t}` : `due in ${t}`;
};

// Timeline of an approval chain, with delegate / nudge for the person who can act.
export default function Chain({ itemId, chain, isAuthor, canNudge, onChanged }) {
  const toast = useToast();
  const [users, setUsers] = useState([]);
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (chain.can_act) api.get('/api/auth/users').then(setUsers).catch(() => {}); }, [chain.can_act]);
  const go = async (fn, msg) => { setBusy(true); try { await fn(); toast(msg); setTo(''); setReason(''); onChanged(); } catch (e) { toast(e.message, 'err'); } setBusy(false); };
  const cur = chain.steps[chain.current_step];
  const staff = users.filter((u) => ['reviewer', 'approver', 'admin'].includes(u.role));
  return (
    <div className="stack">
      <div className="notice">Approval chain: <strong>{chain.workflow}</strong>. {chain.status === 'active' ? 'Steps run in order. Nobody can approve their own content or two steps of the same chain.' : `Chain ${chain.status}.`}</div>
      <ol style={{ listStyle: 'none', padding: 0, margin: 0 }} aria-label="Approval steps">
        {chain.steps.map((s) => {
          const kind = s.status === 'done' ? 'ok' : s.status === 'active' ? (s.overdue ? 'high' : 'medium') : '';
          return (
            <li key={s.index} className="card" style={{ marginBottom: 8, borderLeft: `4px solid var(--${s.status === 'done' ? 'ok' : s.overdue ? 'high' : s.status === 'active' ? 'med' : 'border'})` }}>
              <div className="row between"><strong>{s.index + 1}. {s.name}</strong><Badge kind={kind}>{s.status === 'pending' ? 'waiting' : s.status}</Badge></div>
              <div className="small muted">{s.min_approvals}× {s.assignee_role || 'any role'}{s.assignee_group ? ` in “${s.assignee_group}”` : ''}</div>
              {s.status === 'active' && <div className="small" style={{ marginTop: 4 }}>{dueText(s.due_at)}{s.escalation_level ? ` · escalated (level ${s.escalation_level})` : ''} · {s.approvals.length}/{s.min_approvals} approvals</div>}
              {s.approvals.map((a, i) => <div className="small" key={i}>✓ {a.name} ({a.role}{a.acted_as ? `, ${a.acted_as}` : ''}) · {fmtDate(a.at)}</div>)}
              {s.delegated.map((d, i) => <div className="small muted" key={i}>↪ delegated to {d.to}{d.reason ? `: ${d.reason}` : ''}</div>)}
            </li>);
        })}
      </ol>
      {chain.can_act && cur && cur.status === 'active' && (
        <div className="stack">
          <h3>Delegate this step</h3>
          <div className="row"><select aria-label="Delegate to" value={to} onChange={(e) => setTo(e.target.value)}><option value="">Choose a person…</option>{staff.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.role})</option>)}</select>
            <input aria-label="Reason" placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
            <button className="btn" disabled={busy || !to} onClick={() => go(() => api.post(`/api/items/${itemId}/delegate`, { to_user_id: to, reason }), 'Delegated.')}>Delegate</button></div>
        </div>)}
      {(isAuthor || canNudge) && chain.status === 'active' && <div><button className="btn sm" disabled={busy} onClick={() => go(() => api.post(`/api/items/${itemId}/nudge`), 'Reminder sent to the current approvers.')}>Send a reminder</button></div>}
    </div>
  );
}
