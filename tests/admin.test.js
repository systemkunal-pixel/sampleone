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
  for (const t of ['clients', 'area_agents', 'password_resets', 'mail_log', 'mail_settings', 'imports', 'audit_log', 'deposit_slips', 'visits', 'payments', 'sessions', 'loans', 'users', 'companies',
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
  tampered[0].principal = -5;
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

// A lender's recovery list (VFS "Borrower Details" layout), made-up data.
async function recoveryList(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Borrower Details');
  ws.addRow([]);
  ws.addRow([null, 'PI_NAME', 'CUST_NAME', 'ACCT_NO', 'Asset Class', 'Address', 'PIN Code', 'State', 'District', 'Mob No.', 'OS_AMT', 'INT_RATE', 'DUE_SINCE', 'T_ODUE']);
  for (const [acct, pin, district, due] of rows) {
    ws.addRow([null, 'VFS CAPITAL LIMITED', `BORROWER ${acct}`, acct, 'NPA', 'NEAR SCHOOL', pin, 'WEST BENGAL', district, '9800012345', due, 18, 45570, due]);
  }
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
}
const importAll = async (base64, fileName = 'vfs.xlsx', clientId = undefined) => {
  const pre = (await call('/api/admin/import/preview', { method: 'POST', body: { fileName, base64, clientId } })).body;
  const done = (await call('/api/admin/import/commit', { method: 'POST', body: { fileName, totalRows: pre.totalRows, clientId, loans: pre.rows.map((r) => r.loan) } })).body;
  return { pre, done };
};
const officerOf = async (loanNo, client = 'VFS') => (await pool.query(
  'SELECT l.officer_code FROM loans l JOIN clients c ON c.id = l.client_id WHERE l.loan_no = ? AND c.code = ?', [loanNo, client]))[0]?.officer_code ?? null;
let vfs;

test('areas: a recovery list by pincode, agents deputed per pincode, new accounts follow the agent', opts, async () => {
  // Agents have no branch: they work every client's accounts in their pincodes.
  for (const [code, name] of [['AG1', 'Agent One'], ['AG2', 'Agent Two']]) {
    assert.equal((await call('/api/admin/users', { method: 'POST', body: { code, name, role: 'officer', branch: '', pin: '2468' } })).status, 200);
  }
  // A list imported before clients existed (lender as branch) moves to a client of that name on upgrade.
  const legacy = await importAll(await recoveryList([['V001', 711302, 'HOWRAH', 26530], ['V002', 711302, 'HOWRAH', 5000], ['V003', 721429, 'EAST MEDINIPORE', 9000]]));
  assert.deepEqual([legacy.done.created, legacy.pre.rows[0].loan.branch], [3, 'VFS']);
  const { migrate } = await import('../server/db.js');
  await migrate(pool);
  const { clients } = (await call('/api/admin/clients')).body;
  vfs = clients.find((c) => c.code === 'VFS');
  assert.equal(vfs.accounts, 3);
  assert.deepEqual((await pool.query('SELECT DISTINCT branch FROM loans WHERE client_id = ?', [vfs.id])).map((r) => r.branch), ['']);
  assert.equal((await call(`/api/admin/clients/${vfs.id}`, { method: 'PATCH', body: { name: 'VFS Capital Limited', feePct: 12.5 } })).status, 200);

  // Re-importing for the client matches the same accounts and keeps every column of the file.
  const first = await importAll(await recoveryList([['V001', 711302, 'HOWRAH', 26530], ['V002', 711302, 'HOWRAH', 5000], ['V003', 721429, 'EAST MEDINIPORE', 9000]]), 'vfs.xlsx', vfs.id);
  assert.deepEqual([first.done.created, first.done.updated], [0, 3]);
  assert.equal(first.pre.rows[0].loan.branch, '', 'no branch for a client without one');
  const [row] = await pool.query("SELECT t_odue, os_amt, int_rate, asset_class, due_since, source_row FROM loans WHERE loan_no = 'V001'");
  assert.deepEqual([row.t_odue, row.os_amt, row.int_rate, row.asset_class, row.due_since], [26530, 26530, 18, 'NPA', '2024-10-05']);
  assert.equal(JSON.parse(row.source_row).PI_NAME, 'VFS CAPITAL LIMITED');
  assert.equal((await call('/api/admin/import/preview', { method: 'POST', body: { fileName: 'x.xlsx', base64: await recoveryList([]), clientId: 999 } })).status, 400);

  let areas = (await call('/api/admin/areas')).body;
  assert.deepEqual(areas.clients.map((c) => c.code), ['VFS']);
  const wb = areas.states.find((s) => s.state === 'WEST BENGAL');
  assert.deepEqual(wb.districts.map((d) => [d.district, d.accounts, d.unassigned]), [['HOWRAH', 2, 2], ['EAST MEDINIPORE', 1, 1]]);
  assert.equal(wb.overdue, 26530 + 5000 + 9000);

  // An officer tied to a branch takes only that branch's accounts; AG1 (no branch) takes both.
  assert.equal((await call('/api/admin/areas/agent', { method: 'POST', body: { pincodes: ['711302'], officerCode: 'FO27' } })).body.changed, 0);
  const dep = (await call('/api/admin/areas/agent', { method: 'POST', body: { pincodes: ['711302'], officerCode: 'AG1' } })).body;
  assert.equal(dep.changed, 2);
  areas = (await call('/api/admin/areas')).body;
  const pin = areas.states[0].districts.find((d) => d.district === 'HOWRAH').pincodes[0];
  assert.deepEqual([pin.pincode, pin.agent.code, pin.unassigned], ['711302', 'AG1', 0]);

  // V003 is moved by hand to AG2; next month's file has V001–V003 again plus a new V004 in 711302.
  await call('/api/admin/loans/assign', { method: 'POST', body: { loanIds: [first.pre.rows[2].loan.id], officerCode: 'AG2' } });
  const next = await importAll(await recoveryList([
    ['V001', 711302, 'HOWRAH', 20000], ['V002', 711302, 'HOWRAH', 5000], ['V003', 721429, 'EAST MEDINIPORE', 9000], ['V004', 711302, 'HOWRAH', 7000],
  ]), 'vfs-next.xlsx', vfs.id);
  assert.deepEqual([next.done.created, next.done.updated], [1, 3]);
  const v4 = next.pre.rows.find((r) => r.loan.loanNo === 'V004');
  assert.ok(v4.warnings.some((w) => /agent for pincode 711302/.test(w)));
  assert.deepEqual(await Promise.all(['V001', 'V002', 'V003', 'V004'].map((n) => officerOf(n))), ['AG1', 'AG1', 'AG2', 'AG1'], 'officers kept; the new account follows the agent');

  // A second client with the same account number in the same pincode: a separate account, same agent.
  const sbi = (await call('/api/admin/clients', { method: 'POST', body: { code: 'SBI', name: 'State Bank of India' } })).body;
  assert.equal((await call('/api/admin/clients', { method: 'POST', body: { code: 'sbi', name: 'Again' } })).status, 409);
  const other = await importAll(await recoveryList([['V001', 711302, 'HOWRAH', 4000]]), 'sbi.xlsx', sbi.id);
  assert.deepEqual([other.done.created, other.done.updated], [1, 0]);
  assert.equal(await officerOf('V001', 'SBI'), 'AG1');
  assert.equal((await call(`/api/admin/areas?client=${sbi.id}`)).body.states[0].accounts, 1);

  // Loans can be listed by pincode and client; the agent's phone gets both clients' accounts with their details.
  assert.deepEqual((await call('/api/admin/loans?pincode=721429')).body.rows.map((r) => r.loanNo), ['V003']);
  assert.equal((await call(`/api/admin/loans?client=${sbi.id}`)).body.total, 1);
  const phone = (await call('/api/bootstrap', { token: await login('AG1', '2468') })).body;
  assert.deepEqual(phone.loans.map((l) => `${l.client.code}:${l.loanNo}`).sort(), ['SBI:V001', 'VFS:V001', 'VFS:V002', 'VFS:V004']);
  const v1 = phone.loans.find((l) => l.client.code === 'VFS' && l.loanNo === 'V001');
  assert.deepEqual(v1.area, { state: 'WEST BENGAL', district: 'HOWRAH', pincode: '711302' });
  assert.equal(v1.installments[0].amount, 20000, 'the new file updates the amount due');
  assert.deepEqual([v1.client.name, v1.recovery.tOdue, v1.recovery.assetClass], ['VFS Capital Limited', 20000, 'NPA']);

  // Removing the agent but keeping the assignments.
  assert.equal((await call('/api/admin/areas/agent', { method: 'POST', body: { pincodes: ['711302'], officerCode: null, mode: 'unassigned' } })).body.changed, 0);
  assert.equal(await officerOf('V001'), 'AG1');
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM area_agents')).at(0).n, 0);
  const [entry] = await pool.query("SELECT action FROM audit_log WHERE action LIKE 'area_agent%' ORDER BY id DESC LIMIT 1");
  assert.equal(entry.action, 'area_agent_removed');
});

test('agents have a home pincode and range; the recruitment plan places agents within range', opts, async () => {
  assert.equal((await call('/api/admin/users/AG2', { method: 'PATCH', body: { basePincode: '12345' } })).status, 400);
  assert.equal((await call('/api/admin/users/AG2', { method: 'PATCH', body: { basePincode: '721429', rangeKm: 300 } })).status, 400);
  assert.equal((await call('/api/admin/users/AG2', { method: 'PATCH', body: { basePincode: '721429', rangeKm: 15 } })).status, 200);
  const ag2 = (await call('/api/admin/users')).body.users.find((u) => u.code === 'AG2');
  assert.deepEqual([ag2.basePincode, ag2.rangeKm], ['721429', 15]);
  assert.equal((await call('/api/admin/users/ADMIN', { method: 'PATCH', body: { basePincode: '721429' } })).status, 200);
  assert.equal((await call('/api/admin/users')).body.users.find((u) => u.code === 'ADMIN').basePincode, null, 'only field officers have a home pincode');

  // Pincodes within AG2's 15 km: 721429 itself, not Howrah (about 100 km away).
  const near = (await call('/api/admin/areas/nearby/AG2')).body;
  assert.equal(near.range, 15);
  assert.deepEqual(near.pincodes.map((p) => [p.pincode, p.km]), [['721429', 0]]);
  assert.equal((await call('/api/admin/areas/nearby/AG1')).status, 400, 'no home pincode yet');

  const plan = (await call('/api/admin/areas/plan?km=20&max=250&min=1&scope=all')).body;
  assert.equal(plan.summary.accounts, 5, 'all clients');
  assert.equal((await call(`/api/admin/areas/plan?client=${vfs.id}&min=1&scope=all`)).body.summary.accounts, 4);
  assert.deepEqual(plan.agents.map((a) => a.base.pincode).sort(), ['711302', '721429']);
  const open = (await call('/api/admin/areas/plan?min=1')).body;
  assert.equal(open.summary.accounts, 5, 'no pincode has an agent now, so all are open');
  const xlsx = await fetch(`${base}/api/admin/areas/plan.xlsx?min=1`, { headers: { Authorization: `Bearer ${admin}` } });
  assert.match(xlsx.headers.get('content-type'), /spreadsheetml/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await xlsx.arrayBuffer()));
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Agents to recruit', 'Thin areas', 'Pincodes', 'About']);
  assert.equal(wb.getWorksheet('Agents to recruit').rowCount, 3);
});
