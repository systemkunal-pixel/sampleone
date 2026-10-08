// Thin client for the recovery server (same origin as the app).

/** The server couldn't be reached (no signal, or down for maintenance). Work continues offline. */
export class OfflineError extends Error {}

/** The server answered with an error. */
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function call(path, { token, method = 'GET', body, timeout = 20000, raw = false } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res;
  try {
    res = await fetch(`./api/${path}`, {
      method,
      signal: ctrl.signal,
      cache: 'no-store',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new OfflineError('Server unreachable.');
  } finally {
    clearTimeout(timer);
  }
  // A reverse proxy answers 502/503/504 while the app server is down for maintenance.
  if ([502, 503, 504].includes(res.status)) throw new OfflineError('Server is down for maintenance.');
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data.error || `Server error (HTTP ${res.status}).`);
  }
  return raw ? res.blob() : res.json();
}
