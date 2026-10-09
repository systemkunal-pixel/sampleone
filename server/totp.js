// RFC 6238 time-based one-time codes (Google Authenticator, Microsoft Authenticator, Authy …).
import { createHmac, randomBytes } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP = 30;

export function newSecret() {
  const bytes = randomBytes(20);
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  return bits.match(/.{5}/g).map((c) => ALPHABET[parseInt(c, 2)]).join('');
}

function decode(secret) {
  const bits = [...secret.replace(/[\s=]/g, '').toUpperCase()]
    .map((ch) => {
      const v = ALPHABET.indexOf(ch);
      if (v < 0) throw new Error('Invalid base32 secret.');
      return v.toString(2).padStart(5, '0');
    })
    .join('');
  return Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
}

export function codeAt(secret, timeMs = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(timeMs / 1000 / STEP)));
  const h = createHmac('sha1', decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}

/**
 * Accepts the current code and one step either side, for phone clocks that drift. Returns the matched
 * time step (store it and pass it back as `after` so a code can't be used twice), or 0 if wrong.
 */
export function verifyCode(secret, code, { timeMs = Date.now(), after = 0 } = {}) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return 0;
  const now = Math.floor(timeMs / 1000 / STEP);
  for (const step of [now - 1, now, now + 1]) {
    if (step > after && codeAt(secret, step * STEP * 1000) === c) return step;
  }
  return 0;
}

export const otpauthUrl = (secret, account, issuer = 'LoanDesk Overlord') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP}`;
