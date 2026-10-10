// Admin console API (/api/admin/*). Every route requires an admin session.
import { loanStatus, isoDate, DPD_BUCKETS, toCSV } from '../src/js/logic.js';
import { hashPin, validPin, pinRule, verifyPin, SUPPORT_CODE } from './auth.js';
import { companyEntitlements } from './plans.js';
import { loadLoans, upsertLoan, withTx, audit, now } from './db.js';
import { HttpError, send } from './http.js';
import { EMAIL } from './mail.js';
import { readImportFile, normalise, checkAgainstDb, buildTemplate, ImportError, MAX_FILE_BYTES } from './importer.js';

const ROLES = ['officer', 'supervisor', 'admin'];
const CODE = /^[A-Z0-9]{2,12}$/;
const IMPORT_BODY = Math.ceil(MAX_FILE_BYTES * 1.4) + 1024 * 1024;
const COMMIT_BODY = 40 * 1024 * 1024;

const str = (v) => String(v ?? '').trim();
const SUMMARY = ['off', 'daily', 'weekly'];

/** Admins may have an email address (password resets, summaries); field staff don't. */
function emailFields(b, role, current = {}) {
  if (role !== 'admin') return { email: null, summary: current.summary_email || 'daily' };
  let email = b.email !== undefined ? str(b.email).toLowerCase() || null : current.email ?? null;
  if (email && (!EMAIL.test(email) || email.length > 190)) throw new HttpError(400, 'Enter a valid email address, or leave it empty.');
  const summary = b.summaryEmail !== undefined ? str(b.summaryEmail) : current.summary_email || 'daily';
  if (!SUMMARY.includes(summary)) throw new HttpError(400, 'Choose how often to send the summary email.');
  return { email, summary };
}

function userRow(u) {
  return {
    code: u.code, name: u.name, role: u.role, branch: u.branch, active: Boolean(u.active),
    email: u.email || null, summaryEmail: u.summary_email || 'daily',
    lastLoginAt: u.last_login_at, createdAt: u.created_at, loans: Number(u.loans || 0),
  };
}

/** Loans with just enough payment data to compute dues, filtered in SQL. */
export async function portfolio(pool, companyId, { branch, officer, q, loanIds, state, district, pincode } = {}) {
  const where = ['l.company_id = ?'];
  const args = [companyId];
  if (branch) where.push('l.branch = ?'), args.push(branch);
  if (state) where.push('l.state = ?'), args.push(state);
  if (district) where.push('l.district = ?'), args.push(district);
  if (pincode) where.push('l.pincode = ?'), args.push(pincode);
  if (officer === '__none') where.push('l.officer_code IS NULL');
  else if (officer) where.push('l.officer_code = ?'), args.push(officer);
  if (q) {
    where.push('(l.loan_no LIKE ? OR l.borrower LIKE ? OR l.officer_code LIKE ?)');
    const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
    args.push(like, like, like);
  }
  if (loanIds) where.push('l.id IN (?)'), args.push(loanIds.length ? loanIds : ['']);
  const sql = `WHERE ${where.join(' AND ')}`;
  const rows = await pool.query(
    `SELECT l.id, l.loan_no, l.branch, l.officer_code, l.product, l.principal, l.emi, l.disbursed_on, l.borrower,
            l.installments, l.updated_at, l.state, l.district, l.pincode, u.name AS officer_name
     FROM loans l LEFT JOIN users u ON u.company_id = l.company_id AND u.code = l.officer_code ${sql}`, args);
  const pays = await pool.query(
    `SELECT p.loan_id, p.amount, p.verification FROM payments p JOIN loans l ON l.id = p.loan_id ${sql}`, args);
  const byLoan = new Map();
  for (const p of pays) {
    if (!byLoan.has(p.loan_id)) byLoan.set(p.loan_id, []);
    byLoan.get(p.loan_id).push({ amount: p.amount, ...(p.verification ? { deposit: { verification: p.verification } } : {}) });
  }
  const today = isoDate();
  return rows.map((r) => {
    const borrower = JSON.parse(r.borrower);
    const st = loanStatus({ installments: JSON.parse(r.installments), payments: byLoan.get(r.id) || [] }, today);
    return {
      id: r.id, loanNo: r.loan_no, branch: r.branch, officerCode: r.officer_code, officerName: r.officer_name,
      product: r.product, principal: r.principal, emi: r.emi, disbursedOn: r.disbursed_on, updatedAt: r.updated_at,
      state: r.state, district: r.district, pincode: r.pincode,
      borrower: { name: borrower.name, phone: borrower.phone, village: borrower.village },
      outstanding: st.outstanding, overdue: st.overdue, dpd: st.dpd, bucket: st.closed ? 'closed' : st.bucket.key,
    };
  });
}

const SORTS = {
  dpd: (a, b) => a.dpd - b.dpd || a.overdue - b.overdue,
  overdue: (a, b) => a.overdue - b.overdue,
  outstanding: (a, b) => a.outstanding - b.outstanding,
  loanNo: (a, b) => a.loanNo.localeCompare(b.loanNo, 'en', { numeric: true }),
  borrower: (a, b) => a.borrower.name.localeCompare(b.borrower.name),
  officer: (a, b) => String(a.officerCode || '~').localeCompare(String(b.officerCode || '~')),
};

function filterLoans(list, query) {
  const bucket = query.get('bucket');
  let rows = bucket ? list.filter((l) => l.bucket === bucket) : list;
  const sort = SORTS[query.get('sort')] ? query.get('sort') : 'dpd';
  const dir = query.get('dir') === 'asc' ? 1 : -1;
  rows = rows.sort((a, b) => dir * SORTS[sort](a, b));
  return rows;
}

async function assertOfficer(conn, companyId, code, branch) {
  const [o] = await conn.query("SELECT code, branch, active FROM users WHERE company_id = ? AND code = ? AND role = 'officer'", [companyId, code]);
  if (!o) throw new HttpError(400, `${code} is not a field officer.`);
  if (!o.active) throw new HttpError(400, `${code} is deactivated.`);
  if (branch && o.branch !== branch) throw new HttpError(400, `${code} belongs to ${o.branch}, not ${branch}.`);
  return o;
}

async function activeAdmins(conn, companyId) {
  const [{ n }] = await conn.query("SELECT COUNT(*) AS n FROM users WHERE company_id = ? AND role = 'admin' AND active = 1", [companyId]);
  return n;
}

/** Throws if one more active officer would exceed the company's plan limit. */
async function assertOfficerSeat(conn, companyId) {
  const { maxOfficers } = await companyEntitlements(conn, companyId);
  if (maxOfficers == null) return;
  const [{ n }] = await conn.query("SELECT COUNT(*) AS n FROM users WHERE company_id = ? AND role = 'officer' AND active = 1", [companyId]);
  if (n >= maxOfficers) throw new HttpError(409, `Your plan allows ${maxOfficers} active field officers. Deactivate one or contact LoanDesk to upgrade.`);
}

const FEATURE_OFF = "This feature isn't included in your company's LoanDesk plan.";
async function requireFeature(conn, companyId, feature) {
  const { features } = await companyEntitlements(conn, companyId);
  if (!features[feature]) throw new HttpError(403, FEATURE_OFF);
}

export function mountAdmin(router, { pool, authed, readJson }) {
  const R = (method, path, fn) => router.add(method, `/api/admin${path}`, async (req, res, params, query) => {
    const { user } = await authed(req);
    return fn({ req, res, params, query, user });
  });

  // ---------- dashboard ----------

  R('GET', '/summary', async ({ user }) => {
    const cid = user.companyId;
    const loans = await portfolio(pool, cid);
    const users = await pool.query('SELECT role, active, branch FROM users WHERE company_id = ?', [cid]);
    const today = isoDate();
    const month = today.slice(0, 7);
    const [coll] = await pool.query(
      `SELECT COALESCE(SUM(IF(recorded_at >= ?, amount, 0)), 0) AS today, COALESCE(SUM(IF(recorded_at >= ?, 1, 0)), 0) AS todayCount,
              COALESCE(SUM(amount), 0) AS month, COUNT(*) AS monthCount
       FROM payments WHERE company_id = ? AND recorded_at >= ? AND (verification IS NULL OR verification <> 'rejected')`,
      [`${today} 00:00:00`, `${today} 00:00:00`, cid, `${month}-01 00:00:00`]);
    const pending = await pool.query(
      `SELECT l.branch, COUNT(*) AS n, SUM(p.amount) AS amount FROM payments p JOIN loans l ON l.id = p.loan_id
       WHERE p.company_id = ? AND p.verification = 'pending' GROUP BY l.branch`, [cid]);
    const branches = new Map();
    const branch = (name) => {
      if (!branches.has(name)) branches.set(name, { branch: name, loans: 0, outstanding: 0, overdue: 0, par30: 0, officers: 0, unassigned: 0, pendingDeposits: 0 });
      return branches.get(name);
    };
    const buckets = Object.fromEntries(DPD_BUCKETS.map((b) => [b.key, { key: b.key, label: b.label, loans: 0, outstanding: 0, overdue: 0 }]));
    let outstanding = 0, overdue = 0, par30 = 0, active = 0, unassigned = 0;
    for (const l of loans) {
      if (l.bucket === 'closed') continue;
      active += 1;
      const b = branch(l.branch);
      b.loans += 1;
      b.outstanding += l.outstanding;
      b.overdue += l.overdue;
      if (l.dpd > 30) (b.par30 += l.outstanding), (par30 += l.outstanding);
      if (!l.officerCode) (b.unassigned += 1), (unassigned += 1);
      outstanding += l.outstanding;
      overdue += l.overdue;
      const k = buckets[l.bucket];
      k.loans += 1;
      k.outstanding += l.outstanding;
      k.overdue += l.overdue;
    }
    for (const u of users) if (u.role === 'officer' && u.active) branch(u.branch).officers += 1;
    for (const p of pending) branch(p.branch).pendingDeposits = p.n;
    const recent = await pool.query('SELECT at, user_code, action, entity_id FROM audit_log WHERE company_id = ? ORDER BY id DESC LIMIT 8', [cid]);
    const count = (role, act = 1) => users.filter((u) => u.role === role && u.active === act).length;
    return {
      users: { officers: count('officer'), supervisors: count('supervisor'), admins: count('admin'), inactive: users.filter((u) => !u.active).length },
      loans: { total: loans.length, active, closed: loans.length - active, unassigned },
      outstanding, overdue, par30Pct: outstanding ? (par30 / outstanding) * 100 : 0,
      collections: { today: coll.today, todayCount: coll.todayCount, month: coll.month, monthCount: coll.monthCount },
      pendingDeposits: { count: pending.reduce((s, p) => s + p.n, 0), amount: pending.reduce((s, p) => s + Number(p.amount), 0) },
      buckets: Object.values(buckets),
      branches: [...branches.values()].sort((a, b) => a.branch.localeCompare(b.branch)),
      recent,
    };
  });

  R('GET', '/branches', async ({ user }) => {
    const rows = await pool.query('SELECT branch FROM users WHERE company_id = ? UNION SELECT branch FROM loans WHERE company_id = ? ORDER BY branch',
      [user.companyId, user.companyId]);
    return { branches: rows.map((r) => r.branch) };
  });

  // ---------- users ----------

  R('GET', '/users', async ({ user }) => {
    const rows = await pool.query(
      `SELECT u.*, (SELECT COUNT(*) FROM loans l WHERE l.company_id = u.company_id AND l.officer_code = u.code) AS loans
       FROM users u WHERE u.company_id = ? ORDER BY u.active DESC, u.branch, FIELD(u.role, 'admin', 'supervisor', 'officer'), u.code`,
      [user.companyId]);
    return { users: rows.map(userRow) };
  });

  R('POST', '/users', async ({ req, user }) => {
    const b = await readJson(req);
    const code = str(b.code).toUpperCase();
    const name = str(b.name);
    const branch = str(b.branch);
    const role = str(b.role);
    if (!CODE.test(code)) throw new HttpError(400, 'Code must be 2–12 letters or digits.');
    if (code === SUPPORT_CODE) throw new HttpError(400, `${SUPPORT_CODE} is reserved for LoanDesk support.`);
    if (name.length < 2 || name.length > 100) throw new HttpError(400, 'Enter the full name.');
    if (branch.length < 2 || branch.length > 100) throw new HttpError(400, 'Enter the branch.');
    if (!ROLES.includes(role)) throw new HttpError(400, 'Choose a role.');
    if (!validPin(b.pin, role)) throw new HttpError(400, pinRule(role));
    const mail = emailFields(b, role);
    // Codes are unique across all companies on LoanDesk: people sign in with code + PIN only.
    const [dup] = await pool.query('SELECT code FROM users WHERE code = ?', [code]);
    if (dup) throw new HttpError(409, `Code ${code} is already taken.`);
    if (role === 'officer') await assertOfficerSeat(pool, user.companyId);
    await pool.query('INSERT INTO users (company_id, code, name, role, branch, pin_hash, email, summary_email, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [user.companyId, code, name, role, branch, await hashPin(b.pin), mail.email, mail.summary, now()]);
    await audit(pool, user, 'user_created', code, { role, branch });
    return { ok: true };
  });

  R('PATCH', '/users/:code', async ({ req, params, user }) => {
    const b = await readJson(req);
    return withTx(pool, async (conn) => {
      const [u] = await conn.query('SELECT * FROM users WHERE company_id = ? AND code = ? FOR UPDATE', [user.companyId, params.code]);
      if (!u) throw new HttpError(404, 'User not found.');
      const next = {
        name: b.name !== undefined ? str(b.name) : u.name,
        role: b.role !== undefined ? str(b.role) : u.role,
        branch: b.branch !== undefined ? str(b.branch) : u.branch,
        active: b.active !== undefined ? Boolean(b.active) : Boolean(u.active),
      };
      if (next.name.length < 2 || next.name.length > 100) throw new HttpError(400, 'Enter the full name.');
      if (next.branch.length < 2 || next.branch.length > 100) throw new HttpError(400, 'Enter the branch.');
      if (!ROLES.includes(next.role)) throw new HttpError(400, 'Choose a role.');
      const mail = emailFields(b, next.role, u);
      const self = u.code === user.code;
      if (self && (next.role !== 'admin' || !next.active)) throw new HttpError(400, "You can't remove your own admin access.");
      if (u.role === 'admin' && u.active && (next.role !== 'admin' || !next.active) && (await activeAdmins(conn, user.companyId)) <= 1) {
        throw new HttpError(400, 'There must be at least one active admin.');
      }
      const [{ loans }] = await conn.query('SELECT COUNT(*) AS loans FROM loans WHERE company_id = ? AND officer_code = ?', [user.companyId, u.code]);
      const becomesOfficer = next.role === 'officer' && next.active && !(u.role === 'officer' && u.active);
      if (becomesOfficer) await assertOfficerSeat(conn, user.companyId);
      const leavesPost = next.role !== 'officer' || next.branch !== u.branch || !next.active;
      if (u.role === 'officer' && loans > 0 && leavesPost) {
        throw new HttpError(409, `${u.code} still has ${loans} assigned loan(s). Reassign them first.`);
      }
      const credentialClassChanges = (u.role === 'admin') !== (next.role === 'admin');
      let pinHash = u.pin_hash;
      if (credentialClassChanges) {
        if (!validPin(b.pin, next.role)) throw new HttpError(400, `Changing to/from admin needs a new credential. ${pinRule(next.role)}`);
        pinHash = await hashPin(b.pin);
      }
      await conn.query('UPDATE users SET name = ?, role = ?, branch = ?, active = ?, pin_hash = ?, email = ?, summary_email = ?, updated_at = ? WHERE id = ?',
        [next.name, next.role, next.branch, next.active, pinHash, mail.email, mail.summary, now(), u.id]);
      // Role, branch or status changes take effect immediately: end existing sessions.
      if (next.role !== u.role || next.branch !== u.branch || !next.active || credentialClassChanges) {
        await conn.query('DELETE FROM sessions WHERE user_id = ?', [u.id]);
      }
      const changes = Object.fromEntries(Object.entries(next).filter(([k, v]) => String(v) !== String(k === 'active' ? Boolean(u.active) : u[k])));
      if ((mail.email || null) !== (u.email || null)) changes.email = mail.email || '(removed)';
      if (next.role === 'admin' && mail.summary !== u.summary_email) changes.summaryEmail = mail.summary;
      await audit(conn, user, next.active === Boolean(u.active) ? 'user_updated' : next.active ? 'user_activated' : 'user_deactivated', u.code, changes);
      return { ok: true };
    });
  });

  R('POST', '/users/:code/reset-pin', async ({ req, params, user }) => {
    const { pin } = await readJson(req);
    const [u] = await pool.query('SELECT id, role FROM users WHERE company_id = ? AND code = ?', [user.companyId, params.code]);
    if (!u) throw new HttpError(404, 'User not found.');
    if (!validPin(pin, u.role)) throw new HttpError(400, pinRule(u.role));
    await pool.query('UPDATE users SET pin_hash = ?, updated_at = ? WHERE id = ?', [await hashPin(pin), now(), u.id]);
    await pool.query('DELETE FROM sessions WHERE user_id = ?', [u.id]);
    await audit(pool, user, 'pin_reset', params.code, null);
    return { ok: true };
  });

  R('POST', '/me/password', async ({ req, user }) => {
    const { current, next } = await readJson(req);
    if (user.support) throw new HttpError(400, 'Support sessions have no password to change.');
    const [u] = await pool.query('SELECT id, pin_hash FROM users WHERE id = ?', [user.id]);
    if (!(await verifyPin(String(current || ''), u.pin_hash))) throw new HttpError(400, 'Current password is wrong.');
    if (!validPin(next, 'admin')) throw new HttpError(400, pinRule('admin'));
    await pool.query('UPDATE users SET pin_hash = ?, updated_at = ? WHERE id = ?', [await hashPin(next), now(), u.id]);
    await audit(pool, user, 'password_changed', user.code, null);
    return { ok: true };
  });

  // ---------- loans ----------

  const listParams = (query) => ({
    branch: str(query.get('branch')) || undefined,
    officer: str(query.get('officer')) || undefined,
    q: str(query.get('q')).slice(0, 60) || undefined,
    state: str(query.get('state')) || undefined,
    district: str(query.get('district')) || undefined,
    pincode: str(query.get('pincode')) || undefined,
  });

  R('GET', '/loans', async ({ query, user }) => {
    const rows = filterLoans(await portfolio(pool, user.companyId, listParams(query)), query);
    const pageSize = Math.min(100, Math.max(10, Number(query.get('pageSize')) || 25));
    const pages = Math.max(1, Math.ceil(rows.length / pageSize));
    const page = Math.min(pages, Math.max(1, Number(query.get('page')) || 1));
    return {
      total: rows.length, page, pages, pageSize,
      totals: { outstanding: rows.reduce((s, r) => s + r.outstanding, 0), overdue: rows.reduce((s, r) => s + r.overdue, 0) },
      rows: rows.slice((page - 1) * pageSize, page * pageSize),
      ids: rows.length <= 5000 ? rows.map((r) => r.id) : null, // for "select all matching"
    };
  });

  R('GET', '/loans/export', async ({ res, query, user }) => {
    await requireFeature(pool, user.companyId, 'loan_export');
    const rows = filterLoans(await portfolio(pool, user.companyId, listParams(query)), query);
    const csv = toCSV(
      ['Loan No', 'Branch', 'Officer', 'Borrower', 'Phone', 'Village', 'Product', 'Principal', 'EMI', 'Disbursed On', 'Outstanding', 'Overdue', 'DPD', 'Bucket'],
      rows.map((r) => [r.loanNo, r.branch, r.officerCode || '', r.borrower.name, r.borrower.phone, r.borrower.village || '',
        r.product, r.principal, r.emi, r.disbursedOn, r.outstanding, r.overdue, r.dpd, r.bucket]));
    send(res, 200, Buffer.from(`﻿${csv}`, 'utf8'), {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="loans-${isoDate()}.csv"`,
    });
  });

  R('GET', '/loans/:id', async ({ params, user }) => {
    const [loan] = await loadLoans(pool, { companyId: user.companyId, loanId: params.id });
    if (!loan) throw new HttpError(404, 'Loan not found.');
    const [meta] = await pool.query(
      `SELECT l.created_at, l.updated_at, i.file_name, i.at AS imported_at, u.name AS officer_name
       FROM loans l LEFT JOIN imports i ON i.id = l.import_id LEFT JOIN users u ON u.company_id = l.company_id AND u.code = l.officer_code
       WHERE l.id = ?`, [params.id]);
    return {
      loan, status: loanStatus(loan),
      meta: { createdAt: meta.created_at, updatedAt: meta.updated_at, importFile: meta.file_name, importedAt: meta.imported_at, officerName: meta.officer_name },
    };
  });

  async function assign(conn, ids, officerCode, user) {
    const loans = await conn.query('SELECT id, branch, officer_code FROM loans WHERE company_id = ? AND id IN (?) FOR UPDATE', [user.companyId, ids]);
    if (loans.length !== ids.length) throw new HttpError(404, 'Some loans were not found.');
    if (officerCode) {
      const branches = [...new Set(loans.map((l) => l.branch))];
      if (branches.length > 1) throw new HttpError(400, `Selected loans span branches (${branches.join(', ')}). Assign one branch at a time.`);
      await assertOfficer(conn, user.companyId, officerCode, branches[0]);
    }
    const changed = loans.filter((l) => l.officer_code !== officerCode);
    if (changed.length) {
      await conn.query('UPDATE loans SET officer_code = ?, updated_at = ? WHERE id IN (?)', [officerCode, now(), changed.map((l) => l.id)]);
      await audit(conn, user, 'loans_assigned', officerCode || 'unassigned', { loans: changed.length, ids: changed.slice(0, 50).map((l) => l.id) });
    }
    return changed.length;
  }

  R('PATCH', '/loans/:id', async ({ req, params, user }) => {
    const { officerCode } = await readJson(req);
    const code = officerCode ? str(officerCode).toUpperCase() : null;
    const changed = await withTx(pool, (conn) => assign(conn, [params.id], code, user));
    return { changed };
  });

  R('POST', '/loans/assign', async ({ req, user }) => {
    const { loanIds, officerCode } = await readJson(req);
    if (!Array.isArray(loanIds) || !loanIds.length || loanIds.length > 5000) throw new HttpError(400, 'Select 1–5000 loans.');
    const code = officerCode ? str(officerCode).toUpperCase() : null;
    const changed = await withTx(pool, (conn) => assign(conn, [...new Set(loanIds.map(String))], code, user));
    return { changed };
  });

  // ---------- areas: state → district → pincode, and the agent deputed to each pincode ----------

  R('GET', '/areas', async ({ query, user }) => {
    const branches = (await pool.query(
      'SELECT branch, COUNT(*) AS n FROM loans WHERE company_id = ? AND pincode IS NOT NULL GROUP BY branch ORDER BY n DESC', [user.companyId]))
      .map((b) => b.branch);
    const branch = branches.includes(query.get('branch')) ? query.get('branch') : branches[0];
    if (!branch) return { branches, branch: null, states: [] };
    const loans = await portfolio(pool, user.companyId, { branch });
    const agents = new Map((await pool.query('SELECT pincode, officer_code FROM area_agents WHERE company_id = ? AND branch = ?', [user.companyId, branch]))
      .map((a) => [a.pincode, a.officer_code]));
    const names = new Map((await pool.query("SELECT code, name, active FROM users WHERE company_id = ? AND role = 'officer'", [user.companyId]))
      .map((u) => [u.code, u]));
    const blank = () => ({ accounts: 0, overdue: 0, outstanding: 0, unassigned: 0 });
    const add = (node, l) => {
      node.accounts += 1;
      node.overdue += l.overdue;
      node.outstanding += l.outstanding;
      if (!l.officerCode) node.unassigned += 1;
    };
    const states = new Map();
    for (const l of loans) {
      if (l.bucket === 'closed') continue;
      const st = l.state || '—';
      const di = l.district || '—';
      const pin = l.pincode || '—';
      if (!states.has(st)) states.set(st, { state: st, ...blank(), districts: new Map() });
      const S = states.get(st);
      if (!S.districts.has(di)) S.districts.set(di, { district: di, ...blank(), pincodes: new Map() });
      const D = S.districts.get(di);
      if (!D.pincodes.has(pin)) D.pincodes.set(pin, { pincode: pin, ...blank(), officers: {} });
      const P = D.pincodes.get(pin);
      for (const node of [S, D, P]) add(node, l);
      if (l.officerCode) P.officers[l.officerCode] = (P.officers[l.officerCode] || 0) + 1;
    }
    const byOverdue = (a, b) => b.overdue - a.overdue;
    return {
      branches, branch,
      states: [...states.values()].sort(byOverdue).map((S) => ({
        ...S,
        districts: [...S.districts.values()].sort(byOverdue).map((D) => ({
          ...D,
          pincodes: [...D.pincodes.values()].sort(byOverdue).map((P) => {
            const agent = agents.get(P.pincode);
            return {
              ...P,
              agent: agent ? { code: agent, name: names.get(agent)?.name || agent, active: Boolean(names.get(agent)?.active) } : null,
              officers: Object.entries(P.officers).map(([code, n]) => ({ code, name: names.get(code)?.name || code, n })).sort((a, b) => b.n - a.n),
            };
          }),
        })),
      })),
    };
  });

  /** Deputes an agent to one or more pincodes (or removes the agent), and assigns those pincodes' accounts. */
  R('POST', '/areas/agent', async ({ req, user }) => {
    const b = await readJson(req);
    const branch = str(b.branch);
    const pincodes = [...new Set((Array.isArray(b.pincodes) ? b.pincodes : []).map((p) => str(p)))].filter((p) => /^[1-9]\d{5}$/.test(p));
    if (!branch || !pincodes.length || pincodes.length > 2000) throw new HttpError(400, 'Choose the pincodes to depute an agent to.');
    const code = b.officerCode ? str(b.officerCode).toUpperCase() : null;
    const mode = b.mode === 'unassigned' ? 'unassigned' : 'all';
    return withTx(pool, async (conn) => {
      if (code) await assertOfficer(conn, user.companyId, code, branch);
      if (code) {
        for (const p of pincodes) {
          await conn.query('REPLACE INTO area_agents (company_id, branch, pincode, officer_code, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
            [user.companyId, branch, p, code, user.code, now()]);
        }
      } else {
        await conn.query('DELETE FROM area_agents WHERE company_id = ? AND branch = ? AND pincode IN (?)', [user.companyId, branch, pincodes]);
      }
      let changed = 0;
      if (code || mode === 'all') {
        const r = await conn.query(
          `UPDATE loans SET officer_code = ?, updated_at = ? WHERE company_id = ? AND branch = ? AND pincode IN (?)
             AND ${mode === 'unassigned' ? 'officer_code IS NULL' : 'NOT (officer_code <=> ?)'}`,
          [code, now(), user.companyId, branch, pincodes, ...(mode === 'unassigned' ? [] : [code])]);
        changed = r.affectedRows;
      }
      await audit(conn, user, code ? 'area_agent_set' : 'area_agent_removed', code || 'unassigned',
        { branch, pincodes: pincodes.slice(0, 50), count: pincodes.length, loans: changed, mode });
      return { changed };
    });
  });

  // ---------- import ----------

  R('GET', '/import/template', async ({ res, user }) => {
    await requireFeature(pool, user.companyId, 'loan_import');
    send(res, 200, await buildTemplate(), {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="loan-import-template.xlsx"',
    });
  });

  R('POST', '/import/preview', async ({ req, user }) => {
    await requireFeature(pool, user.companyId, 'loan_import');
    const { fileName, base64 } = await readJson(req, IMPORT_BODY);
    const name = str(fileName).slice(0, 200);
    if (!name || typeof base64 !== 'string') throw new HttpError(400, 'Choose a file to upload.');
    let parsed;
    try {
      parsed = await readImportFile(name, Buffer.from(base64, 'base64'));
    } catch (err) {
      if (err instanceof ImportError) throw new HttpError(400, err.message);
      throw err;
    }
    if (parsed.missingHeaders.length) {
      return { fileName: name, format: parsed.format, totalRows: parsed.records.length, missingHeaders: parsed.missingHeaders, rows: [], errors: [] };
    }
    const { valid, errors } = normalise(parsed);
    const rows = await checkAgainstDb(pool, user.companyId, valid, errors);
    return { fileName: name, format: parsed.format, totalRows: parsed.records.length, missingHeaders: [], rows, errors };
  });

  R('POST', '/import/commit', async ({ req, user }) => {
    await requireFeature(pool, user.companyId, 'loan_import');
    const { fileName, loans, totalRows } = await readJson(req, COMMIT_BODY);
    if (!Array.isArray(loans) || !loans.length) throw new HttpError(400, 'Nothing to import.');
    // Re-validate everything: the browser's copy is never trusted.
    const records = loans.map((l, i) => ({ rowNo: i + 1, sheet: 'Import', structured: l }));
    const { valid, errors } = normalise({ records, installments: [] });
    const rows = await checkAgainstDb(pool, user.companyId, valid, errors);
    if (errors.length) {
      throw new HttpError(422, `${errors.length} loan(s) no longer pass validation (data changed since the preview?). Run the preview again.`);
    }
    return withTx(pool, async (conn) => {
      const created = rows.filter((r) => r.action === 'create').length;
      const updated = rows.length - created;
      const skipped = Math.max(0, Number(totalRows || 0) - rows.length);
      const res = await conn.query(
        'INSERT INTO imports (company_id, at, user_code, file_name, total_rows, created, updated, skipped) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [user.companyId, now(), user.code, str(fileName).slice(0, 200) || 'upload', Number(totalRows) || rows.length, created, updated, skipped]);
      for (const r of rows) await upsertLoan(conn, user.companyId, r.loan, res.insertId);
      await audit(conn, user, 'loans_imported', String(res.insertId), { file: fileName, created, updated, skipped });
      return { importId: res.insertId, created, updated, skipped };
    });
  });

  R('GET', '/imports', async ({ user }) => ({
    imports: await pool.query('SELECT * FROM imports WHERE company_id = ? ORDER BY id DESC LIMIT 20', [user.companyId]),
  }));

  // ---------- audit ----------

  R('GET', '/audit', async ({ query, user }) => {
    await requireFeature(pool, user.companyId, 'audit_log');
    const where = ['a.company_id = ?'];
    const args = [user.companyId];
    if (query.get('action')) where.push('a.action = ?'), args.push(query.get('action'));
    if (query.get('user')) where.push('a.user_code = ?'), args.push(str(query.get('user')).toUpperCase());
    const sql = `WHERE ${where.join(' AND ')}`;
    const pageSize = 50;
    const [{ n }] = await pool.query(`SELECT COUNT(*) AS n FROM audit_log a ${sql}`, args);
    const pages = Math.max(1, Math.ceil(n / pageSize));
    const page = Math.min(pages, Math.max(1, Number(query.get('page')) || 1));
    // Work done during a support session is shown with the support person's name.
    const rows = await pool.query(
      `SELECT a.id, a.at, a.user_code, a.action, a.entity_id, a.detail, o.name AS support_name FROM audit_log a
       LEFT JOIN support_sessions ss ON ss.id = a.support_id LEFT JOIN overlords o ON o.id = ss.overlord_id
       ${sql} ORDER BY a.id DESC LIMIT ? OFFSET ?`, [...args, pageSize, (page - 1) * pageSize]);
    const actions = (await pool.query('SELECT DISTINCT action FROM audit_log WHERE company_id = ? ORDER BY action', [user.companyId])).map((r) => r.action);
    return { total: n, page, pages, rows: rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null })), actions };
  });
}
