// Admin CLI:  npm run admin -- <command> [options]
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { config } from './config.js';
import { createPool, migrate, upsertLoan, withTx, now } from './db.js';
import { hashPin, validPin } from './auth.js';
import { seedLoans } from '../src/js/seed.js';
import { localTimestamp } from '../src/js/logic.js';

const USAGE = `Usage: npm run admin -- <command> [options]

  migrate                                   create/upgrade tables
  add-user --code FO27 --name "Priya Mishra" --role officer|supervisor --branch "Lucknow Rural" --pin 1234
  set-pin --code FO27 --pin 4321            reset a PIN (logs the user out everywhere)
  deactivate --code FO27                    block a user and end their sessions
  list-users
  import-loans <file.json>                  upsert loans (see README for the format)
  seed-demo                                 demo branch: officers FO27/FO31 (PIN 1234), supervisor SUP1 (PIN 9999)`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    code: { type: 'string' }, name: { type: 'string' }, role: { type: 'string' },
    branch: { type: 'string' }, pin: { type: 'string' },
  },
});

const need = (...keys) => {
  for (const k of keys) if (!values[k]) throw new Error(`--${k} is required.\n\n${USAGE}`);
};

export async function addUser(conn, { code, name, role, branch, pin }) {
  if (!['officer', 'supervisor'].includes(role)) throw new Error('--role must be officer or supervisor');
  if (!validPin(pin)) throw new Error('PIN must be 4–8 digits');
  await conn.query('INSERT INTO users (code, name, role, branch, pin_hash) VALUES (?, ?, ?, ?, ?)', [
    code.toUpperCase(), name, role, branch, await hashPin(pin),
  ]);
}

/** Demo branch with two officers sharing the generated portfolio and one supervisor. */
export async function seedDemo(pool) {
  const branch = 'Lucknow Rural';
  const [{ n }] = await pool.query('SELECT COUNT(*) AS n FROM users');
  if (n > 0) throw new Error('Database already has users; seed-demo only runs on an empty database.');
  await withTx(pool, async (conn) => {
    await addUser(conn, { code: 'FO27', name: 'Priya Mishra', role: 'officer', branch, pin: '1234' });
    await addUser(conn, { code: 'FO31', name: 'Ravi Tiwari', role: 'officer', branch, pin: '1234' });
    await addUser(conn, { code: 'SUP1', name: 'Neha Saxena', role: 'supervisor', branch, pin: '9999' });
    const loans = seedLoans();
    for (const [i, loan] of loans.entries()) {
      await upsertLoan(conn, { ...loan, branch, officerCode: i % 4 === 3 ? 'FO31' : 'FO27' });
      for (const p of loan.payments) {
        await conn.query(
          `INSERT INTO payments (id, loan_id, recorded_at, amount, mode, reference, receipt_no, officer_code, received_at)
           VALUES (?, ?, ?, ?, ?, '', ?, 'BRANCH', ?)`,
          [p.id, loan.id, p.at.replace('T', ' '), p.amount, p.mode, p.receiptNo, now()]);
      }
      for (const v of loan.visits) {
        await conn.query(
          `INSERT INTO visits (id, loan_id, recorded_at, outcome, notes, ptp_date, ptp_amount, officer_code, received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'BRANCH', ?)`,
          [v.id, loan.id, v.at.replace('T', ' '), v.outcome, v.notes, v.ptpDate, v.ptpAmount, now()]);
      }
      const ptp = loan.visits.find((v) => v.ptpDate);
      if (ptp) await conn.query('UPDATE loans SET follow_up_date = ? WHERE id = ?', [ptp.ptpDate, loan.id]);
    }
  });
}

function validateLoan(l, i) {
  const where = `loan #${i + 1}${l?.loanNo ? ` (${l.loanNo})` : ''}`;
  const req = ['id', 'loanNo', 'branch', 'product', 'principal', 'emi', 'disbursedOn', 'borrower', 'installments'];
  for (const k of req) if (l?.[k] == null) throw new Error(`${where}: missing "${k}"`);
  if (!l.borrower.name || !l.borrower.phone) throw new Error(`${where}: borrower needs name and phone`);
  if (!Array.isArray(l.installments) || !l.installments.every((x) => x.no && /^\d{4}-\d{2}-\d{2}$/.test(x.dueDate) && x.amount > 0)) {
    throw new Error(`${where}: installments must be [{ no, dueDate: "YYYY-MM-DD", amount }]`);
  }
}

async function main() {
  const [cmd, arg] = positionals;
  if (!cmd) return console.log(USAGE);
  const pool = createPool(config.db);
  try {
    await migrate(pool);
    switch (cmd) {
      case 'migrate':
        console.log('Schema is up to date.');
        break;
      case 'add-user':
        need('code', 'name', 'role', 'branch', 'pin');
        await addUser(pool, values);
        console.log(`Added ${values.role} ${values.code.toUpperCase()}.`);
        break;
      case 'set-pin': {
        need('code', 'pin');
        if (!validPin(values.pin)) throw new Error('PIN must be 4–8 digits');
        const code = values.code.toUpperCase();
        const r = await pool.query('UPDATE users SET pin_hash = ? WHERE code = ?', [await hashPin(values.pin), code]);
        if (!r.affectedRows) throw new Error(`No user ${code}`);
        await pool.query('DELETE s FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.code = ?', [code]);
        console.log(`PIN reset for ${code}.`);
        break;
      }
      case 'deactivate': {
        need('code');
        const code = values.code.toUpperCase();
        const r = await pool.query('UPDATE users SET active = 0 WHERE code = ?', [code]);
        if (!r.affectedRows) throw new Error(`No user ${code}`);
        await pool.query('DELETE s FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.code = ?', [code]);
        console.log(`${code} deactivated.`);
        break;
      }
      case 'list-users':
        console.table(await pool.query('SELECT code, name, role, branch, active FROM users ORDER BY branch, role, code'));
        break;
      case 'import-loans': {
        if (!arg) throw new Error(`File path required.\n\n${USAGE}`);
        const loans = JSON.parse(await readFile(arg, 'utf8'));
        if (!Array.isArray(loans)) throw new Error('File must contain a JSON array of loans.');
        loans.forEach(validateLoan);
        await withTx(pool, async (conn) => {
          for (const l of loans) await upsertLoan(conn, l);
        });
        console.log(`Imported ${loans.length} loans at ${localTimestamp()}.`);
        break;
      }
      case 'seed-demo':
        await seedDemo(pool);
        console.log('Demo data loaded. Officers FO27 / FO31 (PIN 1234), supervisor SUP1 (PIN 9999).');
        break;
      default:
        console.log(USAGE);
        process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
