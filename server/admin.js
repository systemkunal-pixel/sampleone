// Admin CLI:  npm run admin -- <command> [options]
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readImportFile, normalise, checkAgainstDb } from './importer.js';
import { config } from './config.js';
import { createPool, migrate, upsertLoan, withTx, now } from './db.js';
import { hashPin, validPin, pinRule, SUPPORT_CODE, validOverlordPassword, OVERLORD_PASSWORD_RULE } from './auth.js';
import { seedLoans } from '../src/js/seed.js';
import { localTimestamp } from '../src/js/logic.js';

const USAGE = `Usage: npm run admin -- <command> [options]

  migrate                                   create/upgrade tables
  list-companies
  add-user --company BRMC --code FO27 --name "Priya Mishra" --role officer|supervisor|admin --branch "Lucknow Rural" --pin 1234
                                            (admins: --pin is a password of 10+ chars with letters and digits;
                                             optional --email for password-reset links and summary emails)
  set-pin --code FO27 --pin 4321            reset a PIN/password (logs the user out everywhere)
  deactivate --code FO27                    block a user and end their sessions
                                            (user codes are unique across all companies)
  list-users [--company BRMC]
  import-loans --company BRMC <file.xlsx|.csv|.json>   validate and upsert loans (same rules as the admin console)
  seed-demo --company DATAHAAT [--password P]   demo branch in an empty company: two officers (PIN 1234), a
                                            supervisor (PIN 9999) and an admin (password P, default Demo@Admin2026);
                                            prints their codes

  add-overlord --email you@example.com --name "Your Name" --password "…"
                                            platform operator for the /overlord/ console (12+ chars, letters
                                            and digits); the authenticator app is set up at first sign-in
  overlord-password --email you@example.com --password "…"   reset an overlord password
  overlord-reset-2fa --email you@example.com                 lost phone: set up the authenticator again
  list-overlords
  status                                    counts for scripts: BRMC admins, overlords, companies (JSON)`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    company: { type: 'string' }, code: { type: 'string' }, name: { type: 'string' }, role: { type: 'string' },
    branch: { type: 'string' }, pin: { type: 'string' }, email: { type: 'string' }, password: { type: 'string' },
  },
});

const need = (...keys) => {
  for (const k of keys) if (!values[k]) throw new Error(`--${k} is required.\n\n${USAGE}`);
};

async function companyId(conn, code) {
  const [c] = await conn.query('SELECT id FROM companies WHERE code = ?', [String(code).trim().toUpperCase()]);
  if (!c) throw new Error(`No company with code ${code}. See: npm run admin -- list-companies`);
  return c.id;
}

/** True when a user code is already used in any company (codes are unique across LoanDesk). */
export async function codeTaken(conn, code) {
  const [u] = await conn.query('SELECT id FROM users WHERE code = ?', [String(code).toUpperCase()]);
  return Boolean(u);
}

export async function addUser(conn, { companyId, code, name, role, branch, pin, email = null }) {
  if (!['officer', 'supervisor', 'admin'].includes(role)) throw new Error('--role must be officer, supervisor or admin');
  if (!validPin(pin, role)) throw new Error(pinRule(role));
  if (code.toUpperCase() === SUPPORT_CODE) throw new Error(`${SUPPORT_CODE} is reserved for LoanDesk support.`);
  if (await codeTaken(conn, code)) throw new Error(`User code ${code.toUpperCase()} is already used. Every user needs a code of their own.`);
  await conn.query('INSERT INTO users (company_id, code, name, role, branch, pin_hash, email) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    companyId, code.toUpperCase(), name, role, branch, await hashPin(pin), role === 'admin' ? email : null,
  ]);
}

export const demoLogins = (c, adminPassword = 'Demo@Admin2026') =>
  `officers ${c.FO27} / ${c.FO31} (PIN 1234), supervisor ${c.SUP1} (PIN 9999), admin ${c.ADMIN} (password ${adminPassword})`;

/** Demo branch with two officers sharing the generated portfolio and one supervisor, in an empty company. */
export async function seedDemo(pool, companyId = 1, { adminPassword = 'Demo@Admin2026' } = {}) {
  const branch = 'Lucknow Rural';
  const [{ n }] = await pool.query('SELECT (SELECT COUNT(*) FROM users WHERE company_id = ?) + (SELECT COUNT(*) FROM loans WHERE company_id = ?) AS n', [companyId, companyId]);
  if (n > 0) throw new Error('This company already has users or loans; demo data only goes into an empty company.');
  // Ids are global across companies, so the demo's get the company prefix.
  const id = (s) => `${companyId}-${s}`;
  // User codes are global too: the plain demo codes if free, else with the company's first letters.
  const [{ code: companyCode }] = await pool.query('SELECT code FROM companies WHERE id = ?', [companyId]);
  const base = ['FO27', 'FO31', 'SUP1', 'ADMIN'];
  let free = true;
  for (const b of base) if (await codeTaken(pool, b)) free = false;
  const codes = Object.fromEntries(base.map((b) => [b, free ? b : `${companyCode.slice(0, 3)}${b}`.slice(0, 12)]));
  await withTx(pool, async (conn) => {
    await addUser(conn, { companyId, code: codes.FO27, name: 'Priya Mishra', role: 'officer', branch, pin: '1234' });
    await addUser(conn, { companyId, code: codes.FO31, name: 'Ravi Tiwari', role: 'officer', branch, pin: '1234' });
    await addUser(conn, { companyId, code: codes.SUP1, name: 'Neha Saxena', role: 'supervisor', branch, pin: '9999' });
    await addUser(conn, { companyId, code: codes.ADMIN, name: 'Head Office Admin', role: 'admin', branch: 'Head Office', pin: adminPassword });
    const loans = seedLoans();
    for (const [i, loan] of loans.entries()) {
      const loanId = id(loan.id);
      await upsertLoan(conn, companyId, { ...loan, id: loanId, branch, officerCode: i % 4 === 3 ? codes.FO31 : codes.FO27 });
      for (const p of loan.payments) {
        await conn.query(
          `INSERT INTO payments (company_id, id, loan_id, recorded_at, amount, mode, reference, receipt_no, officer_code, received_at)
           VALUES (?, ?, ?, ?, ?, ?, '', ?, 'BRANCH', ?)`,
          [companyId, id(p.id), loanId, p.at.replace('T', ' '), p.amount, p.mode, p.receiptNo, now()]);
      }
      for (const v of loan.visits) {
        await conn.query(
          `INSERT INTO visits (id, loan_id, recorded_at, outcome, notes, ptp_date, ptp_amount, officer_code, received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'BRANCH', ?)`,
          [id(v.id), loanId, v.at.replace('T', ' '), v.outcome, v.notes, v.ptpDate, v.ptpAmount, now()]);
      }
      const ptp = loan.visits.find((v) => v.ptpDate);
      if (ptp) await conn.query('UPDATE loans SET follow_up_date = ? WHERE id = ?', [ptp.ptpDate, loanId]);
    }
  });
  return codes;
}

/** Creates a platform operator. The authenticator app is enrolled at their first sign-in. */
export async function addOverlord(conn, { email, name, password }) {
  const mail = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) throw new Error('Enter a valid email address.');
  if (String(name || '').trim().length < 2) throw new Error('Enter the name.');
  if (!validOverlordPassword(password)) throw new Error(OVERLORD_PASSWORD_RULE);
  const res = await conn.query('INSERT INTO overlords (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)',
    [mail, String(name).trim(), await hashPin(password), now()]);
  return res.insertId;
}

async function overlordByEmail(pool, email) {
  const [o] = await pool.query('SELECT id FROM overlords WHERE email = ?', [String(email).trim().toLowerCase()]);
  if (!o) throw new Error(`No overlord ${email}`);
  return o.id;
}

async function main() {
  const [cmd, arg] = positionals;
  if (!cmd) return console.log(USAGE);
  const pool = createPool(config.db);
  const cliAudit = (action, detail) => pool.query('INSERT INTO overlord_audit (at, overlord_email, action, detail) VALUES (?, ?, ?, ?)',
    [now(), 'CLI', action, JSON.stringify(detail)]);
  try {
    await migrate(pool);
    switch (cmd) {
      case 'migrate':
        console.log('Schema is up to date.');
        break;
      case 'status': {
        // Machine-readable counts for the installers.
        const [[{ admins }], [{ overlords }], [{ companies }]] = await Promise.all([
          pool.query("SELECT COUNT(*) AS admins FROM users u JOIN companies c ON c.id = u.company_id WHERE c.code = 'BRMC' AND u.role = 'admin'"),
          pool.query('SELECT COUNT(*) AS overlords FROM overlords'),
          pool.query('SELECT COUNT(*) AS companies FROM companies'),
        ]);
        console.log(JSON.stringify({ brmcAdmins: admins, overlords, companies }));
        break;
      }
      case 'list-companies':
        console.table(await pool.query('SELECT code, name, plan, status FROM companies ORDER BY id'));
        break;
      case 'add-user':
        need('company', 'code', 'name', 'role', 'branch', 'pin');
        await addUser(pool, { ...values, companyId: await companyId(pool, values.company) });
        console.log(`Added ${values.role} ${values.code.toUpperCase()} to ${values.company.toUpperCase()}.`);
        break;
      case 'set-pin': {
        need('code', 'pin');
        const code = values.code.toUpperCase();
        const [u] = await pool.query('SELECT id, role FROM users WHERE code = ?', [code]);
        if (!u) throw new Error(`No user ${code}`);
        if (!validPin(values.pin, u.role)) throw new Error(pinRule(u.role));
        await pool.query('UPDATE users SET pin_hash = ? WHERE id = ?', [await hashPin(values.pin), u.id]);
        await pool.query('DELETE FROM sessions WHERE user_id = ?', [u.id]);
        console.log(`PIN reset for ${code}.`);
        break;
      }
      case 'deactivate': {
        need('code');
        const code = values.code.toUpperCase();
        const [u] = await pool.query('SELECT id FROM users WHERE code = ?', [code]);
        if (!u) throw new Error(`No user ${code}`);
        await pool.query('UPDATE users SET active = 0 WHERE id = ?', [u.id]);
        await pool.query('DELETE FROM sessions WHERE user_id = ?', [u.id]);
        console.log(`${code} deactivated.`);
        break;
      }
      case 'list-users':
        console.table(await pool.query(
          `SELECT c.code AS company, u.code, u.name, u.role, u.branch, u.active FROM users u JOIN companies c ON c.id = u.company_id
           ${values.company ? 'WHERE c.code = ?' : ''} ORDER BY c.id, u.branch, u.role, u.code`,
          values.company ? [values.company.toUpperCase()] : []));
        break;
      case 'import-loans': {
        need('company');
        if (!arg) throw new Error(`File path required.\n\n${USAGE}`);
        const cid = await companyId(pool, values.company);
        const parsed = await readImportFile(basename(arg), await readFile(arg));
        if (parsed.missingHeaders.length) throw new Error(`Missing required columns: ${parsed.missingHeaders.join(', ')}`);
        const { valid, errors } = normalise(parsed);
        const rows = await checkAgainstDb(pool, cid, valid, errors);
        for (const e of errors) console.error(`  Row ${e.rowNo}${e.loanNo ? ` (${e.loanNo})` : ''}: ${e.errors.join(' ')}`);
        if (errors.length) throw new Error(`${errors.length} row(s) have errors; nothing was imported.`);
        const result = await withTx(pool, async (conn) => {
          const created = rows.filter((r) => r.action === 'create').length;
          const res = await conn.query(
            'INSERT INTO imports (company_id, at, user_code, file_name, total_rows, created, updated, skipped) VALUES (?, ?, ?, ?, ?, ?, ?, 0)',
            [cid, now(), 'CLI', basename(arg), rows.length, created, rows.length - created]);
          for (const r of rows) await upsertLoan(conn, cid, r.loan, res.insertId);
          return { created, updated: rows.length - created };
        });
        console.log(`Imported ${rows.length} loans (${result.created} new, ${result.updated} updated) at ${localTimestamp()}.`);
        break;
      }
      case 'seed-demo': {
        need('company');
        const adminPassword = values.password || 'Demo@Admin2026';
        if (!validPin(adminPassword, 'admin')) throw new Error(pinRule('admin'));
        const codes = await seedDemo(pool, await companyId(pool, values.company), { adminPassword });
        console.log(`Demo data loaded into ${values.company.toUpperCase()}: ${demoLogins(codes, adminPassword)}.`);
        break;
      }
      case 'add-overlord':
        need('email', 'name', 'password');
        await addOverlord(pool, values);
        await cliAudit('overlord_added', { email: values.email.toLowerCase() });
        console.log(`Overlord ${values.email.toLowerCase()} added. Sign in at /overlord/ to set up the authenticator app.`);
        break;
      case 'overlord-password': {
        need('email', 'password');
        if (!validOverlordPassword(values.password)) throw new Error(OVERLORD_PASSWORD_RULE);
        const id = await overlordByEmail(pool, values.email);
        await pool.query('UPDATE overlords SET password_hash = ? WHERE id = ?', [await hashPin(values.password), id]);
        await pool.query('DELETE FROM overlord_sessions WHERE overlord_id = ?', [id]);
        await cliAudit('overlord_password_reset', { email: values.email.toLowerCase() });
        console.log('Password reset.');
        break;
      }
      case 'overlord-reset-2fa': {
        need('email');
        const id = await overlordByEmail(pool, values.email);
        await pool.query('UPDATE overlords SET totp_secret = NULL, totp_enabled = 0, totp_last_step = NULL WHERE id = ?', [id]);
        await pool.query('DELETE FROM overlord_sessions WHERE overlord_id = ?', [id]);
        await cliAudit('overlord_2fa_reset', { email: values.email.toLowerCase() });
        console.log('Authenticator removed. It will be set up again at the next sign-in.');
        break;
      }
      case 'list-overlords':
        console.table(await pool.query('SELECT email, name, active, totp_enabled AS authenticator, last_login_at FROM overlords ORDER BY id'));
        break;
      default:
        console.log(USAGE);
        process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

// Run only when started directly (not when imported by tests). pathToFileURL handles Windows paths.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
