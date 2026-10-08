import mariadb from 'mariadb';
import { readFile } from 'node:fs/promises';
import { localTimestamp } from '../src/js/logic.js';

export function createPool(dbConfig) {
  return mariadb.createPool({
    ...dbConfig,
    dateStrings: true, // DATE/DATETIME as strings — no timezone shifting
    decimalAsNumber: true,
    bigIntAsNumber: true,
    insertIdAsNumber: true,
    autoJsonMap: false,
  });
}

export async function migrate(pool) {
  const sql = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  const statements = sql
    .replace(/^\s*--.*$/gm, '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of statements) await pool.query(s);
}

/** Runs fn(conn) inside a transaction. */
export async function withTx(pool, fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

export const now = () => localTimestamp().replace('T', ' ');
const ts = (v) => (v ? String(v).replace(' ', 'T') : null);
const json = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);

export function audit(conn, userCode, action, entityId, detail) {
  return conn.query(
    'INSERT INTO audit_log (at, user_code, action, entity_id, detail) VALUES (?, ?, ?, ?, ?)',
    [now(), userCode, action, entityId, detail == null ? null : JSON.stringify(detail)]
  );
}

// ---------- row → API shapes (match what the app stores locally) ----------

export function paymentFromRow(r) {
  return {
    id: r.id,
    at: ts(r.recorded_at),
    amount: r.amount,
    mode: r.mode,
    reference: r.reference,
    receiptNo: r.receipt_no,
    officer: r.officer_code,
    location: json(r.location),
    synced: true,
    ...(r.slip_no
      ? {
          deposit: {
            slipNo: r.slip_no,
            bank: r.deposit_bank,
            depositDate: r.deposit_date,
            verification: r.verification,
            verifiedBy: r.verified_by,
            verifiedAt: ts(r.verified_at),
            note: r.verification_note,
          },
        }
      : {}),
  };
}

export function visitFromRow(r) {
  return {
    id: r.id,
    at: ts(r.recorded_at),
    outcome: r.outcome,
    notes: r.notes,
    ptpDate: r.ptp_date,
    ptpAmount: r.ptp_amount,
    followUpDate: r.follow_up_date,
    officer: r.officer_code,
    location: json(r.location),
    synced: true,
  };
}

export function loanFromRow(r) {
  return {
    id: r.id,
    loanNo: r.loan_no,
    branch: r.branch,
    officerCode: r.officer_code,
    product: r.product,
    principal: r.principal,
    emi: r.emi,
    disbursedOn: r.disbursed_on,
    borrower: json(r.borrower),
    installments: json(r.installments),
    followUpDate: r.follow_up_date,
    payments: [],
    visits: [],
  };
}

/** Loans with their payments and visits, filtered by officer or branch. */
export async function loadLoans(conn, { officerCode, branch, loanId }) {
  const [where, arg] = loanId
    ? ['l.id = ?', loanId]
    : officerCode
      ? ['l.officer_code = ?', officerCode]
      : ['l.branch = ?', branch];
  const loans = (await conn.query(`SELECT l.* FROM loans l WHERE ${where} ORDER BY l.loan_no`, [arg])).map(loanFromRow);
  const byId = new Map(loans.map((l) => [l.id, l]));
  if (!loans.length) return loans;
  const payments = await conn.query(
    `SELECT p.* FROM payments p JOIN loans l ON l.id = p.loan_id WHERE ${where} ORDER BY p.recorded_at`, [arg]);
  for (const r of payments) byId.get(r.loan_id).payments.push(paymentFromRow(r));
  const visits = await conn.query(
    `SELECT v.* FROM visits v JOIN loans l ON l.id = v.loan_id WHERE ${where} ORDER BY v.recorded_at`, [arg]);
  for (const r of visits) byId.get(r.loan_id).visits.push(visitFromRow(r));
  return loans;
}

/** Inserts or updates a loan (used by the loan import and demo seed). */
export function upsertLoan(conn, loan) {
  return conn.query(
    `INSERT INTO loans (id, loan_no, branch, officer_code, product, principal, emi, disbursed_on, borrower, installments, follow_up_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE loan_no = VALUES(loan_no), branch = VALUES(branch), officer_code = VALUES(officer_code),
       product = VALUES(product), principal = VALUES(principal), emi = VALUES(emi), disbursed_on = VALUES(disbursed_on),
       borrower = VALUES(borrower), installments = VALUES(installments)`,
    [
      loan.id, loan.loanNo, loan.branch, loan.officerCode || null, loan.product, loan.principal, loan.emi,
      loan.disbursedOn, JSON.stringify(loan.borrower), JSON.stringify(loan.installments), loan.followUpDate || null,
    ]
  );
}
