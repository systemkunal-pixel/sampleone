// API tests against a real MariaDB. Set TEST_DB_USER / TEST_DB_PASSWORD / TEST_DB_NAME (and optionally
// TEST_DB_HOST / TEST_DB_PORT) to run them; the test database is wiped first.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { isoDate, localTimestamp, loanStatus } from '../src/js/logic.js';

const env = process.env;
const enabled = Boolean(env.TEST_DB_USER && env.TEST_DB_NAME);
const opts = { skip: enabled ? false : 'set TEST_DB_USER and TEST_DB_NAME to run server tests' };

let pool, server, base;
const TODAY = isoDate();
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]).toString('base64');

async function api(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}

const login = async (code, pin) => (await api('/api/login', { method: 'POST', body: { code, pin } })).body.token;

let seq = 0;
const payment = (loanId, extra = {}) => ({
  type: 'payment',
  loanId,
  record: {
    id: `p-test-${++seq}`, at: localTimestamp(), amount: 100, mode: 'Cash', reference: '',
    receiptNo: `R-T-${seq}`, location: { lat: 26.85, lng: 80.95, accuracy: 10 }, ...extra,
  },
});
const deposit = (loanId, slipNo, extra = {}) => ({
  ...payment(loanId, { mode: 'Bank deposit', amount: 500, deposit: { slipNo, bank: 'SBI Chinhat', depositDate: TODAY }, ...extra }),
  slip: { mimeType: 'image/jpeg', base64: JPEG },
});
const send = (token, ...records) => api('/api/records', { token, method: 'POST', body: { records } });

let fo27, fo31, sup;
let myLoan, otherLoan;

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
  [fo27, fo31, sup] = [await login('FO27', '1234'), await login('fo31', '1234'), await login('SUP1', '9999')];
  const mine = (await api('/api/bootstrap', { token: fo27 })).body.loans;
  myLoan = mine.find((l) => loanStatus(l).overdue >= 1000).id;
  otherLoan = (await api('/api/bootstrap', { token: fo31 })).body.loans[0].id;
});

after(async () => {
  server?.close();
  await pool?.end();
});

test('login: wrong PIN rejected, then throttled', opts, async () => {
  assert.equal((await api('/api/login', { method: 'POST', body: { code: 'FO31', pin: '0000' } })).status, 401);
  for (let i = 0; i < 4; i++) await api('/api/login', { method: 'POST', body: { code: 'FO31', pin: '0000' } });
  const locked = await api('/api/login', { method: 'POST', body: { code: 'FO31', pin: '1234' } });
  assert.equal(locked.status, 429);
  assert.equal((await api('/api/bootstrap')).status, 401);
});

test('bootstrap is scoped: officers see their accounts, supervisors their branch', opts, async () => {
  const a = (await api('/api/bootstrap', { token: fo27 })).body;
  const s = (await api('/api/bootstrap', { token: sup })).body;
  assert.equal(a.user.role, 'officer');
  assert.ok(a.loans.length > 0 && a.loans.every((l) => l.officerCode === 'FO27'));
  assert.equal(s.loans.length, 12);
  assert.ok(a.loans[0].payments.every((p) => /^\d{4}-\d{2}-\d{2}T/.test(p.at)), 'timestamps use T separator');
});

test('payments are idempotent and checked against the balance', opts, async () => {
  const item = payment(myLoan);
  assert.equal((await send(fo27, item)).body.results[0].status, 'accepted');
  assert.equal((await send(fo27, item)).body.results[0].status, 'duplicate');
  const big = (await send(fo27, payment(myLoan, { amount: 99999999 }))).body.results[0];
  assert.equal(big.status, 'rejected');
  assert.match(big.error, /exceeds/);
  const upi = (await send(fo27, payment(myLoan, { mode: 'UPI' }))).body.results[0];
  assert.match(upi.error, /reference/);
  const notMine = (await send(fo27, payment(otherLoan))).body.results[0];
  assert.match(notMine.error, /not assigned/);
  assert.equal((await send(sup, payment(myLoan))).status, 403, 'supervisors cannot record collections');
});

test('bank deposits need a genuine slip and unique slip number', opts, async () => {
  const noSlip = { ...deposit(myLoan, 'NS-1'), slip: undefined };
  assert.match((await send(fo27, noSlip)).body.results[0].error, /slip image is missing/);
  const fake = { ...deposit(myLoan, 'FK-1'), slip: { mimeType: 'image/jpeg', base64: Buffer.from('<script>').toString('base64') } };
  assert.match((await send(fo27, fake)).body.results[0].error, /corrupt/);
  assert.equal((await send(fo27, deposit(myLoan, 'JRN-900'))).body.results[0].status, 'accepted');
  const dup = (await send(fo31, deposit(otherLoan, 'jrn900'))).body.results[0];
  assert.equal(dup.status, 'rejected');
  assert.match(dup.error, /already recorded on MFL/);
});

test('supervisor verification flow', opts, async () => {
  assert.equal((await api('/api/deposits', { token: fo27 })).status, 403);
  const item = deposit(myLoan, 'JRN-777');
  await send(fo27, item);
  const id = item.record.id;

  const queue = (await api('/api/deposits?status=pending', { token: sup })).body.deposits;
  const d = queue.find((x) => x.id === id);
  assert.equal(d.deposit.verification, 'pending');
  assert.equal(d.officerName, 'Priya Mishra');

  const slip = await api(`/api/slips/${id}`, { token: sup });
  assert.equal(slip.status, 200);
  assert.equal(slip.headers.get('content-type'), 'image/jpeg');
  assert.equal(slip.body.toString('base64'), JPEG);
  assert.equal((await api(`/api/slips/${id}`, { token: fo31 })).status, 404, 'other officers cannot see the slip');

  const before = (await api('/api/bootstrap', { token: fo27 })).body.loans.find((l) => l.id === myLoan);
  const noReason = await api(`/api/deposits/${id}/decision`, { token: sup, method: 'POST', body: { decision: 'rejected' } });
  assert.equal(noReason.status, 400);
  const rej = await api(`/api/deposits/${id}/decision`, {
    token: sup, method: 'POST', body: { decision: 'rejected', note: 'Amount on slip is ₹50 not ₹500' },
  });
  assert.equal(rej.status, 200);
  assert.equal(rej.body.payment.deposit.verification, 'rejected');
  const again = await api(`/api/deposits/${id}/decision`, { token: sup, method: 'POST', body: { decision: 'verified' } });
  assert.equal(again.status, 409);

  // The officer sees the rejection and the dues go back up.
  const after = (await api('/api/bootstrap', { token: fo27 })).body.loans.find((l) => l.id === myLoan);
  const p = after.payments.find((x) => x.id === id);
  assert.equal(p.deposit.note, 'Amount on slip is ₹50 not ₹500');
  assert.equal(loanStatus(after).outstanding, loanStatus(before).outstanding + 500);

  // A rejected slip number can be entered again (corrected), then verified.
  const fixed = deposit(myLoan, 'JRN-777', { amount: 50 });
  assert.equal((await send(fo27, fixed)).body.results[0].status, 'accepted');
  const ok = await api(`/api/deposits/${fixed.record.id}/decision`, { token: sup, method: 'POST', body: { decision: 'verified' } });
  assert.equal(ok.body.payment.deposit.verification, 'verified');
  assert.equal(ok.body.payment.deposit.verifiedBy, 'SUP1');
  const verified = (await api('/api/deposits?status=verified', { token: sup })).body.deposits;
  assert.ok(verified.some((x) => x.id === fixed.record.id));

  const [log] = await pool.query("SELECT COUNT(*) AS n FROM audit_log WHERE entity_id = ? AND action = 'deposit_rejected'", [id]);
  assert.equal(log.n, 1);
});

test('visits store promises and set the follow-up date', opts, async () => {
  const v = {
    type: 'visit', loanId: myLoan,
    record: { id: `v-test-${++seq}`, at: localTimestamp(), outcome: 'PTP', notes: 'Will pay Friday', ptpDate: TODAY, ptpAmount: 1500 },
  };
  assert.equal((await send(fo27, v)).body.results[0].status, 'accepted');
  const loan = (await api('/api/bootstrap', { token: fo27 })).body.loans.find((l) => l.id === myLoan);
  assert.equal(loan.followUpDate, TODAY);
  assert.equal(loan.visits.at(-1).ptpAmount, 1500);
  const bad = { ...v, record: { ...v.record, id: `v-test-${++seq}`, outcome: 'HACK' } };
  assert.equal((await send(fo27, bad)).body.results[0].status, 'rejected');
});

test('static hosting sends security headers and blocks traversal', opts, async () => {
  const index = await api('/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal((await api('/..%2fpackage.json')).status, 403);
  assert.equal((await api('/%2e%2e/package.json')).status, 404); // normalised by the URL parser, stays inside src/
  assert.equal((await api('/api/nope')).status, 404);
});

test('the field app at /app/ reaches the API through its relative /app/api/ path', opts, async () => {
  const res = await api('/app/api/login', { method: 'POST', body: { code: 'FO27', pin: '1234' } });
  assert.equal(res.status, 200);
  assert.ok(res.body.token);
  assert.equal((await api('/app/api/bootstrap', { token: res.body.token })).status, 200);
});
