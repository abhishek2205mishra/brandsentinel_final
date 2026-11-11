import { useEffect, useState } from 'react';
import { api } from '../api';
import { Loading, Badge } from '../components/ui';

export default function AINotice() {
  const [n, setN] = useState(null);
  useEffect(() => { api.get('/api/admin/ai-notice').then(setN); }, []);
  if (!n) return <Loading />;
  return (
    <>
      <div className="page-head"><div><h1>How we use AI</h1><p className="muted">A plain-language disclosure of what automation does here, what it sends anywhere, and where people stay in control.</p></div></div>
      <div className="grid cols-2">
        <section className="card"><h2>Rules engine and retrieval</h2><p>{n.rules_engine}</p>
          <p className="muted small">It checks terminology, tone, claims, facts, accessibility and visual rules. Every finding names the guideline, fact, asset or regulation it comes from.</p></section>
        <section className="card"><h2>Optional AI assistant</h2>
          <p><Badge kind={n.llm.enabled && n.llm.configured ? 'medium' : 'ok'}>{n.llm.enabled && n.llm.configured ? 'on' : 'off'}</Badge> {n.llm.enabled && n.llm.configured ? <>Provider <span className="mono">{n.llm.provider}</span>, model <span className="mono">{n.llm.model}</span>. {n.llm.blocked_by_confidential_mode ? 'Currently blocked by Confidential Mode.' : 'Only redacted text is sent.'}</> : n.llm.enabled ? 'Switched on in settings, but no AI provider key is configured on the server.' : 'No language model is used. All checks are deterministic.'}</p>
          <p className="muted small">When enabled it can suggest extra tone issues and sentence rewrites. Its answers are discarded unless they quote the real text and cite a real clause, and rewrites must pass the Purpose Lock check.</p></section>
        <section className="card"><h2>What leaves this server</h2>
          {n.external_services.length === 0 ? <p><Badge kind="ok">nothing</Badge> No content is sent to any external service.</p> : <p><Badge kind="high">external</Badge> Redacted text may be sent to: <span className="mono">{n.external_services.join(', ')}</span></p>}
          <p className="muted small">{n.redaction}</p>
          <p className="small">Confidential Mode: <Badge kind={n.confidential_mode ? 'ok' : ''}>{n.confidential_mode ? 'on' : 'off'}</Badge> When on, any non-local AI endpoint is blocked.</p></section>
        <section className="card"><h2>Human control</h2><p>{n.human_control}</p><p className="muted small">{n.limits}</p></section>
      </div>
    </>
  );
}
