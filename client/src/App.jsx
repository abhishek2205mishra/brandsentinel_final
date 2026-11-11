import { useEffect, useState } from 'react';
import { Routes, Route, NavLink, Link, Navigate, useLocation } from 'react-router-dom';
import { useAuth, can } from './auth';
import { api } from './api';
import { Loading, ago } from './components/ui';
import { useTheme } from './theme';
import { IconBell, IconSun, IconMoon } from './components/icons';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Items from './pages/Items';
import NewReview from './pages/NewReview';
import Review from './pages/Review';
import KnowledgeBase from './pages/KnowledgeBase';
import Insights from './pages/Insights';
import Governance from './pages/Governance';
import AINotice from './pages/AINotice';
import Account from './pages/Account';
import Workflows from './pages/Workflows';
import Verify from './pages/Verify';

const Shield = () => (
  <svg viewBox="0 0 32 32" aria-hidden="true">
    <rect width="32" height="32" rx="8" fill="var(--brand)" />
    <path d="M16 6l8 3v6c0 5-3.5 8.5-8 11-4.5-2.5-8-6-8-11V9z" fill="var(--brand-ink)" />
    <path d="M12.5 15.5l2.5 2.5 5-5" stroke="var(--brand)" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

function Bell() {
  const [list, setList] = useState([]);
  const [open, setOpen] = useState(false);
  const load = () => api.get('/api/admin/notifications').then(setList).catch(() => {});
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, []);
  const unread = list.filter((n) => !n.read).length;
  const toggle = () => { setOpen((o) => !o); if (!open && unread) api.post('/api/admin/notifications/read').then(() => setTimeout(load, 1500)); };
  return (
    <div className="bell">
      <button className="icon-btn" aria-label={`Notifications, ${unread} unread`} aria-expanded={open} onClick={toggle}><IconBell width="18" height="18" />{unread > 0 && <span className="dot">{unread}</span>}</button>
      {open && (
        <div className="dropdown" role="menu">
          {list.length === 0 && <div className="it muted">No notifications yet.</div>}
          {list.map((n) => (n.link
            ? <Link key={n.id} to={n.link} onClick={() => setOpen(false)}>{n.text}<div className="muted small">{ago(n.created_at)}</div></Link>
            : <div key={n.id} className="it">{n.text}</div>))}
        </div>
      )}
    </div>
  );
}

function AiStrip() {
  const [n, setN] = useState(null);
  useEffect(() => { api.get('/api/admin/ai-notice').then(setN).catch(() => {}); }, []);
  if (!n) return null;
  return (
    <div className="ai-strip"><div>
      <strong>AI use:</strong>
      <span>Rules engine runs on this server</span>
      <span>AI assistant: {!n.llm.enabled || !n.llm.configured ? 'off' : n.llm.blocked_by_confidential_mode ? 'blocked by Confidential Mode' : `on (${n.llm.provider}, redacted text only)`}</span>
      <span>Confidential Mode: {n.confidential_mode ? 'on' : 'off'}</span>
      <span>People make every final decision</span>
      <Link to="/ai">Details</Link>
    </div></div>
  );
}

function Layout({ children }) {
  const { user, org, logout } = useAuth();
  const [theme, setTheme] = useTheme();
  const loc = useLocation();
  const r = user.role;
  const initials = user.name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header className="topbar"><div className="topbar-inner">
        <Link to="/" className="logo"><Shield />BrandSentinel</Link>
        <nav className="nav" aria-label="Main">
          <NavLink to="/" end>Dashboard</NavLink>
          <NavLink to="/items" end>Content</NavLink>
          {can.create(r) && <NavLink to="/items/new">New review</NavLink>}
          <NavLink to="/kb">Knowledge base</NavLink>
          {can.insights(r) && <NavLink to="/insights">Insights</NavLink>}
          {can.governance(r) && <NavLink to="/governance">Governance</NavLink>}
          {can.workflows(r) && <NavLink to="/workflows">Workflows</NavLink>}
          <NavLink to="/ai">How we use AI</NavLink>
        </nav>
        <div className="topbar-right">
          <button className="icon-btn" onClick={() => setTheme()} aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} title={theme === 'dark' ? 'Light theme' : 'Dark theme'}>{theme === 'dark' ? <IconSun width="18" height="18" /> : <IconMoon width="18" height="18" />}</button>
          <Bell />
          <Link to="/account" className="user-chip small" title="Your account"><span className="avatar" aria-hidden="true">{initials}</span><span><strong>{user.name}</strong><br /><span className="muted">{r} · {org && org.name}</span></span></Link>
          <button className="btn sm" onClick={logout}>Sign out</button>
        </div>
      </div></header>
      <AiStrip />
      <main id="main"><div className="page" key={loc.pathname}>{children}</div></main>
    </>
  );
}

export default function App() {
  const { user, ready } = useAuth();
  const loc = useLocation();
  if (loc.pathname === '/verify' || loc.pathname.startsWith('/verify/')) return <Routes><Route path="/verify" element={<Verify />} /><Route path="/verify/:code" element={<Verify />} /></Routes>;
  if (!ready) return <Loading label="Starting BrandSentinel…" />;
  if (!user) return loc.pathname === '/login' ? <Login /> : <Navigate to="/login" replace />;
  if (loc.pathname === '/login') return <Navigate to="/" replace />;
  const r = user.role;
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/items" element={<Items />} />
        <Route path="/items/new" element={can.create(r) ? <NewReview /> : <Navigate to="/items" replace />} />
        <Route path="/items/:id" element={<Review />} />
        <Route path="/kb" element={<KnowledgeBase />} />
        <Route path="/insights" element={can.insights(r) ? <Insights /> : <Navigate to="/" replace />} />
        <Route path="/governance" element={can.governance(r) ? <Governance /> : <Navigate to="/" replace />} />
        <Route path="/workflows" element={can.workflows(r) ? <Workflows /> : <Navigate to="/" replace />} />
        <Route path="/ai" element={<AINotice />} />
        <Route path="/account" element={<Account />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
