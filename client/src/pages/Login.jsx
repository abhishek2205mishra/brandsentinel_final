import { useState } from 'react';
import { useAuth } from '../auth';
import { FloatField } from '../components/ui';
import { useTheme } from '../theme';
import { IconShield, IconSpark, IconLock, IconEye, IconSun, IconMoon } from '../components/icons';

const DEMO = [
  ['creator@novabrew.test', 'Creator', 'Submits content, fixes issues'],
  ['reviewer@novabrew.test', 'Reviewer', 'Reviews and approves low/medium risk'],
  ['approver@novabrew.test', 'Approver', 'Final sign-off on high risk'],
  ['admin@novabrew.test', 'Brand admin', 'Owns guidelines and settings'],
  ['agency@novabrew.test', 'Agency', 'External partner, redacted view'],
  ['auditor@novabrew.test', 'Auditor', 'Read-only governance view'],
];

const Logo = () => (
  <svg viewBox="0 0 32 32" width="40" height="40" aria-hidden="true">
    <defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#7c3aed" /><stop offset="1" stopColor="#22d3ee" /></linearGradient></defs>
    <rect width="32" height="32" rx="9" fill="url(#lg)" />
    <path d="M16 6l8 3v6c0 5-3.5 8.5-8 11-4.5-2.5-8-6-8-11V9z" fill="#fff" />
    <path d="M12.5 15.5l2.5 2.5 5-5" stroke="#6d4cf0" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export default function Login() {
  const { login, register } = useAuth();
  const [theme, setTheme] = useTheme();
  const [mode, setMode] = useState('login');
  const [f, setF] = useState({ email: '', password: '', orgName: '', name: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setErr(''); setBusy(true);
    try { mode === 'login' ? await login(f.email, f.password) : await register(f); }
    catch (ex) { setErr(ex.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="auth">
      <aside className="auth-hero" aria-label="About BrandSentinel">
        <span className="blob b1" /><span className="blob b2" /><span className="blob b3" />
        <div className="row" style={{ gap: 12 }}><Logo /><strong style={{ fontSize: '1.2rem', letterSpacing: '-0.02em' }}>BrandSentinel</strong></div>
        <div>
          <h2>Publish with <span className="grad-text" style={{ backgroundImage: 'linear-gradient(120deg,#c4b5fd,#67e8f9)' }}>confidence</span>, not hope.</h2>
          <p>Every brand, fact, claim and accessibility problem is caught before anything goes out, and every finding shows the approved source behind it.</p>
          <div className="hero-points">
            <div><IconShield />Evidence-or-silence: no source, no finding</div>
            <div><IconSpark />Minimal fixes that keep your message intact</div>
            <div><IconLock />Redaction, Confidential Mode and an audit trail</div>
            <div><IconEye />People make every final decision</div>
          </div>
        </div>
        <div className="hero-preview" aria-hidden="true">
          <div className="glass-card">
            <div className="q">Our new roast is <mark>India&apos;s #1</mark> coffee, now <mark>30%</mark> off.</div>
            <div className="cite"><span className="pill">High</span>Claim Ledger · CLAIM-1 and FACT-1 cited</div>
          </div>
          <div className="glass-card">
            <div className="q">Our new roast is <b>a trusted</b> coffee, now <b>20%</b> off.</div>
            <div className="cite"><span className="pill ok">Fixed</span>Purpose kept 99% · cleared for approval</div>
          </div>
        </div>
        <div className="hero-foot">Evidence-backed brand governance · rules first, AI second</div>
      </aside>

      <section className="auth-form-side">
        <div className="auth-card">
          <div className="auth-top">
            <div className="seg" role="group" aria-label="Sign in or sign up">
              <button type="button" aria-pressed={mode === 'login'} onClick={() => { setMode('login'); setErr(''); }}>Sign in</button>
              <button type="button" aria-pressed={mode === 'register'} onClick={() => { setMode('register'); setErr(''); }}>Sign up</button>
            </div>
            <button type="button" className="icon-btn" onClick={() => setTheme()} aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>{theme === 'dark' ? <IconSun width="18" height="18" /> : <IconMoon width="18" height="18" />}</button>
          </div>
          <h1>{mode === 'login' ? <>Welcome <span className="grad-text">back</span></> : <>Create your <span className="grad-text">workspace</span></>}</h1>
          <p className="muted" style={{ marginBottom: 24 }}>{mode === 'login' ? 'Sign in to review content against your brand.' : 'Start with a ready-made guideline pack. You become the admin.'}</p>
          <form onSubmit={submit}>
            {mode === 'register' && <>
              <FloatField label="Organisation name" type="text" required value={f.orgName} onChange={set('orgName')} />
              <FloatField label="Your name" type="text" required value={f.name} onChange={set('name')} />
            </>}
            <FloatField label="Email" type="email" required autoComplete="username" value={f.email} onChange={set('email')} />
            <FloatField label="Password" type="password" required autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={f.password} onChange={set('password')} hint={mode === 'register' ? 'At least 8 characters.' : ''} />
            {err && <div className="notice err" role="alert">{err}</div>}
            <button className="cta" disabled={busy}>{busy ? <span className="spinner" aria-hidden="true" /> : null}{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create organisation'}</button>
          </form>
          {mode === 'login' && (
            <div className="demo-box">
              <h3>Try the demo brand (NovaBrew Coffee)</h3>
              <p className="muted small">Pick a role to fill the form. Password for every demo user: <span className="mono">Demo@1234</span></p>
              <div className="demo-users">
                {DEMO.map(([email, name, hint]) => (
                  <button key={email} type="button" className="chip" title={hint} aria-pressed={f.email === email} onClick={() => setF({ ...f, email, password: 'Demo@1234' })}>{name}</button>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
