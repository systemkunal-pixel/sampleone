// Admin API tests against MariaDB (same TEST_DB_* variables as server.test.js; the database is wiped).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import ExcelJS from 'exceljs';
import { addDays, isoDate } from '../src/js/logic.js';

// Test loans: disbursed 37 days ago, first EMI 7 days ago → always in the 1–30 DPD band.
const dmy = (iso) => iso.split('-').reverse().join('/');
const DISBURSED = dmy(addDays(isoDate(), -37));
const FIRST_DUE = dmy(addDays(isoDate(), -7));

const env = process.env;
const enabled = Boolean(env.TEST_DB_USER && env.TEST_DB_NAME);
const opts = { skip: enabled ? false : 'set TEST_DB_USER and TEST_DB_NAME to run admin API tests' };

let pool, server, base, admin;

async function call(path, { token = admin, method = 'GET', body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : await res.text() };
}
const login = async (code, pin) => (await call('/api/login', { token: null, method: 'POST', body: { code, pin } })).body.token;

async function workbook(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Loans');
  ws.addRow(['Loan No', 'Branch', 'Officer Code', 'Principal', 'EMI', 'Disbursed On', 'Tenure', 'First Due Date', 'Borrower Name', 'Phone']);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
}

before(async () => {
  if (!enabled) return;
  const { createPool, migrate } = await import('../server/db.js');
  const { createApp } = await import('../server/app.js');
  const { seedDemo } = await import('../server/admin.js');
  pool = createPool({
    host: env.TEST_DB_HOST || '127.0.0.1', port: Number(env.TEST_DB_PORT) || 3306,
    user: env.TEST_DB_USER, password: env.TEST_DB_PASSWORD || '', database: env.TEST_DB_NAME, connectionLimit: 5,
  });
  for (const t of ['imports', 'audit_log', 'deposit_slips', 'visits', 'payments', 'sessions', 'loans', 'users', 'companies',
    'overlord_sessions', 'overlords', 'support_sessions', 'overlord_audit', 'plans', 'plan_features', 'company_feature_overrides',
    'platform_updates', 'platform_update_events', 'platform_state', 'leads']) {
    await pool.query(`DROP TABLE IF EXISTS ${t}`);
  }
  await migrate(pool);
  await seedDemo(pool);
  server = createServer(createApp({ pool }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await login('ADMIN', 'Demo@Admin2026');
});

after(async () => {
  server?.close();
  await pool?.end();
});

test('only admins reach the admin API, and admins cannot use the field app', opts, async () => {
  const sup = await login('SUP1', '9999');
  assert.equal((await call('/api/admin/users', { token: sup })).status, 403);
  assert.equal((await call('/api/admin/users', { token: null })).status, 401);
  assert.equal((await call('/api/bootstrap')).status, 403);
  assert.equal((await call('/admin')).status, 200); // redirect followed to /admin/
});

test('user management rules', opts, async () => {
  const weak = await call('/api/admin/users', { method: 'POST', body: { code: 'ADM2', name: 'Second Admin', role: 'admin', branch: 'Head Office', pin: '123456' } });
  assert.equal(weak.status, 400);
  assert.match(weak.body.error, /10\+ characters/);
  assert.equal((await call('/api/admin/users', { method: 'POST', body: { code: 'fo60', name: 'New Officer', role: 'officer', branch: 'Kanpur', pin: '4321' } })).status, 200);
  assert.equal((await call('/api/admin/users', { method: 'POST', body: { code: 'FO60', name: 'Dup', role: 'officer', branch: 'Kanpur', pin: '4321' } })).status, 409);

  assert.match((await call('/api/admin/users/ADMIN', { method: 'PATCH', body: { active: false } })).body.error, /your own admin/);
  const busy = await call('/api/admin/users/FO31', { method: 'PATCH', body: { active: false } });
  assert.equal(busy.status, 409);
  assert.match(busy.body.error, /3 assigned loan/);
  assert.match((await call('/api/admin/users/FO31', { method: 'PATCH', body: { branch: 'Kanpur' } })).body.error, /Reassign/);
  // Promoting to admin needs a password, not a PIN.
  assert.match((await call('/api/admin/users/SUP1', { method: 'PATCH', body: { role: 'admin', pin: '9999' } })).body.error, /needs a new credential/);

  // Deactivating ends sessions immediately.
  const fo60 = await login('FO60', '4321');
  assert.equal((await call('/api/bootstrap', { token: fo60 })).status, 200);
  assert.equal((await call('/api/admin/users/FO60', { method: 'PATCH', body: { active: false } })).status, 200);
  assert.equal((await call('/api/bootstrap', { token: fo60 })).status, 401);

  // PIN reset logs the user out and the new PIN works.
  const fo27 = await login('FO27', '1234');
  assert.equal((await call('/api/admin/users/FO27/reset-pin', { method: 'POST', body: { pin: '24680' } })).status, 200);
  assert.equal((await call('/api/bootstrap', { token: fo27 })).status, 401);
  assert.ok(await login('FO27', '24680'));

  const { users } = (await call('/api/admin/users')).body;
  const f27 = users.find((u) => u.code === 'FO27');
  assert.equal(f27.loans, 9);
  assert.ok(f27.lastLoginAt);
});

test('import: preview reports errors, commit creates then updates, tampering is rejected', opts, async () => {
  await call('/api/admin/users', { method: 'POST', body: { code: 'FO70', name: 'Kanpur Officer', role: 'officer', branch: 'Kanpur', pin: '1357' } });
  const base64 = await workbook([
    ['K/1', 'Kanpur', 'FO70', 12000, 1000, DISBURSED, 12, FIRST_DUE, 'Asha', '9839011111'],
    ['K/2', 'Kanpur', '', 6000, 500, DISBURSED, 12, FIRST_DUE, 'Meena', '9839022222'],
    ['K/3', 'Kanpur', 'FO27', 6000, 500, DISBURSED, 12, FIRST_DUE, 'Wrong Branch', '9839033333'],
    ['K/4', 'Kanpur', '', 6000, 500, 'someday', 12, FIRST_DUE, 'Bad Date', '9839044444'],
  ]);
  const pre = (await call('/api/admin/import/preview', { method: 'POST', body: { fileName: 'k.xlsx', base64 } })).body;
  assert.equal(pre.totalRows, 4);
  assert.deepEqual(pre.rows.map((r) => [r.loan.loanNo, r.action]), [['K/1', 'create'], ['K/2', 'create']]);
  assert.match(pre.rows[1].warnings[0], /unassigned/);
  assert.deepEqual(pre.errors.map((e) => e.rowNo), [4, 5]);
  assert.match(pre.errors[0].errors[0], /FO27 belongs to Lucknow Rural, not Kanpur/);

  const loans = pre.rows.map((r) => r.loan);
  const done = (await call('/api/admin/import/commit', { method: 'POST', body: { fileName: 'k.xlsx', totalRows: 4, loans } })).body;
  assert.deepEqual([done.created, done.updated, done.skipped], [2, 0, 2]);

  const again = (await call('/api/admin/import/commit', { method: 'POST', body: { fileName: 'k2.xlsx', totalRows: 2, loans } })).body;
  assert.deepEqual([again.created, again.updated], [0, 2]);

  const tampered = structuredClone(loans);
  tampered[0].borrower.phone = '123';
  const bad = await call('/api/admin/import/commit', { method: 'POST', body: { fileName: 'k.xlsx', loans: tampered } });
  assert.equal(bad.status, 422);

  const { imports } = (await call('/api/admin/imports')).body;
  assert.equal(imports[0].file_name, 'k2.xlsx');

  const tpl = await fetch(`${base}/api/admin/import/template`, { headers: { Authorization: `Bearer ${admin}` } });
  assert.match(tpl.headers.get('content-type'), /spreadsheetml/);
});

test('loans: filters, paging, assignment rules and export', opts, async () => {
  const all = (await call('/api/admin/loans?pageSize=10')).body;
  assert.equal(all.total, 14);
  assert.equal(all.rows.length, 10);
  assert.equal(all.pages, 2);
  assert.ok(all.rows[0].dpd >= all.rows[1].dpd, 'default sort is DPD descending');

  const unassigned = (await call('/api/admin/loans?officer=__none')).body;
  assert.deepEqual(unassigned.rows.map((r) => r.loanNo), ['K/2']);
  assert.equal((await call('/api/admin/loans?q=asha')).body.rows[0].loanNo, 'K/1');
  assert.equal((await call('/api/admin/loans?branch=Kanpur&bucket=1-30')).body.total, 2);

  const kId = unassigned.rows[0].id;
  const lucknowId = (await call('/api/admin/loans?branch=Lucknow%20Rural')).body.rows[0].id;
  assert.match((await call('/api/admin/loans/assign', { method: 'POST', body: { loanIds: [kId, lucknowId], officerCode: 'FO70' } })).body.error, /span branches/);
  assert.match((await call(`/api/admin/loans/${kId}`, { method: 'PATCH', body: { officerCode: 'FO27' } })).body.error, /belongs to Lucknow Rural/);
  assert.equal((await call(`/api/admin/loans/${kId}`, { method: 'PATCH', body: { officerCode: 'FO70' } })).body.changed, 1);

  // Reassign FO31's loans, after which FO31 can be deactivated.
  const fo31 = (await call('/api/admin/loans?officer=FO31')).body.ids;
  assert.equal((await call('/api/admin/loans/assign', { method: 'POST', body: { loanIds: fo31, officerCode: 'FO27' } })).body.changed, 3);
  assert.equal((await call('/api/admin/users/FO31', { method: 'PATCH', body: { active: false } })).status, 200);

  const detail = (await call(`/api/admin/loans/${lucknowId}`)).body;
  assert.ok(detail.loan.installments.length && detail.status.outstanding >= 0);

  const csv = await call('/api/admin/loans/export?branch=Kanpur');
  assert.match(csv.headers.get('content-disposition'), /attachment/);
  assert.equal(csv.body.trim().split('\r\n').length, 3);
});

test('summary and audit trail', opts, async () => {
  const s = (await call('/api/admin/summary')).body;
  assert.equal(s.loans.total, 14);
  assert.deepEqual(s.branches.map((b) => b.branch), ['Kanpur', 'Lucknow Rural']);
  assert.equal(s.buckets.reduce((n, b) => n + b.loans, 0), s.loans.active);
  assert.ok(s.par30Pct > 0 && s.par30Pct < 100);

  const audit = (await call('/api/admin/audit?user=ADMIN')).body;
  const actions = new Set(audit.rows.map((r) => r.action));
  for (const a of ['user_created', 'user_deactivated', 'pin_reset', 'loans_imported', 'loans_assigned']) assert.ok(actions.has(a), a);
});
