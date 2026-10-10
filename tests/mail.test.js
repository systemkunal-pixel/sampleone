// Email: SMTP settings, the outgoing log, password resets, alerts and summaries, against MariaDB
// (same TEST_DB_* variables as server.test.js; the database is wiped). No real email is sent: a fake
// transport records each message.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { isoDate, addDays, localTimestamp } from '../src/js/logic.js';
import { codeAt } from '../server/totp.js';

// A key for the SMTP password, so the test never writes secret.key into the app folder.
process.env.MAIL_SECRET_KEY = randomBytes(32).toString('base64');

const env = process.env;
const enabled = Boolean(env.TEST_DB_USER && env.TEST_DB_NAME);
const opts = { skip: enabled ? false : 'set TEST_DB_USER and TEST_DB_NAME to run email tests' };
const OVERLORD = { email: 'owner@datahaat.test', name: 'Platform Owner', password: 'Overlord-Pass-2026' };
const SITE = 'https://loandesk.example.test';

let pool, server, base, ov, mailer, emails;
const outbox = [];
let failNext = null;
let transportOptions = null;

async function call(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const O = (path, o = {}) => call(`/api/overlord${path}`, { token: ov, ...o });
const login = (code, pin) => call('/api/login', { method: 'POST', body: { code, pin } });
const settle = async (n = 1) => {
  for (let i = 0; i < 50 && outbox.length < n; i++) await new Promise((r) => setTimeout(r, 20));
};

before(async () => {
  if (!enabled) return;
  const { createPool, migrate } = await import('../server/db.js');
  const { createApp } = await import('../server/app.js');
  const { createMailer } = await import('../server/mail.js');
  const { seedDemo, addOverlord } = await import('../server/admin.js');
  emails = await import('../server/emails.js');
  pool = createPool({
    host: env.TEST_DB_HOST || '127.0.0.1', port: Number(env.TEST_DB_PORT) || 3306,
    user: env.TEST_DB_USER, password: env.TEST_DB_PASSWORD || '', database: env.TEST_DB_NAME, connectionLimit: 5,
  });
  for (const t of ['clients', 'area_agents', 'password_resets', 'mail_log', 'mail_settings', 'imports', 'audit_log', 'deposit_slips', 'visits', 'payments',
    'sessions', 'loans', 'users', 'companies', 'overlord_sessions', 'overlords', 'support_sessions', 'overlord_audit', 'plans',
    'plan_features', 'company_feature_overrides', 'platform_updates', 'platform_update_events', 'platform_state', 'leads']) {
    await pool.query(`DROP TABLE IF EXISTS ${t}`);
  }
  await migrate(pool);
  await seedDemo(pool, 1);
  await addOverlord(pool, OVERLORD);
  mailer = createMailer(pool, {
    transport: (o) => {
      transportOptions = o;
      return {
        async sendMail(m) {
          if (failNext) {
            const err = new Error(failNext);
            failNext = null;
            throw err;
          }
          outbox.push(m);
        },
      };
    },
  });
  server = createServer(createApp({ pool, mailer }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const first = (await call('/api/overlord/login', { method: 'POST', body: OVERLORD })).body;
  ov = (await call('/api/overlord/login/verify', { method: 'POST', body: { ticket: first.ticket, code: codeAt(first.secret) } })).body.token;
});

after(async () => {
  server?.close();
  await pool?.end();
});

test('before email is set up nothing is sent, and the settings page offers SMTP2GO defaults', opts, async () => {
  const r = await O('/mail');
  assert.equal(r.body.settings.configured, false);
  assert.deepEqual(r.body.settings.defaults, { host: 'mail.smtp2go.com', port: 2525, security: 'starttls' });
  assert.equal((await O('/me')).body.mailReady, false);
  assert.equal((await O('/mail/test', { method: 'POST', body: {} })).status, 400);
  const res = await mailer.send({ to: 'x@example.test', kind: 'test', subject: 'Hi', message: { title: 'Hi' } });
  assert.equal(res.status, 'skipped');
  assert.equal(outbox.length, 0);
});

test('overlord saves SMTP settings; the password is stored encrypted and never returned', opts, async () => {
  const bad = await O('/mail', { method: 'PUT', body: { host: 'mail.smtp2go.com', port: 2525, fromEmail: 'not-an-email' } });
  assert.equal(bad.status, 400);
  const body = {
    host: 'mail.smtp2go.com', port: 2525, security: 'starttls', username: 'loandesk', password: 'smtp-secret-1',
    fromName: 'LoanDesk', fromEmail: 'noreply@datahaat.test', siteUrl: `${SITE}/`, alertTo: '',
  };
  const r = await O('/mail', { method: 'PUT', body });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.settings.configured, true);
  assert.equal(r.body.settings.hasPassword, true);
  assert.equal(r.body.settings.siteUrl, SITE, 'trailing slash removed');
  assert.equal(JSON.stringify(r.body).includes('smtp-secret-1'), false);
  const [row] = await pool.query('SELECT password_enc FROM mail_settings');
  assert.match(row.password_enc, /^v1:/);
  assert.equal(row.password_enc.includes('smtp-secret-1'), false);

  // Saving again without a password keeps the old one.
  await O('/mail', { method: 'PUT', body: { ...body, password: undefined, fromName: 'LoanDesk Alerts' } });
  const test1 = await O('/mail/test', { method: 'POST', body: { to: 'me@datahaat.test' } });
  assert.equal(test1.status, 200, JSON.stringify(test1.body));
  assert.deepEqual(transportOptions.auth, { user: 'loandesk', pass: 'smtp-secret-1' });
  assert.equal(transportOptions.requireTLS, true);
  const m = outbox.pop();
  assert.equal(m.to, 'me@datahaat.test');
  assert.equal(m.from.name, 'LoanDesk Alerts');
  assert.match(m.html, /Email works/);

  // A failure is reported with the server's reason and logged.
  failNext = '535 Authentication failed';
  const fail = await O('/mail/test', { method: 'POST', body: { to: 'me@datahaat.test' } });
  assert.equal(fail.status, 502);
  assert.match(fail.body.error, /535 Authentication failed/);
  const log = (await O('/mail')).body.log;
  assert.deepEqual(log.slice(0, 2).map((l) => l.status), ['failed', 'sent']);
  assert.equal((await O('/me')).body.mailReady, true);
  const audit = await pool.query("SELECT action FROM overlord_audit WHERE action LIKE 'mail_%'");
  assert.ok(audit.some((a) => a.action === 'mail_settings_updated'));
});

test('a new demo request emails the alert list (every overlord when the list is blank)', opts, async () => {
  outbox.length = 0;
  const r = await call('/api/leads', { method: 'POST', body: { name: 'Asha Rao', company: 'Sahyog MFI', phone: '9876543210', officers: 40 } });
  assert.equal(r.status, 200);
  await settle();
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].to, OVERLORD.email);
  assert.match(outbox[0].subject, /Sahyog MFI/);
  assert.match(outbox[0].text, /9876543210/);
  assert.match(outbox[0].html, new RegExp(`${SITE}/overlord/#/leads`));
});

test('an admin resets a forgotten password with the emailed link, once', opts, async () => {
  // No email on file: same answer, nothing sent.
  outbox.length = 0;
  const none = await call('/api/password/forgot', { method: 'POST', body: { code: 'ADMIN' } });
  assert.equal(none.status, 200);
  assert.equal((await call('/api/password/forgot', { method: 'POST', body: { code: 'NOBODY' } })).body.message, none.body.message);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(outbox.length, 0);

  // The admin adds an email address (and the field roles can't have one).
  const admin = (await login('ADMIN', 'Demo@Admin2026')).body.token;
  const A = (path, o = {}) => call(`/api/admin${path}`, { token: admin, ...o });
  assert.equal((await A('/users/ADMIN', { method: 'PATCH', body: { email: 'not valid' } })).status, 400);
  assert.equal((await A('/users/ADMIN', { method: 'PATCH', body: { email: 'Admin@Company.test', summaryEmail: 'daily' } })).status, 200);
  assert.equal((await A('/users/FO27', { method: 'PATCH', body: { email: 'fo@company.test' } })).status, 200);
  const users = (await A('/users')).body.users;
  assert.equal(users.find((u) => u.code === 'ADMIN').email, 'admin@company.test');
  assert.equal(users.find((u) => u.code === 'FO27').email, null);

  const r = await call('/api/password/forgot', { method: 'POST', body: { code: 'admin' } });
  assert.equal(r.body.message, none.body.message);
  await settle();
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].to, 'admin@company.test');
  const link = /https:\/\/loandesk\.example\.test\/admin\/#reset=([\w-]+)/.exec(outbox[0].text);
  assert.ok(link, outbox[0].text);

  assert.equal((await call('/api/password/reset', { method: 'POST', body: { token: link[1], password: 'short' } })).status, 400);
  assert.equal((await call('/api/password/reset', { method: 'POST', body: { token: 'wrong', password: 'NewAdmin-2026x' } })).status, 400);
  const ok = await call('/api/password/reset', { method: 'POST', body: { token: link[1], password: 'NewAdmin-2026x' } });
  assert.equal(ok.status, 200);
  assert.equal((await call('/api/me', { token: admin })).status, 401, 'old sessions end');
  assert.equal((await login('ADMIN', 'Demo@Admin2026')).status, 401);
  assert.equal((await login('ADMIN', 'NewAdmin-2026x')).status, 200);
  assert.equal((await call('/api/password/reset', { method: 'POST', body: { token: link[1], password: 'Another-2026x' } })).status, 400, 'single use');
  const actions = (await pool.query("SELECT action FROM audit_log WHERE action LIKE 'password_reset%' ORDER BY id")).map((a) => a.action);
  assert.deepEqual(actions, ['password_reset_no_email', 'password_reset_requested', 'password_reset_by_email']);

  // Asking again and again is throttled.
  let last;
  for (let i = 0; i < 5; i++) last = await call('/api/password/forgot', { method: 'POST', body: { code: 'ADMIN' } });
  assert.equal(last.status, 429);
});

test('support access can email the company; other overlords are told', opts, async () => {
  const { addOverlord } = await import('../server/admin.js');
  await addOverlord(pool, { email: 'second@datahaat.test', name: 'Second Overlord', password: 'Overlord-Pass-2027' });
  await pool.query("UPDATE companies SET contact_email = 'owner@brmc.test' WHERE id = 1");
  outbox.length = 0;
  const r = await O('/companies/1/support', { method: 'POST', body: { reason: 'Customer call about imports', notifyOwner: true } });
  assert.equal(r.status, 200);
  assert.equal(r.body.notified, true);
  await settle(2);
  const owner = outbox.find((m) => /working in your account/.test(m.subject));
  assert.deepEqual(owner.bcc.sort(), ['admin@company.test', 'owner@brmc.test']);
  const alert = outbox.find((m) => /Support session/.test(m.subject));
  assert.equal(alert.to, 'second@datahaat.test', 'the overlord who entered is not emailed about themselves');
  const [ss] = await pool.query('SELECT owner_notified FROM support_sessions WHERE id = ?', [r.body.supportId]);
  assert.equal(ss.owner_notified, 1);
});

test('each finished update is reported once', opts, async () => {
  outbox.length = 0;
  await pool.query(
    `INSERT INTO platform_updates (from_version, to_version, file_name, sha256, size, staged_by, staged_at, status, finished_at, detail, mailed)
     VALUES ('1.2.3', '1.3.0', 'loandesk-1.3.0.ldpatch', REPEAT('a', 64), 1, 'owner@datahaat.test', NOW(), 'rolled_back', NOW(), 'Not healthy. Rolled back to 1.2.3.', 0),
            ('1.2.3', '1.3.1', 'loandesk-1.3.1.ldpatch', REPEAT('b', 64), 1, 'owner@datahaat.test', NOW(), 'staged', NULL, NULL, 0)`);
  await emails.sendUpdateResults(pool, mailer);
  await emails.sendUpdateResults(pool, mailer);
  assert.equal(outbox.length, 1);
  assert.match(outbox[0].subject, /1\.2\.3 → 1\.3\.0 rolled back/);
  assert.deepEqual(outbox[0].bcc.sort(), ['owner@datahaat.test', 'second@datahaat.test']);
});

test('summaries go to admins who want them, once a day (weekly ones on Monday)', opts, async () => {
  outbox.length = 0;
  // A payment yesterday, so there is something to report.
  const officer = (await login('FO27', '1234')).body.token;
  const [loan] = await pool.query("SELECT id FROM loans WHERE officer_code = 'FO27' LIMIT 1");
  const yesterday = new Date(Date.now() - 864e5);
  await call('/api/records', {
    token: officer, method: 'POST',
    body: { records: [{ type: 'payment', loanId: loan.id, record: { id: 'p-mail-1', at: localTimestamp(yesterday), amount: 1500, mode: 'Cash', reference: '', receiptNo: 'R-MAIL-1' } }] },
  });
  const early = new Date();
  early.setHours(7, 0, 0, 0);
  assert.equal(await emails.sendSummaries(pool, mailer, early), 0, 'not before 8 am');
  const at = new Date();
  at.setHours(9, 0, 0, 0);
  assert.equal(await emails.sendSummaries(pool, mailer, at), 1);
  assert.equal(await emails.sendSummaries(pool, mailer, at), 0, 'only once a day');
  assert.equal(outbox[0].to, 'admin@company.test');
  assert.match(outbox[0].subject, /daily summary/);
  assert.match(outbox[0].text, /Collected: ₹1,500 in 1 payment/);
  assert.match(outbox[0].text, new RegExp(addDays(isoDate(at), -1)));

  // Weekly admins only hear on Mondays, about the previous Monday–Sunday.
  await pool.query("UPDATE users SET summary_email = 'weekly' WHERE code = 'ADMIN'");
  const monday = new Date(at);
  monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7));
  const tuesday = new Date(monday.getTime() + 864e5);
  assert.equal(await emails.sendSummaries(pool, mailer, tuesday), 0);
  assert.equal(await emails.sendSummaries(pool, mailer, monday), 1);
  const [from, to] = emails.lastWeek(isoDate(monday));
  assert.equal(new Date(`${from}T00:00:00`).getDay(), 1);
  assert.equal(addDays(from, 6), to);
  assert.equal(to, addDays(isoDate(monday), -1));

  // A failed send is retried later (not every minute), at most three times.
  await pool.query("UPDATE users SET summary_email = 'daily' WHERE code = 'ADMIN'");
  const next = new Date(monday.getTime() + 2 * 864e5);
  failNext = 'connection refused';
  assert.equal(await emails.sendSummaries(pool, mailer, next), 0);
  // The log stores the real time; move the failure to the simulated day.
  await pool.query("UPDATE mail_log SET at = ? WHERE status = 'failed' AND dedupe_key LIKE 'summary:%'", [localTimestamp(next).replace('T', ' ')]);
  assert.equal(await emails.sendSummaries(pool, mailer, new Date(next.getTime() + 60000)), 0, 'not retried within the hour');
  assert.equal(await emails.sendSummaries(pool, mailer, new Date(next.getTime() + 61 * 60000)), 1, 'retried after an hour');

  // Turned off: nothing.
  await pool.query("UPDATE users SET summary_email = 'off' WHERE code = 'ADMIN'");
  assert.equal(await emails.sendSummaries(pool, mailer, new Date(next.getTime() + 864e5)), 0);
});

test('email HTML escapes what users typed', opts, async () => {
  const { render } = await import('../server/mail.js');
  const { html } = render({ title: '<script>x</script>', rows: [['Name', '"><img src=x onerror=alert(1)>']] });
  assert.equal(html.includes('<script>x'), false);
  assert.equal(html.includes('<img src=x'), false);
});
