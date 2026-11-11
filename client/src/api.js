// Thin fetch wrapper. The JWT is kept in localStorage (wrapped in try/catch in case storage is blocked).
// Optional: when the UI is hosted separately from the API (e.g. Vercel + Render) set VITE_API_URL at build time.
const BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
export const apiUrl = (u) => (u.startsWith('/') ? BASE + u : u);
let token = '';
try { token = localStorage.getItem('bs_token') || ''; } catch { /* storage unavailable */ }

export const getToken = () => token;
export function setToken(t) {
  token = t || '';
  try { t ? localStorage.setItem('bs_token', t) : localStorage.removeItem('bs_token'); } catch { /* ignore */ }
}

async function request(method, url, { body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  let res;
  try {
    res = await fetch(apiUrl(url), { method, headers, body: payload });
  } catch {
    throw new Error('Cannot reach the server. Check your connection and try again. If the server was idle it may take up to a minute to wake up.');
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty or non-JSON body */ }
  if (!res.ok) {
    if (res.status === 401 && !url.includes('/auth/login')) { setToken(''); window.dispatchEvent(new Event('bs-logout')); }
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  get: (u) => request('GET', u),
  post: (u, body) => request('POST', u, { body: body ?? {} }),
  put: (u, body) => request('PUT', u, { body }),
  del: (u) => request('DELETE', u),
  form: (u, fd) => request('POST', u, { form: fd }),
};

export const fileUrl = (id, v) => apiUrl(`/api/items/${id}/file?v=${v}&token=${encodeURIComponent(token)}`);
export const reportUrl = (id) => apiUrl(`/api/items/${id}/report?token=${encodeURIComponent(token)}`);
