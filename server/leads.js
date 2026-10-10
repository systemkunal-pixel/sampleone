// Demo requests from the home page. Public endpoint with a honeypot and a per-address limit;
// the overlord console lists and tracks them.
import { HttpError } from './http.js';
import { now } from './db.js';
import { leadAlert } from './emails.js';

const PER_HOUR = 5;
const STATUSES = ['new', 'contacted', 'demo_done', 'won', 'lost'];
const str = (v, max) => String(v ?? '').trim().slice(0, max);

export function mountLeads(router, { pool, readJson, clientIp, mailer }) {
  const recent = new Map(); // ip -> timestamps of the last hour

  router.add('POST', '/api/leads', async (req) => {
    const b = await readJson(req, 16 * 1024);
    const ip = clientIp(req);
    // Bots fill the hidden "website" field; tell them it worked and store nothing.
    if (str(b.website, 200)) return { ok: true };
    const hour = Date.now() - 36e5;
    const times = (recent.get(ip) || []).filter((t) => t > hour);
    if (times.length >= PER_HOUR) throw new HttpError(429, 'Too many requests from this network. Please try again later.');
    const name = str(b.name, 100);
    const company = str(b.company, 150);
    const phone = String(b.phone ?? '').replace(/[\s-]/g, '').replace(/^(\+91|0)/, '');
    const email = str(b.email, 190);
    if (name.length < 2 || company.length < 2) throw new HttpError(400, 'Please fill in your name, organisation and mobile number.');
    if (!/^[6-9]\d{9}$/.test(phone)) throw new HttpError(400, 'Enter a valid 10-digit mobile number.');
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address, or leave it empty.');
    const officers = Number.parseInt(b.officers, 10);
    times.push(Date.now());
    recent.set(ip, times);
    const lead = {
      name, company, phone, email: email || null, officers: Number.isFinite(officers) && officers >= 0 ? Math.min(officers, 1e6) : null,
      message: str(b.message, 1000) || null,
    };
    await pool.query(
      'INSERT INTO leads (at, name, company, phone, email, officers, message, lang, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [now(), name, company, phone, lead.email, lead.officers, lead.message, str(b.lang, 5) || null, ip]);
    if (mailer) await leadAlert(mailer, lead).catch((err) => console.error('Lead email:', err.message));
    return { ok: true };
  });

  return {
    /** Overlord routes, registered through the overlord router helper R. */
    register(R, oaudit) {
      R('GET', '/leads', async ({ query }) => {
        const status = query.get('status');
        const rows = await pool.query(
          `SELECT * FROM leads ${STATUSES.includes(status) ? 'WHERE status = ?' : ''} ORDER BY id DESC LIMIT 500`,
          STATUSES.includes(status) ? [status] : []);
        const counts = Object.fromEntries((await pool.query('SELECT status, COUNT(*) AS n FROM leads GROUP BY status')).map((r) => [r.status, r.n]));
        return { leads: rows, counts };
      });
      R('PATCH', '/leads/:id', async ({ req, params, ctx }) => {
        const b = await readJson(req);
        if (!STATUSES.includes(b.status)) throw new HttpError(400, 'Unknown status.');
        const r = await pool.query('UPDATE leads SET status = ?, note = ?, updated_by = ?, updated_at = ? WHERE id = ?',
          [b.status, str(b.note, 1000) || null, ctx.overlord.email, now(), Number(params.id) || 0]);
        if (!r.affectedRows) throw new HttpError(404, 'Request not found.');
        await oaudit(pool, ctx, 'lead_updated', null, { id: Number(params.id), status: b.status });
        return { ok: true };
      });
    },
  };
}
