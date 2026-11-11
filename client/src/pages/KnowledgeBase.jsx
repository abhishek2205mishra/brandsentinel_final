import { useEffect, useState, useCallback } from 'react';
import { api } from '../api';
import { useAuth, can } from '../auth';
import { Loading, Tabs, Modal, Field, Badge, Empty, useToast, isExpired } from '../components/ui';

const CATEGORIES = ['tone', 'terminology', 'messaging', 'claims', 'facts', 'visual', 'accessibility', 'provenance'];
const ASSET_TEMPLATES = {
  palette: { tolerance: 22, minImageWidth: 1080, colors: [{ name: 'Roast Brown', hex: '#5B3A29' }, { name: 'Crema', hex: '#F5E6D3' }] },
  fonts: { allowed: ['Inter', 'Georgia'] },
  logo: { aspect: 2.5, tolerance: 0.03, minWidth: 120, clearSpace: 'Keep clear space equal to the height of the letter N.' },
};

const COLLECTIONS = {
  guidelines: {
    label: 'Guidelines', blurb: 'Clauses that findings cite. A clause with a "rule" block is checked automatically; others guide people and the optional AI.',
    cols: [['Code', (r) => <span className="mono">{r.code}</span>], ['Title', (r) => r.title], ['Category', (r) => <Badge>{r.category}</Badge>], ['Check', (r) => (r.rule ? <span className="mono">{r.rule.type}</span> : <span className="muted">manual</span>)], ['Status', (r) => (r.active ? <Badge kind="ok">active</Badge> : <Badge>off</Badge>)]],
    fields: [{ k: 'code', l: 'Code', t: 'text', req: 1 }, { k: 'title', l: 'Title', t: 'text', req: 1 }, { k: 'category', l: 'Category', t: 'select', o: CATEGORIES }, { k: 'severity', l: 'Severity', t: 'select', o: ['low', 'medium', 'high'] }, { k: 'text', l: 'Guideline text (quoted in findings)', t: 'textarea', req: 1 }, { k: 'rule', l: 'Automatic check (JSON, optional)', t: 'json', hint: 'Example: {"type":"tone.exclaim","max":1}. See the list of check types below the table.' }, { k: 'confidential', l: 'Confidential (hidden from agencies)', t: 'check' }, { k: 'active', l: 'Active', t: 'check' }],
    blank: { category: 'tone', severity: 'medium', active: true, rule: '' },
  },
  terms: {
    label: 'Terminology', blurb: 'Terms to avoid and the preferred alternative. Works for Hindi, Marathi and other languages too.',
    cols: [['Avoid', (r) => r.banned], ['Use instead', (r) => r.preferred || <span className="muted">remove</span>], ['Language', (r) => r.lang], ['Why', (r) => r.reason]],
    fields: [{ k: 'banned', l: 'Term to avoid', t: 'text', req: 1 }, { k: 'preferred', l: 'Preferred term', t: 'text' }, { k: 'lang', l: 'Language code', t: 'text', hint: 'en, hi, mr …' }, { k: 'reason', l: 'Reason shown to creators', t: 'textarea' }, { k: 'guideline_code', l: 'Guideline code it belongs to (optional)', t: 'text' }],
    blank: { lang: 'en' },
  },
  facts: {
    label: 'Approved facts', blurb: 'Prices, offers, dates and statistics. Expired facts and conflicting values are caught in drafts.',
    cols: [['Subject', (r) => r.subject], ['Approved value', (r) => <strong>{r.value}</strong>], ['Valid until', (r) => (r.valid_until ? <>{r.valid_until} {isExpired(r.valid_until) && <Badge kind="high">expired</Badge>}</> : '–')], ['Owner', (r) => r.owner || '–'], ['Evidence', (r) => r.evidence || '–']],
    fields: [{ k: 'subject', l: 'Subject', t: 'text', req: 1 }, { k: 'keywords', l: 'Keywords that mention it (comma separated)', t: 'text', req: 1 }, { k: 'statement', l: 'Approved statement', t: 'text', req: 1 }, { k: 'value', l: 'Approved value', t: 'text', req: 1, hint: 'Use a percentage like 20% or a price like ₹349 to enable conflict checks.' }, { k: 'valid_from', l: 'Valid from', t: 'date' }, { k: 'valid_until', l: 'Valid until', t: 'date' }, { k: 'owner', l: 'Owner', t: 'text' }, { k: 'evidence', l: 'Evidence (document or reference)', t: 'text' }, { k: 'confidential', l: 'Confidential (hidden from agencies)', t: 'check' }],
    blank: {},
  },
  claims: {
    label: 'Claim ledger', blurb: 'Promotional claims that are allowed, with the evidence behind them. Anything not listed is flagged as unsupported.',
    cols: [['Claim', (r) => <strong>{r.phrase}</strong>], ['Type', (r) => <Badge>{r.claim_type}</Badge>], ['Evidence', (r) => r.evidence || '–'], ['Valid until', (r) => (r.valid_until ? <>{r.valid_until} {isExpired(r.valid_until) && <Badge kind="high">expired</Badge>}</> : '–')], ['Approved by', (r) => r.approved_by || '–']],
    fields: [{ k: 'phrase', l: 'Claim wording', t: 'text', req: 1, hint: 'The exact phrase, e.g. 100% organic' }, { k: 'claim_type', l: 'Type', t: 'select', o: ['natural', 'environmental', 'health', 'comparative', 'superlative', 'financial', 'statistic', 'certification'] }, { k: 'evidence', l: 'Evidence', t: 'textarea' }, { k: 'valid_until', l: 'Evidence valid until', t: 'date' }, { k: 'approved_by', l: 'Approved by', t: 'text' }],
    blank: { claim_type: 'natural' },
  },
  assets: {
    label: 'Asset library', blurb: 'Approved palette, fonts and logo rules used by the visual checks.',
    cols: [['Name', (r) => r.name], ['Kind', (r) => <Badge>{r.kind}</Badge>], ['Details', (r) => <span className="mono small">{JSON.stringify(r.data).slice(0, 110)}</span>]],
    fields: [{ k: 'kind', l: 'Kind', t: 'select', o: ['palette', 'fonts', 'logo'] }, { k: 'name', l: 'Name', t: 'text', req: 1 }, { k: 'data', l: 'Settings (JSON)', t: 'json', req: 1 }],
    blank: { kind: 'palette', data: JSON.stringify(ASSET_TEMPLATES.palette, null, 2) },
  },
};

function EditForm({ cfg, table, row, onDone }) {
  const toast = useToast();
  const [v, setV] = useState(() => {
    const init = { ...cfg.blank, ...row };
    for (const f of cfg.fields) if (f.t === 'json' && init[f.k] && typeof init[f.k] === 'object') init[f.k] = JSON.stringify(init[f.k], null, 2);
    return init;
  });
  const [err, setErr] = useState('');
  const set = (k, val) => setV((o) => ({ ...o, [k]: val }));
  const save = async (e) => {
    e.preventDefault(); setErr('');
    const body = {};
    for (const f of cfg.fields) {
      let x = v[f.k];
      if (f.t === 'json') { if (!x) { body[f.k] = null; continue; } try { x = JSON.parse(x); } catch { return setErr(`"${f.l}" is not valid JSON.`); } }
      if (x !== undefined) body[f.k] = x;
    }
    try { row && row.id ? await api.put(`/api/kb/${table}/${row.id}`, body) : await api.post(`/api/kb/${table}`, body); toast('Saved.'); onDone(true); }
    catch (ex) { setErr(ex.message); }
  };
  return (
    <form className="stack" onSubmit={save}>
      {cfg.fields.map((f) => (
        <div key={f.k}>
          {f.t === 'check' ? <label className="check"><input type="checkbox" checked={!!v[f.k]} onChange={(e) => set(f.k, e.target.checked)} /> {f.l}</label> : (
            <Field label={f.l} hint={f.hint}>
              {f.t === 'select' ? <select value={v[f.k] || ''} onChange={(e) => { set(f.k, e.target.value); if (table === 'assets' && f.k === 'kind') set('data', JSON.stringify(ASSET_TEMPLATES[e.target.value], null, 2)); }}>{f.o.map((o) => <option key={o}>{o}</option>)}</select>
                : f.t === 'textarea' ? <textarea rows={3} value={v[f.k] || ''} onChange={(e) => set(f.k, e.target.value)} />
                : f.t === 'json' ? <textarea rows={6} className="code" value={v[f.k] || ''} onChange={(e) => set(f.k, e.target.value)} />
                : <input type={f.t} required={!!f.req} value={v[f.k] || ''} onChange={(e) => set(f.k, e.target.value)} />}
            </Field>)}
        </div>))}
      {err && <div className="notice err" role="alert">{err}</div>}
      <div className="row"><button className="btn primary">Save</button><button type="button" className="btn" onClick={() => onDone(false)}>Cancel</button></div>
    </form>
  );
}

function ImportPanel({ onDone }) {
  const toast = useToast();
  const [preview, setPreview] = useState(null);
  const [picked, setPicked] = useState({});
  const [busy, setBusy] = useState(false);
  const upload = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    setBusy(true);
    try { const fd = new FormData(); fd.append('file', file); const r = await api.form('/api/kb/import/preview', fd); setPreview(r); setPicked(Object.fromEntries(r.clauses.map((c, i) => [i, true]))); }
    catch (ex) { toast(ex.message, 'err'); } finally { setBusy(false); }
  };
  const commit = async () => {
    const clauses = preview.clauses.filter((_, i) => picked[i]);
    try { const r = await api.post('/api/kb/import/commit', { clauses }); toast(`${r.added} clause(s) imported.`); setPreview(null); onDone(); } catch (ex) { toast(ex.message, 'err'); }
  };
  return (
    <div className="stack">
      <p className="muted">Upload your existing brand book (PDF, DOCX, Markdown or text). BrandSentinel splits it into clauses so findings can cite them. You review before anything is saved.</p>
      <input type="file" accept=".pdf,.docx,.md,.txt" onChange={upload} disabled={busy} aria-label="Brand guideline file" />
      {preview && (
        <>
          <p><strong>{preview.clauses.length}</strong> clause(s) found in {preview.file}. Untick any you do not want.</p>
          <div className="table-wrap"><table><thead><tr><th /><th>Code</th><th>Title</th><th>Category</th><th>Text</th></tr></thead><tbody>
            {preview.clauses.map((c, i) => (
              <tr key={i}><td><input type="checkbox" checked={!!picked[i]} aria-label={`Import ${c.title}`} onChange={(e) => setPicked({ ...picked, [i]: e.target.checked })} /></td><td className="mono">{c.code}</td><td>{c.title}</td>
                <td><select value={c.category} aria-label="Category" onChange={(e) => { const next = [...preview.clauses]; next[i] = { ...c, category: e.target.value }; setPreview({ ...preview, clauses: next }); }}>{CATEGORIES.map((o) => <option key={o}>{o}</option>)}</select></td><td className="small">{c.text.slice(0, 140)}</td></tr>))}
          </tbody></table></div>
          <button className="btn primary" onClick={commit}>Import selected</button>
        </>)}
    </div>
  );
}

export default function KnowledgeBase() {
  const { user } = useAuth();
  const toast = useToast();
  const admin = can.editKb(user.role);
  const [kb, setKb] = useState(null);
  const [tab, setTab] = useState('guidelines');
  const [edit, setEdit] = useState(null);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState(null);
  const load = useCallback(() => api.get('/api/kb').then(setKb).catch((e) => toast(e.message, 'err')), [toast]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!q.trim()) return setHits(null);
    const t = setTimeout(() => api.get(`/api/kb/search?q=${encodeURIComponent(q)}`).then(setHits).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [q]);

  if (!kb) return <Loading />;
  const cfg = COLLECTIONS[tab];
  const rows = cfg ? kb[tab] : null;
  const remove = async (r) => { if (!window.confirm('Delete this entry?')) return; try { await api.del(`/api/kb/${tab}/${r.id}`); toast('Deleted.'); load(); } catch (e) { toast(e.message, 'err'); } };

  const tabs = [...Object.entries(COLLECTIONS).map(([id, c]) => ({ id, label: `${c.label} (${kb[id].length})` })), { id: 'regs', label: `Regulatory packs (${kb.regs.length})` }, ...(admin ? [{ id: 'import', label: 'Import brand book' }] : [])];

  return (
    <>
      <div className="page-head">
        <div><h1>Knowledge base</h1><p className="muted">The approved source material every finding must cite. {admin ? 'You can edit it.' : 'Only brand admins can edit it.'}</p></div>
        <div style={{ minWidth: 260 }}><input type="search" placeholder="Search guidelines (e.g. exclamation)" aria-label="Search guidelines" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      </div>
      {kb.redacted_view && <div className="notice warn" style={{ marginBottom: 12 }}>You are seeing a redacted view: confidential items and evidence details are hidden from agency accounts.</div>}
      {hits && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3>Best matches</h3>
          {hits.length === 0 ? <p className="muted">No matching guideline.</p> : hits.map((h) => <p key={h.code} style={{ margin: '6px 0' }}><span className="mono">{h.code}</span> <strong>{h.title}</strong> <Badge>{h.category}</Badge><br /><span className="muted small">{h.text}</span></p>)}
        </div>)}
      <div className="card">
        <Tabs tabs={tabs} value={tab} onChange={setTab} />
        {cfg && (
          <>
            <div className="card-head"><p className="muted" style={{ margin: 0 }}>{cfg.blurb}</p>{admin && <button className="btn primary" onClick={() => setEdit({ table: tab, row: null })}>+ Add</button>}</div>
            {rows.length === 0 ? <Empty>Nothing here yet.</Empty> : (
              <div className="table-wrap"><table>
                <thead><tr>{cfg.cols.map(([h]) => <th key={h}>{h}</th>)}{admin && <th />}</tr></thead>
                <tbody>{rows.map((r) => (
                  <tr key={r.id}>{cfg.cols.map(([h, fn]) => <td key={h}>{fn(r)}</td>)}
                    {admin && <td style={{ whiteSpace: 'nowrap' }}><button className="btn sm" onClick={() => setEdit({ table: tab, row: r })}>Edit</button> <button className="btn sm danger" onClick={() => remove(r)}>Delete</button></td>}</tr>))}</tbody>
              </table></div>)}
            {tab === 'guidelines' && (
              <details style={{ marginTop: 14 }}><summary>Automatic check types you can put in a rule</summary>
                <ul className="small">
                  {[['tone.exclaim', '{"max":1}', 'limit exclamation marks'], ['tone.caps', '{"allow":["FAQ"]}', 'flag ALL-CAPS words'], ['tone.hype', '{"phrases":[{"phrase":"hurry","replacement":""}]}', 'pushy phrases'], ['tone.emoji', '{"max":2}', 'emoji budget'], ['tone.sentence', '{"maxWords":28}', 'sentence length'], ['tone.grade', '{"maxGrade":10}', 'reading level'], ['tone.ai_boilerplate', '{"phrases":["delve into"]}', 'stock AI phrases'], ['claims.policy', '{}', 'unsupported claims need the Claim Ledger'], ['facts.dates', '{}', 'expired offer dates'], ['a11y.hashtag', '{}', 'CamelCase hashtags'], ['ai.disclosure', '{"label":"Created with AI assistance."}', 'AI disclosure label']].map(([t, ex, d]) => <li key={t}><span className="mono">{t}</span> <span className="mono muted">{ex}</span> {d}</li>)}
                </ul>
                <p className="small muted">No clause means no check: a finding is only shown when it can cite an active clause, fact, asset or regulation.</p></details>)}
          </>)}
        {tab === 'regs' && (
          <div className="stack">
            <p className="muted">Shared references used for claims, accessibility and AI-disclosure findings. These are plain-language summaries for review support, not legal advice.</p>
            {kb.regs.map((r) => <div key={r.code} className="source"><strong>{r.title}</strong> <Badge>{r.pack}</Badge> <span className="mono muted">{r.code}</span><q>{r.text}</q></div>)}
          </div>)}
        {tab === 'import' && admin && <ImportPanel onDone={() => { load(); setTab('guidelines'); }} />}
      </div>
      {edit && <Modal title={`${edit.row ? 'Edit' : 'Add'} ${COLLECTIONS[edit.table].label.toLowerCase()}`} onClose={() => setEdit(null)}><EditForm cfg={COLLECTIONS[edit.table]} table={edit.table} row={edit.row} onDone={(saved) => { setEdit(null); if (saved) load(); }} /></Modal>}
    </>
  );
}
