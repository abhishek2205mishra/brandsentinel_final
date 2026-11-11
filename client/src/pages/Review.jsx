import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, reportUrl, fileUrl } from '../api';
import { useAuth, can } from '../auth';
import { Loading, Tabs, StatusBadge, RiskBadge, Badge, Field, useToast, fmtDate, Empty } from '../components/ui';
import Highlighted from '../components/Highlighted';
import FindingCard from '../components/FindingCard';
import { diffWords } from '../utils/diff';
import Chain from '../components/Chain';

function Share({ code, canRevoke, onRevoke }) {
  const toast = useToast();
  const url = `${window.location.origin}/verify/${code}`;
  const copy = async () => { try { await navigator.clipboard.writeText(url); toast('Link copied.'); } catch { toast(url); } };
  return (
    <div className="source stack">
      <div><strong>Public verification</strong><div className="small muted">Anyone with this link can confirm the content was approved and see what was checked, without signing in. The content itself is never shown.</div></div>
      <div className="mono">{code}</div>
      <div className="row"><button className="btn sm" onClick={copy}>Copy link</button><a className="btn sm" href={`/verify/${code}`} target="_blank" rel="noopener noreferrer">Open page</a>
        {canRevoke && <button className="btn sm danger" onClick={() => { const r = window.prompt('Why is this clearance being withdrawn? (required)'); if (r && r.trim().length >= 5) onRevoke(r.trim()); }}>Revoke certificate</button>}</div>
    </div>
  );
}

export default function Review() {
  const { id } = useParams();
  const { user } = useAuth();
  const toast = useToast();
  const [d, setD] = useState(null);
  const [ver, setVer] = useState(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState('findings');
  const [active, setActive] = useState(null);
  const [filter, setFilter] = useState('open');
  const [cat, setCat] = useState('all');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [alt, setAlt] = useState('');
  const [diff, setDiff] = useState(null);
  const [comment, setComment] = useState('');
  const [decision, setDecision] = useState({ reason: '', override: '' });
  const [busy, setBusy] = useState(false);

  const load = useCallback((n) => api.get(`/api/items/${id}${n ? `?v=${n}` : ''}`).then((x) => { setD(x); setErr(''); }).catch((e) => setErr(e.message)), [id]);
  useEffect(() => { setD(null); setVer(null); setDiff(null); setEditing(false); load(); }, [id, load]);

  const run = async (fn, okMsg) => {
    setBusy(true);
    try { await fn(); if (okMsg) toast(okMsg); await load(ver); } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const findings = d ? d.findings : [];
  const pages = d && d.version.meta.pages;
  const pageOf = useCallback((f) => {
    if (!pages || f.start < 0) return null;
    const p = pages.find((x) => f.start >= x.start && f.start < x.end);
    return p ? `${p.label || 'Page'} ${p.page}` : null;
  }, [pages]);

  const cats = useMemo(() => ['all', ...new Set(findings.map((f) => f.category))], [findings]);
  const shown = findings.filter((f) => (filter === 'all' || (filter === 'open' ? f.status === 'open' : f.status !== 'open')) && (cat === 'all' || f.category === cat));

  if (err) return <div className="notice err">{err} <Link to="/items">Back to content</Link></div>;
  if (!d) return <Loading />;

  const { item, version, analysis, versions, comments, decisions, certificate, workflow: chain } = d;
  const isCurrent = version.n === item.current_version;
  const isAuthor = user.id === item.author_id;
  const editable = isCurrent && (isAuthor || user.role === 'admin') && (item.status !== 'approved' || user.role === 'admin');
  const canAct = isCurrent && user.role !== 'auditor' && item.status !== 'approved';
  const openFindings = findings.filter((f) => f.status === 'open' && !f.advisory);
  const openHigh = openFindings.filter((f) => f.severity === 'high');
  const isImage = item.kind === 'image';
  const code = item.kind === 'html';

  const pick = (fid) => { setActive(fid); setTab('findings'); setFilter('all'); setTimeout(() => document.getElementById(`finding-${fid}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 50); };
  const accept = (f, payload) => run(() => api.post(`/api/items/${id}/findings/${f.id}/accept`, payload), 'Fix applied as a new version and re-checked.').then(() => setVer(null));
  const dismiss = (f, reason) => run(() => api.post(`/api/items/${id}/findings/${f.id}/dismiss`, { reason }), 'Finding dismissed. Your reason was recorded.');
  const reopen = (f) => run(() => api.post(`/api/items/${id}/findings/${f.id}/reopen`));
  const saveEdit = () => run(async () => { await api.post(`/api/items/${id}/versions`, { body: draft, alt, note: 'Edited by author' }); setEditing(false); }, 'Saved as a new version and re-checked.');
  const submit = () => run(() => api.post(`/api/items/${id}/submit`), 'Submitted for review.');
  const addComment = () => comment.trim() && run(async () => { await api.post(`/api/items/${id}/comments`, { body: comment }); setComment(''); });
  const decide = (kind) => run(async () => {
    try { await api.post(`/api/items/${id}/decision`, { decision: kind, reason: decision.reason, override_reason: decision.override }); }
    catch (e) { if (e.status === 409) setTab('workflow'); throw e; }
    setDecision({ reason: '', override: '' });
  }, kind === 'approve' ? 'Approval recorded.' : kind === 'reject' ? 'Rejected.' : 'Changes requested.');

  const selectVersion = (n) => { setVer(n === item.current_version ? null : n); setDiff(null); setEditing(false); load(n === item.current_version ? null : n); };
  const toggleDiff = async () => {
    if (diff) return setDiff(null);
    const prevN = version.n - 1;
    if (prevN < 1) return toast('This is the first version, so there is nothing to compare.', 'err');
    const prev = await api.get(`/api/items/${id}?v=${prevN}`);
    setDiff(diffWords(prev.version.body, version.body));
  };

  const needsMore = item.risk === 'high' ? 'Two different people must approve (one an approver or admin).' : 'One reviewer must approve.';
  const reviewerCan = can.review(user.role) && !isAuthor && item.status === 'submitted';

  return (
    <>
      <div className="page-head">
        <div>
          <p className="small muted" style={{ margin: 0 }}><Link to="/items">Content</Link> / {item.channel}</p>
          <h1>{item.title}</h1>
          <div className="row" style={{ gap: 6 }}>
            <StatusBadge status={item.status} /><RiskBadge risk={item.risk} /><Badge>v{version.n}{isCurrent ? '' : ' (older)'}</Badge>
            {item.ai_generated && <span className="badge ai">AI-generated{item.ai_tool ? `: ${item.ai_tool}` : ''}</span>}
            <span className="small muted">by {item.author_name} · {fmtDate(item.updated_at)}</span>
          </div>
          <p className="small muted" style={{ margin: '6px 0 0' }}><strong>Purpose:</strong> {item.intent}</p>
        </div>
        <div className="row">
          <a className="btn" href={reportUrl(id)} target="_blank" rel="noopener noreferrer">Report</a>
          {editable && !editing && !isImage && <button className="btn" onClick={() => { setDraft(version.body); setEditing(true); }}>Edit and re-check</button>}
          {isCurrent && (isAuthor || user.role === 'admin') && ['draft', 'changes_requested'].includes(item.status) && (
            <button className="btn primary" disabled={busy} onClick={submit}>Submit for review</button>)}
        </div>
      </div>

      {!isCurrent && <div className="notice warn" style={{ marginBottom: 12 }}>You are viewing an older version (read-only). <button className="btn sm" onClick={() => selectVersion(item.current_version)}>Go to the latest</button></div>}
      {item.status === 'approved' && certificate && <div className="notice ok" style={{ marginBottom: 12 }}>Approved and cleared for publication. Clearance certificate #{certificate.id} covers version {certificate.version_n} exactly as written.</div>}
      {item.status === 'changes_requested' && <div className="notice warn" style={{ marginBottom: 12 }}>A reviewer asked for changes: “{[...decisions].reverse().find((x) => x.decision === 'request_changes')?.reason}”</div>}

      <div className="review-grid">
        <section aria-label="Content">
          <div className="card">
            <div className="card-head">
              <h2 style={{ margin: 0 }}>{isImage ? 'Image' : 'Content'}</h2>
              <div className="row">
                {versions.length > 1 && (
                  <select aria-label="Choose version" value={version.n} onChange={(e) => selectVersion(Number(e.target.value))} style={{ width: 'auto' }}>
                    {versions.map((v) => <option key={v.n} value={v.n}>Version {v.n}{v.n === item.current_version ? ' (latest)' : ''}</option>)}
                  </select>)}
                {!isImage && versions.length > 1 && <button className="btn sm" aria-pressed={!!diff} onClick={toggleDiff}>{diff ? 'Hide changes' : 'Show changes'}</button>}
              </div>
            </div>

            {isImage && (
              <div className="stack">
                {version.has_file && <img src={fileUrl(id, version.n)} alt={version.meta.alt || ''} style={{ maxWidth: '100%', maxHeight: 420, borderRadius: 8, border: '1px solid var(--border)' }} />}
                {version.meta.image && <div className="small muted">{version.meta.image.w} × {version.meta.image.h}px · dominant colours:{' '}
                  {version.meta.image.palette.map((c) => <span key={c.hex} title={`${c.hex} (${Math.round(c.share * 100)}%)`} style={{ display: 'inline-block', width: 18, height: 18, background: c.hex, border: '1px solid var(--border)', borderRadius: 4, verticalAlign: 'middle', marginRight: 4 }} />)}</div>}
                <p className="small"><strong>Alt text:</strong> {version.meta.alt || <em className="muted">none provided</em>}</p>
                {editable && <div className="row"><input type="text" value={alt} onChange={(e) => setAlt(e.target.value)} placeholder="Type alt text, then save" aria-label="Alt text" style={{ flex: 1 }} /><button className="btn sm primary" onClick={() => run(() => api.post(`/api/items/${id}/versions`, { body: version.body, alt, note: 'Alt text updated' }), 'Alt text saved and re-checked.')}>Save alt text</button></div>}
              </div>)}

            {!isImage && editing && (
              <div className="stack">
                <textarea rows={14} className={code ? 'code' : ''} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Edit content" />
                <div className="row"><button className="btn primary" disabled={busy} onClick={saveEdit}>Save as new version</button><button className="btn" onClick={() => setEditing(false)}>Cancel</button></div>
              </div>)}

            {!isImage && !editing && (diff
              ? <div className="content-box diffbox" tabIndex={0}>{diff.map((p, i) => p.t === 'eq' ? <span key={i}>{p.v}</span> : p.t === 'ins' ? <ins key={i} className="diff">{p.v}</ins> : <del key={i} className="diff">{p.v}</del>)}</div>
              : <Highlighted body={version.body} findings={findings} activeId={active} onPick={pick} code={code} />)}
            {code && !editing && !diff && <p className="small muted" style={{ marginTop: 8 }}>Showing the HTML source. Highlights mark the exact code or text that triggered a finding.</p>}
          </div>

          {analysis && analysis.supported_claims && analysis.supported_claims.length > 0 && (
            <div className="card">
              <h3>Claims backed by approved evidence</h3>
              {analysis.supported_claims.map((c, i) => <p key={i} className="small" style={{ margin: '4px 0' }}><Badge kind="ok">supported</Badge> “{c.text}” <span className="muted">({c.evidence})</span></p>)}
            </div>)}
        </section>

        <section aria-label="Review panel">
          <div className="card">
            <Tabs value={tab} onChange={setTab} tabs={[
              { id: 'findings', label: `Findings (${openFindings.length} open)` }, { id: 'discussion', label: `Discussion (${comments.length})` },
              { id: 'history', label: `History (${versions.length})` }, { id: 'workflow', label: 'Approval' }]} />

            {tab === 'findings' && (
              <>
                <div className="row" style={{ marginBottom: 12 }}>
                  <div className="chips" role="group" aria-label="Status filter">
                    {[['open', 'Open'], ['handled', 'Handled'], ['all', 'All']].map(([k, l]) => <button key={k} className="chip" aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>)}
                  </div>
                  {cats.length > 2 && <div className="chips" role="group" aria-label="Category filter">{cats.map((c) => <button key={c} className="chip" aria-pressed={cat === c} onClick={() => setCat(c)}>{c}</button>)}</div>}
                </div>
                {findings.length === 0 && <Empty>No issues found. This content matches your approved guidelines.</Empty>}
                {findings.length > 0 && shown.length === 0 && <Empty>Nothing in this filter.</Empty>}
                {shown.map((f) => <FindingCard key={f.id} f={f} active={f.id === active} onActivate={setActive} canAct={canAct} onAccept={accept} onDismiss={dismiss} onReopen={reopen} pageLabel={pageOf(f)} />)}
                {analysis && analysis.errors && analysis.errors.length > 0 && <div className="notice warn" style={{ marginTop: 10 }}>Some checks could not run: {analysis.errors.join('; ')}</div>}
              </>)}

            {tab === 'discussion' && (
              <>
                {comments.length === 0 && <Empty>No comments yet.</Empty>}
                {comments.map((c) => <div className="comment" key={c.id}><div className="who">{c.author_name} <span className="muted small">({c.author_role}) · {fmtDate(c.created_at)}</span></div><div>{c.body}</div></div>)}
                {user.role !== 'auditor' && (
                  <div className="stack" style={{ marginTop: 12 }}>
                    <Field label="Add a comment" hint="Use @name to notify someone."><textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
                    <button className="btn primary" disabled={busy || !comment.trim()} onClick={addComment}>Post comment</button>
                  </div>)}
              </>)}

            {tab === 'history' && (
              <div className="table-wrap"><table>
                <thead><tr><th>Version</th><th>When</th><th>By</th><th>Note</th></tr></thead>
                <tbody>{versions.map((v) => (
                  <tr key={v.n}><td><button className="btn sm ghost" onClick={() => selectVersion(v.n)}>v{v.n}</button></td><td>{fmtDate(v.created_at)}</td><td>{v.by}</td><td>{v.note}<div className="mono muted" title="SHA-256 of this version">{v.content_hash.slice(0, 12)}…</div></td></tr>))}</tbody>
              </table></div>)}

            {tab === 'workflow' && (
              <div className="stack">
                {chain ? <Chain itemId={id} chain={chain} isAuthor={isAuthor} canNudge={['admin', 'approver'].includes(user.role)} onChanged={() => load(ver)} />
                  : <div className="notice">Risk is <strong>{item.risk}</strong>. {needsMore} The author can never approve their own content.</div>}
                {decisions.length === 0 && <p className="muted small">No decisions yet.</p>}
                {decisions.map((x) => (
                  <div className="comment" key={x.id}>
                    <div className="who">{x.user_name} <span className="muted small">({x.user_role}) · v{x.version_n} · {fmtDate(x.created_at)}</span></div>
                    <Badge kind={x.decision === 'approve' ? 'ok' : x.decision === 'reject' ? 'high' : 'medium'}>{x.decision.replace('_', ' ')}</Badge>
                    {x.reason && <div>{x.reason}</div>}{x.override_reason && <div className="small muted">Override reason: {x.override_reason}</div>}
                  </div>))}

                {(chain && chain.status === 'active' ? chain.can_act : reviewerCan) && (
                  <div className="stack">
                    <h3>Your decision</h3>
                    {openHigh.length > 0 && <div className="notice warn">{openHigh.length} high-severity finding(s) are still open. Resolve them, or explain below why approval is still right.</div>}
                    <Field label="Comment for the author"><textarea rows={2} value={decision.reason} onChange={(e) => setDecision({ ...decision, reason: e.target.value })} /></Field>
                    {openHigh.length > 0 && <Field label="Override reason (required to approve with open high-severity findings)"><input type="text" value={decision.override} onChange={(e) => setDecision({ ...decision, override: e.target.value })} /></Field>}
                    <div className="row">
                      <button className="btn good" disabled={busy} onClick={() => decide('approve')}>Approve</button>
                      <button className="btn" disabled={busy} onClick={() => decide('request_changes')}>Request changes</button>
                      <button className="btn danger" disabled={busy} onClick={() => decide('reject')}>Reject</button>
                    </div>
                  </div>)}

                {certificate && (
                  <div className="stack">
                    <h3>Clearance certificate</h3>
                    <p className="small muted">A signature over this exact content. If a single character changes, publishing tools that check it will refuse.</p>
                    <div className="source"><div>Certificate #{certificate.id} · version {certificate.version_n} · issued {fmtDate(certificate.issued_at)}</div>
                      <div className="mono" style={{ wordBreak: 'break-all', marginTop: 6 }}>sha256: {certificate.content_hash}</div>
                      <div className="mono" style={{ wordBreak: 'break-all' }}>signature: {certificate.signature}</div></div>
                    {certificate.verification_code && <Share code={certificate.verification_code} canRevoke={['admin', 'approver'].includes(user.role)} onRevoke={(reason) => run(() => api.post(`/api/items/${id}/certificate/revoke`, { reason }), 'Certificate revoked.')} />}
                  </div>)}
              </div>)}
          </div>
        </section>
      </div>
    </>
  );
}
