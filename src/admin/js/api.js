// Admin API client. The session lives in sessionStorage, so closing the browser logs the admin out.
const KEY = 'loan-recovery:admin';

export const session = {
  get() {
    try {
      return JSON.parse(sessionStorage.getItem(KEY));
    } catch {
      return null;
    }
  },
  set(s) {
    sessionStorage.setItem(KEY, JSON.stringify(s));
  },
  clear() {
    sessionStorage.removeItem(KEY);
  },
};

export class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

let onExpired = () => {};
export const setExpiredHandler = (fn) => (onExpired = fn);

async function request(url, { method = 'GET', body, raw = false, auth = true } = {}) {
  const token = session.get()?.token;
  let res;
  try {
    res = await fetch(url, {
      method,
      cache: 'no-store',
      headers: {
        ...(auth && token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check your connection.');
  }
  if (res.status === 401 && auth) {
    session.clear();
    onExpired();
    throw new ApiError(401, 'Your session has expired. Please sign in again.');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data.error || `Request failed (HTTP ${res.status}).`, data);
  }
  return raw ? res : res.json();
}

/** Admin endpoints: api('users'), api('users', { method: 'POST', body }) … */
export const api = (path, opts) => request(`../api/admin/${path}`, opts);

export async function login(company, code, pin) {
  const res = await request('../api/login', { method: 'POST', body: { company, code, pin }, auth: false });
  if (res.user.role !== 'admin') {
    await request('../api/logout', { method: 'POST', raw: true, auth: false }).catch(() => {});
    throw new ApiError(403, 'This console is for admin accounts. Field staff use the mobile app.');
  }
  session.set(res);
  return res.user;
}

/** Who is signed in and what their company's plan includes: { user, plan, features, maxOfficers }. */
export const me = () => request('../api/me');

/** Starts a support session handed over by the overlord console (token in the URL fragment). */
export async function adoptSupportToken(token) {
  session.set({ token, user: null });
  const ctx = await me();
  session.set({ token, user: ctx.user });
  return ctx;
}

export async function logout() {
  const support = session.get()?.user?.support;
  await request(support ? '../api/support/end' : '../api/logout', { method: 'POST' }).catch(() => {});
  session.clear();
}

/** Downloads an authenticated file (CSV export, Excel template). */
export async function download(path, fallbackName) {
  const res = await api(path, { raw: true });
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
