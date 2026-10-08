// Device-local persistence plus an outbox of records awaiting sync.
import { isoDate, localTimestamp, receiptNumber } from './logic.js';
import { seedLoans } from './seed.js';

const KEY = 'loan-recovery:v1';

function blank() {
  return {
    officer: null, // { name, code, branch }
    loans: [],
    outbox: [],
    receiptSeq: { date: null, seq: 0 },
    settings: { syncUrl: '', syncToken: '' },
    lastSyncAt: null,
  };
}

let state = load();
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
  localStorage.setItem(KEY, JSON.stringify(state));
  listeners.forEach((fn) => fn(state));
}

export const getState = () => state;
export const onChange = (fn) => listeners.add(fn);

export function uid(prefix) {
  const rand = crypto.getRandomValues(new Uint32Array(2));
  return `${prefix}-${Date.now().toString(36)}-${rand[0].toString(36)}${rand[1].toString(36)}`;
}

export function getLoan(id) {
  return state.loans.find((l) => l.id === id);
}

export function setupOfficer(officer, withDemoData) {
  state.officer = officer;
  if (withDemoData && !state.loans.length) state.loans = seedLoans();
  save();
}

export function updateOfficer(officer) {
  state.officer = { ...state.officer, ...officer };
  save();
}

export function updateSettings(settings) {
  state.settings = { ...state.settings, ...settings };
  save();
}

function nextReceiptNo() {
  const today = isoDate();
  if (state.receiptSeq.date !== today) state.receiptSeq = { date: today, seq: 0 };
  state.receiptSeq.seq += 1;
  return receiptNumber(state.officer?.code, today, state.receiptSeq.seq);
}

function enqueue(type, loanId, record) {
  state.outbox.push({ id: uid('ob'), type, loanId, record, queuedAt: localTimestamp() });
}

/** Records a collection and returns the stored payment. */
export function recordPayment(loanId, { amount, mode, reference, location }) {
  const loan = getLoan(loanId);
  if (!loan) throw new Error('Loan not found');
  const payment = {
    id: uid('p'),
    at: localTimestamp(),
    amount,
    mode,
    reference: reference || '',
    receiptNo: nextReceiptNo(),
    officer: state.officer?.code || '',
    location: location || null,
    synced: false,
  };
  loan.payments.push(payment);
  enqueue('payment', loanId, payment);
  save();
  return payment;
}

/** Records a field visit (and optional follow-up date) and returns it. */
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
    officer: state.officer?.code || '',
    location: location || null,
    synced: false,
  };
  loan.visits.push(visit);
  loan.followUpDate = followUpDate || (outcome === 'PTP' ? ptpDate : null);
  enqueue('visit', loanId, visit);
  save();
  return visit;
}

/**
 * Pushes queued records to the configured sync endpoint.
 * Expects the server to answer 2xx once it has stored every record in the batch.
 */
export async function syncNow() {
  const { syncUrl, syncToken } = state.settings;
  if (!syncUrl) throw new Error('No sync URL configured. Add one in Settings.');
  if (!navigator.onLine) throw new Error('You are offline. Records stay queued on this device.');
  const batch = state.outbox.slice();
  if (!batch.length) return 0;
  const res = await fetch(syncUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(syncToken ? { Authorization: `Bearer ${syncToken}` } : {}),
    },
    body: JSON.stringify({ officer: state.officer, sentAt: localTimestamp(), records: batch }),
  });
  if (!res.ok) throw new Error(`Server rejected sync (HTTP ${res.status}). Records stay queued.`);
  const sent = new Set(batch.map((b) => b.record.id));
  state.outbox = state.outbox.filter((o) => !sent.has(o.record.id));
  for (const loan of state.loans) {
    for (const r of [...loan.payments, ...loan.visits]) if (sent.has(r.id)) r.synced = true;
  }
  state.lastSyncAt = localTimestamp();
  save();
  return batch.length;
}

export function exportBackup() {
  return JSON.stringify(state, null, 2);
}

export function importBackup(json) {
  const data = JSON.parse(json);
  if (!Array.isArray(data.loans)) throw new Error('Not a valid backup file.');
  state = { ...blank(), ...data };
  save();
}

/** Replaces the loan book (e.g. a branch allocation file), keeping unsynced work. */
export function loadDemoData() {
  if (state.outbox.length) throw new Error('Sync or export pending records before reloading data.');
  state.loans = seedLoans();
  save();
}

export function resetAll() {
  state = blank();
  save();
}
