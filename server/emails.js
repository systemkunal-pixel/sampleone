// The emails LoanDesk sends, and the once-a-minute job that sends the scheduled ones:
//   • new demo request            → platform alert recipients
//   • update applied / rolled back → platform alert recipients
//   • support session started     → platform alert recipients, and the company when the overlord ticks "email the company"
//   • admin password reset link   → that admin
//   • daily / weekly summary      → each company admin who has an email address and wants it
import { isoDate, addDays, localTimestamp } from '../src/js/logic.js';
import { money } from './mail.js';
import { portfolio } from './admin-api.js';
import { now } from './db.js';

export const SUMMARY_HOUR = 8; // summaries go out from 8 am server time
export const RESET_MINUTES = 30;

// ---------- platform alerts ----------

export async function leadAlert(mailer, lead) {
  const s = await mailer.settings();
  if (!s.configured || !s.alertLeads) return;
  const site = await mailer.siteUrl();
  mailer.queue({
    to: await mailer.alertRecipients(), kind: 'lead',
    subject: `New demo request: ${lead.company}`,
    message: {
      title: 'New demo request',
      intro: `${lead.name} from ${lead.company} asked for a LoanDesk demo on the home page.`,
      rows: [
        ['Name', lead.name], ['Organisation', lead.company], ['Mobile', lead.phone], ['Email', lead.email || '—'],
        ['Field officers', lead.officers ?? '—'], ['Message', lead.message || '—'],
      ],
      button: site ? { label: 'Open demo requests', url: `${site}/overlord/#/leads` } : null,
      foot: 'Call new requests within a working day.',
    },
  });
}

const UPDATE_WORDS = {
  applied: ['installed', 'The update was installed and the new version is running.'],
  rolled_back: ['rolled back', 'The new version did not come up healthy, so the previous version was put back automatically.'],
  failed: ['FAILED', 'The update failed and the automatic rollback did not finish. Check the server now.'],
};

/** Tells the alert recipients how each finished update ended (once per update). */
export async function sendUpdateResults(pool, mailer) {
  const rows = await pool.query(
    "SELECT * FROM platform_updates WHERE mailed = 0 AND status IN ('applied', 'rolled_back', 'failed') ORDER BY id");
  if (!rows.length) return;
  const s = await mailer.settings();
  const site = await mailer.siteUrl();
  for (const u of rows) {
    await pool.query('UPDATE platform_updates SET mailed = 1 WHERE id = ?', [u.id]);
    if (!s.configured || !s.alertUpdates) continue;
    const [word, line] = UPDATE_WORDS[u.status];
    await mailer.send({
      to: await mailer.alertRecipients(), kind: 'update', dedupeKey: `update:${u.id}`,
      subject: `LoanDesk update ${u.from_version} → ${u.to_version} ${word}`,
      message: {
        title: `Update ${word}: ${u.from_version} → ${u.to_version}`,
        intro: line,
        rows: [['Package', u.file_name], ['Staged by', u.staged_by], ['Started', u.started_at || '—'], ['Finished', u.finished_at || '—'], ['Detail', u.detail || '—']],
        button: site ? { label: 'Open Update & diagnostics', url: `${site}/overlord/#/updates` } : null,
      },
    });
  }
}

export async function supportAlerts(pool, mailer, { company, overlord, reason, minutes, notifyOwner }) {
  const s = await mailer.settings();
  if (!s.configured) return { ownerNotified: false };
  if (s.alertSupport) {
    mailer.queue({
      to: (await mailer.alertRecipients()).filter((a) => a !== overlord.email), kind: 'support', companyId: company.id,
      subject: `Support session: ${overlord.name} entered ${company.name}`,
      message: {
        title: 'Support session started',
        intro: `${overlord.name} (${overlord.email}) entered ${company.name} as LoanDesk support for up to ${minutes} minutes.`,
        rows: [['Company', `${company.name} (${company.code})`], ['Reason', reason], ['Started', now()]],
      },
    });
  }
  if (!notifyOwner) return { ownerNotified: false };
  const to = [company.contact_email,
    ...(await pool.query("SELECT email FROM users WHERE company_id = ? AND role = 'admin' AND active = 1 AND email IS NOT NULL", [company.id])).map((u) => u.email)];
  const r = await mailer.send({
    to, kind: 'support_owner', companyId: company.id,
    subject: 'LoanDesk support is working in your account',
    message: {
      title: 'LoanDesk support entered your account',
      intro: `${overlord.name} from the LoanDesk team opened your admin console to help you.`,
      rows: [['Reason', reason], ['Started', now()], ['Access ends', `after at most ${minutes} minutes`]],
      foot: 'Everything support does is recorded in your Audit log under their name. Questions? Reply to your LoanDesk contact.',
    },
  });
  return { ownerNotified: r.status === 'sent' };
}

// ---------- password reset ----------

export function resetEmail(user, url) {
  return {
    to: user.email, kind: 'password_reset', companyId: user.company_id,
    subject: 'Reset your LoanDesk admin password',
    message: {
      title: 'Reset your password',
      intro: `Hello ${user.name}, someone asked to reset the LoanDesk admin password for ${user.code} (${user.company_name}).`,
      lines: [`The link works once and expires in ${RESET_MINUTES} minutes.`],
      button: { label: 'Choose a new password', url },
      foot: "If you didn't ask for this, ignore this email: your password stays as it is.",
    },
  };
}

// ---------- daily and weekly summaries ----------

/** Figures for one company over [from, to] (dates, inclusive), plus the portfolio as of today. */
export async function companySummary(pool, companyId, from, to) {
  const start = `${from} 00:00:00`;
  const end = `${addDays(to, 1)} 00:00:00`;
  const loans = await portfolio(pool, companyId);
  const branches = new Map();
  const br = (b) => {
    if (!branches.has(b)) branches.set(b, { branch: b, collected: 0, payments: 0, pending: 0, overdue: 0 });
    return branches.get(b);
  };
  let outstanding = 0, overdue = 0, par30 = 0, active = 0;
  for (const l of loans) {
    if (l.bucket === 'closed') continue;
    active += 1;
    outstanding += l.outstanding;
    overdue += l.overdue;
    if (l.dpd > 30) par30 += l.outstanding;
    br(l.branch).overdue += l.overdue;
  }
  const pays = await pool.query(
    `SELECT l.branch, SUM(IF(p.verification = 'rejected', 0, p.amount)) AS amount, COUNT(*) AS n
     FROM payments p JOIN loans l ON l.id = p.loan_id WHERE p.company_id = ? AND p.recorded_at >= ? AND p.recorded_at < ? GROUP BY l.branch`,
    [companyId, start, end]);
  for (const p of pays) Object.assign(br(p.branch), { collected: Number(p.amount) || 0, payments: p.n });
  const pending = await pool.query(
    `SELECT l.branch, COUNT(*) AS n, SUM(p.amount) AS amount FROM payments p JOIN loans l ON l.id = p.loan_id
     WHERE p.company_id = ? AND p.verification = 'pending' GROUP BY l.branch`, [companyId]);
  for (const p of pending) br(p.branch).pending = p.n;
  const [dec] = await pool.query(
    `SELECT SUM(verification = 'verified') AS verified, SUM(verification = 'rejected') AS rejected FROM payments
     WHERE company_id = ? AND verified_at >= ? AND verified_at < ?`, [companyId, start, end]);
  const [vis] = await pool.query(
    `SELECT COUNT(*) AS n FROM visits v JOIN loans l ON l.id = v.loan_id WHERE l.company_id = ? AND v.recorded_at >= ? AND v.recorded_at < ?`,
    [companyId, start, end]);
  const sum = (k) => [...branches.values()].reduce((s, b) => s + b[k], 0);
  return {
    from, to, activeLoans: active, outstanding, overdue, par30Pct: outstanding ? (par30 / outstanding) * 100 : 0,
    collected: sum('collected'), payments: sum('payments'), visits: Number(vis.n) || 0,
    pendingDeposits: pending.reduce((s, p) => s + p.n, 0), pendingAmount: pending.reduce((s, p) => s + Number(p.amount), 0),
    verified: Number(dec.verified) || 0, rejected: Number(dec.rejected) || 0,
    branches: [...branches.values()].sort((a, b) => a.branch.localeCompare(b.branch)),
  };
}

export function summaryEmail(admin, company, f, freq, site) {
  const period = freq === 'daily' ? `yesterday (${f.from})` : `last week (${f.from} to ${f.to})`;
  return {
    to: admin.email, kind: `summary_${freq}`, companyId: company.id,
    subject: `LoanDesk ${freq} summary for ${company.name}: ${money(f.collected)} collected`,
    message: {
      title: `${freq === 'daily' ? 'Daily' : 'Weekly'} summary · ${company.name}`,
      intro: `Hello ${admin.name}, here is how collections went ${period}.`,
      rows: [
        ['Collected', `${money(f.collected)} in ${f.payments} payment(s)`],
        ['Visits recorded', String(f.visits)],
        ['Deposits verified / rejected', `${f.verified} / ${f.rejected}`],
        ['Deposits waiting for a supervisor', `${f.pendingDeposits} (${money(f.pendingAmount)})`],
        ['Active loans', String(f.activeLoans)],
        ['Outstanding', money(f.outstanding)],
        ['Overdue', money(f.overdue)],
        ['PAR 30', `${f.par30Pct.toFixed(1)}%`],
      ],
      table: f.branches.length > 1 ? {
        head: ['Branch', 'Collected', 'Deposits waiting', 'Overdue'],
        rows: f.branches.map((b) => [b.branch, money(b.collected), String(b.pending), money(b.overdue)]),
      } : null,
      button: site ? { label: 'Open the admin console', url: `${site}/admin/` } : null,
      foot: 'You get this because summary emails are on for your admin account. Turn them off in the admin console: Users → your name → Summary email.',
    },
  };
}

/** Monday of the week before the week containing `day`, and that week's Sunday. */
export function lastWeek(day) {
  const dow = (new Date(`${day}T00:00:00`).getDay() + 6) % 7; // Monday = 0
  const monday = addDays(day, -dow - 7);
  return [monday, addDays(monday, 6)];
}

/** Sends the summaries that are due today and not yet sent. Safe to call every minute. */
export async function sendSummaries(pool, mailer, at = new Date()) {
  if (at.getHours() < SUMMARY_HOUR) return 0;
  const s = await mailer.settings();
  if (!s.configured || !s.summaries) return 0;
  const today = isoDate(at);
  const monday = new Date(`${today}T00:00:00`).getDay() === 1;
  const admins = await pool.query(
    `SELECT u.id, u.name, u.email, u.summary_email, c.id AS company_id, c.code AS company_code, c.name AS company_name
     FROM users u JOIN companies c ON c.id = u.company_id
     WHERE u.role = 'admin' AND u.active = 1 AND u.email IS NOT NULL AND c.status = 'active'
       AND (u.summary_email = 'daily' OR (u.summary_email = 'weekly' AND ?))`, [monday]);
  if (!admins.length) return 0;
  // Sent once per admin per day; after a failure, retried hourly up to three times.
  const done = new Set();
  const failures = new Map();
  for (const r of await pool.query('SELECT dedupe_key, at FROM mail_log WHERE dedupe_key LIKE ?', [`summary:%:${today}:%`])) {
    const [base, failed] = r.dedupe_key.split('#failed#');
    if (!failed) done.add(base);
    else failures.set(base, [...(failures.get(base) || []), String(r.at)]);
  }
  const hourAgo = localTimestamp(new Date(at.getTime() - 36e5)).replace('T', ' ');
  const site = await mailer.siteUrl();
  const figures = new Map();
  let n = 0;
  for (const a of admins) {
    const key = `summary:${a.summary_email}:${today}:${a.id}`;
    const fails = failures.get(key) || [];
    if (done.has(key) || fails.length >= 3 || fails.some((t) => t > hourAgo)) continue;
    const [from, to] = a.summary_email === 'daily' ? [addDays(today, -1), addDays(today, -1)] : lastWeek(today);
    const fk = `${a.company_id}:${from}:${to}`;
    if (!figures.has(fk)) figures.set(fk, await companySummary(pool, a.company_id, from, to));
    const company = { id: a.company_id, code: a.company_code, name: a.company_name };
    const r = await mailer.send({ ...summaryEmail(a, company, figures.get(fk), a.summary_email, site), dedupeKey: key });
    if (r.status === 'sent') n += 1;
  }
  return n;
}

/** Started by server/index.js: update results and summaries, checked every minute. */
export function startMailJobs(pool, mailer, everyMs = 60000) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await sendUpdateResults(pool, mailer);
      await sendSummaries(pool, mailer);
    } catch (err) {
      console.error('Email job:', err.message);
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 15000).unref();
  return setInterval(tick, everyMs).unref();
}
