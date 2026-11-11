import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth, can } from '../auth';
import { ChainChip, Loading, Empty, StatusBadge, RiskBadge, ago } from '../components/ui';

export default function Items() {
  const { user } = useAuth();
  const [items, setItems] = useState(null);
  const [f, setF] = useState({ status: '', risk: '', q: '' });
  const [err, setErr] = useState('');
  const [sort, setSort] = useState({ key: 'updated_at', dir: 'desc' });

  useEffect(() => {
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
    const t = setTimeout(() => api.get(`/api/items?${qs}`).then(setItems).catch((e) => setErr(e.message)), 200);
    return () => clearTimeout(t);
  }, [f]);

  const RISK = { low: 0, medium: 1, high: 2 };
  const rows = useMemo(() => {
    if (!items) return null;
    const val = (i) => (sort.key === 'risk' ? RISK[i.risk] : sort.key === 'updated_at' ? new Date(i.updated_at).getTime() : (typeof i[sort.key] === 'string' ? i[sort.key].toLowerCase() : i[sort.key]));
    return [...items].sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * (sort.dir === 'asc' ? 1 : -1); });
  }, [items, sort]);
  const th = (key, label) => (
    <th className="sortable" tabIndex={0} aria-sort={sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      onClick={() => setSort((s) => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' }))}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSort((s) => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' })); } }}>
      {label}<span className="arr" aria-hidden="true">↑</span>
    </th>
  );

  return (
    <>
      <div className="page-head">
        <div><h1>Content</h1><p className="muted">Every piece of content, its review status and open issues. Click a column to sort.</p></div>
        {can.create(user.role) && <Link className="btn primary" to="/items/new">+ New review</Link>}
      </div>
      <div className="card">
        <div className="row" style={{ marginBottom: 14 }}>
          <input type="search" placeholder="Search by title" aria-label="Search by title" style={{ maxWidth: 260 }} value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
          <select aria-label="Filter by status" style={{ maxWidth: 190 }} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
            <option value="">All statuses</option>
            {['draft', 'submitted', 'changes_requested', 'approved', 'rejected'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
          </select>
          <select aria-label="Filter by risk" style={{ maxWidth: 160 }} value={f.risk} onChange={(e) => setF({ ...f, risk: e.target.value })}>
            <option value="">All risk levels</option>
            {['low', 'medium', 'high'].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        {err && <div className="notice err">{err}</div>}
        {!items ? <Loading /> : items.length === 0 ? <Empty>No content matches.</Empty> : (
          <div className="table-wrap"><table>
            <thead><tr>{th('title', 'Title')}{th('channel', 'Channel')}{th('status', 'Status')}{th('risk', 'Risk')}{th('open_findings', 'Open issues')}{th('author_name', 'Author')}{th('updated_at', 'Updated')}</tr></thead>
            <tbody>{rows.map((i) => (
              <tr key={i.id}>
                <td><Link to={`/items/${i.id}`}>{i.title}</Link>{i.ai_generated ? <> <span className="badge ai">AI-generated</span></> : null}<ChainChip chain={i.chain} /></td>
                <td>{i.channel}</td><td><StatusBadge status={i.status} /></td><td><RiskBadge risk={i.risk} /></td>
                <td>{i.open_findings}{i.open_high ? <span className="badge high" style={{ marginLeft: 6 }}>{i.open_high} high</span> : null}</td>
                <td>{i.author_name}</td><td className="muted">{ago(i.updated_at)}</td>
              </tr>))}</tbody>
          </table></div>)}
      </div>
    </>
  );
}
