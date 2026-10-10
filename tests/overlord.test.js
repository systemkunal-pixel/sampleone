// Multi-company isolation and the overlord console API, against MariaDB (same TEST_DB_* variables as
// server.test.js; the database is wiped).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { isoDate, localTimestamp } from '../src/js/logic.js';
import { codeAt } from '../server/totp.js';

const env = process.env;
const enabled = Boolean(env.TEST_DB_USER && env.TEST_DB_NAME);
const opts = { skip: enabled ? false : 'set TEST_DB_USER and TEST_DB_NAME to run overlord tests' };

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]).toString('base64');
const OVERLORD = { email: 'owner@datahaat.test', name: 'Platform Owner', password: 'Overlord-Pass-2026' };

let pool, server, base, ov, secret;

async function call(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
}
const login = async (code, pin, company) => call('/api/login', { method: 'POST', body: { code, pin, company } });
const O = (path, opts = {}) => call(`/api/overlord${path}`, { token: ov, ...opts });

let seq = 0;
const record = (loanId, extra = {}) => ({
  type: 'payment', loanId,
  record: { id: `p-ov-${++seq}`, at: localTimestamp(), amount: 100, mode: 'Cash', reference: '', receiptNo: `R-OV-${seq}`, ...extra },
});
const deposit = (loanId, slipNo) => ({
  ...record(loanId, { mode: 'Bank deposit', deposit: { slipNo, bank: 'SBI', depositDate: isoDate() } }),
  slip: { mimeType: 'image/jpeg', base64: JPEG },
});

before(async () => {
  if (!enabled) return;
  const { createPool, migrate } = await import('../server/db.js');
  const { createApp } = await import('../server/app.js');
  const { seedDemo, addOverlord } = await import('../server/admin.js');
  pool = createPool({
    host: env.TEST_DB_HOST || '127.0.0.1', port: Number(env.TEST_DB_PORT) || 3306,
    user: env.TEST_DB_USER, password: env.TEST_DB_PASSWORD || '', database: env.TEST_DB_NAME, connectionLimit: 5,
  });
  for (const t of ['password_resets', 'mail_log', 'mail_settings', 'imports', 'audit_log', 'deposit_slips', 'visits', 'payments', 'sessions', 'loans', 'users', 'companies',
    'overlord_sessions', 'overlords', 'support_sessions', 'overlord_audit', 'plans', 'plan_features', 'company_feature_overrides',
    'platform_updates', 'platform_update_events', 'platform_state', 'leads']) {
    await pool.query(`DROP TABLE IF EXISTS ${t}`);
  }
  await migrate(pool);
  await seedDemo(pool, 1);
  await addOverlord(pool, OVERLORD);
  server = createServer(createApp({ pool }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  await pool?.end();
});

test('first migration creates BRMC (with existing data) and DataHaat', opts, async () => {
  const rows = await pool.query('SELECT id, code, name FROM companies ORDER BY id');
  assert.deepEqual(rows.map((r) => r.code), ['BRMC', 'DATAHAAT']);
  assert.equal(rows[0].name, 'Bihar Risk Management Consultancy Private Limited');
});

test('overlord sign-in needs the password, then an authenticator code set up on first use', opts, async () => {
  assert.equal((await call('/api/overlord/overview')).status, 401);
  assert.equal((await call('/api/overlord/login', { method: 'POST', body: { ...OVERLORD, password: 'wrong-password-1' } })).status, 401);

  const first = (await call('/api/overlord/login', { method: 'POST', body: OVERLORD })).body;
  assert.equal(first.stage, 'enroll');
  assert.match(first.qrSvg, /^<svg/);
  assert.match(first.otpauthUrl, /^otpauth:\/\/totp\//);
  secret = first.secret;
  // The ticket from the password step is not a session.
  assert.equal((await call('/api/overlord/overview', { token: first.ticket })).status, 401);
  const wrong = await call('/api/overlord/login/verify', { method: 'POST', body: { ticket: first.ticket, code: '000000' } });
  assert.equal(wrong.status, 400);

  const code = codeAt(secret);
  const ok = await call('/api/overlord/login/verify', { method: 'POST', body: { ticket: first.ticket, code } });
  assert.equal(ok.status, 200);
  ov = ok.body.token;
  assert.equal((await O('/me')).body.overlord.email, OVERLORD.email);

  // Enrolled now: the next sign-in asks for a code, and the code just used can't be replayed.
  const second = (await call('/api/overlord/login', { method: 'POST', body: OVERLORD })).body;
  assert.equal(second.stage, 'code');
  assert.equal(second.secret, undefined);
  assert.equal((await call('/api/overlord/login/verify', { method: 'POST', body: { ticket: second.ticket, code } })).status, 400);

  // Company staff tokens never open the overlord API.
  const admin = (await login('ADMIN', 'Demo@Admin2026')).body.token;
  assert.equal((await call('/api/overlord/overview', { token: admin })).status, 401);
});

let acme, acmeAdmin;

test('overlord creates a company with its first admin; data stays inside each company', opts, async () => {
  const bad = await O('/companies', { method: 'POST', body: { code: 'AC ME', name: 'Acme', admin: {} } });
  assert.equal(bad.status, 400);
  const res = await O('/companies', {
    method: 'POST',
    body: { code: 'acme', name: 'Acme Microfinance', plan: 'pro', contactEmail: 'ops@acme.test', admin: { code: 'BOSS', name: 'Acme Admin', password: 'AcmeAdmin2026' } },
  });
  assert.equal(res.status, 200);
  acme = res.body.id;
  assert.equal((await O('/companies', { method: 'POST', body: { code: 'ACME', name: 'Again', admin: { code: 'X1', name: 'Xx', password: 'AcmeAdmin2026' } } })).status, 409);

  // User codes are unique across companies: ACME's demo users get ACME's first letters.
  assert.equal((await O(`/companies/${acme}/demo`, { method: 'POST' })).status, 409, 'not empty: it has an admin');
  await pool.query('DELETE FROM users WHERE company_id = ?', [acme]);
  const demo = await O(`/companies/${acme}/demo`, { method: 'POST' });
  assert.equal(demo.status, 200);
  assert.match(demo.body.logins, /ACMFO27 \/ ACMFO31/);
  await O(`/companies/${acme}/admins`, { method: 'POST', body: { code: 'BOSS', name: 'Acme Admin', password: 'AcmeAdmin2026' } });

  // Codes taken in another company are refused everywhere.
  assert.equal((await O(`/companies/${acme}/admins`, { method: 'POST', body: { code: 'ADMIN', name: 'Dup Admin', password: 'AcmeAdmin2026' } })).status, 409);
  const brmc27 = (await login('FO27', '1234')).body;
  const acme27 = (await login('ACMFO27', '1234')).body;
  assert.equal(brmc27.user.company.code, 'BRMC');
  assert.equal(acme27.user.company.code, 'ACME');
  assert.equal((await login('BOSS', 'AcmeAdmin2026')).status, 200, 'no company code needed');
  assert.equal((await login('FO27', '1234', 'NOPE')).status, 401, 'a wrong company code, if sent, still fails');

  const brmcLoans = (await call('/api/bootstrap', { token: brmc27.token })).body.loans;
  const acmeLoans = (await call('/api/bootstrap', { token: acme27.token })).body.loans;
  assert.ok(brmcLoans.length && acmeLoans.length);
  assert.ok(acmeLoans.every((l) => l.id.startsWith(`${acme}-`)));
  assert.ok(!acmeLoans.some((a) => brmcLoans.some((b) => b.id === a.id)));

  // An officer can't write to another company's loan, and an admin can't read one.
  const cross = (await call('/api/records', { token: acme27.token, method: 'POST', body: { records: [record(brmcLoans[0].id)] } })).body.results[0];
  assert.equal(cross.status, 'rejected');
  acmeAdmin = (await login('BOSS', 'AcmeAdmin2026')).body.token;
  assert.equal((await call('/api/admin/users', { token: acmeAdmin, method: 'POST', body: { code: 'FO27', name: 'Copy Cat', role: 'officer', branch: 'Lucknow Rural', pin: '1234' } })).status, 409);
  assert.equal((await call(`/api/admin/loans/${encodeURIComponent(brmcLoans[0].id)}`, { token: acmeAdmin })).status, 404);
  const acmeList = (await call('/api/admin/loans?pageSize=100', { token: acmeAdmin })).body;
  const [{ n: acmeCount }] = await pool.query('SELECT COUNT(*) AS n FROM loans WHERE company_id = ?', [acme]);
  assert.equal(acmeList.total, acmeCount);
  const users = (await call('/api/admin/users', { token: acmeAdmin })).body.users;
  assert.ok(users.every((u) => ['ACMFO27', 'ACMFO31', 'ACMSUP1', 'ACMADMIN', 'BOSS'].includes(u.code)));
  assert.equal(users.length, 5);

  // Slip numbers are unique within a company, not across companies.
  const s1 = (await call('/api/records', { token: brmc27.token, method: 'POST', body: { records: [deposit(brmcLoans[0].id, 'SLIP-777')] } })).body.results[0];
  const s2 = (await call('/api/records', { token: acme27.token, method: 'POST', body: { records: [deposit(acmeLoans[0].id, 'SLIP-777')] } })).body.results[0];
  assert.equal(s1.status, 'accepted');
  assert.equal(s2.status, 'accepted');
  // The other company's slip image is invisible.
  assert.equal((await call(`/api/slips/${s1.id}`, { token: acmeAdmin })).status, 404);

  // Overview counts both, and the demo's audit lines carry the right company.
  const overview = (await O('/overview')).body;
  assert.equal(overview.totals.companies, 3);
  const a = overview.companies.find((c) => c.code === 'ACME');
  assert.equal(a.officers, 2);
  assert.equal(a.loans, acmeCount);
  // Each admin sees exactly their own company's audit lines.
  const [{ n }] = await pool.query('SELECT COUNT(*) AS n FROM audit_log WHERE company_id = ?', [acme]);
  assert.equal((await call('/api/admin/audit', { token: acmeAdmin })).body.total, n);
});

test('plans gate features; overrides beat the plan; officer limits are enforced', opts, async () => {
  assert.equal((await O(`/companies/${acme}`, { method: 'PATCH', body: { plan: 'regular' } })).status, 200);
  const me = (await call('/api/me', { token: acmeAdmin })).body;
  assert.equal(me.plan, 'regular');
  assert.equal(me.features.bank_deposits, false);
  assert.equal((await call('/api/admin/loans/export', { token: acmeAdmin })).status, 403);
  assert.equal((await call('/api/admin/audit', { token: acmeAdmin })).status, 403);

  const fo31 = (await login('ACMFO31', '1234')).body.token;
  const loan = (await call('/api/bootstrap', { token: fo31 })).body.loans[0];
  const refused = (await call('/api/records', { token: fo31, method: 'POST', body: { records: [deposit(loan.id, 'SLIP-900')] } })).body.results[0];
  assert.equal(refused.status, 'rejected');
  assert.match(refused.error, /plan/);

  await O(`/companies/${acme}/overrides`, { method: 'PUT', body: { feature: 'bank_deposits', enabled: true } });
  const allowed = (await call('/api/records', { token: fo31, method: 'POST', body: { records: [deposit(loan.id, 'SLIP-901')] } })).body.results[0];
  assert.equal(allowed.status, 'accepted');

  // Plan matrix edits apply to every company on that plan.
  await O('/plans/regular', { method: 'PUT', body: { features: { loan_export: true } } });
  assert.equal((await call('/api/admin/loans/export', { token: acmeAdmin })).status, 200);
  const plans = (await O('/plans')).body;
  assert.equal(plans.matrix.regular.loan_export, true);
  assert.equal(plans.companies.find((c) => c.id === acme).overrides.bank_deposits, true);

  // Officer limit: ACME has two officers; cap it at two.
  await O(`/companies/${acme}`, { method: 'PATCH', body: { maxOfficers: 2 } });
  const third = await call('/api/admin/users', { token: acmeAdmin, method: 'POST', body: { code: 'FO40', name: 'New Officer', role: 'officer', branch: 'Lucknow Rural', pin: '1234' } });
  assert.equal(third.status, 409);
  assert.match(third.body.error, /2 active field officers/);
  await O(`/companies/${acme}`, { method: 'PATCH', body: { maxOfficers: null, plan: 'pro' } });
});

test('support access: logged, time-boxed, attributed to the overlord, and can be ended', opts, async () => {
  assert.equal((await O(`/companies/${acme}/support`, { method: 'POST', body: { reason: '' } })).status, 400);
  const s = (await O(`/companies/${acme}/support`, { method: 'POST', body: { reason: 'Customer cannot import loans', notifyOwner: true } })).body;
  assert.ok(s.token);
  const me = (await call('/api/me', { token: s.token })).body.user;
  assert.equal(me.role, 'admin');
  assert.equal(me.code, 'SUPPORT');
  assert.equal(me.company.code, 'ACME');
  assert.equal(me.support.overlordName, OVERLORD.name);

  const created = await call('/api/admin/users', { token: s.token, method: 'POST', body: { code: 'SUP9', name: 'Helper Supervisor', role: 'supervisor', branch: 'Lucknow Rural', pin: '4321' } });
  assert.equal(created.status, 200);
  assert.equal((await call('/api/admin/me/password', { token: s.token, method: 'POST', body: { current: 'x', next: 'y' } })).status, 400);
  assert.equal((await call('/api/admin/users', { token: s.token, method: 'POST', body: { code: 'SUPPORT', name: 'Fake', role: 'officer', branch: 'X', pin: '1234' } })).status, 400);

  const [row] = await pool.query("SELECT user_code, support_id FROM audit_log WHERE action = 'user_created' AND entity_id = 'SUP9'");
  assert.equal(row.user_code, 'SUPPORT');
  assert.equal(row.support_id, s.supportId);
  const audit = (await call('/api/admin/audit?action=user_created', { token: acmeAdmin })).body.rows;
  assert.equal(audit[0].support_name, OVERLORD.name);

  const sessions = (await O('/support-sessions')).body.rows;
  assert.equal(sessions[0].reason, 'Customer cannot import loans');
  assert.equal(sessions[0].live, true);
  assert.equal(sessions[0].actions, 1);

  assert.equal((await call('/api/support/end', { token: s.token, method: 'POST' })).status, 200);
  assert.equal((await call('/api/me', { token: s.token })).status, 401);
  assert.equal((await O('/support-sessions')).body.rows[0].live, false);
});

test('lock and archive cut sessions and block sign-in; reopen restores', opts, async () => {
  assert.equal((await O(`/companies/${acme}/status`, { method: 'POST', body: { action: 'lock' } })).status, 400, 'reason required');
  assert.equal((await O(`/companies/${acme}/status`, { method: 'POST', body: { action: 'lock', reason: 'Invoice unpaid' } })).status, 200);
  assert.equal((await call('/api/me', { token: acmeAdmin })).status, 401);
  const blocked = await login('BOSS', 'AcmeAdmin2026');
  assert.equal(blocked.status, 403);
  assert.match(blocked.body.error, /locked/);
  // Support can still enter a locked company to help sort it out.
  const s = (await O(`/companies/${acme}/support`, { method: 'POST', body: { reason: 'Checking before unlock' } })).body;
  assert.equal((await call('/api/me', { token: s.token })).status, 200);

  assert.equal((await O(`/companies/${acme}/status`, { method: 'POST', body: { action: 'archive', reason: 'Customer left' } })).status, 200);
  assert.equal((await call('/api/me', { token: s.token })).status, 401, 'archive ends support sessions');
  assert.equal((await O(`/companies/${acme}/support`, { method: 'POST', body: { reason: 'Look inside please' } })).status, 409);
  assert.equal((await O('/overview')).body.companies.some((c) => c.id === acme), false, 'archived companies leave the overview');
  assert.equal((await O('/companies?archived=1')).body.companies.find((c) => c.id === acme).status, 'archived');

  assert.equal((await O(`/companies/${acme}/status`, { method: 'POST', body: { action: 'unlock' } })).status, 409);
  assert.equal((await O(`/companies/${acme}/status`, { method: 'POST', body: { action: 'reopen' } })).status, 200);
  assert.equal((await login('BOSS', 'AcmeAdmin2026')).status, 200);
});

test('overlord accounts and the overlord audit trail', opts, async () => {
  const add = await O('/overlords', { method: 'POST', body: { email: 'Support@DataHaat.test', name: 'Support Desk', password: 'short' } });
  assert.equal(add.status, 400);
  const ok = await O('/overlords', { method: 'POST', body: { email: 'Support@DataHaat.test', name: 'Support Desk', password: 'Support-Desk-2026' } });
  assert.equal(ok.status, 200);
  const list = (await O('/overlords')).body.overlords;
  const me = list.find((o) => o.email === OVERLORD.email);
  assert.equal((await O(`/overlords/${me.id}`, { method: 'PATCH', body: { active: false } })).status, 400, "can't deactivate yourself");
  assert.equal((await O(`/overlords/${ok.body.id}/reset-authenticator`, { method: 'POST' })).status, 200);

  const actions = (await O('/audit?page=1')).body.actions;
  for (const a of ['login', 'authenticator_enrolled', 'company_created', 'company_updated', 'plan_updated', 'feature_override',
    'support_started', 'company_locked', 'company_archived', 'company_reopened', 'overlord_added', 'authenticator_reset']) {
    assert.ok(actions.includes(a), `audit has ${a}`);
  }
  const lock = (await O(`/audit?action=company_locked`)).body.rows[0];
  assert.equal(lock.companyCode, 'ACME');
  assert.equal(lock.detail.reason, 'Invoice unpaid');
  assert.equal(lock.who, OVERLORD.email);
});

test('signed updates: verify needs the release key, stage needs the typed version, and both are logged', opts, async () => {
  const { generateSigningKeys, buildPatch } = await import('../server/patch.js');
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, dirname } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'ld-rel-'));
  for (const [p, body] of Object.entries({ 'package.json': '{"version":"99.0.0"}', 'server/index.js': '//', 'server/schema.sql': '' })) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), body);
  }
  const keys = generateSigningKeys();
  const pkg = buildPatch(root, keys.privatePem).toString('base64');

  delete process.env.UPDATE_PUBLIC_KEY;
  const noKey = await O('/updates/verify', { method: 'POST', body: { fileName: 'x.ldpatch', base64: pkg } });
  assert.equal(noKey.status, 400);
  assert.match(noKey.body.error, /signing key/);

  process.env.UPDATE_PUBLIC_KEY = generateSigningKeys().publicKey; // someone else's key
  assert.match((await O('/updates/verify', { method: 'POST', body: { fileName: 'x.ldpatch', base64: pkg } })).body.error, /Signature/);

  process.env.UPDATE_PUBLIC_KEY = keys.publicKey;
  const ok = await O('/updates/verify', { method: 'POST', body: { fileName: 'loandesk-99.0.0.ldpatch', base64: pkg } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.summary.version, '99.0.0');
  assert.equal((await O('/updates/stage', { method: 'POST', body: { sha256: ok.body.sha256, confirm: '1.0' } })).status, 400);
  const staged = await O('/updates/stage', { method: 'POST', body: { sha256: ok.body.sha256, fileName: ok.body.fileName, confirm: '99.0.0' } });
  assert.equal(staged.status, 200);
  assert.equal((await O('/updates/stage', { method: 'POST', body: { sha256: ok.body.sha256, confirm: '99.0.0' } })).status, 409, 'one at a time');
  const page = (await O('/updates')).body;
  assert.equal(page.active.to_version, '99.0.0');
  assert.equal(page.diagnostics.signingKey.configured, true);
  assert.deepEqual(page.events.slice(0, 5).map((e) => `${e.action}:${e.outcome}`), ['stage:refused', 'stage:ok', 'stage:refused', 'verify:ok', 'verify:refused']);
  assert.equal((await O(`/updates/${staged.body.id}/cancel`, { method: 'POST' })).status, 200);
  delete process.env.UPDATE_PUBLIC_KEY;
});

test('home page demo requests: validated, honeypot ignored, listed and tracked in the overlord console', opts, async () => {
  const post = (body) => call('/api/leads', { method: 'POST', body });
  assert.equal((await post({ name: 'Asha', company: 'Asha MFI', phone: '12345' })).status, 400);
  assert.equal((await post({ name: 'Bot', company: 'Spam', phone: '9876543210', website: 'http://spam' })).status, 200);
  assert.equal((await post({ name: 'Asha Verma', company: 'Asha MFI', phone: '+91 98765 43210', officers: '25', lang: 'hi' })).status, 200);
  const { leads, counts } = (await O('/leads')).body;
  assert.equal(leads.length, 1, 'the honeypot submission was not stored');
  assert.equal(leads[0].phone, '9876543210');
  assert.equal(leads[0].officers, 25);
  assert.equal(counts.new, 1);
  assert.equal((await O(`/leads/${leads[0].id}`, { method: 'PATCH', body: { status: 'contacted', note: 'Demo on Friday' } })).status, 200);
  assert.equal((await O('/leads?status=contacted')).body.leads[0].note, 'Demo on Friday');
  assert.equal((await call('/api/overlord/leads')).status, 401);
});

test('codes duplicated before the rule are renamed once, with their loans and records', opts, async () => {
  const { migrate } = await import('../server/db.js');
  const { hashPin } = await import('../server/auth.js');
  // Recreate an old database: the global unique index missing and FO27 in two companies.
  await pool.query('ALTER TABLE users DROP INDEX uq_users_code');
  const [dh] = await pool.query("SELECT id FROM companies WHERE code = 'DATAHAAT'");
  await pool.query("INSERT INTO users (company_id, code, name, role, branch, pin_hash) VALUES (?, 'FO27', 'Twin Officer', 'officer', 'Patna', ?)",
    [dh.id, await hashPin('5555')]);
  await pool.query("INSERT INTO loans (company_id, id, loan_no, branch, officer_code, product, principal, emi, disbursed_on, borrower, installments) VALUES (?, 'dh-twin', 'DH/1', 'Patna', 'FO27', 'Loan', 1000, 100, '2026-01-01', '{\"name\":\"X\",\"phone\":\"9876543210\"}', '[]')",
    [dh.id]);
  await migrate(pool);
  const [twin] = await pool.query("SELECT code FROM users WHERE name = 'Twin Officer'");
  assert.equal(twin.code, 'DATFO27');
  assert.equal((await pool.query("SELECT officer_code FROM loans WHERE id = 'dh-twin'"))[0].officer_code, 'DATFO27');
  assert.equal((await pool.query("SELECT u.code FROM users u JOIN companies c ON c.id = u.company_id WHERE c.code = 'BRMC' AND u.name = 'Priya Mishra'"))[0].code, 'FO27', 'the oldest keeps its code');
  assert.equal((await login('DATFO27', '5555')).status, 200);
  await assert.rejects(pool.query("INSERT INTO users (company_id, code, name, role, branch, pin_hash) VALUES (?, 'DATFO27', 'Third', 'officer', 'X', 'x')", [dh.id]), /Duplicate/);
});
