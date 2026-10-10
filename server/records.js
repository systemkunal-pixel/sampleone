// Validates and stores payments and visits sent by officers' phones.
import {
  PAYMENT_MODES, BANK_DEPOSIT, VISIT_OUTCOMES, money, loanStatus, validateDeposit, normaliseSlipNo,
} from '../src/js/logic.js';
import { withTx, now, loadLoans, audit } from './db.js';

export const MAX_SLIP_BYTES = 5 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const OUTCOMES = new Set(VISIT_OUTCOMES.map((o) => o.code));

const SIGNATURES = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 4).toString('hex') === '89504e47',
  'image/webp': (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP',
  'application/pdf': (b) => b.subarray(0, 5).toString() === '%PDF-',
};

class Rejected extends Error {}
const reject = (msg) => {
  throw new Rejected(msg);
};

const str = (v, max) => (typeof v === 'string' && v.length <= max ? v.trim() : reject('Malformed record.'));
const optStr = (v, max) => (v == null || v === '' ? '' : str(v, max));
const optDate = (v) => (v == null || v === '' ? null : DATE.test(v) ? v : reject('Malformed date.'));
const sqlTs = (v) => (TS.test(v || '') ? v.replace('T', ' ') : reject('Malformed timestamp.'));

function location(v) {
  if (v == null) return null;
  const ok = [v.lat, v.lng].every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    Math.abs(v.lat) <= 90 && Math.abs(v.lng) <= 180;
  if (!ok) reject('Malformed location.');
  return JSON.stringify({ lat: v.lat, lng: v.lng, accuracy: Number(v.accuracy) || null });
}

function amountOf(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || money(v) !== v) reject('Invalid amount.');
  return v;
}

function decodeSlip(slip) {
  if (!slip || typeof slip.base64 !== 'string') reject('Deposit slip image is missing.');
  const check = SIGNATURES[slip.mimeType];
  if (!check) reject('Slip must be a JPEG, PNG, WebP or PDF.');
  const buf = Buffer.from(slip.base64, 'base64');
  if (!buf.length || buf.length > MAX_SLIP_BYTES) reject('Slip file is empty or larger than 5 MB.');
  if (!check(buf)) reject('Slip file is corrupt or not the type it claims to be.');
  return { mimeType: slip.mimeType, data: buf };
}

async function lockAssignedLoan(conn, user, loanId) {
  const [row] = await conn.query('SELECT id, officer_code FROM loans WHERE id = ? AND company_id = ? FOR UPDATE', [loanId, user.companyId]);
  if (!row) reject('Account not found on the server.');
  if (row.officer_code !== user.code) reject('This account is not assigned to you.');
}

async function storePayment(conn, user, loanId, r, slip, features) {
  const amount = amountOf(r.amount);
  if (!PAYMENT_MODES.includes(r.mode)) reject('Unknown payment mode.');
  const at = sqlTs(r.at);
  const receiptNo = str(r.receiptNo, 40);
  const reference = optStr(r.reference, 60);
  if (r.mode !== 'Cash' && r.mode !== BANK_DEPOSIT && !reference) reject(`${r.mode} reference is required.`);

  if (r.mode === BANK_DEPOSIT && !features.bank_deposits) reject("Bank deposits aren't included in your company's LoanDesk plan.");
  const [loan] = await loadLoans(conn, { companyId: user.companyId, loanId });
  const { outstanding } = loanStatus(loan, r.at.slice(0, 10));
  if (amount > outstanding) reject(`Amount exceeds the outstanding balance of ₹${outstanding}.`);

  let dep = null;
  if (r.mode === BANK_DEPOSIT) {
    const d = r.deposit || reject('Deposit details are missing.');
    dep = { slipNo: str(d.slipNo, 40), bank: str(d.bank, 100), depositDate: optDate(d.depositDate) };
    // Duplicate slips are enforced by the unique slip_key index below.
    const err = validateDeposit({ ...dep, hasSlip: true }, [], r.at.slice(0, 10));
    if (err) reject(err);
  }
  const slipFile = dep ? decodeSlip(slip) : null;

  try {
    await conn.query(
      `INSERT INTO payments (company_id, id, loan_id, recorded_at, amount, mode, reference, receipt_no, officer_code, location, received_at,
         slip_no, slip_key, deposit_bank, deposit_date, verification)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        user.companyId, r.id, loanId, at, amount, r.mode, dep ? dep.slipNo : reference, receiptNo, user.code, location(r.location), now(),
        dep?.slipNo ?? null, dep ? normaliseSlipNo(dep.slipNo) : null, dep?.bank ?? null, dep?.depositDate ?? null,
        dep ? 'pending' : null,
      ]
    );
    // Billing keeps the client and circle the account had on the day it was collected.
    await conn.query('UPDATE payments p JOIN loans l ON l.id = p.loan_id SET p.client_id = l.client_id, p.circle_id = l.circle_id WHERE p.id = ?', [r.id]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY' && /slip/.test(err.message)) {
      const [other] = await conn.query(
        'SELECT l.loan_no FROM payments p JOIN loans l ON l.id = p.loan_id WHERE p.company_id = ? AND p.slip_key = ?',
        [user.companyId, normaliseSlipNo(dep.slipNo)]
      );
      reject(`Slip ${dep.slipNo} is already recorded${other ? ` on ${other.loan_no}` : ''}.`);
    }
    throw err;
  }
  if (slipFile) {
    await conn.query('INSERT INTO deposit_slips (payment_id, mime_type, data) VALUES (?, ?, ?)', [r.id, slipFile.mimeType, slipFile.data]);
  }
}

async function storeVisit(conn, user, loanId, r) {
  if (!OUTCOMES.has(r.outcome)) reject('Unknown visit outcome.');
  const isPtp = r.outcome === 'PTP';
  const ptpDate = isPtp ? optDate(r.ptpDate) : null;
  const ptpAmount = isPtp ? amountOf(r.ptpAmount) : null;
  if (isPtp && !ptpDate) reject('Promise date is required.');
  const followUp = optDate(r.followUpDate);
  await conn.query(
    `INSERT INTO visits (id, loan_id, recorded_at, outcome, notes, ptp_date, ptp_amount, follow_up_date, officer_code, location, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [r.id, loanId, sqlTs(r.at), r.outcome, optStr(r.notes, 500), ptpDate, ptpAmount, followUp, user.code, location(r.location), now()]
  );
  await conn.query('UPDATE loans SET follow_up_date = ? WHERE id = ?', [followUp || ptpDate, loanId]);
}

/**
 * Stores one outbox item. Idempotent: a record id already on the server returns 'duplicate',
 * so a phone that lost the response can safely resend.
 */
export async function acceptRecord(pool, user, item, features = {}) {
  const r = item?.record;
  const id = r?.id;
  if (!ID.test(id || '') || !ID.test(item?.loanId || '') || !['payment', 'visit'].includes(item?.type)) {
    return { id: id ?? null, status: 'rejected', error: 'Malformed record.' };
  }
  const table = item.type === 'payment' ? 'payments' : 'visits';
  try {
    return await withTx(pool, async (conn) => {
      await lockAssignedLoan(conn, user, item.loanId);
      const [existing] = await conn.query(`SELECT id FROM ${table} WHERE id = ?`, [id]);
      if (existing) return { id, status: 'duplicate' };
      if (item.type === 'payment') await storePayment(conn, user, item.loanId, r, item.slip, features);
      else await storeVisit(conn, user, item.loanId, r);
      return { id, status: 'accepted' };
    });
  } catch (err) {
    if (err instanceof Rejected) {
      await audit(pool, user, `reject_${item.type}`, id, { loanId: item.loanId, reason: err.message }).catch(() => {});
      return { id, status: 'rejected', error: err.message };
    }
    throw err;
  }
}
