// Client state. The server is the source of truth: every record is sent the moment it's saved.
// The outbox only holds records while the server is unreachable (no signal or maintenance).
import { isoDate, localTimestamp, receiptNumber, findDuplicateSlip } from './logic.js';
import { call, OfflineError, ApiError } from './api.js';
import { getSlip, blobToBase64, clearSlips } from './slips.js';

const KEY = 'loan-recovery:v2';
const AUTO_SYNC_MS = 20000;
const REFRESH_EVERY_MS = 60000;

function blank() {
  return {
    session: null, // { token, user: { code, name, role, branch, company: { code, name } }, expired? }
    features: {}, // what the company's plan includes, from the server
    loans: [],
    outbox: [],
    rejected: [], // records the server refused: { id, type, loanId, summary, error, at }
    receiptSeq: { date: null, seq: 0 },
    lastSyncAt: null,
  };
}

let state = load();
// Not persisted: connection status for the header pill.
export const net = { status: 'unknown', message: '', lastRefreshMs: 0 };
const listeners = new Set();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...blank(), ...JSON.parse(raw) } : blank();
  } catch {
    return blank();
  }
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Storage full or blocked: keep running from memory rather than lose the session.
  }
}

/** Subscribe to data/connection changes. fn(reason) */
export const onChange = (fn) => listeners.add(fn);
const emit = (reason) => listeners.forEach((fn) => fn(reason));

function setNet(status, message = '') {
  if (net.status === status && net.message === message) return;
  Object.assign(net, { status, message });
  emit('net');
}

export const getState = () => state;
export const user = () => state.session?.user || null;
export const getLoan = (id) => state.loans.find((l) => l.id === id);

export function uid(prefix) {
  const rand = crypto.getRandomValues(new Uint32Array(2));
  return `${prefix}-${Date.now().toString(36)}-${rand[0].toString(36)}${rand[1].toString(36)}`;
}

function token() {
  return state.session?.token;
}

/** Handles a failed call: offline → keep working, 401 → ask for login again. */
function handleError(err) {
  if (err instanceof OfflineError) {
    setNet('offline', err.message);
  } else if (err instanceof ApiError && err.status === 401 && state.session) {
    state.session.expired = true;
    save();
    emit('session');
  }
  throw err;
}

// ---------- session ----------

const COMPANY_KEY = 'loandesk:company';
export function rememberedCompany() {
  try {
    return localStorage.getItem(COMPANY_KEY) || '';
  } catch {
    return '';
  }
}

export async function login(company, code, pin) {
  const pending = state.outbox[0]?.officer;
  const pendingCompany = state.session?.user?.company?.code;
  const wanted = String(code).trim().toUpperCase();
  const wantedCompany = String(company || '').trim().toUpperCase();
  if (pending && (pending !== wanted || (pendingCompany && wantedCompany && pendingCompany !== wantedCompany))) {
    throw new Error(`This phone has ${state.outbox.length} unsent record(s) from ${pending}${pendingCompany ? ` (${pendingCompany})` : ''}. Log in as ${pending} to send them first.`);
  }
  const res = await call('login', { method: 'POST', body: { company: wantedCompany, code: wanted, pin } }).catch((err) => {
    if (err instanceof OfflineError) throw new Error('Cannot reach the server. Check your connection and try again.');
    throw err;
  });
  try {
    localStorage.setItem(COMPANY_KEY, res.user.company.code);
  } catch {}
  const sameUser = state.session?.user?.code === res.user.code &&
    (!state.session.user.company || state.session.user.company.code === res.user.company.code);
  state = { ...(sameUser ? state : blank()), session: { token: res.token, user: res.user } };
  if (!sameUser) await clearSlips().catch(() => {});
  save();
  await refresh().catch(() => {});
  await flush().catch(() => {});
  emit('session');
}

export async function logout() {
  if (state.outbox.length) {
    throw new Error(`${state.outbox.length} record(s) haven't reached the server yet. Wait until you're back online.`);
  }
  await call('logout', { method: 'POST', token: token(), timeout: 5000 }).catch(() => {});
  state = blank();
  save();
  await clearSlips().catch(() => {});
  emit('session');
}

// ---------- data from the server ----------

/** Re-applies records the server hasn't received yet on top of fresh server data. */
function applyOutbox(loans) {
  for (const item of state.outbox) {
    const loan = loans.find((l) => l.id === item.loanId);
    if (!loan) continue;
    const list = item.type === 'payment' ? loan.payments : loan.visits;
    if (!list.some((r) => r.id === item.record.id)) list.push({ ...item.record, synced: false });
    if (item.type === 'visit') loan.followUpDate = item.record.followUpDate || item.record.ptpDate || loan.followUpDate;
  }
  return loans;
}

let refreshing = null;
export function refresh() {
  if (!token() || state.session.expired) return Promise.resolve();
  refreshing ||= (async () => {
    try {
      const data = await call('bootstrap', { token: token() });
      state.loans = applyOutbox(data.loans);
      state.session.user = data.user;
      state.features = data.features || {};
      const local = state.receiptSeq.date === data.receiptSeq.date ? state.receiptSeq.seq : 0;
      state.receiptSeq = { date: data.receiptSeq.date, seq: Math.max(local, data.receiptSeq.seq) };
      net.lastRefreshMs = Date.now();
      save();
      setNet(state.outbox.length ? 'pending' : 'online');
      emit('data');
    } catch (err) {
      handleError(err);
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

// ---------- recording (officers) ----------

function nextReceiptNo() {
  const today = isoDate();
  if (state.receiptSeq.date !== today) state.receiptSeq = { date: today, seq: 0 };
  state.receiptSeq.seq += 1;
  return receiptNumber(user()?.code, today, state.receiptSeq.seq);
}

function enqueue(type, loanId, record) {
  state.outbox.push({ id: uid('ob'), type, loanId, record, officer: user().code, queuedAt: localTimestamp() });
}

/**
 * Records a collection locally and starts sending it. `deposit` is set when the borrower paid
 * straight into the bank: { slipNo, bank, depositDate } — the slip image is in IndexedDB under `id`.
 */
export function recordPayment(loanId, { id, amount, mode, reference, location, deposit }) {
  const loan = getLoan(loanId);
  if (!loan) throw new Error('Loan not found');
  if (deposit && findDuplicateSlip(state.loans, deposit.slipNo)) throw new Error('This slip is already recorded.');
  const payment = {
    id: id || uid('p'),
    at: localTimestamp(),
    amount,
    mode,
    reference: reference || '',
    receiptNo: nextReceiptNo(),
    officer: user().code,
    location: location || null,
    synced: false,
    ...(deposit ? { deposit: { ...deposit, verification: 'pending' } } : {}),
  };
  loan.payments.push(payment);
  enqueue('payment', loanId, payment);
  save();
  return payment;
}

export function recordVisit(loanId, { outcome, notes, ptpDate, ptpAmount, followUpDate, location }) {
  const loan = getLoan(loanId);
  if (!loan) throw new Error('Loan not found');
  const visit = {
    id: uid('v'),
    at: localTimestamp(),
    outcome,
    notes: notes || '',
    ptpDate: outcome === 'PTP' ? ptpDate : null,
    ptpAmount: outcome === 'PTP' ? ptpAmount : null,
    followUpDate: followUpDate || null,
    officer: user().code,
    location: location || null,
    synced: false,
  };
  loan.visits.push(visit);
  loan.followUpDate = followUpDate || (outcome === 'PTP' ? ptpDate : null);
  enqueue('visit', loanId, visit);
  save();
  return visit;
}

function summarise(item) {
  const r = item.record;
  const loan = getLoan(item.loanId);
  const who = loan ? `${loan.borrower.name} (${loan.loanNo})` : item.loanId;
  return item.type === 'payment' ? `₹${r.amount} ${r.mode} · ${r.receiptNo} · ${who}` : `Visit · ${who}`;
}

let flushing = null;
/**
 * Sends queued records one at a time, oldest first. Stops at the first connection problem
 * and leaves the rest queued. Resolves to the number of records the server accepted.
 */
export function flush() {
  if (!token() || state.session.expired || !state.outbox.length) return Promise.resolve(0);
  flushing ||= (async () => {
    let sent = 0;
    setNet('syncing');
    try {
      while (state.outbox.length) {
        const item = state.outbox[0];
        let payload = item;
        if (item.record.deposit) {
          const blob = await getSlip(item.record.id);
          payload = blob ? { ...item, slip: { mimeType: blob.type, base64: await blobToBase64(blob) } } : item;
        }
        const { results } = await call('records', { method: 'POST', token: token(), body: { records: [payload] }, timeout: 60000 });
        const result = results[0];
        state.outbox.shift();
        const loan = getLoan(item.loanId);
        const list = loan && (item.type === 'payment' ? loan.payments : loan.visits);
        const local = list?.find((r) => r.id === item.record.id);
        if (result.status === 'rejected') {
          state.rejected.unshift({ id: item.record.id, type: item.type, loanId: item.loanId, summary: summarise(item), error: result.error, at: localTimestamp() });
          if (list && local) list.splice(list.indexOf(local), 1);
        } else {
          if (local) local.synced = true;
          sent += 1;
        }
        state.lastSyncAt = localTimestamp();
        save();
        emit('data');
      }
      setNet('online');
    } catch (err) {
      if (err instanceof ApiError && err.status !== 401) setNet('pending', err.message); // server error: retry later
      else handleError(err);
    } finally {
      flushing = null;
    }
    if (sent) await refresh().catch(() => {});
    return sent;
  })();
  return flushing;
}

export function dismissRejected(id) {
  state.rejected = state.rejected.filter((r) => r.id !== id);
  save();
  emit('data');
}

/** Background loop: resend queued records and pick up supervisor decisions. */
export function startAutoSync() {
  const tick = () => {
    if (document.visibilityState !== 'visible' || !token() || state.session.expired) return;
    if (state.outbox.length) flush().catch(() => {});
    else if (Date.now() - net.lastRefreshMs > REFRESH_EVERY_MS) refresh().catch(() => {});
  };
  setInterval(tick, AUTO_SYNC_MS);
  addEventListener('online', () => {
    net.lastRefreshMs = 0;
    tick();
  });
  addEventListener('offline', () => setNet('offline', 'No network on this phone.'));
  document.addEventListener('visibilitychange', tick);
}

// ---------- supervisor ----------

export async function fetchDeposits(status) {
  try {
    const { deposits } = await call(`deposits?status=${status}`, { token: token() });
    setNet(state.outbox.length ? 'pending' : 'online');
    return deposits;
  } catch (err) {
    return handleError(err);
  }
}

export async function decideDeposit(paymentId, decision, note) {
  try {
    const res = await call(`deposits/${encodeURIComponent(paymentId)}/decision`, {
      method: 'POST', token: token(), body: { decision, note },
    });
    refresh().catch(() => {});
    return res.payment;
  } catch (err) {
    return handleError(err);
  }
}

/** Slip image from this phone if it was captured here, otherwise from the server. */
export async function slipBlob(paymentId) {
  const local = await getSlip(paymentId).catch(() => null);
  if (local) return local;
  try {
    return await call(`slips/${encodeURIComponent(paymentId)}`, { token: token(), raw: true });
  } catch {
    return null;
  }
}
