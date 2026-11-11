import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth, can } from '../auth';
import { ChainChip, Loading, Empty, StatusBadge, RiskBadge, ago } from '../components/ui';
import { AreaTrend, Spark, HBars, Donut, Ring, Trend, CountUp, useChartColors, dailySeries, sumLast } from '../components/charts';
import { IconClock, IconAlert, IconDoc, IconCheck, IconPlus } from '../components/icons';

function Kpi({ icon: Icon, label, value, color, trend, spark, hint }) {
  return (
    <div className="tile kpi">
      <div className="kpi-top"><span>{label}</span><span className="kpi-ico"><Icon /></span></div>
      <div className="num" style={color ? { color } : undefined}><CountUp value={value} /></div>
      <div className="kpi-foot">
        <div className="row" style={{ gap: 8 }}>{trend}{hint && <span className="muted small">{hint}</span>}</div>
        {spark}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const c = useChartColors();
  const [items, setItems] = useState(null);
  const [ins, setIns] = useState(null);
  const [err, setErr] = useState('');
  const [view, setView] = useState('');

  useEffect(() => {
    api.get('/api/items').then(setItems).catch((e) => setErr(e.message));
    if (can.insights(user.role)) api.get('/api/insights').then(setIns).catch(() => {});
  }, [user.role]);

  const data = useMemo(() => {
    if (!items) return null;
    const created = dailySeries(items.map((i) => i.created_at));
    const approved = dailySeries(items.filter((i) => i.status === 'approved').map((i) => i.updated_at));
    return { created, approved };
  }, [items]);

  if (err) return <div className="notice err">{err}</div>;
  if (!items || !data) return <Loading />;

  const r = user.role;
  const queue = items.filter((i) => i.status === 'submitted' && i.author_id !== user.id);
  const mine = items.filter((i) => i.author_id === user.id && ['draft', 'changes_requested'].includes(i.status));
  const attention = can.review(r) ? [...queue].sort((a, b) => (b.chain?.awaiting_me ? 1 : 0) - (a.chain?.awaiting_me ? 1 : 0) || (b.chain?.overdue ? 1 : 0) - (a.chain?.overdue ? 1 : 0)) : mine;
  const openHigh = items.reduce((n, i) => n + (['approved', 'rejected'].includes(i.status) ? 0 : i.open_high), 0);
  const count = (s) => items.filter((i) => i.status === s).length;
  const issues = ins ? ins.trend : null;
  const chartView = view || (issues ? 'issues' : 'created');
  const riskRows = ['low', 'medium', 'high'].map((k) => ({ key: k, n: items.filter((i) => i.risk === k).length }));
  const riskColors = { low: c.ok, medium: c.med, high: c.high, default: c.brand };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Hello, <span className="grad-text">{user.name.split(' ')[0]}</span></h1>
          <p className="muted">{can.review(r) ? 'Here is what is waiting for your review.' : r === 'auditor' ? 'A read-only view of governance activity.' : 'Check content against the brand before it goes out.'}</p>
        </div>
        {can.create(r) && <Link className="btn primary" to="/items/new"><IconPlus width="16" height="16" />New review</Link>}
      </div>

      <div className="bento">
        <div className="span-3"><Kpi icon={IconClock} label="Waiting for review" value={count('submitted')} hint={`${items.filter((i) => i.status === 'submitted' && i.risk === 'high').length} high risk`} /></div>
        <div className="span-3"><Kpi icon={IconAlert} label="Open high-severity issues" value={openHigh} color={openHigh ? 'var(--high)' : undefined}
          trend={issues ? <Trend cur={sumLast(issues, 7)} prev={sumLast(issues, 7, 7)} goodWhen="down" title="Issues found: last 7 days vs the 7 before" /> : null} hint={issues ? 'issues found, 7d' : ''} /></div>
        <div className="span-3"><Kpi icon={IconDoc} label="Content created · 7 days" value={sumLast(data.created, 7)}
          trend={<Trend cur={sumLast(data.created, 7)} prev={sumLast(data.created, 7, 7)} />} spark={<Spark data={data.created.slice(-14)} />} /></div>
        <div className="span-3"><Kpi icon={IconCheck} label="Approved and cleared" value={count('approved')} color="var(--ok)"
          trend={<Trend cur={sumLast(data.approved, 7)} prev={sumLast(data.approved, 7, 7)} title="Approved: last 7 days vs the 7 before" />} spark={<Spark data={data.approved.slice(-14)} />} /></div>

        <section className="card span-8" aria-labelledby="act">
          <div className="card-head">
            <div><h2 id="act" style={{ margin: 0 }}>{chartView === 'issues' ? 'Issues found per day' : 'Content created per day'}</h2><div className="muted small">Last 30 days · hover for details</div></div>
            {issues && <div className="seg" role="group" aria-label="Chart data"><button aria-pressed={chartView === 'issues'} onClick={() => setView('issues')}>Issues</button><button aria-pressed={chartView === 'created'} onClick={() => setView('created')}>Content</button></div>}
          </div>
          {chartView === 'issues' ? <AreaTrend data={issues} unit="issues" label="Issues found per day" /> : <AreaTrend data={data.created} unit="items" label="Content created per day" />}
        </section>

        <section className="card span-4" aria-labelledby="risk">
          <h2 id="risk">Content by risk</h2>
          <Donut rows={riskRows} colors={riskColors} center={items.length} label="items" />
        </section>

        <section className="card span-7" aria-labelledby="att">
          <div className="card-head"><h2 id="att" style={{ margin: 0 }}>{can.review(r) ? 'Review queue' : 'Needs your attention'}</h2><span className="muted small">{attention.length} item{attention.length === 1 ? '' : 's'}</span></div>
          {attention.length === 0 ? <Empty>{can.review(r) ? 'Nothing is waiting. Nice.' : 'No drafts need attention.'}</Empty> : (
            <div className="table-wrap"><table><tbody>
              {attention.slice(0, 7).map((i) => (
                <tr key={i.id}>
                  <td><Link to={`/items/${i.id}`}>{i.title}</Link><div className="muted small">{i.author_name} · {ago(i.updated_at)}</div><ChainChip chain={i.chain} /></td>
                  <td><RiskBadge risk={i.risk} /></td><td><StatusBadge status={i.status} /></td>
                </tr>))}
            </tbody></table></div>)}
        </section>

        <section className="card span-5" aria-labelledby="rec">
          <div className="card-head"><h2 id="rec" style={{ margin: 0 }}>Recent content</h2><Link to="/items" className="small">View all</Link></div>
          {items.length === 0 ? <Empty>No content yet.</Empty> : (
            <div className="table-wrap"><table><tbody>
              {items.slice(0, 7).map((i) => (
                <tr key={i.id}>
                  <td><Link to={`/items/${i.id}`}>{i.title}</Link><div className="muted small">{i.channel} · {i.open_findings} open issue{i.open_findings === 1 ? '' : 's'}</div></td>
                  <td><StatusBadge status={i.status} /></td>
                </tr>))}
            </tbody></table></div>)}
        </section>

        {ins && <>
          <section className="card span-4" aria-labelledby="gov">
            <h2 id="gov">Governance at a glance</h2>
            <div className="row" style={{ gap: 22, alignItems: 'center' }}>
              <Ring value={ins.totals.first_pass_clean} label="clean first pass" size={132} />
              <div className="stat-list" style={{ flex: 1, minWidth: 120 }}>
                <div><span className="muted small">Avg. time to approval</span><b>{ins.totals.avg_hours_to_approval ?? '–'}h</b></div>
                <div><span className="muted small">Items reviewed</span><b>{ins.totals.items}</b></div>
              </div>
            </div>
            <p className="small muted" style={{ marginTop: 14, marginBottom: 0 }}><Link to="/insights">See recurring mistakes and unclear guidelines</Link></p>
          </section>
          <section className="card span-8" aria-labelledby="cats">
            <h2 id="cats">Top issue categories</h2>
            <HBars rows={ins.categories.slice(0, 6)} unit="issues" label="Issues by category" />
          </section>
        </>}
      </div>
    </>
  );
}
