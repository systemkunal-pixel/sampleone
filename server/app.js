// HTTP API + static hosting of the field app (/) and admin console (/admin/). One origin for everything.
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { isoDate, lastReceiptSeq } from '../src/js/logic.js';
import { createSession, userForToken, deleteSession, verifyPin, hashPin, validPin, pinRule, sha256, sqlTime, LoginThrottle } from './auth.js';
import { createMailer } from './mail.js';
import { resetEmail, RESET_MINUTES } from './emails.js';
import { companyEntitlements } from './plans.js';
import { mountOverlord, clientIp } from './overlord-api.js';
import { mountLeads } from './leads.js';
import { VERSION } from './version.js';
import { loadLoans, paymentFromRow, withTx, audit, now } from './db.js';
import { acceptRecord, MAX_SLIP_BYTES } from './records.js';
import { HttpError, send, readJson, Router } from './http.js';
import { mountAdmin } from './admin-api.js';

const STATIC_DIR = resolve(import.meta.dirname, '..', 'src');
const MAX_BODY = Math.ceil(MAX_SLIP_BYTES * 1.4) + 64 * 1024; // one record with a base64 slip
const ADMIN_SESSION_DAYS = 0.5; // admins re-authenticate every 12 hours
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; " +
  "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const RETIRED_SW = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) await caches.delete(k);
  await self.registration.unregister();
  for (const c of await self.clients.matchAll({ type: 'window' })) c.navigate(c.url);
})()));
`;

const publicUser = (u) => ({
  code: u.code, name: u.name, role: u.role, branch: u.branch,
  company: { code: u.company.code, name: u.company.name },
  ...(u.support ? { support: u.support } : {}),
});
const LOCKED = {
  locked: (name) => `Sign-in for ${name} is locked. Please contact LoanDesk support.`,
  archived: (name) => `${name}'s LoanDesk account is closed. Please contact LoanDesk support.`,
};

export function createApp({ pool, sessionDays = 30, staticDir = STATIC_DIR, mailer = createMailer(pool) }) {
  const throttle = new LoginThrottle();
  const resetThrottle = new LoginThrottle({ maxFails: 5, lockMs: 60 * 60 * 1000 });
  const router = new Router();
  const json = (req, max = MAX_BODY) => readJson(req, max);

  async function authed(req, role) {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    const user = await userForToken(pool, token);
    if (!user) throw new HttpError(401, 'Your session has expired. Please log in again.');
    if (role && user.role !== role) throw new HttpError(403, 'Not allowed for your role.');
    return { user, token };
  }

  router.add('GET', '/api/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true, version: VERSION, time: now() };
  });

  /**
   * Sign in with company code + user code + PIN. The company code may be left out when the user code
   * and PIN identify exactly one person; if the same code and PIN exist in two companies it is required.
   */
  router.add('POST', '/api/login', async (req) => {
    const { company, code, pin } = await json(req);
    const key = String(code || '').trim().toUpperCase();
    const companyCode = String(company || '').trim().toUpperCase();
    if (!key || !pin) throw new HttpError(400, 'Enter your code and PIN.');
    const throttleKey = `${companyCode || '*'}:${key}`;
    const wait = throttle.lockedFor(throttleKey);
    if (wait) throw new HttpError(429, `Too many wrong attempts. Try again in ${Math.ceil(wait / 60000)} minutes.`);
    const candidates = await pool.query(
      `SELECT u.*, c.code AS company_code, c.name AS company_name, c.status AS company_status
       FROM users u JOIN companies c ON c.id = u.company_id
       WHERE u.code = ? AND u.active = 1 ${companyCode ? 'AND c.code = ?' : ''}`,
      companyCode ? [key, companyCode] : [key]);
    const matches = [];
    for (const c of candidates) if (await verifyPin(pin, c.pin_hash)) matches.push(c);
    if (!matches.length) {
      throttle.fail(throttleKey);
      const companyId = new Set(candidates.map((c) => c.company_id)).size === 1 ? candidates[0].company_id : null;
      await audit(pool, { code: key, companyId }, 'login_failed', null, companyCode ? { company: companyCode } : null);
      throw new HttpError(401, companyCode ? 'Wrong company code, user code or PIN.' : 'Wrong code or PIN.');
    }
    if (matches.length > 1) throw new HttpError(400, 'Enter your company code as well — this code is used in more than one company.');
    const row = matches[0];
    throttle.succeed(throttleKey);
    if (row.company_status !== 'active') throw new HttpError(403, LOCKED[row.company_status](row.company_name));
    const user = {
      id: row.id, code: row.code, name: row.name, role: row.role, branch: row.branch, companyId: row.company_id,
      company: { id: row.company_id, code: row.company_code, name: row.company_name },
    };
    const token = await createSession(pool, user.id, user.role === 'admin' ? ADMIN_SESSION_DAYS : sessionDays);
    await pool.query('UPDATE users SET last_login_at = ? WHERE id = ?', [now(), user.id]);
    await audit(pool, user, 'login', null, null);
    return { token, user: publicUser(user) };
  });

  /** Who am I, and what may my company use. */
  router.add('GET', '/api/me', async (req) => {
    const { user } = await authed(req);
    const ent = await companyEntitlements(pool, user.companyId);
    return { user: publicUser(user), plan: ent.plan, features: ent.features, maxOfficers: ent.maxOfficers };
  });

  /** Ends a support session early (the Exit button on the support banner). */
  router.add('POST', '/api/support/end', async (req) => {
    const { user, token } = await authed(req);
    if (!user.support) throw new HttpError(400, 'Not a support session.');
    await pool.query('UPDATE support_sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL', [now(), user.support.id]);
    await deleteSession(pool, token);
    return { ok: true };
  });

  /**
   * "Forgot password?" on the admin sign-in page. Emails a one-time link to the admin's address on file.
   * The answer is the same whether or not the code exists, so it can't be used to find admin codes.
   */
  router.add('POST', '/api/password/forgot', async (req) => {
    const { code } = await json(req, 4096);
    const key = String(code || '').trim().toUpperCase();
    if (!key) throw new HttpError(400, 'Enter your admin code.');
    const ip = clientIp(req) || '?';
    for (const k of [`ip:${ip}`, `code:${key}`]) {
      if (resetThrottle.lockedFor(k)) throw new HttpError(429, 'Too many reset requests. Try again in an hour.');
    }
    resetThrottle.fail(`ip:${ip}`);
    resetThrottle.fail(`code:${key}`);
    const done = { ok: true, message: 'If this admin code has an email address on file, a reset link is on its way. It works for 30 minutes.' };
    const [u] = await pool.query(
      `SELECT u.id, u.code, u.name, u.email, u.company_id, c.name AS company_name FROM users u JOIN companies c ON c.id = u.company_id
       WHERE u.code = ? AND u.role = 'admin' AND u.active = 1 AND c.status = 'active'`, [key]);
    if (!u) return done;
    if (!u.email) {
      await audit(pool, { code: u.code, companyId: u.company_id }, 'password_reset_no_email', u.code, null);
      return done;
    }
    const site = await mailer.siteUrl();
    if (!site || !(await mailer.configured())) return done;
    const token = randomBytes(32).toString('base64url');
    await pool.query('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL', [u.id]);
    await pool.query('INSERT INTO password_resets (token_hash, user_id, created_at, expires_at, ip) VALUES (?, ?, ?, ?, ?)',
      [sha256(token), u.id, now(), sqlTime(new Date(Date.now() + RESET_MINUTES * 60000)), ip]);
    await audit(pool, { code: u.code, companyId: u.company_id }, 'password_reset_requested', u.code, { ip });
    mailer.queue(resetEmail(u, `${site}/admin/#reset=${token}`));
    return done;
  });

  /** Sets a new admin password with the link from the reset email. */
  router.add('POST', '/api/password/reset', async (req) => {
    const { token, password } = await json(req, 4096);
    if (!validPin(password, 'admin')) throw new HttpError(400, pinRule('admin'));
    return withTx(pool, async (conn) => {
      const [r] = await conn.query(
        `SELECT r.token_hash, u.id, u.code, u.company_id FROM password_resets r JOIN users u ON u.id = r.user_id
         WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > ? AND u.active = 1 AND u.role = 'admin' FOR UPDATE`,
        [sha256(String(token || '')), now()]);
      if (!r) throw new HttpError(400, 'This reset link has expired or was already used. Ask for a new one.');
      await conn.query('UPDATE password_resets SET used_at = ? WHERE token_hash = ?', [now(), r.token_hash]);
      await conn.query('UPDATE users SET pin_hash = ?, updated_at = ? WHERE id = ?', [await hashPin(password), now(), r.id]);
      await conn.query('DELETE FROM sessions WHERE user_id = ?', [r.id]);
      await audit(conn, { code: r.code, companyId: r.company_id }, 'password_reset_by_email', r.code, null);
      return { ok: true, code: r.code };
    });
  });

  router.add('POST', '/api/logout', async (req) => {
    const { token } = await authed(req);
    await deleteSession(pool, token);
    return { ok: true };
  });

  /** Everything the field app needs to render: the officer's (or branch's) loans with history. */
  router.add('GET', '/api/bootstrap', async (req) => {
    const { user } = await authed(req);
    if (user.role === 'admin') throw new HttpError(403, 'Admin accounts use the admin console at /admin/.');
    const loans = user.role === 'officer'
      ? await loadLoans(pool, { companyId: user.companyId, officerCode: user.code })
      : await loadLoans(pool, { companyId: user.companyId, branch: user.branch });
    const today = isoDate();
    const todays = await pool.query(
      'SELECT receipt_no FROM payments WHERE company_id = ? AND officer_code = ? AND recorded_at >= ?',
      [user.companyId, user.code, `${today} 00:00:00`]);
    const { features } = await companyEntitlements(pool, user.companyId);
    return {
      user: publicUser(user),
      features,
      loans,
      serverTime: now(),
      receiptSeq: { date: today, seq: lastReceiptSeq(todays.map((r) => r.receipt_no), user.code, today) },
    };
  });

  router.add('POST', '/api/records', async (req) => {
    const { user } = await authed(req, 'officer');
    const { records } = await json(req);
    if (!Array.isArray(records) || records.length > 50) throw new HttpError(400, 'Send 1–50 records.');
    const results = [];
    const { features } = await companyEntitlements(pool, user.companyId);
    for (const item of records) results.push(await acceptRecord(pool, user, item, features));
    return { results };
  });

  router.add('GET', '/api/slips/:id', async (req, res, { id }) => {
    const { user } = await authed(req);
    const [row] = await pool.query(
      `SELECT s.mime_type, s.data, l.officer_code, l.branch FROM deposit_slips s
       JOIN payments p ON p.id = s.payment_id JOIN loans l ON l.id = p.loan_id WHERE s.payment_id = ? AND l.company_id = ?`,
      [id, user.companyId]);
    const allowed = row && (
      user.role === 'admin' ||
      (user.role === 'supervisor' ? row.branch === user.branch : row.officer_code === user.code));
    if (!allowed) throw new HttpError(404, 'Slip not found.');
    send(res, 200, row.data, {
      'Content-Type': row.mime_type,
      'Content-Disposition': `inline; filename="slip-${id}${row.mime_type === 'application/pdf' ? '.pdf' : ''}"`,
      'Cache-Control': 'private, max-age=86400',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    });
  });

  /** Supervisor queue of bank deposits in their branch. */
  router.add('GET', '/api/deposits', async (req, res, params, query) => {
    const { user } = await authed(req, 'supervisor');
    const status = query.get('status') || 'pending';
    if (!['pending', 'verified', 'rejected'].includes(status)) throw new HttpError(400, 'Unknown status.');
    const rows = await pool.query(
      `SELECT p.*, l.loan_no, l.borrower, l.emi, u.name AS officer_name FROM payments p
       JOIN loans l ON l.id = p.loan_id LEFT JOIN users u ON u.company_id = p.company_id AND u.code = p.officer_code
       WHERE l.company_id = ? AND l.branch = ? AND p.verification = ?
       ORDER BY ${status === 'pending' ? 'p.recorded_at ASC' : 'p.verified_at DESC'} LIMIT 200`,
      [user.companyId, user.branch, status]);
    return {
      deposits: rows.map((r) => ({
        ...paymentFromRow(r),
        loanId: r.loan_id,
        loanNo: r.loan_no,
        emi: r.emi,
        borrower: JSON.parse(r.borrower).name,
        officerName: r.officer_name || r.officer_code,
      })),
    };
  });

  router.add('POST', '/api/deposits/:id/decision', async (req, res, { id }) => {
    const { user } = await authed(req, 'supervisor');
    const { decision, note } = await json(req);
    if (!['verified', 'rejected'].includes(decision)) throw new HttpError(400, 'Decision must be verified or rejected.');
    const reason = String(note || '').trim().slice(0, 300);
    if (decision === 'rejected' && !reason) throw new HttpError(400, 'Give a reason for rejecting the deposit.');
    return withTx(pool, async (conn) => {
      const [p] = await conn.query(
        `SELECT p.verification, p.verified_by, l.branch FROM payments p JOIN loans l ON l.id = p.loan_id
         WHERE p.id = ? AND l.company_id = ? AND p.slip_no IS NOT NULL FOR UPDATE`, [id, user.companyId]);
      if (!p || p.branch !== user.branch) throw new HttpError(404, 'Deposit not found.');
      if (p.verification !== 'pending') {
        throw new HttpError(409, `Already ${p.verification} by ${p.verified_by}.`);
      }
      // Clearing slip_key on rejection frees the slip number to be entered again correctly.
      await conn.query(
        `UPDATE payments SET verification = ?, verified_by = ?, verified_at = ?, verification_note = ?,
           slip_key = IF(? = 'rejected', NULL, slip_key) WHERE id = ?`,
        [decision, user.code, now(), reason || null, decision, id]);
      await audit(conn, user, `deposit_${decision}`, id, reason ? { note: reason } : null);
      const [row] = await conn.query('SELECT * FROM payments WHERE id = ?', [id]);
      return { payment: paymentFromRow(row) };
    });
  });

  mountAdmin(router, { pool, authed: (req) => authed(req, 'admin'), readJson: json });
  const leads = mountLeads(router, { pool, readJson: json, clientIp, mailer });
  mountOverlord(router, { pool, readJson: json, leads, mailer });

  async function serveStatic(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/admin' || path === '/overlord' || path === '/app') {
      res.writeHead(301, { Location: `${path}/` }).end();
      return;
    }
    if (path === '/sw.js') {
      // The field app used to live at / with its service worker there; it moved to /app/.
      // This replacement removes the old worker from phones so / shows the home page.
      send(res, 200, Buffer.from(RETIRED_SW), { 'Content-Type': TYPES['.js'], 'Cache-Control': 'no-cache' });
      return;
    }
    // The field app is served at /app/ from the same files (src/), so its relative links keep working.
    if (path.startsWith('/app/')) {
      const rest = path.slice(4);
      if (/^\/(admin|overlord)(\/|$)/.test(rest)) {
        res.writeHead(301, { Location: rest }).end();
        return;
      }
      path = rest === '/' ? '/index.html' : rest;
    } else if (path === '/') {
      path = '/home/index.html';
    }
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(staticDir, path));
    if (!file.startsWith(staticDir + sep)) throw new HttpError(403, 'Forbidden.');
    let body;
    try {
      body = await readFile(file);
    } catch {
      throw new HttpError(404, 'Not found.');
    }
    send(res, 200, body, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ...(extname(file) === '.html' ? { 'Content-Security-Policy': CSP } : {}),
    });
  }

  return async function handle(req, res) {
    try {
      const url = new URL(req.url, 'http://x');
      // The field app (served at /app/) calls the API relatively, as /app/api/….
      if (url.pathname.startsWith('/app/api/')) url.pathname = url.pathname.slice(4);
      if (!url.pathname.startsWith('/api/')) return await serveStatic(req, res);
      const found = router.match(req.method, url.pathname);
      if (!found) throw new HttpError(404, 'Not found.');
      if (found.methodNotAllowed) throw new HttpError(405, 'Method not allowed.');
      const result = await found.handler(req, res, found.params, url.searchParams);
      if (!res.headersSent) send(res, 200, result);
    } catch (err) {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      console.error(err);
      send(res, 500, { error: 'Server error. Please try again.' });
    }
  };
}
