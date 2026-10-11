// Recovery desk against MariaDB (same TEST_DB_* variables as server.test.js; the database is wiped): the team
// dashboard and daily report, visits and calls, difficult cases, targets, allocation by coordinators, settings.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { isoDate, addDays, localTimestamp } from '../src/js/logic.js';

const env = process.env;
const enabled = Boolean(env.TEST_DB_USER && env.TEST_DB_NAME);
const opts = { skip: enabled ? false : 'set TEST_DB_USER and TEST_DB_NAME to run recovery desk tests' };

let pool, server, base, admin, fo27, dc1, dc2, sh;
let loans = [];

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
const record = (type, loan, r) => ({ type, loanId: loan.id, record: { id: `${type}-${Math.random().toString(36).slice(2)}`, at: localTimestamp(new Date(Date.now() - 60000)), ...r } });

before(async () => {
  if (!enabled) return;
  const { createPool, migrate } = await import('../server/db.js');
  const { createApp } = await import('../server/app.js');
  const { seedDemo } = await import('../server/admin.js');
  pool = createPool({
    host: env.TEST_DB_HOST || '127.0.0.1', port: Number(env.TEST_DB_PORT) || 3306,
    user: env.TEST_DB_USER, password: env.TEST_DB_PASSWORD || '', database: env.TEST_DB_NAME, connectionLimit: 5,
  });
  for (const t of ['targets', 'case_events', 'company_settings', 'circle_areas', 'circles', 'clients', 'area_agents', 'password_resets', 'mail_log', 'mail_settings', 'imports', 'audit_log', 'deposit_slips', 'visits', 'payments', 'sessions', 'loans', 'users', 'companies',
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
  // Regional Coordinator SH01 → Area Coordinators DC0001 (with the demo's two agents) and DC0002 (nobody yet).
  await call('/api/admin/team/commit', { method: 'POST', body: { post: 'state_head', people: [{ name: 'Ravi Kumar', phone: '9830000001', pin: '1111' }] } });
  await call('/api/admin/team/commit', { method: 'POST', body: { post: 'coordinator', parentCode: 'SH01', people: [
    { name: 'Asha Verma', phone: '9830000002', pin: '2222', districts: 'LUCKNOW' }, { name: 'Gopal Das', phone: '9830000003', pin: '3333' }] } });
  await pool.query("UPDATE users SET post = 'agent', parent_code = 'DC0001', branch = '' WHERE code IN ('FO27', 'FO31')");
  fo27 = await login('FO27', '1234');
  dc1 = await login('DC0001', '2222');
  dc2 = await login('DC0002', '3333');
  sh = await login('SH01', '1111');
  loans = (await call('/api/bootstrap', { token: fo27 })).body.loans.filter((l) => l.installments.some((i) => i.dueDate <= isoDate()));
});

after(async () => {
  server?.close();
  await pool?.end();
});

test('agents log a visit or a call, and can refer a difficult case to their coordinator', opts, async () => {
  const bad = await call('/api/records', { token: fo27, method: 'POST', body: { records: [record('visit', loans[2], { outcome: 'REFUSED', notes: '', contactType: 'call', difficult: true })] } });
  assert.equal(bad.body.results[0].status, 'rejected');
  assert.match(bad.body.results[0].error, /why this is a difficult case/);
  const records = [
    record('visit', loans[0], { outcome: 'PTP', notes: 'After harvest', ptpDate: addDays(isoDate(), 1), ptpAmount: 2500, contactType: 'visit', location: { lat: 26.85, lng: 80.95 } }),
    record('visit', loans[1], { outcome: 'NO_ANSWER', notes: '', contactType: 'call' }),
    record('visit', loans[2], { outcome: 'REFUSED', notes: 'Says his brother took the loan', contactType: 'call', difficult: true }),
    record('visit', loans[3], { outcome: 'DOOR_LOCKED', notes: '', contactType: 'visit' }),
    record('payment', loans[4], { amount: 1500, mode: 'Cash', reference: '', receiptNo: 'R-FO27-T-001' }),
  ];
  const res = await call('/api/records', { token: fo27, method: 'POST', body: { records } });
  assert.deepEqual(res.body.results.map((r) => r.status), ['accepted', 'accepted', 'accepted', 'accepted', 'accepted']);
  const [v] = await pool.query('SELECT contact_type FROM visits WHERE loan_id = ? ORDER BY recorded_at DESC LIMIT 1', [loans[1].id]);
  assert.equal(v.contact_type, 'call');
  const boot = (await call('/api/bootstrap', { token: fo27 })).body;
  const difficult = boot.loans.find((l) => l.id === loans[2].id);
  assert.deepEqual([difficult.case.level, difficult.case.note, difficult.case.by], [1, 'Says his brother took the loan', 'FO27']);
  assert.equal(boot.loans.find((l) => l.id === loans[1].id).visits.at(-1).contactType, 'call');
  // A second "difficult" on the same account keeps the case as it is.
  await call('/api/records', { token: fo27, method: 'POST', body: { records: [record('visit', loans[2], { outcome: 'REFUSED', notes: 'Again', contactType: 'visit', difficult: true })] } });
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM case_events WHERE loan_id = ?', [loans[2].id]))[0].n, 1);
});

test('the team dashboard shows each coordinator only their own team, with the daily report', opts, async () => {
  assert.equal((await call('/api/desk', { token: fo27 })).status, 403, 'agents have their own report on the phone');
  const d = (await call('/api/desk', { token: dc1 })).body;
  assert.deepEqual(d.agents.map((a) => a.code).sort(), ['FO27', 'FO31']);
  const r = d.agents.find((a) => a.code === 'FO27').report;
  // Visits: the PTP visit, the second (field) visit to the difficult account, door locked, and the payment.
  assert.deepEqual([r.contacted, r.visits, r.calls, r.ptpObtained, r.collected, r.ptpDueTomorrow, r.noContact, r.difficult], [3, 4, 2, 1, 1500, 1, 2, 1]);
  assert.equal(d.totals.difficult, 1);
  assert.equal(d.totals.collectedToday, 1500);
  assert.equal(d.lists.difficult[0].id, loans[2].id);
  assert.equal(d.ages.reduce((s, a) => s + a.count, 0), d.totals.accounts);
  assert.ok(d.totals.recoveryPct > 0);

  const empty = (await call('/api/desk', { token: dc2 })).body;
  assert.equal(empty.agents.length, 0);
  assert.equal(empty.totals.accounts, 0);
  assert.equal((await call('/api/desk?under=FO27', { token: dc2 })).status, 404);

  const region = (await call('/api/desk', { token: sh })).body;
  assert.deepEqual(region.areas.map((a) => a.code), ['DC0001', 'DC0002']);
  assert.equal(region.areas[0].collectedToday, 1500);
  assert.equal((await call('/api/desk?under=DC0001', { token: sh })).body.scope.code, 'DC0001');

  const all = (await call('/api/admin/desk')).body;
  assert.deepEqual(all.regions.map((x) => x.code), ['SH01']);
  assert.equal((await call(`/api/admin/desk?date=${addDays(isoDate(), 1)}`)).status, 400);
  const xlsx = await fetch(`${base}/api/admin/desk.xlsx`, { headers: { Authorization: `Bearer ${admin}` } });
  assert.match(xlsx.headers.get('content-type'), /spreadsheetml/);
  // Yesterday: nothing was recorded then.
  const y = (await call(`/api/admin/desk?date=${addDays(isoDate(), -1)}`)).body;
  assert.equal(y.totals.day.contacted, 0);
});

test('targets and allocation stay within the coordinator’s own team', opts, async () => {
  assert.equal((await call('/api/desk/targets', { token: dc2, method: 'POST', body: { officerCodes: ['FO27'], dayAmount: 5000 } })).status, 400);
  assert.equal((await call('/api/desk/targets', { token: dc1, method: 'POST', body: { officerCodes: ['FO27'], dayAmount: -1 } })).status, 400);
  const ok = await call('/api/desk/targets', { token: dc1, method: 'POST', body: { officerCodes: ['FO27', 'FO31'], dayAmount: 5000, dayVisits: 10, monthAmount: 100000 } });
  assert.equal(ok.body.count, 2);
  const a = (await call('/api/desk', { token: dc1 })).body.agents.find((x) => x.code === 'FO27');
  assert.deepEqual([a.target.dayAmount, a.target.dayVisits, a.target.monthAmount, a.achievement.day], [5000, 10, 100000, 30]);
  assert.equal((await call('/api/bootstrap', { token: fo27 })).body.target.dayAmount, 5000);

  const id = loans[5].id;
  assert.equal((await call('/api/desk/assign', { token: dc2, method: 'POST', body: { loanIds: [id], officerCode: 'FO31' } })).status, 400);
  const moved = await call('/api/desk/assign', { token: dc1, method: 'POST', body: { loanIds: [id], officerCode: 'FO31' } });
  assert.equal(moved.body.changed, 1);
  assert.equal((await pool.query('SELECT officer_code FROM loans WHERE id = ?', [id]))[0].officer_code, 'FO31');
  await call('/api/desk/assign', { token: dc1, method: 'POST', body: { loanIds: [id], officerCode: 'FO27' } });
});

test('a difficult case goes to the agency head and is resolved, always with a note', opts, async () => {
  const id = loans[2].id;
  const path = `/api/desk/cases/${encodeURIComponent(id)}`;
  assert.equal((await call(path, { token: dc1, method: 'POST', body: { action: 'escalate', note: '' } })).status, 400);
  assert.equal((await call(path, { token: dc2, method: 'POST', body: { action: 'escalate', note: 'not mine' } })).status, 404);
  assert.equal((await call(path, { token: dc1, method: 'POST', body: { action: 'escalate', note: 'Needs the lender’s documents' } })).body.case.level, 2);
  assert.equal((await call(path, { token: dc1, method: 'POST', body: { action: 'escalate', note: 'again' } })).status, 409);
  const done = await call(`/api/admin/cases/${encodeURIComponent(id)}`, { method: 'POST', body: { action: 'resolve', note: 'Settled with the borrower' } });
  assert.equal(done.body.case, null);
  const events = (await call(`/api/admin/cases/${encodeURIComponent(id)}`)).body.events;
  assert.deepEqual(events.map((e) => [e.action, e.by]), [['raised', 'FO27'], ['escalated', 'DC0001'], ['resolved', 'ADMIN']]);
  assert.deepEqual((await call(`/api/admin/loans/${encodeURIComponent(id)}`)).body.meta.caseEvents.length, 3);
});

test('settings: own post names, accounts per agent (planning only) and the high-value mark', opts, async () => {
  assert.deepEqual((await call('/api/admin/settings')).body, { posts: { state_head: null, coordinator: null, agent: null }, accountsPerAgent: 25, highValue: 100000 });
  assert.equal((await call('/api/admin/settings', { method: 'PUT', body: { accountsPerAgent: 0, highValue: 1 } })).status, 400);
  const s = (await call('/api/admin/settings', { method: 'PUT', body: { posts: { state_head: 'Regional Coordinator', agent: 'Recovery Agent' }, accountsPerAgent: 30, highValue: 20000 } })).body;
  assert.deepEqual(s, { posts: { state_head: 'Regional Coordinator', coordinator: null, agent: 'Recovery Agent' }, accountsPerAgent: 30, highValue: 20000 });
  assert.equal((await call('/api/me')).body.settings.posts.agent, 'Recovery Agent');
  assert.equal((await call('/api/bootstrap', { token: dc1 })).body.settings.accountsPerAgent, 30);
  assert.equal((await call('/api/admin/areas/plan')).body.max, 30, 'the recruitment plan starts from the company’s figure');
  assert.ok((await call('/api/admin/desk')).body.totals.highValue >= 1);
});

test('the loans export carries the next action: last contact, PTP, follow-up, case', opts, async () => {
  const csv = (await call('/api/admin/loans/export')).body;
  const [head, ...rows] = csv.replace(/^﻿/, '').split('\r\n');
  for (const col of ['Last contact', 'Contact type', 'Last outcome', 'PTP date', 'PTP status', 'Last payment date', 'Next follow-up', 'Case']) assert.ok(head.includes(col), col);
  assert.ok(rows.some((r) => r.includes('Promise to pay') && r.includes('Open')));
  assert.ok(rows.some((r) => r.includes(',call,')));
});

test('the evening team report goes to coordinators with an email address and a team', opts, async () => {
  const { sendTeamReports } = await import('../server/emails.js');
  await call('/api/admin/users/DC0001', { method: 'PATCH', body: { email: 'asha@company.test', summaryEmail: 'daily' } });
  await call('/api/admin/users/DC0002', { method: 'PATCH', body: { email: 'gopal@company.test' } });
  const sent = [];
  const mailer = {
    settings: async () => ({ configured: true, summaries: true }),
    siteUrl: async () => 'https://loandesk.example.test',
    send: async (m) => (sent.push(m), { status: 'sent' }),
  };
  const day = (h, m) => new Date(`${isoDate()}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`);
  assert.equal(await sendTeamReports(pool, mailer, day(19, 0)), 0, 'not before 7:30 pm');
  assert.equal(await sendTeamReports(pool, mailer, day(19, 45)), 1, 'DC0002 has nobody to report on');
  assert.equal(sent[0].to, 'asha@company.test');
  assert.match(sent[0].subject, /collected by your team/);
  assert.ok(sent[0].message.table.rows.some((r) => r[0] === 'Priya Mishra'));
  assert.equal(sent[0].message.table.head[0], 'Recovery Agent', 'the company’s own name for the post');
});
