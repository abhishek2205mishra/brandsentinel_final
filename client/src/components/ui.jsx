import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';

export const Badge = ({ kind, children }) => <span className={`badge ${kind || ''}`}>{children ?? String(kind).replace('_', ' ')}</span>;
export const StatusBadge = ({ status }) => <Badge kind={status}>{String(status).replace('_', ' ')}</Badge>;
export const SeverityBadge = ({ severity }) => <Badge kind={severity}>{severity === 'info' ? 'advisory' : severity}</Badge>;
export const RiskBadge = ({ risk }) => <Badge kind={risk}>{risk} risk</Badge>;

export const Empty = ({ children }) => <div className="empty">{children}</div>;
export const Loading = ({ label = 'Loading…' }) => <div className="empty" role="status"><span className="loading-dots" aria-hidden="true"><i /><i /><i /></span>{label}</div>;

export function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

// Floating-label input used on the sign-in and sign-up forms.
export function FloatField({ label, hint, ...props }) {
  return (
    <label className="float">
      <input placeholder=" " {...props} />
      <span>{label}</span>
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)}>{t.label}</button>
      ))}
    </div>
  );
}

export function Modal({ title, onClose, children }) {
  const ref = useRef();
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    ref.current && ref.current.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <div className="card-head"><h2 style={{ margin: 0 }}>{title}</h2><button className="btn sm" onClick={onClose}>Close</button></div>
        {children}
      </div>
    </div>
  );
}

const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }) {
  const [list, setList] = useState([]);
  const push = useCallback((text, kind = 'ok') => {
    const id = Math.random();
    setList((l) => [...l, { id, text, kind }]);
    setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-host" aria-live="polite">{list.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}</div>
    </ToastCtx.Provider>
  );
}

export const fmtDate = (s) => (s ? new Date(s).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
export const fmtDay = (s) => (s ? new Date(s).toLocaleDateString([], { dateStyle: 'medium' }) : '');
export const ago = (s) => {
  const m = Math.round((Date.now() - new Date(s).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} d ago`;
};
export const isExpired = (d) => d && new Date(d) < new Date(new Date().toISOString().slice(0, 10));

// Where a submitted item is in its approval chain (from /api/items "chain"), with deadline and whether it waits for the viewer.
export const ChainChip = ({ chain }) => {
  if (!chain) return null;
  let due = '';
  if (chain.due_at) { const ms = new Date(chain.due_at).getTime() - Date.now(); const h = Math.abs(ms) / 3600000; const t = h >= 48 ? `${Math.round(h / 24)} d` : h >= 1 ? `${Math.round(h)} h` : `${Math.max(1, Math.round(h * 60))} min`; due = ms < 0 ? `overdue ${t}` : `due in ${t}`; }
  return (
    <div className="small" style={{ marginTop: 2 }}>
      <span className="muted">Step {chain.step_no}/{chain.steps}: {chain.step}</span>{due && <> · <span className={`badge ${chain.overdue ? 'high' : ''}`}>{due}</span></>}{chain.escalation_level ? <> <span className="badge medium">escalated</span></> : null}{chain.awaiting_me ? <> <span className="badge ok">your turn</span></> : null}
    </div>
  );
};
