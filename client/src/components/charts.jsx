// Interactive, theme-aware charts (Recharts) plus trend badges, rings and count-up numbers.
import { useEffect, useId, useState } from 'react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid, BarChart, Bar, LabelList, PieChart, Pie, Cell } from 'recharts';
import { IconUp, IconDown, IconDash } from './icons';

const read = () => {
  const s = getComputedStyle(document.documentElement);
  const g = (n) => s.getPropertyValue(n).trim();
  return { brand: g('--brand'), brand2: g('--brand-2'), muted: g('--muted'), text: g('--text'), grid: g('--chart-grid'), ok: g('--ok'), high: g('--high'), med: g('--med'), low: g('--low') };
};
export function useChartColors() {
  const [c, setC] = useState(read);
  useEffect(() => { const f = () => setC(read()); window.addEventListener('bs-theme', f); return () => window.removeEventListener('bs-theme', f); }, []);
  return c;
}
const reduced = () => typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const safeId = (id) => id.replace(/[^a-zA-Z0-9]/g, '');

export function useCountUp(target, ms = 800) {
  const [v, setV] = useState(reduced() ? target : 0);
  useEffect(() => {
    if (reduced() || typeof target !== 'number') { setV(target); return undefined; }
    let raf; const t0 = performance.now();
    const step = (t) => { const p = Math.min(1, (t - t0) / ms); setV(Math.round(target * (1 - (1 - p) ** 3))); if (p < 1) raf = requestAnimationFrame(step); };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}
export const CountUp = ({ value, suffix = '' }) => { const v = useCountUp(typeof value === 'number' ? value : 0); return <>{typeof value === 'number' ? v : '–'}{typeof value === 'number' ? suffix : ''}</>; };

// Trend badge: green/red arrow with a percentage. goodWhen="down" for things like "issues found".
export function Trend({ cur, prev, goodWhen = 'up', title }) {
  if (cur == null || prev == null) return null;
  let pct; let dir = 'flat';
  if (prev === 0) { if (cur === 0) pct = '0%'; else { pct = 'new'; dir = 'up'; } }
  else { const d = Math.round(((cur - prev) / prev) * 100); pct = `${Math.abs(d)}%`; dir = d > 0 ? 'up' : d < 0 ? 'down' : 'flat'; }
  const tone = dir === 'flat' ? 'flat' : (dir === goodWhen ? 'good' : 'bad');
  const Ico = dir === 'up' ? IconUp : dir === 'down' ? IconDown : IconDash;
  return <span className={`trend ${tone}`} title={title || 'Compared with the previous 7 days'}><Ico />{pct}</span>;
}

export function Tip({ active, payload, label, fmtLabel, unit, dot }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div className="chart-tip">
      <div className="t">{fmtLabel ? fmtLabel(label) : (label ?? payload[0].payload.key)}</div>
      {payload.map((p, i) => <div className="v" key={i}><i style={{ background: dot }} />{p.value}{unit ? <span className="muted small"> {unit}</span> : null}</div>)}
    </div>
  );
}
const fmtDay = (d) => { const x = new Date(`${d}T00:00:00Z`); return Number.isNaN(x.getTime()) ? d : x.toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' }); };

export function AreaTrend({ data, xKey = 'day', yKey = 'n', height = 250, unit = 'issues', label }) {
  const c = useChartColors();
  const id = safeId(useId());
  const flat = data.length > 0 && data.every((d) => d[yKey] === data[0][yKey]);
  const total = data.reduce((a, d) => a + d[yKey], 0);
  return (
    <div className="chart" role="img" aria-label={`${label || 'Trend'}: ${total} ${unit} over ${data.length} days`}>
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={data} margin={{ top: 12, right: 10, left: -14, bottom: 0 }}>
          <defs>
            <linearGradient id={`f${id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={c.brand} stopOpacity={0.5} /><stop offset="60%" stopColor={c.brand2} stopOpacity={0.14} /><stop offset="100%" stopColor={c.brand2} stopOpacity={0} /></linearGradient>
            <linearGradient id={`s${id}`} x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stopColor={c.brand} /><stop offset="100%" stopColor={c.brand2} /></linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke={c.grid} strokeDasharray="2 8" />
          <XAxis dataKey={xKey} tickLine={false} axisLine={false} tick={{ fill: c.muted, fontSize: 11 }} tickFormatter={fmtDay} minTickGap={30} tickMargin={8} />
          <YAxis tickLine={false} axisLine={false} width={44} allowDecimals={false} tick={{ fill: c.muted, fontSize: 11 }} domain={[0, (m) => Math.max(3, m)]} />
          <Tooltip content={<Tip fmtLabel={fmtDay} unit={unit} dot={c.brand2} />} cursor={{ stroke: c.brand2, strokeDasharray: '4 5', strokeOpacity: 0.7 }} />
          <Area type="monotone" dataKey={yKey} stroke={flat ? c.brand : `url(#s${id})`} strokeWidth={3} fill={`url(#f${id})`} dot={false}
            activeDot={{ r: 6, strokeWidth: 3, stroke: c.brand2, fill: '#fff' }} isAnimationActive={!reduced()} animationDuration={900} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function Spark({ data, yKey = 'n', height = 40 }) {
  const c = useChartColors();
  const id = safeId(useId());
  if (!data || !data.length) return null;
  return (
    <div className="spark-mini" aria-hidden="true">
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={data} margin={{ top: 4, right: 0, left: 0, bottom: 2 }}>
          <defs><linearGradient id={`k${id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={c.brand2} stopOpacity={0.5} /><stop offset="100%" stopColor={c.brand2} stopOpacity={0} /></linearGradient></defs>
          <Area type="monotone" dataKey={yKey} stroke={c.brand2} strokeWidth={2} fill={`url(#k${id})`} dot={false} isAnimationActive={!reduced()} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// Horizontal bars with a violet-to-cyan gradient, value labels, no axes or grid.
export function HBars({ rows, labelKey = 'key', valueKey = 'n', unit = '', label }) {
  const c = useChartColors();
  const id = safeId(useId());
  if (!rows.length) return <div className="empty">No data yet.</div>;
  const h = rows.length * 38 + 8;
  return (
    <div className="chart" role="img" aria-label={`${label || 'Breakdown'}: ${rows.map((r) => `${r[labelKey]} ${r[valueKey]}`).join(', ')}`}>
      <ResponsiveContainer width="100%" height={h}>
        <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 36, left: 0, bottom: 0 }} barCategoryGap={10}>
          <defs><linearGradient id={`b${id}`} x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stopColor={c.brand} /><stop offset="100%" stopColor={c.brand2} /></linearGradient></defs>
          <XAxis type="number" hide domain={[0, 'dataMax']} />
          <YAxis type="category" dataKey={labelKey} axisLine={false} tickLine={false} width={118} tick={{ fill: c.muted, fontSize: 12.5, fontWeight: 600 }} />
          <Tooltip content={<Tip unit={unit} dot={c.brand2} />} cursor={{ fill: c.grid }} />
          <Bar dataKey={valueKey} fill={`url(#b${id})`} radius={[4, 12, 12, 4]} barSize={16} isAnimationActive={!reduced()} animationDuration={900}>
            <LabelList dataKey={valueKey} position="right" style={{ fill: c.text, fontSize: 12, fontWeight: 800 }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function Donut({ rows, colors, center, label }) {
  const total = rows.reduce((a, r) => a + r.n, 0);
  return (
    <div>
      <div className="ring chart" role="img" aria-label={`${label || 'Distribution'}: ${rows.map((r) => `${r.key} ${r.n}`).join(', ')}`}>
        <ResponsiveContainer width="100%" height={190}>
          <PieChart>
            <Tooltip content={<Tip />} />
            <Pie data={total ? rows : [{ key: 'none', n: 1 }]} dataKey="n" nameKey="key" innerRadius={62} outerRadius={86} paddingAngle={total ? 4 : 0} cornerRadius={8} stroke="none" isAnimationActive={!reduced()} animationDuration={900}>
              {(total ? rows : [{ key: 'none' }]).map((r, i) => <Cell key={r.key} fill={total ? colors[r.key] || colors.default : 'rgba(127,127,160,.2)'} />)}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="center"><b>{center ?? total}</b><span>{label}</span></div>
      </div>
      <div className="legend">{rows.map((r) => <span key={r.key}><i style={{ background: colors[r.key] || colors.default }} />{r.key} · {r.n}</span>)}</div>
    </div>
  );
}

// Radial progress with a gradient stroke that animates in.
export function Ring({ value, size = 150, stroke = 13, label }) {
  const id = safeId(useId());
  const [p, setP] = useState(0);
  useEffect(() => { const t = setTimeout(() => setP(value ?? 0), 80); return () => clearTimeout(t); }, [value]);
  const r = (size - stroke) / 2; const C = 2 * Math.PI * r;
  return (
    <div className="ring" style={{ width: size, height: size }} role="img" aria-label={`${label}: ${value ?? 'no data'}%`}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <defs><linearGradient id={`r${id}`} x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="var(--brand)" /><stop offset="100%" stopColor="var(--brand-2)" /></linearGradient></defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-2)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={`url(#r${id})`} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - Math.min(100, p) / 100)} style={{ transition: 'stroke-dashoffset 1.1s cubic-bezier(.2,.8,.2,1)' }} />
      </svg>
      <div className="center"><b><CountUp value={value ?? null} suffix="%" /></b><span>{label}</span></div>
    </div>
  );
}

// ---- helpers for turning item lists into per-day series ----
export function dailySeries(timestamps, days = 30) {
  const map = new Map();
  for (const t of timestamps) { const k = new Date(t).toISOString().slice(0, 10); map.set(k, (map.get(k) || 0) + 1); }
  const out = [];
  for (let i = days - 1; i >= 0; i--) { const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10); out.push({ day: d, n: map.get(d) || 0 }); }
  return out;
}
export const sumLast = (series, n, offset = 0) => series.slice(series.length - n - offset, series.length - offset).reduce((a, d) => a + d.n, 0);
