// Outgoing email: the SMTP settings an overlord enters (Overlord console → Email), the outgoing log,
// and the HTML layout every LoanDesk email shares.
//
// The SMTP password is stored encrypted (AES-256-GCM). The key is MAIL_SECRET_KEY from .env when set,
// otherwise a random key kept in secret.key next to the app, so a database backup alone never
// reveals it. Updates leave secret.key alone (it is not part of the app's code).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_ROOT } from './version.js';
import { now } from './db.js';

export const EMAIL = /^[^@\s<>"',;]+@[^@\s<>"',;]+\.[^@\s<>"',;]+$/;
export const SMTP2GO = { host: 'mail.smtp2go.com', port: 2525, security: 'starttls' };
const PASSWORD_MASK = '********';

// ---------- the key that protects the SMTP password ----------

let cachedKey = null;
function secretKey() {
  if (cachedKey) return cachedKey;
  const fromEnv = process.env.MAIL_SECRET_KEY;
  if (fromEnv) {
    const buf = Buffer.from(fromEnv, 'base64');
    if (buf.length !== 32) throw new Error('MAIL_SECRET_KEY must be 32 bytes, base64-encoded.');
    return (cachedKey = buf);
  }
  const file = join(APP_ROOT, 'secret.key');
  if (!existsSync(file)) writeFileSync(file, `${randomBytes(32).toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
  const buf = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
  if (buf.length !== 32) throw new Error(`${file} is damaged. Delete it and enter the SMTP password again.`);
  return (cachedKey = buf);
}

export function encrypt(text) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', secretKey(), iv);
  const body = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${body.toString('base64')}`;
}

export function decrypt(stored) {
  const [v, iv, tag, body] = String(stored || '').split(':');
  if (v !== 'v1' || !body) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8');
  } catch {
    return null; // a different key (secret.key replaced): the password must be entered again
  }
}

// ---------- settings ----------

const bool = (v) => Boolean(Number(v));

function fromRow(r = {}) {
  return {
    host: r.host || '', port: r.port || null, security: r.security || 'starttls', username: r.username || '',
    hasPassword: Boolean(r.password_enc), fromName: r.from_name || '', fromEmail: r.from_email || '',
    siteUrl: r.site_url || '', alertTo: r.alert_to || '',
    alertLeads: r.alert_leads == null ? true : bool(r.alert_leads),
    alertUpdates: r.alert_updates == null ? true : bool(r.alert_updates),
    alertSupport: r.alert_support == null ? true : bool(r.alert_support),
    summaries: r.summaries == null ? true : bool(r.summaries),
    updatedBy: r.updated_by || null, updatedAt: r.updated_at || null,
  };
}

/** Builds the HTML part of an email. Every value is escaped; `html` blocks are trusted markup built here. */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * A message is { title, intro, lines: [text], rows: [[label, value]], table: { head, rows }, button: { label, url }, foot }.
 * Returns { html, text } with the same content.
 */
export function render(m) {
  const text = [m.title, '', m.intro, ...(m.lines || [])];
  if (m.rows?.length) text.push('', ...m.rows.map(([k, v]) => `${k}: ${v}`));
  if (m.table?.rows?.length) text.push('', m.table.head.join(' | '), ...m.table.rows.map((r) => r.join(' | ')));
  if (m.button) text.push('', `${m.button.label}: ${m.button.url}`);
  if (m.foot) text.push('', m.foot);
  text.push('', '— LoanDesk');

  const cell = 'padding:6px 10px;border-bottom:1px solid #e6e9ef;font-size:14px';
  const html = `<!doctype html><html><body style="margin:0;background:#f3f5f9;font-family:Segoe UI,Arial,sans-serif;color:#1d2433">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f9;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e1e5ee">
<tr><td style="background:#0f5c4c;color:#ffffff;padding:16px 24px;font-size:18px;font-weight:700">LoanDesk</td></tr>
<tr><td style="padding:24px">
<h1 style="margin:0 0 12px;font-size:20px">${esc(m.title)}</h1>
${m.intro ? `<p style="margin:0 0 12px;font-size:15px;line-height:1.5">${esc(m.intro)}</p>` : ''}
${(m.lines || []).map((l) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.5">${esc(l)}</p>`).join('')}
${m.rows?.length ? `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:4px 0 16px;width:100%">
${m.rows.map(([k, v]) => `<tr><td style="${cell};color:#5b6474;width:42%">${esc(k)}</td><td style="${cell};font-weight:600">${esc(v)}</td></tr>`).join('')}</table>` : ''}
${m.table?.rows?.length ? `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:4px 0 16px;width:100%">
<tr>${m.table.head.map((h, i) => `<th style="${cell};text-align:${i ? 'right' : 'left'};color:#5b6474;font-weight:600">${esc(h)}</th>`).join('')}</tr>
${m.table.rows.map((r) => `<tr>${r.map((v, i) => `<td style="${cell};text-align:${i ? 'right' : 'left'}">${esc(v)}</td>`).join('')}</tr>`).join('')}</table>` : ''}
${m.button ? `<p style="margin:20px 0"><a href="${esc(m.button.url)}" style="display:inline-block;background:#0f5c4c;color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600">${esc(m.button.label)}</a></p>` : ''}
${m.foot ? `<p style="margin:16px 0 0;font-size:13px;color:#5b6474;line-height:1.5">${esc(m.foot)}</p>` : ''}
</td></tr></table>
<p style="font-size:12px;color:#8a92a3;margin:12px 0 0">Sent by LoanDesk. Please don't reply to this email.</p>
</td></tr></table></body></html>`;
  return { html, text: text.filter((l) => l != null).join('\n') };
}

export const money = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;

// ---------- the mailer ----------

/**
 * createMailer(pool, { transport }) → mailer. `transport(options)` returns an object with sendMail();
 * it defaults to nodemailer, which is loaded on first use so a missing package never stops the server.
 */
export function createMailer(pool, { transport } = {}) {
  async function makeTransport(opts) {
    if (transport) return transport(opts);
    const { default: nodemailer } = await import('nodemailer');
    return nodemailer.createTransport(opts);
  }

  async function row() {
    const [r] = await pool.query('SELECT * FROM mail_settings WHERE id = 1');
    return r;
  }

  const mailer = {
    PASSWORD_MASK,

    /** Settings for the overlord console (never the password itself). */
    async settings() {
      const s = fromRow(await row());
      return { ...s, configured: Boolean(s.host && s.port && s.fromEmail), defaults: SMTP2GO };
    },

    async configured() {
      return (await mailer.settings()).configured;
    },

    /** The public address of this site (for links in emails), or '' when not set. */
    async siteUrl() {
      return (await mailer.settings()).siteUrl.replace(/\/+$/, '');
    },

    async save(input, by) {
      const b = input || {};
      const str = (v, max) => String(v ?? '').trim().slice(0, max);
      const host = str(b.host, 190).toLowerCase();
      const port = Number(b.port);
      const security = ['starttls', 'ssl', 'none'].includes(b.security) ? b.security : 'starttls';
      const fromEmail = str(b.fromEmail, 190).toLowerCase();
      const siteUrl = str(b.siteUrl, 190).replace(/\/+$/, '');
      const alertTo = str(b.alertTo, 500).split(/[\s,;]+/).filter(Boolean);
      if (!/^[a-z0-9.-]+$/.test(host)) throw new Error('Enter the SMTP server name, e.g. mail.smtp2go.com.');
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Enter the SMTP port, e.g. 2525.');
      if (!EMAIL.test(fromEmail)) throw new Error('Enter the "from" email address.');
      if (siteUrl && !/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(siteUrl)) throw new Error('Site address must look like https://loandesk.example.com (no path).');
      const bad = alertTo.find((a) => !EMAIL.test(a));
      if (bad) throw new Error(`${bad} is not an email address.`);
      const current = await row();
      let passwordEnc = current?.password_enc ?? null;
      if (b.password !== undefined && b.password !== PASSWORD_MASK) passwordEnc = str(b.password, 300) ? encrypt(String(b.password)) : null;
      await pool.query(
        `REPLACE INTO mail_settings (id, host, port, security, username, password_enc, from_name, from_email, site_url, alert_to,
           alert_leads, alert_updates, alert_support, summaries, updated_by, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [host, port, security, str(b.username, 190) || null, passwordEnc, str(b.fromName, 100) || null, fromEmail, siteUrl || null,
          alertTo.join(', ') || null, b.alertLeads !== false, b.alertUpdates !== false, b.alertSupport !== false, b.summaries !== false,
          by, now()]);
      return mailer.settings();
    },

    /** Who gets platform alerts: the list in the settings, or every active overlord. */
    async alertRecipients() {
      const s = await mailer.settings();
      if (s.alertTo) return s.alertTo.split(/,\s*/);
      return (await pool.query('SELECT email FROM overlords WHERE active = 1')).map((o) => o.email);
    },

    /**
     * Sends one message and records it in mail_log. Never throws: the result is { status, error }.
     * A dedupeKey makes the send happen at most once (daily summaries, update results).
     */
    async send({ to, kind, subject, message, companyId = null, dedupeKey = null }) {
      const list = [...new Set((Array.isArray(to) ? to : [to]).map((a) => String(a || '').trim().toLowerCase()).filter((a) => EMAIL.test(a)))];
      const subj = String(subject).slice(0, 250);
      if (!list.length) return { status: 'skipped', error: 'No recipient with an email address.' };
      let logId;
      try {
        const r = await pool.query(
          'INSERT INTO mail_log (at, kind, recipients, subject, company_id, status, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [now(), kind, list.join(', ').slice(0, 1000), subj, companyId, 'sending', dedupeKey]);
        logId = r.insertId;
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return { status: 'skipped', error: 'Already sent.' };
        console.error('mail log:', err.message);
        return { status: 'failed', error: 'Could not record the email.' };
      }
      const finish = async (status, error = null) => {
        // A failed send frees its dedupe key (renamed, so the attempt stays countable) for a later retry.
        await pool.query(
          `UPDATE mail_log SET status = ?, error = ?, dedupe_key = IF(? = 'failed' AND dedupe_key IS NOT NULL, CONCAT(dedupe_key, '#failed#', id), dedupe_key)
           WHERE id = ?`, [status, error && String(error).slice(0, 500), status, logId]).catch(() => {});
        return { status, error };
      };
      try {
        const r = await row();
        const s = fromRow(r);
        if (!s.host || !s.port || !s.fromEmail) return finish('skipped', 'Email is not set up (Overlord console → Email).');
        const pass = r.password_enc ? decrypt(r.password_enc) : null;
        if (r.password_enc && pass == null) return finish('failed', 'The saved SMTP password cannot be read on this server. Enter it again.');
        const t = await makeTransport({
          host: s.host, port: s.port, secure: s.security === 'ssl', requireTLS: s.security === 'starttls', ignoreTLS: s.security === 'none',
          auth: s.username ? { user: s.username, pass: pass || '' } : undefined,
          connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
        });
        const { html, text } = render(message);
        await t.sendMail({
          from: { name: s.fromName || 'LoanDesk', address: s.fromEmail },
          to: list.length === 1 ? list[0] : undefined,
          bcc: list.length > 1 ? list : undefined, // alert lists and admins don't see each other's addresses
          subject: subj, text, html,
        });
        return finish('sent');
      } catch (err) {
        return finish('failed', err.response || err.message || String(err));
      }
    },

    /** Fire and forget, for emails that must not slow down or fail a request. */
    queue(msg) {
      mailer.send(msg).then((r) => r.status === 'failed' && console.error(`Email "${msg.subject}" failed: ${r.error}`));
    },

    async log(limit = 100) {
      return pool.query(
        `SELECT m.id, m.at, m.kind, m.recipients, m.subject, m.status, m.error, c.name AS company
         FROM mail_log m LEFT JOIN companies c ON c.id = m.company_id ORDER BY m.id DESC LIMIT ?`, [limit]);
    },
  };
  return mailer;
}
