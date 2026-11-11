import { useState } from 'react';
import { Badge, SeverityBadge } from './ui';

const LEVEL = { minimal: 'Minimal fix', balanced: 'Cleaner wording', rewrite: 'Rewrite' };

export default function FindingCard({ f, active, onActivate, canAct, onAccept, onDismiss, onReopen, pageLabel }) {
  const [why, setWhy] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState('');
  const [editing, setEditing] = useState(false);
  const [custom, setCustom] = useState('');
  const handled = f.status !== 'open';
  const hasSpan = f.start >= 0;

  return (
    <article id={`finding-${f.id}`} className={`finding ${f.severity}${handled ? ' handled' : ''}${active ? ' active' : ''}`} onClick={() => onActivate(f.id)}>
      <div className="row between">
        <div className="row" style={{ gap: 6 }}>
          <SeverityBadge severity={f.severity} />
          <Badge>{f.category}</Badge>
          {f.ai_assisted && <span className="badge ai">AI-assisted</span>}
          {pageLabel && <Badge>{pageLabel}</Badge>}
          {handled && <Badge kind={f.status === 'dismissed' ? 'info' : 'ok'}>{f.status}</Badge>}
        </div>
        <span className="small muted" title="How sure the check is">confidence {Math.round(f.confidence * 100)}%</span>
      </div>

      <p className="msg">{f.message}</p>
      {f.matched && hasSpan && <p className="small muted" style={{ margin: 0 }}>Flagged text: <span className="mono">{f.matched.length > 120 ? f.matched.slice(0, 120) + '…' : f.matched}</span></p>}
      {!hasSpan && <p className="small muted" style={{ margin: 0 }}>Applies to the whole item.</p>}

      <details open={why} onToggle={(e) => setWhy(e.currentTarget.open)} style={{ marginTop: 8 }}>
        <summary>Why was this flagged?</summary>
        <div className="source">
          <strong>{f.source_type === 'guideline' ? 'Brand guideline' : f.source_type === 'regulation' ? 'Regulatory reference' : f.source_type === 'fact' ? 'Approved fact' : f.source_type === 'claim_ledger' ? 'Claim ledger' : f.source_type === 'asset' ? 'Asset library' : f.source_type === 'terminology' ? 'Terminology list' : 'Source'}:</strong>{' '}
          <span className="mono">{f.source_code || 'none'}</span>
          {f.source_quote && <q>{f.source_quote}</q>}
          {f.also_cites && f.also_cites.length > 0 && <div style={{ marginTop: 6 }} className="small muted">Also relevant: {f.also_cites.join(', ')}</div>}
        </div>
      </details>

      {!handled && f.suggestions.length > 0 && (
        <div>
          {f.suggestions.map((s) => (
            <div className="suggestion" key={s.level}>
              <div>
                <div className="small muted">{LEVEL[s.level]} · {s.note}</div>
                {s.text === '' ? <em>Remove this text</em> : <span className="txt">{s.text.trim() || s.text}</span>}
                <div className="small muted" style={{ marginTop: 3 }}>
                  Purpose kept <span className="meter" aria-hidden="true"><i style={{ width: `${Math.round(s.intent_preserved * 100)}%` }} /></span> {Math.round(s.intent_preserved * 100)}%
                </div>
              </div>
              {canAct && <button className="btn sm primary" onClick={(e) => { e.stopPropagation(); onAccept(f, { level: s.level }); }}>Accept</button>}
            </div>
          ))}
        </div>
      )}

      {canAct && !handled && (
        <div className="row" style={{ marginTop: 10 }} onClick={(e) => e.stopPropagation()}>
          {hasSpan && <button className="btn sm" onClick={() => { setEditing(!editing); setCustom(f.suggestions[0] ? f.suggestions[0].text : f.matched || ''); }}>Edit it myself</button>}
          <button className="btn sm" onClick={() => setDismissing(!dismissing)}>Dismiss with reason</button>
        </div>
      )}

      {editing && (
        <div className="stack" style={{ marginTop: 10 }} onClick={(e) => e.stopPropagation()}>
          <label className="field"><span>Replace the flagged text with</span><textarea rows={2} value={custom} onChange={(e) => setCustom(e.target.value)} /></label>
          <div className="row"><button className="btn sm primary" onClick={() => onAccept(f, { text: custom })}>Apply my edit</button><button className="btn sm" onClick={() => setEditing(false)}>Cancel</button></div>
        </div>
      )}
      {dismissing && (
        <div className="stack" style={{ marginTop: 10 }} onClick={(e) => e.stopPropagation()}>
          <label className="field"><span>Why is this acceptable?</span><input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Your reason helps us find unclear guidelines" /></label>
          <div className="row"><button className="btn sm danger" disabled={reason.trim().length < 3} onClick={() => { onDismiss(f, reason); setDismissing(false); }}>Dismiss</button><button className="btn sm" onClick={() => setDismissing(false)}>Cancel</button></div>
        </div>
      )}
      {handled && f.status === 'dismissed' && (
        <div className="small muted" style={{ marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
          Reason: “{f.status_reason}” {canAct && <button className="btn sm ghost" onClick={() => onReopen(f)}>Reopen</button>}
        </div>
      )}
    </article>
  );
}
