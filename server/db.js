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
  await makeUserCodesUnique(pool);
  await agentsPerPincode(pool);
  await recoveryListsToClients(pool);
}

/** v9: an agent deputed to a pincode covers it for every client, so area_agents loses its branch column. */
async function agentsPerPincode(pool) {
  const [col] = await pool.query("SHOW COLUMNS FROM area_agents LIKE 'branch'");
  if (!col) return;
  // Keep the most recent deputation where a pincode had agents under two branches.
  await pool.query(
    `DELETE a FROM area_agents a JOIN area_agents b ON a.company_id = b.company_id AND a.pincode = b.pincode
       AND (a.updated_at < b.updated_at OR (a.updated_at = b.updated_at AND a.branch > b.branch))`);
  await pool.query('ALTER TABLE area_agents DROP PRIMARY KEY, DROP COLUMN branch, ADD PRIMARY KEY (company_id, pincode)');
}

/**
 * v9: accounts imported from a lender's recovery list before clients existed carried the lender as their
 * branch ("VFS", product "VFS · NPA · 18%"). They move to a client of that name with no branch, and the
 * field staff of that "branch" become staff for every client.
 */
async function recoveryListsToClients(pool) {
  const lists = await pool.query(
    `SELECT company_id, branch, COUNT(*) AS n FROM loans
     WHERE client_id IS NULL AND pincode IS NOT NULL AND branch <> '' AND product LIKE CONCAT(branch, ' ·%')
     GROUP BY company_id, branch`);
  for (const l of lists) {
    await withTx(pool, async (conn) => {
      let [c] = await conn.query('SELECT id FROM clients WHERE company_id = ? AND code = ?', [l.company_id, l.branch.slice(0, 20)]);
      if (!c) {
        const r = await conn.query('INSERT INTO clients (company_id, code, name, created_at) VALUES (?, ?, ?, ?)',
          [l.company_id, l.branch.slice(0, 20), l.branch, now()]);
        c = { id: r.insertId };
      }
      await conn.query(
        `UPDATE loans SET client_id = ?, branch = '' WHERE company_id = ? AND branch = ? AND client_id IS NULL AND pincode IS NOT NULL`,
        [c.id, l.company_id, l.branch]);
      await conn.query("UPDATE users SET branch = '' WHERE company_id = ? AND branch = ? AND role IN ('officer', 'supervisor')",
        [l.company_id, l.branch]);
      await audit(conn, { code: 'SYSTEM', companyId: l.company_id }, 'client_created', l.branch,
        { accounts: l.n, reason: 'Recovery-list accounts moved from branch to client' });
    });
  }
}

/**
 * User codes are unique across all companies (people sign in with code + PIN only). Codes that
 * were duplicated before this rule keep their oldest owner; the others get the first letters of
 * their company code in front ("FO27" in DATAHAAT becomes "DATFO27"), everywhere they are used.
 */
async function makeUserCodesUnique(pool) {
  const dups = await pool.query(
    `SELECT u.id, u.code, u.company_id, c.code AS company_code FROM users u JOIN companies c ON c.id = u.company_id
     WHERE u.code IN (SELECT code FROM users GROUP BY code HAVING COUNT(*) > 1) ORDER BY u.code, u.company_id, u.id`);
  const seen = new Set();
  for (const u of dups) {
    if (!seen.has(u.code)) {
      seen.add(u.code);
      continue;
    }
    let next = null;
    for (const len of [3, 4, 2, 5, 6, 1]) {
      const candidate = `${u.company_code.slice(0, len)}${u.code}`.slice(0, 12);
      const [taken] = await pool.query('SELECT id FROM users WHERE code = ?', [candidate]);
      if (!taken) {
        next = candidate;
        break;
      }
    }
    if (!next) throw new Error(`Cannot find a free code for ${u.code} in ${u.company_code}; rename it by hand.`);
    await withTx(pool, async (conn) => {
      await conn.query('UPDATE users SET code = ? WHERE id = ?', [next, u.id]);
      await conn.query('UPDATE loans SET officer_code = ? WHERE company_id = ? AND officer_code = ?', [next, u.company_id, u.code]);
      await conn.query('UPDATE payments SET officer_code = ? WHERE company_id = ? AND officer_code = ?', [next, u.company_id, u.code]);
      await conn.query('UPDATE payments SET verified_by = ? WHERE company_id = ? AND verified_by = ?', [next, u.company_id, u.code]);
      await conn.query(
        'UPDATE visits v JOIN loans l ON l.id = v.loan_id SET v.officer_code = ? WHERE l.company_id = ? AND v.officer_code = ?',
        [next, u.company_id, u.code]);
      await audit(conn, { code: 'SYSTEM', companyId: u.company_id }, 'user_code_changed', next,
        { from: u.code, reason: 'User codes must be unique across LoanDesk' });
    });
    console.warn(`User code ${u.code} in ${u.company_code} was also used in another company; it is now ${next}.`);
  }
  await pool.query('ALTER TABLE users ADD UNIQUE KEY IF NOT EXISTS uq_users_code (code)');
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

/** actor: the signed-in user ({ code, companyId, support }) or { code, companyId } for a failed sign-in. */
export function audit(conn, actor, action, entityId, detail) {
  return conn.query(
    'INSERT INTO audit_log (company_id, at, user_code, action, entity_id, detail, support_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [actor.companyId ?? null, now(), actor.code, action, entityId, detail == null ? null : JSON.stringify(detail), actor.support?.id ?? null]
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

/** Columns of a client's recovery list kept on the account: API name → column. */
export const RECOVERY_COLUMNS = {
  custCode: 'cust_code', assetClass: 'asset_class', osAmt: 'os_amt', intRate: 'int_rate', dueSince: 'due_since', odDays: 'od_days',
  pOdue: 'p_odue', iOdue: 'i_odue', oOdue: 'o_odue', tOdue: 't_odue', npaDate: 'npa_date',
};

function recoveryFromRow(r) {
  const out = {};
  for (const [k, col] of Object.entries(RECOVERY_COLUMNS)) if (r[col] != null) out[k] = r[col];
  return Object.keys(out).length ? out : null;
}

export function loanFromRow(r) {
  const recovery = recoveryFromRow(r);
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
    ...(r.pincode || r.district || r.state ? { area: { state: r.state, district: r.district, pincode: r.pincode } } : {}),
    ...(r.client_id ? { client: { id: r.client_id, code: r.client_code, name: r.client_name } } : {}),
    ...(recovery ? { recovery } : {}),
    payments: [],
    visits: [],
  };
}

/** One company's loans with their payments and visits, filtered by officer, branch or id. */
export async function loadLoans(conn, { companyId, officerCode, branch, loanId, where: custom }) {
  if (!companyId) throw new Error('loadLoans needs a companyId');
  // custom: { sql, args } on loans `l` (a supervisor's team, see team.js)
  const [where, extra] = custom
    ? [custom.sql, custom.args]
    : loanId
      ? ['l.id = ?', [loanId]]
      : officerCode
        ? ['l.officer_code = ?', [officerCode]]
        : ['l.branch = ?', [branch]];
  const scope = `l.company_id = ? AND ${where}`;
  const args = [companyId, ...extra];
  const loans = (await conn.query(
    `SELECT l.*, c.code AS client_code, c.name AS client_name FROM loans l LEFT JOIN clients c ON c.id = l.client_id
     WHERE ${scope} ORDER BY l.loan_no`, args)).map(loanFromRow);
  const byId = new Map(loans.map((l) => [l.id, l]));
  if (!loans.length) return loans;
  const payments = await conn.query(
    `SELECT p.* FROM payments p JOIN loans l ON l.id = p.loan_id WHERE ${scope} ORDER BY p.recorded_at`, args);
  for (const r of payments) byId.get(r.loan_id).payments.push(paymentFromRow(r));
  const visits = await conn.query(
    `SELECT v.* FROM visits v JOIN loans l ON l.id = v.loan_id WHERE ${scope} ORDER BY v.recorded_at`, args);
  for (const r of visits) byId.get(r.loan_id).visits.push(visitFromRow(r));
  return loans;
}

/** Inserts or updates a company's loan (used by the loan import and demo seed). */
export async function upsertLoan(conn, companyId, loan, importId = null) {
  // Loan ids are global; never let one company's upsert land on another company's row.
  const [owner] = await conn.query('SELECT company_id FROM loans WHERE id = ?', [loan.id]);
  if (owner && owner.company_id !== companyId) throw new Error(`Loan id ${loan.id} belongs to another company.`);
  const rec = loan.recovery || {};
  const recCols = Object.values(RECOVERY_COLUMNS);
  return conn.query(
    `INSERT INTO loans (company_id, id, loan_no, branch, officer_code, product, principal, emi, disbursed_on, borrower, installments,
       follow_up_date, created_at, updated_at, import_id, state, district, pincode, client_id, source_row, ${recCols.join(', ')})
     VALUES (${Array(20 + recCols.length).fill('?').join(', ')})
     ON DUPLICATE KEY UPDATE loan_no = VALUES(loan_no), branch = VALUES(branch), officer_code = VALUES(officer_code),
       product = VALUES(product), principal = VALUES(principal), emi = VALUES(emi), disbursed_on = VALUES(disbursed_on),
       borrower = VALUES(borrower), installments = VALUES(installments), updated_at = VALUES(updated_at),
       import_id = VALUES(import_id), state = VALUES(state), district = VALUES(district), pincode = VALUES(pincode),
       client_id = VALUES(client_id), source_row = VALUES(source_row), ${recCols.map((c) => `${c} = VALUES(${c})`).join(', ')}`,
    [
      companyId, loan.id, loan.loanNo, loan.branch ?? '', loan.officerCode || null, loan.product, loan.principal, loan.emi,
      loan.disbursedOn, JSON.stringify(loan.borrower), JSON.stringify(loan.installments), loan.followUpDate || null,
      now(), now(), importId, loan.state || null, loan.district || null, loan.pincode || null,
      loan.clientId || null, loan.sourceRow ? JSON.stringify(loan.sourceRow) : null,
      ...Object.keys(RECOVERY_COLUMNS).map((k) => rec[k] ?? null),
    ]
  );
}
