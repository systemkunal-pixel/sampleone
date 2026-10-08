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

export const pinRule = (role) =>
  role === 'admin' ? 'Password must be 10+ characters with letters and numbers.' : 'PIN must be 4–8 digits.';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export async function createSession(conn, userId, days) {
  const token = randomBytes(32).toString('base64url');
  const created = new Date();
  const expires = new Date(created.getTime() + days * 864e5);
  const fmt = (d) => localTimestamp(d).replace('T', ' ');
  await conn.query('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', [
    sha256(token), userId, fmt(created), fmt(expires),
  ]);
  return token;
}

export async function userForToken(conn, token) {
  if (!token) return null;
  const rows = await conn.query(
    `SELECT u.id, u.code, u.name, u.role, u.branch FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`,
    [sha256(token), localTimestamp().replace('T', ' ')]
  );
  return rows[0] || null;
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
