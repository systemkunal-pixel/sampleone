// Pure loan-recovery logic. No DOM, no storage — safe to unit test in Node.

export const VISIT_OUTCOMES = [
  { code: 'PAID', label: 'Paid in full' },
  { code: 'PARTIAL', label: 'Partial payment' },
  { code: 'PTP', label: 'Promise to pay' },
  { code: 'NOT_AVAILABLE', label: 'Borrower not available' },
  { code: 'DOOR_LOCKED', label: 'Door locked' },
  { code: 'REFUSED', label: 'Refused to pay' },
  { code: 'DISPUTE', label: 'Disputes the dues' },
  { code: 'SHIFTED', label: 'Shifted / not traceable' },
];

export const BANK_DEPOSIT = 'Bank deposit';
export const PAYMENT_MODES = ['Cash', 'UPI', 'Cheque', 'Bank transfer', BANK_DEPOSIT];

export const DPD_BUCKETS = [
  { key: 'current', label: 'Current', min: 0, max: 0 },
  { key: '1-30', label: '1–30 DPD', min: 1, max: 30 },
  { key: '31-60', label: '31–60 DPD', min: 31, max: 60 },
  { key: '61-90', label: '61–90 DPD', min: 61, max: 90 },
  { key: '90+', label: '90+ DPD (NPA)', min: 91, max: Infinity },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Local calendar date as YYYY-MM-DD. */
export function isoDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Whole days from date string a to date string b (b - a). */
/** Local timestamp as YYYY-MM-DDTHH:MM:SS (no timezone shift, sorts lexically). */
export function localTimestamp(d = new Date()) {
  const t = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0'));
  return `${isoDate(d)}T${t.join(':')}`;
}

export function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / DAY_MS);
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return isoDate(new Date(y, m - 1, d + n));
}

export function addMonths(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  // Clamp to the last day of the target month (e.g. Jan 31 + 1 month = Feb 28/29).
  const lastDay = new Date(y, m - 1 + n + 1, 0).getDate();
  return isoDate(new Date(y, m - 1 + n, Math.min(d, lastDay)));
}

/** Round to paise to avoid floating point drift. */
export function money(n) {
  return Math.round(n * 100) / 100;
}

export function formatINR(n) {
  return '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

export function totalPaid(loan) {
  return money(loan.payments.reduce((s, p) => s + p.amount, 0));
}

/**
 * Allocates payments to installments oldest-first and returns each installment
 * with its paid and pending amounts.
 */
export function allocate(loan) {
  let pool = totalPaid(loan);
  return [...loan.installments]
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .map((inst) => {
      const paid = money(Math.min(pool, inst.amount));
      pool = money(pool - paid);
      return { ...inst, paid, pending: money(inst.amount - paid) };
    });
}

/** Full status of a loan as of a given date. */
export function loanStatus(loan, today = isoDate()) {
  const rows = allocate(loan);
  const due = rows.filter((r) => r.dueDate <= today);
  const overdue = money(due.reduce((s, r) => s + r.pending, 0));
  const outstanding = money(rows.reduce((s, r) => s + r.pending, 0));
  const oldestUnpaid = due.find((r) => r.pending > 0);
  const dpd = oldestUnpaid ? Math.max(0, daysBetween(oldestUnpaid.dueDate, today)) : 0;
  const next = rows.find((r) => r.dueDate > today && r.pending > 0);
  return {
    overdue,
    outstanding,
    dpd,
    bucket: bucketFor(dpd, overdue),
    overdueInstallments: due.filter((r) => r.pending > 0).length,
    nextDue: next ? { date: next.dueDate, amount: next.pending } : null,
    closed: outstanding <= 0,
  };
}

export function bucketFor(dpd, overdue = 1) {
  if (overdue <= 0) return DPD_BUCKETS[0];
  return DPD_BUCKETS.find((b) => dpd >= b.min && dpd <= b.max) || DPD_BUCKETS[0];
}

/** The most recent visit carrying an open promise to pay, if any. */
export function activePromise(loan) {
  const ptps = loan.visits.filter((v) => v.outcome === 'PTP' && v.ptpDate);
  if (!ptps.length) return null;
  const latest = ptps.reduce((a, b) => (a.at > b.at ? a : b));
  // A payment made on or after the promise was recorded keeps the promise.
  const paidSince = money(
    loan.payments.filter((p) => p.at >= latest.at).reduce((s, p) => s + p.amount, 0)
  );
  const kept = paidSince >= (latest.ptpAmount || 0) && paidSince > 0;
  return { ...latest, kept };
}

/**
 * Priority score for ordering the day's visit list. Higher = visit sooner.
 * Broken or due-today promises jump the queue; otherwise ageing and amount drive it.
 */
export function priorityScore(loan, today = isoDate()) {
  const st = loanStatus(loan, today);
  if (st.closed || st.overdue <= 0) return 0;
  let score = Math.min(st.dpd, 180) * 10 + Math.min(st.overdue / 1000, 200);
  const ptp = activePromise(loan);
  if (ptp && !ptp.kept) {
    if (ptp.ptpDate === today) score += 3000;
    else if (ptp.ptpDate < today) score += 2000; // broken promise
    else score -= 1500; // promise still in the future — give them time
  }
  if (loan.followUpDate && loan.followUpDate <= today) score += 1000;
  // Any overdue account stays on the list, however far down.
  return Math.max(1, Math.round(score));
}

export function visitList(loans, today = isoDate()) {
  return loans
    .map((loan) => ({ loan, status: loanStatus(loan, today), score: priorityScore(loan, today) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
}

/** Validates a payment against the loan and returns an error string or null. */
export function validatePayment(loan, amount, today = isoDate()) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return 'Enter an amount greater than zero.';
  if (money(n) !== n) return 'Amount can have at most two decimal places.';
  const { outstanding } = loanStatus(loan, today);
  if (n > outstanding) return `Amount exceeds total outstanding of ${formatINR(outstanding)}.`;
  return null;
}

export const normaliseSlipNo = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Returns the loan and payment already carrying this slip number, if any. */
export function findDuplicateSlip(loans, slipNo) {
  const key = normaliseSlipNo(slipNo);
  if (!key) return null;
  for (const loan of loans) {
    const payment = loan.payments.find((p) => p.deposit && normaliseSlipNo(p.deposit.slipNo) === key);
    if (payment) return { loan, payment };
  }
  return null;
}

/**
 * Validates the details of a borrower's direct bank deposit.
 * Returns an error string or null.
 */
export function validateDeposit({ slipNo, depositDate, bank, hasSlip }, loans, today = isoDate()) {
  if (!hasSlip) return 'Attach a photo of the deposit slip.';
  if (!normaliseSlipNo(slipNo)) return 'Enter the slip / journal number printed on the slip.';
  if (!String(bank || '').trim()) return 'Enter the bank and branch where it was deposited.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(depositDate || '')) return 'Enter the deposit date.';
  if (depositDate > today) return 'Deposit date cannot be in the future.';
  if (daysBetween(depositDate, today) > 90) return 'Deposit is more than 90 days old — refer it to the branch.';
  const dup = findDuplicateSlip(loans, slipNo);
  if (dup) return `Slip ${slipNo} is already recorded on ${dup.loan.loanNo} (${dup.loan.borrower.name}).`;
  return null;
}

/** Receipt number: R-<officer>-<yymmdd>-<seq>, unique per device per day. */
export function receiptNumber(officerCode, dateStr, seq) {
  const ymd = dateStr.replaceAll('-', '').slice(2);
  const code = (officerCode || 'FO').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'FO';
  return `R-${code}-${ymd}-${String(seq).padStart(3, '0')}`;
}

/** Great-circle distance in km between two {lat, lng} points. */
export function distanceKm(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const R = 6371;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Collection and visit totals for one day. */
export function daySummary(loans, day = isoDate()) {
  const payments = [];
  const visits = [];
  for (const loan of loans) {
    for (const p of loan.payments) if (p.at.slice(0, 10) === day) payments.push({ ...p, loan });
    for (const v of loan.visits) if (v.at.slice(0, 10) === day) visits.push({ ...v, loan });
  }
  const byMode = {};
  for (const p of payments) byMode[p.mode] = money((byMode[p.mode] || 0) + p.amount);
  const byOutcome = {};
  for (const v of visits) byOutcome[v.outcome] = (byOutcome[v.outcome] || 0) + 1;
  return {
    collected: money(payments.reduce((s, p) => s + p.amount, 0)),
    payments,
    visits,
    byMode,
    byOutcome,
    ptpCount: visits.filter((v) => v.outcome === 'PTP').length,
  };
}

/** Portfolio totals grouped by DPD bucket. */
export function portfolioSummary(loans, today = isoDate()) {
  const buckets = Object.fromEntries(DPD_BUCKETS.map((b) => [b.key, { ...b, count: 0, overdue: 0 }]));
  let overdue = 0;
  let outstanding = 0;
  for (const loan of loans) {
    const st = loanStatus(loan, today);
    if (st.closed) continue;
    const b = buckets[st.bucket.key];
    b.count += 1;
    b.overdue = money(b.overdue + st.overdue);
    overdue = money(overdue + st.overdue);
    outstanding = money(outstanding + st.outstanding);
  }
  return { buckets: Object.values(buckets), overdue, outstanding };
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  // Neutralise spreadsheet formula injection and quote when needed.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function toCSV(headers, rows) {
  return [headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}

export function collectionsCSV(loans, day) {
  const { payments, visits } = daySummary(loans, day);
  const rows = [
    ...payments.map((p) => [
      p.at, 'PAYMENT', p.loan.loanNo, p.loan.borrower.name, p.amount, p.mode, p.receiptNo, p.reference || '',
      p.deposit ? `Deposited ${p.deposit.depositDate} at ${p.deposit.bank}; slip ${p.deposit.verification}` : '',
    ]),
    ...visits.map((v) => [
      v.at, 'VISIT', v.loan.loanNo, v.loan.borrower.name, v.ptpAmount || '', '', '',
      outcomeLabel(v.outcome), v.notes || '',
    ]),
  ].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return toCSV(
    ['Timestamp', 'Type', 'Loan No', 'Borrower', 'Amount', 'Mode', 'Receipt No', 'Reference/Outcome', 'Notes'],
    rows
  );
}

export function outcomeLabel(code) {
  return VISIT_OUTCOMES.find((o) => o.code === code)?.label || code;
}
