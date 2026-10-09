// Overlord console API (/api/overlord/*): the platform operator's view across every company.
// Sign-in is email + password + a code from an authenticator app (mandatory, enrolled at first sign-in).
// Everything done here is written to overlord_audit; work inside a company happens only through a
// time-boxed, logged support session.
import { randomBytes } from 'node:crypto';
import { loanStatus, isoDate, addDays } from '../src/js/logic.js';
import {
  hashPin, verifyPin, validPin, pinRule, sha256, sqlTime, LoginThrottle, createSupportSession,
  validOverlordPassword, OVERLORD_PASSWORD_RULE, SUPPORT_CODE,
} from './auth.js';
import { withTx, now } from './db.js';
import { HttpError } from './http.js';
import { newSecret, verifyCode, otpauthUrl } from './totp.js';
import { PLANS, PLAN_CODES, FEATURES, FEATURE_KEYS, planMatrix, planLimits, companyEntitlements } from './plans.js';
import { addUser, seedDemo, addOverlord, DEMO_LOGINS } from './admin.js';
import { registerUpdateRoutes } from './updates-api.js';

const TICKET_MINUTES = 5; // between the password step and the authenticator code
const IDLE_MINUTES = 60; // overlord sessions slide on use…
const MAX_HOURS = 12; // …but never outlive this
const SUPPORT_MINUTES = 45;
const COMPANY_CODE = /^[A-Z0-9]{2,12}$/;
const USER_CODE = /^[A-Z0-9]{2,12}$/;

const str = (v) => String(v ?? '').trim();
const minutesFromNow = (m) => sqlTime(new Date(Date.now() + m * 60000));

function clientIp(req) {
  const remote = req.socket.remoteAddress || '';
  // Behind Caddy/nginx on the same machine, the real address is in X-Forwarded-For.
  const fwd = /^(::ffff:)?127\.|^::1$/.test(remote) ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  return (fwd || remote).replace(/^::ffff:/, '').slice(0, 45) || null;
}

function oaudit(conn, ctx, action, companyId, detail) {
  return conn.query(
    'INSERT INTO overlord_audit (at, overlord_id, overlord_email, action, company_id, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [now(), ctx.overlord?.id ?? null, ctx.overlord?.email ?? ctx.email ?? null, action, companyId ?? null,
      detail == null ? null : JSON.stringify(detail), ctx.ip ?? null]);
}

// Loaded on first use, so a missing package (npm ci not yet run after an update) only hides the QR
// code instead of stopping the whole server; the setup key still works.
async function qrSvg(text) {
  try {
    const { default: QRCode } = await import('qrcode-svg');
    return new QRCode({ content: text, padding: 2, width: 220, height: 220, ecl: 'M', join: true, xmlDeclaration: false }).svg();
  } catch (err) {
    console.error(`QR code unavailable (${err.code || err.message}); run npm ci.`);
    return null;
  }
}

// ---------- cross-company figures ----------

/** One row per company with scale, money and activity figures. */
async function companyFigures(pool, { includeArchived = false } = {}) {
  const companies = await pool.query(
    `SELECT * FROM companies ${includeArchived ? '' : "WHERE status <> 'archived'"} ORDER BY name`);
  if (!companies.length) return [];
  const ids = companies.map((c) => c.id);
  const today = isoDate();
  const since30 = `${addDays(today, -29)} 00:00:00`;
  const byCompany = new Map(ids.map((id) => [id, {
    officers: 0, supervisors: 0, admins: 0, loans: 0, activeLoans: 0, outstanding: 0, overdue: 0, par30: 0,
    collected30: 0, payments30: 0, deposits30: 0, pendingDeposits: 0, imports: 0, lastActivity: null,
  }]));
  const touch = (f, at) => {
    if (at && (!f.lastActivity || at > f.lastActivity)) f.lastActivity = at;
  };

  for (const u of await pool.query(
    'SELECT company_id, role, COUNT(*) AS n, MAX(last_login_at) AS last FROM users WHERE active = 1 AND company_id IN (?) GROUP BY company_id, role', [ids])) {
    const f = byCompany.get(u.company_id);
    f[`${u.role}s`] = u.n;
    touch(f, u.last);
  }
  const loans = await pool.query('SELECT id, company_id, installments FROM loans WHERE company_id IN (?)', [ids]);
  const pays = new Map();
  for (const p of await pool.query('SELECT loan_id, amount, verification FROM payments WHERE company_id IN (?)', [ids])) {
    if (!pays.has(p.loan_id)) pays.set(p.loan_id, []);
    pays.get(p.loan_id).push({ amount: p.amount, ...(p.verification ? { deposit: { verification: p.verification } } : {}) });
  }
  for (const l of loans) {
    const f = byCompany.get(l.company_id);
    const st = loanStatus({ installments: JSON.parse(l.installments), payments: pays.get(l.id) || [] }, today);
    f.loans += 1;
    if (st.closed) continue;
    f.activeLoans += 1;
    f.outstanding += st.outstanding;
    f.overdue += st.overdue;
    if (st.dpd > 30) f.par30 += st.outstanding;
  }
  for (const p of await pool.query(
    `SELECT company_id, SUM(IF(verification = 'rejected', 0, amount)) AS amount, COUNT(*) AS n, SUM(slip_no IS NOT NULL) AS deposits,
            MAX(received_at) AS last
     FROM payments WHERE company_id IN (?) AND recorded_at >= ? GROUP BY company_id`, [ids, since30])) {
    const f = byCompany.get(p.company_id);
    Object.assign(f, { collected30: Number(p.amount) || 0, payments30: p.n, deposits30: Number(p.deposits) || 0 });
  }
  for (const p of await pool.query(
    "SELECT company_id, COUNT(*) AS n FROM payments WHERE company_id IN (?) AND verification = 'pending' GROUP BY company_id", [ids])) {
    byCompany.get(p.company_id).pendingDeposits = p.n;
  }
  for (const r of await pool.query(
    `SELECT company_id, MAX(received_at) AS last FROM payments WHERE company_id IN (?) GROUP BY company_id
     UNION ALL SELECT l.company_id, MAX(v.received_at) FROM visits v JOIN loans l ON l.id = v.loan_id WHERE l.company_id IN (?) GROUP BY l.company_id`,
    [ids, ids])) {
    touch(byCompany.get(r.company_id), r.last);
  }
  for (const r of await pool.query('SELECT company_id, COUNT(*) AS n FROM imports WHERE company_id IN (?) GROUP BY company_id', [ids])) {
    byCompany.get(r.company_id).imports = r.n;
  }

  const nameCount = new Map();
  for (const c of companies) nameCount.set(c.name.toLowerCase(), (nameCount.get(c.name.toLowerCase()) || 0) + 1);
  return companies.map((c) => {
    const f = byCompany.get(c.id);
    const last = f.lastActivity ? String(f.lastActivity).replace(' ', 'T') : null;
    return {
      id: c.id, code: c.code, name: c.name, plan: c.plan, status: c.status, statusReason: c.status_reason,
      statusAt: c.status_at, statusBy: c.status_by, createdAt: c.created_at, maxOfficers: c.max_officers,
      contact: { name: c.contact_name, email: c.contact_email, phone: c.contact_phone },
      sameName: nameCount.get(c.name.toLowerCase()) > 1,
      ...f,
      par30Pct: f.outstanding ? (f.par30 / f.outstanding) * 100 : 0,
      lastActivity: last,
      idleDays: last ? Math.max(0, Math.round((Date.parse(`${today}T00:00:00`) - Date.parse(`${last.slice(0, 10)}T00:00:00`)) / 864e5)) : null,
    };
  });
}

// ---------- routes ----------

export function mountOverlord(router, { pool, readJson }) {
  const throttle = new LoginThrottle();

  async function authed(req) {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!token) throw new HttpError(401, 'Please sign in.');
    const [s] = await pool.query(
      `SELECT o.id, o.email, o.name, s.created_at FROM overlord_sessions s JOIN overlords o ON o.id = s.overlord_id
       WHERE s.token_hash = ? AND s.stage = 'full' AND s.expires_at > ? AND o.active = 1`, [sha256(token), now()]);
    if (!s) throw new HttpError(401, 'Your session has ended. Please sign in again.');
    const cap = new Date(Date.parse(String(s.created_at).replace(' ', 'T')) + MAX_HOURS * 36e5);
    const next = new Date(Math.min(Date.now() + IDLE_MINUTES * 60000, cap.getTime()));
    await pool.query('UPDATE overlord_sessions SET expires_at = ? WHERE token_hash = ?', [sqlTime(next), sha256(token)]);
    return { overlord: { id: s.id, email: s.email, name: s.name }, token, ip: clientIp(req) };
  }

  const R = (method, path, fn) => router.add(method, `/api/overlord${path}`, async (req, res, params, query) =>
    fn({ req, res, params, query, ctx: await authed(req) }));
  registerUpdateRoutes(R, { pool, readJson });
  const open = (method, path, fn) => router.add(method, `/api/overlord${path}`, (req, res, params, query) => fn({ req, res, params, query }));

  // ----- sign-in: password, then authenticator code -----

  open('POST', '/login', async ({ req }) => {
    const { email, password } = await readJson(req);
    const mail = str(email).toLowerCase();
    if (!mail || !password) throw new HttpError(400, 'Enter your email and password.');
    const wait = throttle.lockedFor(mail);
    if (wait) throw new HttpError(429, `Too many wrong attempts. Try again in ${Math.ceil(wait / 60000)} minutes.`);
    const [o] = await pool.query('SELECT * FROM overlords WHERE email = ? AND active = 1', [mail]);
    if (!o || !(await verifyPin(password, o.password_hash))) {
      throttle.fail(mail);
      await oaudit(pool, { email: mail, ip: clientIp(req) }, 'login_failed', null, null);
      throw new HttpError(401, 'Wrong email or password.');
    }
    throttle.succeed(mail);
    const ticket = randomBytes(32).toString('base64url');
    await pool.query('DELETE FROM overlord_sessions WHERE overlord_id = ? AND stage = ? AND expires_at < ?', [o.id, 'password', now()]);
    await pool.query(
      "INSERT INTO overlord_sessions (token_hash, overlord_id, stage, created_at, expires_at) VALUES (?, ?, 'password', ?, ?)",
      [sha256(ticket), o.id, now(), minutesFromNow(TICKET_MINUTES)]);
    if (o.totp_enabled) return { stage: 'code', ticket };
    // First sign-in (or after a reset): show the secret until a valid code proves the app is set up.
    let secret = o.totp_secret;
    if (!secret) {
      secret = newSecret();
      await pool.query('UPDATE overlords SET totp_secret = ? WHERE id = ?', [secret, o.id]);
    }
    const url = otpauthUrl(secret, o.email);
    return { stage: 'enroll', ticket, secret, otpauthUrl: url, qrSvg: await qrSvg(url) };
  });

  open('POST', '/login/verify', async ({ req }) => {
    const { ticket, code } = await readJson(req);
    const ip = clientIp(req);
    return withTx(pool, async (conn) => {
      const [t] = await conn.query(
        `SELECT s.token_hash, s.attempts, o.* FROM overlord_sessions s JOIN overlords o ON o.id = s.overlord_id
         WHERE s.token_hash = ? AND s.stage = 'password' AND s.expires_at > ? AND o.active = 1 FOR UPDATE`,
        [sha256(str(ticket)), now()]);
      if (!t) throw new HttpError(401, 'That took too long. Please sign in again.');
      const step = t.totp_secret ? verifyCode(t.totp_secret, code, { after: Number(t.totp_last_step) || 0 }) : 0;
      if (!step) {
        if (t.attempts + 1 >= 5) await conn.query('DELETE FROM overlord_sessions WHERE token_hash = ?', [t.token_hash]);
        else await conn.query('UPDATE overlord_sessions SET attempts = attempts + 1 WHERE token_hash = ?', [t.token_hash]);
        await oaudit(conn, { overlord: t, ip }, 'code_failed', null, null);
        throw new HttpError(t.attempts + 1 >= 5 ? 401 : 400,
          t.attempts + 1 >= 5 ? 'Too many wrong codes. Please sign in again.' : 'Wrong code. Check the 6-digit code in your authenticator app.');
      }
      await conn.query('DELETE FROM overlord_sessions WHERE token_hash = ?', [t.token_hash]);
      const token = randomBytes(32).toString('base64url');
      await conn.query(
        "INSERT INTO overlord_sessions (token_hash, overlord_id, stage, created_at, expires_at) VALUES (?, ?, 'full', ?, ?)",
        [sha256(token), t.id, now(), minutesFromNow(IDLE_MINUTES)]);
      await conn.query('UPDATE overlords SET totp_enabled = 1, totp_last_step = ?, last_login_at = ? WHERE id = ?', [step, now(), t.id]);
      if (!t.totp_enabled) await oaudit(conn, { overlord: t, ip }, 'authenticator_enrolled', null, null);
      await oaudit(conn, { overlord: t, ip }, 'login', null, null);
      return { token, overlord: { email: t.email, name: t.name } };
    });
  });

  R('POST', '/logout', async ({ ctx }) => {
    await pool.query('DELETE FROM overlord_sessions WHERE token_hash = ?', [sha256(ctx.token)]);
    return { ok: true };
  });

  R('GET', '/me', async ({ ctx }) => ({ overlord: ctx.overlord, idleMinutes: IDLE_MINUTES, supportMinutes: SUPPORT_MINUTES }));

  R('POST', '/me/password', async ({ req, ctx }) => {
    const { current, next } = await readJson(req);
    const [o] = await pool.query('SELECT password_hash FROM overlords WHERE id = ?', [ctx.overlord.id]);
    if (!(await verifyPin(String(current || ''), o.password_hash))) throw new HttpError(400, 'Current password is wrong.');
    if (!validOverlordPassword(next)) throw new HttpError(400, OVERLORD_PASSWORD_RULE);
    await pool.query('UPDATE overlords SET password_hash = ? WHERE id = ?', [await hashPin(next), ctx.overlord.id]);
    await pool.query('DELETE FROM overlord_sessions WHERE overlord_id = ? AND token_hash <> ?', [ctx.overlord.id, sha256(ctx.token)]);
    await oaudit(pool, ctx, 'password_changed', null, null);
    return { ok: true };
  });

  // ----- overview and companies -----

  R('GET', '/overview', async () => {
    const companies = await companyFigures(pool);
    const sum = (k) => companies.reduce((s, c) => s + c[k], 0);
    const outstanding = sum('outstanding');
    const [{ archived }] = await pool.query("SELECT COUNT(*) AS archived FROM companies WHERE status = 'archived'");
    return {
      totals: {
        companies: companies.length,
        active: companies.filter((c) => c.status === 'active').length,
        locked: companies.filter((c) => c.status === 'locked').length,
        archived,
        activeIn7: companies.filter((c) => c.idleDays != null && c.idleDays <= 7).length,
        officers: sum('officers'), activeLoans: sum('activeLoans'), outstanding,
        par30Pct: outstanding ? (sum('par30') / outstanding) * 100 : 0,
        collected30: sum('collected30'),
      },
      companies,
    };
  });

  R('GET', '/companies', async ({ query }) => ({ companies: await companyFigures(pool, { includeArchived: query.get('archived') === '1' }) }));

  async function companyRow(conn, id, lock = false) {
    const [c] = await conn.query(`SELECT * FROM companies WHERE id = ?${lock ? ' FOR UPDATE' : ''}`, [Number(id) || 0]);
    if (!c) throw new HttpError(404, 'Company not found.');
    return c;
  }

  R('GET', '/companies/:id', async ({ params }) => {
    const c = await companyRow(pool, params.id);
    const [figures] = (await companyFigures(pool, { includeArchived: true })).filter((f) => f.id === c.id);
    const admins = await pool.query(
      "SELECT code, name, branch, active, last_login_at AS lastLoginAt FROM users WHERE company_id = ? AND role = 'admin' ORDER BY active DESC, code", [c.id]);
    const ent = await companyEntitlements(pool, c.id);
    const support = await pool.query(
      `SELECT ss.id, ss.reason, ss.started_at AS startedAt, ss.ended_at AS endedAt, ss.expires_at AS expiresAt, o.name AS overlord
       FROM support_sessions ss JOIN overlords o ON o.id = ss.overlord_id WHERE ss.company_id = ? ORDER BY ss.id DESC LIMIT 10`, [c.id]);
    const history = await pool.query(
      'SELECT at, overlord_email AS who, action, detail FROM overlord_audit WHERE company_id = ? ORDER BY id DESC LIMIT 15', [c.id]);
    return {
      company: figures, admins, entitlements: ent, support,
      history: history.map((h) => ({ ...h, detail: h.detail ? JSON.parse(h.detail) : null })),
    };
  });

  function companyFields(b, partial = false) {
    const out = {};
    if (!partial || b.name !== undefined) {
      out.name = str(b.name);
      if (out.name.length < 2 || out.name.length > 150) throw new HttpError(400, 'Enter the company name.');
    }
    if (!partial || b.plan !== undefined) {
      out.plan = str(b.plan) || 'regular';
      if (!PLAN_CODES.includes(out.plan)) throw new HttpError(400, 'Choose a plan.');
    }
    if (b.maxOfficers !== undefined) {
      out.max_officers = b.maxOfficers === null || b.maxOfficers === '' ? null : Number(b.maxOfficers);
      if (out.max_officers !== null && (!Number.isInteger(out.max_officers) || out.max_officers < 0 || out.max_officers > 100000)) {
        throw new HttpError(400, 'Officer limit must be a whole number, or blank for the plan default.');
      }
    }
    for (const [k, col, max] of [['contactName', 'contact_name', 100], ['contactEmail', 'contact_email', 190], ['contactPhone', 'contact_phone', 20]]) {
      if (!partial || b[k] !== undefined) {
        out[col] = str(b[k]).slice(0, max) || null;
      }
    }
    if (out.contact_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(out.contact_email)) throw new HttpError(400, 'Contact email is not valid.');
    return out;
  }

  function adminFields(a = {}) {
    const code = str(a.code).toUpperCase();
    if (!USER_CODE.test(code)) throw new HttpError(400, 'Admin code must be 2–12 letters or digits.');
    if (code === SUPPORT_CODE) throw new HttpError(400, `${SUPPORT_CODE} is reserved for LoanDesk support.`);
    const name = str(a.name);
    if (name.length < 2) throw new HttpError(400, "Enter the admin's full name.");
    if (!validPin(a.password, 'admin')) throw new HttpError(400, pinRule('admin'));
    return { code, name, role: 'admin', branch: 'Head Office', pin: a.password };
  }

  R('POST', '/companies', async ({ req, ctx }) => {
    const b = await readJson(req);
    const code = str(b.code).toUpperCase();
    if (!COMPANY_CODE.test(code)) throw new HttpError(400, 'Company code must be 2–12 letters or digits (staff type it when signing in).');
    const fields = companyFields(b);
    const admin = adminFields(b.admin);
    return withTx(pool, async (conn) => {
      const [dup] = await conn.query('SELECT id FROM companies WHERE code = ?', [code]);
      if (dup) throw new HttpError(409, `Company code ${code} is already taken.`);
      const res = await conn.query(
        `INSERT INTO companies (code, name, plan, max_officers, contact_name, contact_email, contact_phone, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [code, fields.name, fields.plan, fields.max_officers ?? null, fields.contact_name, fields.contact_email, fields.contact_phone, now()]);
      await addUser(conn, { ...admin, companyId: res.insertId });
      await oaudit(conn, ctx, 'company_created', res.insertId, { code, name: fields.name, plan: fields.plan, admin: admin.code });
      return { id: res.insertId };
    });
  });

  R('PATCH', '/companies/:id', async ({ req, params, ctx }) => {
    const b = await readJson(req);
    const fields = companyFields(b, true);
    return withTx(pool, async (conn) => {
      const c = await companyRow(conn, params.id, true);
      const changes = Object.fromEntries(Object.entries(fields).filter(([k, v]) => String(v ?? '') !== String(c[k] ?? '')));
      if (!Object.keys(changes).length) return { ok: true };
      await conn.query(`UPDATE companies SET ${Object.keys(changes).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...Object.values(changes), c.id]);
      await oaudit(conn, ctx, 'company_updated', c.id, changes);
      return { ok: true };
    });
  });

  const TRANSITIONS = {
    lock: { from: ['active'], to: 'locked', reason: true, past: 'locked' },
    unlock: { from: ['locked'], to: 'active', reason: false, past: 'unlocked' },
    archive: { from: ['active', 'locked'], to: 'archived', reason: true, past: 'archived' },
    reopen: { from: ['archived'], to: 'active', reason: false, past: 'reopened' },
  };

  R('POST', '/companies/:id/status', async ({ req, params, ctx }) => {
    const { action, reason } = await readJson(req);
    const t = TRANSITIONS[action];
    if (!t) throw new HttpError(400, 'Unknown action.');
    const why = str(reason).slice(0, 300);
    if (t.reason && why.length < 3) throw new HttpError(400, 'Give a reason — it is kept on the company record.');
    return withTx(pool, async (conn) => {
      const c = await companyRow(conn, params.id, true);
      if (!t.from.includes(c.status)) throw new HttpError(409, `${c.name} is ${c.status}; it can't be ${t.past} now.`);
      await conn.query('UPDATE companies SET status = ?, status_reason = ?, status_at = ?, status_by = ? WHERE id = ?',
        [t.to, why || null, now(), ctx.overlord.email, c.id]);
      if (t.to !== 'active') {
        // Cut every live session at once (support sessions too, for an archive).
        await conn.query('DELETE s FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.company_id = ?', [c.id]);
        if (t.to === 'archived') {
          await conn.query('DELETE FROM sessions WHERE company_id = ? AND support_id IS NOT NULL', [c.id]);
          await conn.query('UPDATE support_sessions SET ended_at = ? WHERE company_id = ? AND ended_at IS NULL', [now(), c.id]);
        }
      }
      await oaudit(conn, ctx, `company_${t.past}`, c.id, why ? { reason: why } : null);
      return { ok: true, status: t.to };
    });
  });

  R('POST', '/companies/:id/admins', async ({ req, params, ctx }) => {
    const admin = adminFields(await readJson(req));
    return withTx(pool, async (conn) => {
      const c = await companyRow(conn, params.id);
      const [dup] = await conn.query('SELECT id FROM users WHERE company_id = ? AND code = ?', [c.id, admin.code]);
      if (dup) throw new HttpError(409, `${c.code} already has a user ${admin.code}.`);
      await addUser(conn, { ...admin, companyId: c.id });
      await oaudit(conn, ctx, 'admin_added', c.id, { code: admin.code, name: admin.name });
      return { ok: true };
    });
  });

  R('POST', '/companies/:id/admins/:code/password', async ({ req, params, ctx }) => {
    const { password } = await readJson(req);
    if (!validPin(password, 'admin')) throw new HttpError(400, pinRule('admin'));
    const c = await companyRow(pool, params.id);
    const [u] = await pool.query("SELECT id FROM users WHERE company_id = ? AND code = ? AND role = 'admin'", [c.id, params.code]);
    if (!u) throw new HttpError(404, 'Admin not found.');
    await pool.query('UPDATE users SET pin_hash = ?, active = 1, updated_at = ? WHERE id = ?', [await hashPin(password), now(), u.id]);
    await pool.query('DELETE FROM sessions WHERE user_id = ?', [u.id]);
    await oaudit(pool, ctx, 'admin_password_reset', c.id, { code: params.code });
    return { ok: true };
  });

  R('POST', '/companies/:id/demo', async ({ params, ctx }) => {
    const c = await companyRow(pool, params.id);
    try {
      await seedDemo(pool, c.id);
    } catch (err) {
      if (/already has/.test(err.message)) throw new HttpError(409, err.message);
      throw err;
    }
    await oaudit(pool, ctx, 'demo_loaded', c.id, null);
    return { ok: true, logins: DEMO_LOGINS };
  });

  // ----- support access -----

  R('POST', '/companies/:id/support', async ({ req, params, ctx }) => {
    const { reason, notifyOwner } = await readJson(req);
    const why = str(reason).slice(0, 300);
    if (why.length < 5) throw new HttpError(400, 'Say why you are entering this account (at least a few words). It is logged.');
    return withTx(pool, async (conn) => {
      const c = await companyRow(conn, params.id);
      if (c.status === 'archived') throw new HttpError(409, 'Reopen the company first to look inside.');
      const expires = minutesFromNow(SUPPORT_MINUTES);
      // Email isn't set up yet, so the company can't be notified; the request is recorded as not sent.
      const res = await conn.query(
        'INSERT INTO support_sessions (overlord_id, company_id, reason, started_at, expires_at, ip, owner_notified) VALUES (?, ?, ?, ?, ?, ?, 0)',
        [ctx.overlord.id, c.id, why, now(), expires, ctx.ip]);
      const token = await createSupportSession(conn, c.id, res.insertId, expires);
      await oaudit(conn, ctx, 'support_started', c.id, { reason: why, supportId: res.insertId, notifyRequested: Boolean(notifyOwner) });
      return { token, supportId: res.insertId, expiresAt: expires.replace(' ', 'T'), minutes: SUPPORT_MINUTES, notified: false };
    });
  });

  R('GET', '/support-sessions', async ({ query }) => {
    const page = Math.max(1, Number(query.get('page')) || 1);
    const [{ n }] = await pool.query('SELECT COUNT(*) AS n FROM support_sessions');
    const rows = await pool.query(
      `SELECT ss.id, ss.reason, ss.started_at AS startedAt, ss.expires_at AS expiresAt, ss.ended_at AS endedAt, ss.ip,
              ss.owner_notified AS ownerNotified, o.name AS overlord, o.email AS overlordEmail, c.id AS companyId, c.code AS companyCode,
              c.name AS companyName, (SELECT COUNT(*) FROM audit_log a WHERE a.support_id = ss.id) AS actions
       FROM support_sessions ss JOIN overlords o ON o.id = ss.overlord_id JOIN companies c ON c.id = ss.company_id
       ORDER BY ss.id DESC LIMIT 50 OFFSET ?`, [(page - 1) * 50]);
    const t = now();
    return {
      total: n, page, pages: Math.max(1, Math.ceil(n / 50)),
      rows: rows.map((r) => ({ ...r, live: !r.endedAt && r.expiresAt > t })),
    };
  });

  R('GET', '/support-sessions/:id/actions', async ({ params }) => {
    const rows = await pool.query(
      'SELECT at, action, entity_id AS entityId, detail FROM audit_log WHERE support_id = ? ORDER BY id', [Number(params.id) || 0]);
    return { rows: rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null })) };
  });

  R('POST', '/support-sessions/:id/end', async ({ params, ctx }) => {
    const id = Number(params.id) || 0;
    const [ss] = await pool.query('SELECT company_id, ended_at FROM support_sessions WHERE id = ?', [id]);
    if (!ss) throw new HttpError(404, 'Support session not found.');
    if (!ss.ended_at) {
      await pool.query('UPDATE support_sessions SET ended_at = ? WHERE id = ?', [now(), id]);
      await oaudit(pool, ctx, 'support_ended', ss.company_id, { supportId: id });
    }
    await pool.query('DELETE FROM sessions WHERE support_id = ?', [id]);
    return { ok: true };
  });

  // ----- plans -----

  R('GET', '/plans', async () => {
    const matrix = await planMatrix(pool);
    const limits = await planLimits(pool);
    const companies = await pool.query("SELECT id, code, name, plan, max_officers AS maxOfficers, status FROM companies WHERE status <> 'archived' ORDER BY name");
    const overrides = await pool.query('SELECT company_id, feature, enabled FROM company_feature_overrides');
    return {
      plans: PLANS.map((p) => ({ ...p, maxOfficers: limits[p.code]?.maxOfficers ?? null })),
      features: FEATURES.map(({ key, label, detail }) => ({ key, label, detail })),
      matrix,
      companies: companies.map((c) => ({
        ...c,
        overrides: Object.fromEntries(overrides.filter((o) => o.company_id === c.id && FEATURE_KEYS.includes(o.feature)).map((o) => [o.feature, Boolean(o.enabled)])),
      })),
    };
  });

  R('PUT', '/plans/:plan', async ({ req, params, ctx }) => {
    const plan = params.plan;
    if (!PLAN_CODES.includes(plan)) throw new HttpError(404, 'Unknown plan.');
    const { features = {}, maxOfficers } = await readJson(req);
    const limit = maxOfficers === null || maxOfficers === '' || maxOfficers === undefined ? null : Number(maxOfficers);
    if (limit !== null && (!Number.isInteger(limit) || limit < 0)) throw new HttpError(400, 'Officer limit must be a whole number, or blank for unlimited.');
    return withTx(pool, async (conn) => {
      const before = (await planMatrix(conn))[plan];
      const changes = {};
      for (const key of FEATURE_KEYS) {
        if (typeof features[key] !== 'boolean' || features[key] === before[key]) continue;
        changes[key] = features[key];
        await conn.query('REPLACE INTO plan_features (plan, feature, enabled) VALUES (?, ?, ?)', [plan, key, features[key]]);
      }
      const [{ max_officers: oldLimit }] = await conn.query('SELECT max_officers FROM plans WHERE code = ?', [plan]);
      if (maxOfficers !== undefined && limit !== oldLimit) {
        changes.maxOfficers = limit;
        await conn.query('UPDATE plans SET max_officers = ? WHERE code = ?', [limit, plan]);
      }
      if (Object.keys(changes).length) await oaudit(conn, ctx, 'plan_updated', null, { plan, ...changes });
      return { ok: true };
    });
  });

  R('PUT', '/companies/:id/overrides', async ({ req, params, ctx }) => {
    const { feature, enabled } = await readJson(req);
    if (!FEATURE_KEYS.includes(feature)) throw new HttpError(400, 'Unknown feature.');
    if (![true, false, null].includes(enabled)) throw new HttpError(400, 'enabled must be true, false or null (plan default).');
    const c = await companyRow(pool, params.id);
    if (enabled === null) await pool.query('DELETE FROM company_feature_overrides WHERE company_id = ? AND feature = ?', [c.id, feature]);
    else await pool.query('REPLACE INTO company_feature_overrides (company_id, feature, enabled) VALUES (?, ?, ?)', [c.id, feature, enabled]);
    await oaudit(pool, ctx, 'feature_override', c.id, { feature, enabled: enabled === null ? 'plan default' : enabled });
    return { ok: true };
  });

  // ----- overlord accounts -----

  R('GET', '/overlords', async () => ({
    overlords: await pool.query(
      'SELECT id, email, name, active, totp_enabled AS authenticator, created_at AS createdAt, last_login_at AS lastLoginAt FROM overlords ORDER BY active DESC, name'),
  }));

  R('POST', '/overlords', async ({ req, ctx }) => {
    const b = await readJson(req);
    try {
      const id = await addOverlord(pool, b);
      await oaudit(pool, ctx, 'overlord_added', null, { id, email: str(b.email).toLowerCase() });
      return { id };
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'An overlord with that email already exists.');
      if (err instanceof HttpError || err.sqlState) throw err;
      throw new HttpError(400, err.message);
    }
  });

  R('PATCH', '/overlords/:id', async ({ req, params, ctx }) => {
    const { active } = await readJson(req);
    const id = Number(params.id) || 0;
    if (typeof active !== 'boolean') throw new HttpError(400, 'Nothing to change.');
    if (id === ctx.overlord.id && !active) throw new HttpError(400, "You can't deactivate yourself.");
    return withTx(pool, async (conn) => {
      const [o] = await conn.query('SELECT email, active FROM overlords WHERE id = ? FOR UPDATE', [id]);
      if (!o) throw new HttpError(404, 'Overlord not found.');
      await conn.query('UPDATE overlords SET active = ? WHERE id = ?', [active, id]);
      if (!active) await conn.query('DELETE FROM overlord_sessions WHERE overlord_id = ?', [id]);
      await oaudit(conn, ctx, active ? 'overlord_activated' : 'overlord_deactivated', null, { email: o.email });
      return { ok: true };
    });
  });

  R('POST', '/overlords/:id/reset-authenticator', async ({ params, ctx }) => {
    const id = Number(params.id) || 0;
    if (id === ctx.overlord.id) throw new HttpError(400, 'Ask another overlord to reset your authenticator, or use the server command.');
    const [o] = await pool.query('SELECT email FROM overlords WHERE id = ?', [id]);
    if (!o) throw new HttpError(404, 'Overlord not found.');
    await pool.query('UPDATE overlords SET totp_secret = NULL, totp_enabled = 0, totp_last_step = NULL WHERE id = ?', [id]);
    await pool.query('DELETE FROM overlord_sessions WHERE overlord_id = ?', [id]);
    await oaudit(pool, ctx, 'authenticator_reset', null, { email: o.email });
    return { ok: true };
  });

  // ----- audit -----

  R('GET', '/audit', async ({ query }) => {
    const where = [];
    const args = [];
    if (query.get('action')) where.push('a.action = ?'), args.push(query.get('action'));
    if (query.get('company')) where.push('a.company_id = ?'), args.push(Number(query.get('company')) || 0);
    const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [{ n }] = await pool.query(`SELECT COUNT(*) AS n FROM overlord_audit a ${sql}`, args);
    const pages = Math.max(1, Math.ceil(n / 50));
    const page = Math.min(pages, Math.max(1, Number(query.get('page')) || 1));
    const rows = await pool.query(
      `SELECT a.id, a.at, a.overlord_email AS who, a.action, a.detail, a.ip, c.code AS companyCode, c.name AS companyName
       FROM overlord_audit a LEFT JOIN companies c ON c.id = a.company_id ${sql} ORDER BY a.id DESC LIMIT 50 OFFSET ?`,
      [...args, (page - 1) * 50]);
    const actions = (await pool.query('SELECT DISTINCT action FROM overlord_audit ORDER BY action')).map((r) => r.action);
    return { total: n, page, pages, actions, rows: rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null })) };
  });
}
