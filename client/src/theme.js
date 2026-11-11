// Dark ("Midnight") is the default; the choice is remembered per browser. Storage may be blocked, so every access is guarded.
import { useEffect, useState } from 'react';

const KEY = 'bs_theme';
export function getTheme() {
  try { const t = localStorage.getItem(KEY); if (t === 'light' || t === 'dark') return t; } catch { /* storage unavailable */ }
  return 'dark';
}
export function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem(KEY, t); } catch { /* ignore */ }
  window.dispatchEvent(new Event('bs-theme'));
}
export function initTheme() { document.documentElement.setAttribute('data-theme', getTheme()); }

export function useTheme() {
  const [theme, setTheme] = useState(getTheme());
  useEffect(() => {
    const f = () => setTheme(document.documentElement.getAttribute('data-theme') || 'dark');
    window.addEventListener('bs-theme', f);
    return () => window.removeEventListener('bs-theme', f);
  }, []);
  return [theme, (t) => applyTheme(t || (theme === 'dark' ? 'light' : 'dark'))];
}
