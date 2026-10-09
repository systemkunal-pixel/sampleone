// Overlord API client. The session lives in sessionStorage: closing the browser signs the overlord out.
const KEY = 'loandesk:overlord';

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
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let onExpired = () => {};
export const setExpiredHandler = (fn) => (onExpired = fn);

async function request(path, { method = 'GET', body, auth = true } = {}) {
  const token = session.get()?.token;
  let res;
  try {
    res = await fetch(`../api/overlord/${path}`, {
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
    throw new ApiError(401, 'Your session has ended. Please sign in again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (HTTP ${res.status}).`);
  return data;
}

export const api = (path, opts) => request(path, opts);

/** Step 1: email + password. Returns { stage: 'code' | 'enroll', ticket, … }. */
export const passwordStep = (email, password) => request('login', { method: 'POST', body: { email, password }, auth: false });

/** Step 2: the 6-digit authenticator code. */
export async function codeStep(ticket, code) {
  const res = await request('login/verify', { method: 'POST', body: { ticket, code }, auth: false });
  session.set(res);
  return res;
}

export async function logout() {
  await request('logout', { method: 'POST' }).catch(() => {});
  session.clear();
}
