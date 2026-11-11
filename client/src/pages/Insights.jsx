import { useEffect, useState } from 'react';
import { api } from '../api';
import { Loading, Empty, Badge, useToast } from '../components/ui';
import { useAuth } from '../auth';
import { AreaTrend, HBars, Trend, CountUp, Ring, sumLast } from '../components/charts';

const STATE = { learning: ['', 'Still learning'], trusted: ['ok', 'Trusted'], mixed: ['medium', 'Mixed feedback'], noisy: ['medium', 'Often dismissed: lowered'], silenced: ['high', 'Demoted to advisory'] };
function Calibration() {
  const { user } = useAuth();
  const toast = useToast();
  const [c, setC] = useState(null);
  const load = () => api.get('/api/insights/calibration').then(setC).catch(() => {});
  useEffect(() => { load(); }, []);
  if (!c) return null;
  const admin = user.role === 'admin';
  const act = (fn, m) => fn().then((r) => { setC(r); toast(m); }).catch((e) => toast(e.message, 'err'));
  return (
    <section className="card" style={{ marginTop: 16 }} aria-labelledby="cal">
      <div className="card-head"><div><h2 id="cal" style={{ margin: 0 }}>What the system has learned here</h2>
        <div className="muted small">Every accept, edit, dismiss and override adjusts how confident each rule is for your organisation. Claims, facts and AI-disclosure rules are protected: their confidence is shown, but they are never hidden.</div></div>
        {admin && <div className="row"><label className="row small"><input type="checkbox" checked={c.enabled} onChange={(e) => act(() => api.post('/api/insights/calibration/settings', { enabled: e.target.checked }), e.target.checked ? 'Learning on.' : 'Learning off.')} /> Learn from feedback</label>
          <button className="btn sm" onClick={() => window.confirm('Forget everything learned so far and start again?') && act(() => api.post('/api/insights/calibration/reset'), 'Learning reset.')}>Reset</button></div>}</div>
      {c.rows.length === 0 ? <Empty>No feedback yet. Accept or dismiss findings and this table fills in.</Empty> : (
        <div className="table-wrap"><table><thead><tr><th>Rule</th><th>Guideline</th><th>Helpful</th><th>Dismissed</th><th>Usefulness</th><th>Status</th></tr></thead>
          <tbody>{c.rows.map((r) => <tr key={r.rule + r.clause}><td className="mono">{r.rule}{r.protected ? ' 🔒' : ''}</td><td>{r.clause || '–'}</td><td>{r.pos}</td><td>{r.neg}</td><td>{Math.round(r.p * 100)}%</td><td><Badge kind={STATE[r.state][0]}>{STATE[r.state][1]}</Badge></td></tr>)}</tbody></table></div>)}
      {!c.enabled && <p className="small muted">Learning is switched off: confidence stays at its built-in values.</p>}
    </section>
  );
}

export default function Insights() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.get('/api/insights').then(setD).catch((e) => setErr(e.message)); }, []);
  if (err) return <div className="notice err">{err}</div>;
  if (!d) return <Loading />;
  const t = d.totals;
  const outcome = (a) => (d.suggestionOutcomes.find((x) => x.action === a) || { n: 0 }).n;
  const acc = outcome('accepted') + outcome('edited');
  const totalDecided = acc + outcome('dismissed');
  const accRate = totalDecided ? Math.round((acc / totalDecided) * 100) : null;

  return (
    <>
      <div className="page-head"><div><h1>Governance <span className="grad-text">insights</span></h1><p className="muted">Where mistakes repeat and which guidelines may need clearer wording. Counts use distinct issues, so re-checks do not inflate them.</p></div></div>

      <div className="bento">
        <div className="tile kpi span-3"><div className="kpi-top"><span>Content items reviewed</span></div><div className="num"><CountUp value={t.items} /></div><div className="lbl">{t.in_review} waiting for review</div></div>
        <div className="tile kpi span-3"><div className="kpi-top"><span>Issues found · 7 days</span></div><div className="num"><CountUp value={sumLast(d.trend, 7)} /></div><div className="kpi-foot"><Trend cur={sumLast(d.trend, 7)} prev={sumLast(d.trend, 7, 7)} goodWhen="down" /></div></div>
        <div className="tile kpi span-3"><div className="kpi-top"><span>Average time to approval</span></div><div className="num">{t.avg_hours_to_approval ?? '–'}<span style={{ fontSize: '1rem' }} className="muted">h</span></div></div>
        <div className="tile kpi span-3"><div className="kpi-top"><span>Suggestions accepted</span></div><div className="num"><CountUp value={accRate} suffix="%" /></div><div className="lbl">vs dismissed</div></div>

        <section className="card span-8" aria-labelledby="trend">
          <div className="card-head"><div><h2 id="trend" style={{ margin: 0 }}>New issues per day</h2><div className="muted small">Last 30 days</div></div></div>
          <AreaTrend data={d.trend} unit="issues" label="New issues per day" />
        </section>
        <section className="card span-4" aria-labelledby="fp">
          <h2 id="fp">Clean on the first check</h2>
          <div className="row" style={{ justifyContent: 'center', padding: '10px 0' }}><Ring value={t.first_pass_clean} label="first pass" size={170} stroke={15} /></div>
        </section>

        <section className="card span-6" aria-labelledby="cat"><h2 id="cat">Issues by category</h2><HBars rows={d.categories} unit="issues" label="Issues by category" /></section>
        <section className="card span-6" aria-labelledby="chan"><h2 id="chan">Issues by channel</h2><HBars rows={d.channels} unit="issues" label="Issues by channel" /></section>

        <section className="card span-5" aria-labelledby="top"><h2 id="top">Most common checks that fire</h2><HBars rows={d.rules} unit="times" label="Most common rules" /></section>
        <section className="card span-7" aria-labelledby="rec">
          <h2 id="rec">Repeated mistakes</h2>
          <p className="muted small">The same wording flagged in two or more different pieces of content.</p>
          {d.recurring.length === 0 ? <Empty>No repeats yet.</Empty> : (
            <div className="table-wrap"><table><thead><tr><th>Wording</th><th>Check</th><th>Seen in</th></tr></thead><tbody>
              {d.recurring.map((r, i) => <tr key={i}><td className="mono">{r.matched || '(whole item)'}</td><td>{r.rule}<div className="muted small">cites {r.clause}</div></td><td>{r.items} items</td></tr>)}
            </tbody></table></div>)}
        </section>

        <section className="card span-12" aria-labelledby="radar">
          <h2 id="radar">Guideline Health Radar</h2>
          <p className="muted small">Guidelines that people often dismiss or that reviewers override may be unclear. The score blends dismissal and override rates (needs at least 2 decisions).</p>
          {d.radar.length === 0 ? <Empty>No decisions recorded yet.</Empty> : (
            <div className="table-wrap"><table>
              <thead><tr><th>Guideline</th><th>Flagged</th><th>Accepted</th><th>Dismissed</th><th>Overridden</th><th>Ambiguity</th><th>Suggested action</th></tr></thead>
              <tbody>{d.radar.map((r) => (
                <tr key={r.code}>
                  <td><span className="mono">{r.code}</span><div className="muted small">{r.title}</div></td><td>{r.flagged}</td><td>{r.accepted}</td><td>{r.dismissed}</td><td>{r.overridden}</td>
                  <td><Badge kind={r.ambiguity >= 60 ? 'high' : r.ambiguity >= 30 ? 'medium' : 'ok'}>{r.ambiguity}/100</Badge></td>
                  <td className="small">{r.hint || <span className="muted">Looks clear.</span>}</td>
                </tr>))}</tbody>
            </table></div>)}
        </section>

        <section className="card span-6" aria-labelledby="load">
          <h2 id="load">Reviewer workload</h2>
          <div className="table-wrap"><table><thead><tr><th>Reviewer</th><th>Role</th><th>Decisions</th></tr></thead><tbody>
            {d.reviewerLoad.map((r) => <tr key={r.name}><td>{r.name}</td><td>{r.role}</td><td>{r.decisions}</td></tr>)}</tbody></table></div>
        </section>
        {d.authors && (
          <section className="card span-6" aria-labelledby="auth">
            <h2 id="auth">By author (admins and auditors only)</h2>
            <p className="muted small">Use this to offer training, not to score people. Repeated = the same issue in 2+ items.</p>
            <div className="table-wrap"><table><thead><tr><th>Author</th><th>Items</th><th>Issues</th><th>Repeated</th></tr></thead><tbody>
              {d.authors.map((a) => <tr key={a.author}><td>{a.author}</td><td>{a.items}</td><td>{a.issues}</td><td>{a.repeated}</td></tr>)}</tbody></table></div>
          </section>)}
      </div>
      <Calibration />
    </>
  );
}
