// HTTP API + static hosting of the app. One process serves both, so the app and API share an origin.
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { isoDate, lastReceiptSeq } from '../src/js/logic.js';
import { createSession, userForToken, deleteSession, verifyPin, LoginThrottle } from './auth.js';
import { loadLoans, paymentFromRow, withTx, audit, now } from './db.js';
import { acceptRecord, MAX_SLIP_BYTES } from './records.js';

const STATIC_DIR = resolve(import.meta.dirname, '..', 'src');
const MAX_BODY = Math.ceil(MAX_SLIP_BYTES * 1.4) + 64 * 1024; // one record with a base64 slip
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; " +
  "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Cache-Control': 'no-store',
    ...(isBuf ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
    ...headers,
  });
  res.end(isBuf ? body : JSON.stringify(body));
}

async function readJson(req) {
  if (!/application\/json/.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Expected JSON.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
}

const publicUser = (u) => ({ code: u.code, name: u.name, role: u.role, branch: u.branch });

export function createApp({ pool, sessionDays = 30, staticDir = STATIC_DIR }) {
  const throttle = new LoginThrottle();

  async function authed(req, role) {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    const user = await userForToken(pool, token);
    if (!user) throw new HttpError(401, 'Your session has expired. Please log in again.');
    if (role && user.role !== role) throw new HttpError(403, 'Not allowed for your role.');
    return { user, token };
  }

  const routes = {
    'GET /api/health': async () => {
      await pool.query('SELECT 1');
      return { ok: true, time: now() };
    },

    'POST /api/login': async (req) => {
      const { code, pin } = await readJson(req);
      const key = String(code || '').trim().toUpperCase();
      if (!key || !pin) throw new HttpError(400, 'Enter your officer code and PIN.');
      const wait = throttle.lockedFor(key);
      if (wait) throw new HttpError(429, `Too many wrong PINs. Try again in ${Math.ceil(wait / 60000)} minutes.`);
      const [user] = await pool.query('SELECT * FROM users WHERE code = ? AND active = 1', [key]);
      if (!user || !(await verifyPin(pin, user.pin_hash))) {
        throttle.fail(key);
        await audit(pool, key, 'login_failed', null, null);
        throw new HttpError(401, 'Wrong officer code or PIN.');
      }
      throttle.succeed(key);
      const token = await createSession(pool, user.id, sessionDays);
      await audit(pool, user.code, 'login', null, null);
      return { token, user: publicUser(user) };
    },

    'POST /api/logout': async (req) => {
      const { token } = await authed(req);
      await deleteSession(pool, token);
      return { ok: true };
    },

    /** Everything the app needs to render: the user's (or branch's) loans with history. */
    'GET /api/bootstrap': async (req) => {
      const { user } = await authed(req);
      const loans = user.role === 'officer'
        ? await loadLoans(pool, { officerCode: user.code })
        : await loadLoans(pool, { branch: user.branch });
      const today = isoDate();
      const todays = await pool.query(
        'SELECT receipt_no FROM payments WHERE officer_code = ? AND recorded_at >= ?', [user.code, `${today} 00:00:00`]);
      return {
        user: publicUser(user),
        loans,
        serverTime: now(),
        receiptSeq: { date: today, seq: lastReceiptSeq(todays.map((r) => r.receipt_no), user.code, today) },
      };
    },

    'POST /api/records': async (req) => {
      const { user } = await authed(req, 'officer');
      const { records } = await readJson(req);
      if (!Array.isArray(records) || records.length > 50) throw new HttpError(400, 'Send 1–50 records.');
      const results = [];
      for (const item of records) results.push(await acceptRecord(pool, user, item));
      return { results };
    },

    'GET /api/slips/:id': async (req, res, id) => {
      const { user } = await authed(req);
      const [row] = await pool.query(
        `SELECT s.mime_type, s.data, l.officer_code, l.branch FROM deposit_slips s
         JOIN payments p ON p.id = s.payment_id JOIN loans l ON l.id = p.loan_id WHERE s.payment_id = ?`, [id]);
      const allowed = row && (user.role === 'supervisor' ? row.branch === user.branch : row.officer_code === user.code);
      if (!allowed) throw new HttpError(404, 'Slip not found.');
      send(res, 200, row.data, {
        'Content-Type': row.mime_type,
        'Content-Disposition': `inline; filename="slip-${id}${row.mime_type === 'application/pdf' ? '.pdf' : ''}"`,
        'Cache-Control': 'private, max-age=86400',
        'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      });
    },

    /** Supervisor queue of bank deposits in their branch. */
    'GET /api/deposits': async (req) => {
      const { user } = await authed(req, 'supervisor');
      const status = new URL(req.url, 'http://x').searchParams.get('status') || 'pending';
      if (!['pending', 'verified', 'rejected'].includes(status)) throw new HttpError(400, 'Unknown status.');
      const rows = await pool.query(
        `SELECT p.*, l.loan_no, l.borrower, l.emi, u.name AS officer_name FROM payments p
         JOIN loans l ON l.id = p.loan_id LEFT JOIN users u ON u.code = p.officer_code
         WHERE l.branch = ? AND p.verification = ?
         ORDER BY ${status === 'pending' ? 'p.recorded_at ASC' : 'p.verified_at DESC'} LIMIT 200`,
        [user.branch, status]);
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
    },

    'POST /api/deposits/:id/decision': async (req, res, id) => {
      const { user } = await authed(req, 'supervisor');
      const { decision, note } = await readJson(req);
      if (!['verified', 'rejected'].includes(decision)) throw new HttpError(400, 'Decision must be verified or rejected.');
      const reason = String(note || '').trim().slice(0, 300);
      if (decision === 'rejected' && !reason) throw new HttpError(400, 'Give a reason for rejecting the deposit.');
      return withTx(pool, async (conn) => {
        const [p] = await conn.query(
          `SELECT p.verification, p.verified_by, l.branch FROM payments p JOIN loans l ON l.id = p.loan_id
           WHERE p.id = ? AND p.slip_no IS NOT NULL FOR UPDATE`, [id]);
        if (!p || p.branch !== user.branch) throw new HttpError(404, 'Deposit not found.');
        if (p.verification !== 'pending') {
          throw new HttpError(409, `Already ${p.verification} by ${p.verified_by}.`);
        }
        // Clearing slip_key on rejection frees the slip number to be entered again correctly.
        await conn.query(
          `UPDATE payments SET verification = ?, verified_by = ?, verified_at = ?, verification_note = ?,
             slip_key = IF(? = 'rejected', NULL, slip_key) WHERE id = ?`,
          [decision, user.code, now(), reason || null, decision, id]);
        await audit(conn, user.code, `deposit_${decision}`, id, reason ? { note: reason } : null);
        const [row] = await conn.query('SELECT * FROM payments WHERE id = ?', [id]);
        return { payment: paymentFromRow(row) };
      });
    },
  };

  async function serveStatic(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = normalize(join(staticDir, path.endsWith('/') ? `${path}index.html` : path));
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
      const { pathname } = new URL(req.url, 'http://x');
      if (!pathname.startsWith('/api/')) return await serveStatic(req, res);
      const parts = pathname.split('/');
      // Match /api/x/:id and /api/x/:id/y patterns.
      let key = `${req.method} ${pathname}`;
      let param;
      if (!routes[key] && parts.length >= 4) {
        param = decodeURIComponent(parts[3]);
        key = `${req.method} ${['', ...parts.slice(1, 3), ':id', ...parts.slice(4)].join('/')}`;
      }
      const route = routes[key];
      if (!route) throw new HttpError(404, 'Not found.');
      const result = await route(req, res, param);
      if (!res.headersSent) send(res, 200, result);
    } catch (err) {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      console.error(err);
      send(res, 500, { error: 'Server error. Please try again.' });
    }
  };
}
