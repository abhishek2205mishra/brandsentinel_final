import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api, setToken, getToken } from './api';

const Ctx = createContext(null);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [org, setOrg] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const out = () => { setUser(null); setOrg(null); };
    window.addEventListener('bs-logout', out);
    if (!getToken()) { setReady(true); return () => window.removeEventListener('bs-logout', out); }
    api.get('/api/auth/me').then((d) => { setUser(d.user); setOrg(d.org); }).catch(() => {}).finally(() => setReady(true));
    return () => window.removeEventListener('bs-logout', out);
  }, []);

  const login = useCallback(async (email, password) => {
    const d = await api.post('/api/auth/login', { email, password });
    setToken(d.token); setUser(d.user); setOrg(d.org);
  }, []);
  const register = useCallback(async (payload) => {
    const d = await api.post('/api/auth/register-org', payload);
    setToken(d.token); setUser(d.user); setOrg(d.org);
  }, []);
  const logout = useCallback(() => { setToken(''); setUser(null); setOrg(null); }, []);

  return <Ctx.Provider value={{ user, org, ready, login, register, logout }}>{children}</Ctx.Provider>;
}

// Which screens each role may open (mirrors the server-side checks).
export const can = {
  create: (r) => ['admin', 'creator', 'agency', 'reviewer', 'approver'].includes(r),
  insights: (r) => ['admin', 'approver', 'reviewer', 'auditor'].includes(r),
  governance: (r) => ['admin', 'approver', 'auditor'].includes(r),
  workflows: (r) => ['admin', 'approver', 'reviewer', 'auditor'].includes(r),
  editKb: (r) => r === 'admin',
  review: (r) => ['reviewer', 'approver', 'admin'].includes(r),
};
