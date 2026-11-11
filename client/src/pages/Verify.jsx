import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api, apiUrl } from '../api';
import { Loading, fmtDate, Badge } from '../components/ui';

const NAMES = { v: '', approved_facts: 'approved facts', approved_claims: 'approved claims', regulation_packs: 'regulation packs' };

// Public page (no sign-in): confirms a clearance certificate is genuine and shows what was checked. Never shows the content itself.
export default function Verify() {
  const { code: param } = useParams();
  const nav = useNavigate();
  const [code, setCode] = useState(param || '');
  const [v, setV] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [match, setMatch] = useState(null);

  useEffect(() => {
    setV(null); setErr(''); setMatch(null);
    if (!param) return;
    setBusy(true);
    api.get(`/api/public/verify/${encodeURIComponent(param)}`).then(setV).catch((e) => setErr(e.message)).finally(() => setBusy(false));
  }, [param]);

  const go = (e) => { e.preventDefault(); const c = code.trim().toUpperCase(); if (c) nav(`/verify/${encodeURIComponent(c)}`); };
  const check = async () => {
    setMatch(null);
    try { setMatch(await api.post(`/api/public/verify/${encodeURIComponent(param)}/check`, { text })); } catch (e) { setMatch({ error: e.message }); }
  };
  const k = v && v.checks;
  const tone = v ? (v.status === 'valid' && !v.newer_version_exists ? 'ok' : v.status === 'valid' ? 'warn' : 'err') : '';

  return (
    <main className="page" style={{ maxWidth: 780, margin: '0 auto', padding: '32px 16px' }}>
      <p className="small muted"><Link to="/">BrandSentinel</Link> / Certificate verification</p>
      <h1>Verify a clearance certificate</h1>
      <p className="muted">Enter the code printed on the approved content (like BS-ABCD-EFGH-JKLM) to confirm it was approved, and to see what was checked. No sign-in is needed.</p>
      <form className="row" onSubmit={go} style={{ margin: '14px 0' }}>
        <input aria-label="Verification code" placeholder="BS-XXXX-XXXX-XXXX" value={code} onChange={(e) => setCode(e.target.value)} style={{ maxWidth: 300 }} autoComplete="off" />
        <button className="btn primary" disabled={!code.trim()}>Verify</button>
      </form>
      {busy && <Loading label="Checking…" />}
      {err && <div className="notice err" role="alert">{err}</div>}
      {v && (
        <div className="stack">
          <div className={`notice ${tone}`} role="status">
            {v.status === 'valid' && !v.newer_version_exists && <><strong>Genuine and current.</strong> This certificate was issued by {v.organisation} and its signature is intact.</>}
            {v.status === 'valid' && v.newer_version_exists && <><strong>Genuine, but superseded.</strong> A newer version of this content exists. Make sure you are publishing the version that was approved.</>}
            {v.status === 'revoked' && <><strong>Revoked.</strong> {v.organisation} withdrew this clearance{v.revoked_at ? ` on ${fmtDate(v.revoked_at)}` : ''}. Do not publish this content.</>}
            {v.status === 'invalid' && <><strong>Signature does not verify.</strong> Treat this certificate as not authentic.</>}
          </div>
          <div className="card stack">
            <h2>Certificate</h2>
            <table><tbody>
              <tr><th scope="row">Code</th><td className="mono">{v.code}</td></tr>
              <tr><th scope="row">Organisation</th><td>{v.organisation}</td></tr>
              {v.title && <tr><th scope="row">Title</th><td>{v.title}</td></tr>}
              <tr><th scope="row">Issued</th><td>{fmtDate(v.issued_at)}</td></tr>
              <tr><th scope="row">Version</th><td>{v.version}</td></tr>
              <tr><th scope="row">Content fingerprint</th><td className="mono" style={{ wordBreak: 'break-all' }}>{v.content_hash}</td></tr>
              <tr><th scope="row">Signature</th><td>{v.signature_valid ? 'Valid' : 'Not valid'} <span className="muted small">({v.integrity === 'full' ? 'covers the checks listed below' : 'issued before detailed check records existed'})</span></td></tr>
              {v.audit_anchor && <tr><th scope="row">Audit-log entry</th><td className="mono" style={{ wordBreak: 'break-all' }}>{v.audit_anchor.slice(0, 32)}…</td></tr>}
            </tbody></table>
          </div>
          {k && (
            <div className="card stack">
              <h2>What was checked</h2>
              {k.reconstructed && <p className="small muted">Summary rebuilt from the records of an older certificate.</p>}
              <ul>
                <li>Brand rules engine version <span className="mono">{k.engine_version}</span> ({(k.rule_modules || []).join(', ')})</li>
                <li>{k.knowledge_base.guidelines} guideline clauses, {k.knowledge_base.terms} terminology rules, {k.knowledge_base.approved_facts} approved facts and {k.knowledge_base.approved_claims} approved claims</li>
                <li>Regulation packs: {(k.knowledge_base.regulation_packs || []).join(', ').toUpperCase()}</li>
                <li>Channel: {k.content.channel}; risk level: {k.content.risk}{k.content.ai_generated ? '; declared as AI-assisted' : ''}</li>
                <li>Open issues at approval: {k.findings.open_at_approval}; fixed by the author: {k.findings.fixed}; dismissed with a reason: {k.findings.dismissed_by_author}; overridden by a reviewer: {k.findings.overridden_by_reviewers}</li>
                <li>AI assistance: {k.ai.external_calls ? `${k.ai.external_calls} external call(s), redacted` : 'no external AI calls'}{k.ai.confidential_mode ? '; Confidential Mode on' : ''}</li>
              </ul>
              <h3>Approvals</h3>
              {k.approval.type === 'configured_workflow'
                ? <><p className="small">Approval chain: <strong>{k.approval.name}</strong></p><ol>{k.approval.steps.map((s, i) => <li key={i}>{s.name}: {s.approvals.length} of {s.required_approvals} approval(s) {s.approvals.map((a) => <Badge key={a.at}>{a.role}</Badge>)}</li>)}</ol></>
                : <p className="small">Standard {k.approval.risk}-risk approval by {(k.approval.approvals || []).map((a) => a.role).join(' and ') || 'a reviewer'}.</p>}
              <p className="small muted">People&apos;s names and the content itself are not shown on this page.</p>
            </div>)}
          <div className="card stack">
            <h2>Is this the text that was approved?</h2>
            <p className="small muted">Paste the text you are about to publish. It is compared in your browser session only to the stored fingerprint; nothing is saved.</p>
            <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} aria-label="Text to compare" />
            <div className="row"><button className="btn" disabled={!text.trim()} onClick={check}>Compare</button>
              <img src={apiUrl(`/api/public/verify/${encodeURIComponent(v.code)}/qr.svg`)} alt={`QR code that opens this page for ${v.code}`} width="88" height="88" style={{ marginLeft: 'auto', background: '#fff', borderRadius: 6 }} /></div>
            {match && <div className={`notice ${match.error ? 'err' : match.match ? 'ok' : 'warn'}`} role="status">{match.error || match.message}</div>}
          </div>
        </div>)}
    </main>
  );
}
