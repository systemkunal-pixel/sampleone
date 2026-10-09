import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { localTimestamp } from '../src/js/logic.js';

const scrypt = promisify(scryptCb);
const KEYLEN = 32;

export async function hashPin(pin) {
  const salt = randomBytes(16);
  const hash = await scrypt(String(pin), salt, KEYLEN);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPin(pin, stored) {
  const [scheme, saltB64, hashB64] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(String(pin), Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

/** Field staff use a 4–8 digit PIN; admins need a password of 10+ characters with letters and digits. */
export function validPin(pin, role = 'officer') {
  const s = String(pin || '');
  if (role === 'admin') return s.length >= 10 && s.length <= 72 && /[A-Za-z]/.test(s) && /\d/.test(s);
  return /^\d{4,8}$/.test(s);
}

/** Overlord passwords guard every company's data: 12+ characters with letters and digits. */
export const validOverlordPassword = (p) => {
  const s = String(p || '');
  return s.length >= 12 && s.length <= 72 && /[A-Za-z]/.test(s) && /\d/.test(s);
};
export const OVERLORD_PASSWORD_RULE = 'Overlord password must be 12+ characters with letters and numbers.';

export const pinRule = (role) =>
  role === 'admin' ? 'Password must be 10+ characters with letters and numbers.' : 'PIN must be 4–8 digits.';

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export const sqlTime = (d) => localTimestamp(d).replace('T', ' ');

/** Normal sign-in session for a user row, valid for `days`. */
export async function createSession(conn, userId, days) {
  const token = randomBytes(32).toString('base64url');
  const created = new Date();
  await conn.query('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', [
    sha256(token), userId, sqlTime(created), sqlTime(new Date(created.getTime() + days * 864e5)),
  ]);
  return token;
}

/** Support session: a virtual admin of the company, tied to an overlord's support_sessions row. */
export async function createSupportSession(conn, companyId, supportId, expiresAt) {
  const token = randomBytes(32).toString('base64url');
  await conn.query(
    'INSERT INTO sessions (token_hash, user_id, company_id, support_id, created_at, expires_at) VALUES (?, NULL, ?, ?, ?, ?)',
    [sha256(token), companyId, supportId, sqlTime(new Date()), expiresAt]);
  return token;
}

export const SUPPORT_CODE = 'SUPPORT';

/**
 * The signed-in user for a bearer token, or null. Every user carries companyId and company; a
 * support session also carries support { id, overlordName, secondsLeft }. A locked or archived
 * company ends its users' sessions at once (support may still enter a locked company).
 */
export async function userForToken(conn, token) {
  if (!token) return null;
  const [r] = await conn.query(
    `SELECT s.support_id, u.id, u.code, u.name, u.role, u.branch, u.active,
            c.id AS company_id, c.code AS company_code, c.name AS company_name, c.status AS company_status,
            ss.ended_at, ss.expires_at AS support_expires, o.name AS overlord_name, o.active AS overlord_active
     FROM sessions s
     LEFT JOIN users u ON u.id = s.user_id
     JOIN companies c ON c.id = COALESCE(u.company_id, s.company_id)
     LEFT JOIN support_sessions ss ON ss.id = s.support_id
     LEFT JOIN overlords o ON o.id = ss.overlord_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
    [sha256(token), sqlTime(new Date())]
  );
  if (!r) return null;
  const company = { id: r.company_id, code: r.company_code, name: r.company_name, status: r.company_status };
  if (r.support_id) {
    if (r.ended_at || !r.overlord_active || company.status === 'archived') return null;
    return {
      id: null, code: SUPPORT_CODE, name: `${r.overlord_name} (LoanDesk support)`, role: 'admin', branch: 'Head Office',
      companyId: company.id, company,
      support: {
        id: r.support_id, overlordName: r.overlord_name,
        // Seconds rather than a clock time, so a browser in another time zone counts down correctly.
        secondsLeft: Math.max(0, Math.round((Date.parse(String(r.support_expires).replace(' ', 'T')) - Date.now()) / 1000)),
      },
    };
  }
  if (!r.active || company.status !== 'active') return null;
  return { id: r.id, code: r.code, name: r.name, role: r.role, branch: r.branch, companyId: company.id, company };
}

export function deleteSession(conn, token) {
  return conn.query('DELETE FROM sessions WHERE token_hash = ?', [sha256(token)]);
}

/** In-memory brute-force guard: 5 wrong PINs locks the officer code for 15 minutes. */
export class LoginThrottle {
  constructor({ maxFails = 5, lockMs = 15 * 60 * 1000 } = {}) {
    this.maxFails = maxFails;
    this.lockMs = lockMs;
    this.entries = new Map();
  }
  lockedFor(code) {
    const e = this.entries.get(code);
    if (!e?.until) return 0;
    const left = e.until - Date.now();
    if (left <= 0) {
      this.entries.delete(code);
      return 0;
    }
    return left;
  }
  fail(code) {
    const e = this.entries.get(code) || { fails: 0, until: 0 };
    e.fails += 1;
    if (e.fails >= this.maxFails) e.until = Date.now() + this.lockMs;
    this.entries.set(code, e);
  }
  succeed(code) {
    this.entries.delete(code);
  }
}
