// Pieces shared by the overlord views: company cells, badges, and the support-access / status flows.
import { api } from '../api.js';
import { esc, icon, initials, date, dialog, toast } from '../../../admin/js/ui.js';

export const PLAN_LABEL = { regular: 'Regular', pro: 'Pro', enterprise: 'Enterprise' };
export const planBadge = (p) => `<span class="badge ${p === 'enterprise' ? 'brand' : p === 'pro' ? 'info' : ''}">${PLAN_LABEL[p] || esc(p)}</span>`;

const STATUS = { active: ['Active', 'ok'], locked: ['Locked', 'warn'], archived: ['Archived', ''] };
export const companyStatus = (s) => `<span class="badge ${STATUS[s]?.[1] ?? ''}"><span class="dot"></span>${STATUS[s]?.[0] || esc(s)}</span>`;

export function companyCell(c, { link = true } = {}) {
  const name = link ? `<a href="#/companies/${c.id}" class="co-name">${esc(c.name)}</a>` : `<span class="co-name">${esc(c.name)}</span>`;
  return `<div class="co"><span class="avatar">${esc(initials(c.name))}</span><div style="min-width:0">${name}
    <div class="cell-sub">${esc(c.code)} · since ${esc(date(c.createdAt))}${c.sameName ? ` · <span class="flag" title="Another company has the same name — staff may sign in to the wrong one">${icon('alert')} same name</span>` : ''}</div></div></div>`;
}

/** Opens the admin console inside the company as LoanDesk support (45 minutes, logged). */
export async function enterSupport(c) {
  if (c.status === 'archived') return toast('Reopen the company first to look inside.', 'bad');
  const { mailReady } = await api('me');
  await dialog({
    title: `Enter ${esc(c.name)}`,
    ok: 'Enter as support',
    body: `
      <div class="form">
        <div class="warn-box">${icon('headset')} You'll work in their admin console as <b>LoanDesk support</b> for up to 45 minutes.
          Everything you do is recorded under your name in their audit log and in Support sessions.</div>
        <label class="field"><span>Reason <span class="req">*</span></span>
          <input class="input" name="reason" required minlength="5" maxlength="300" placeholder="e.g. Customer call: import fails on row 12" autofocus>
          <span class="hint">Kept permanently with the session.</span></label>
        ${mailReady ? `<label class="row" style="display:flex;gap:8px;align-items:center">
          <input type="checkbox" name="notify"> Email the company that support entered
          <span class="muted small">(company contact and admins with an email address)</span></label>`
        : `<label class="row" style="display:flex;gap:8px;align-items:center;color:var(--muted)">
          <input type="checkbox" name="notify" disabled> Email the company that support entered
          <a class="badge" href="#/mail">set up email first</a></label>`}
      </div>`,
    onOk: async (data) => {
      // Open the tab now, while the click still counts as a user action, then point it at the session.
      const win = window.open('', '_blank');
      try {
        const s = await api(`companies/${c.id}/support`, { method: 'POST', body: { reason: data.reason, notifyOwner: data.notify === 'on' } });
        const url = `../admin/#support=${encodeURIComponent(s.token)}`;
        if (win) {
          win.opener = null;
          win.location.href = url;
        } else location.href = url;
        if (data.notify === 'on' && !s.notified) toast(`Support session started, but the email to ${c.name} was not sent (see Email → Sent emails)`, 'bad');
        else toast(`Support session started in ${c.name}${s.notified ? ' · company emailed' : ''}`);
      } catch (err) {
        win?.close();
        throw err;
      }
    },
  });
}

const ACTIONS = {
  lock: { title: 'Lock sign-in', ok: 'Lock sign-in', danger: true, reason: true,
    text: 'Nobody in this company can sign in, and everyone signed in is signed out now. Data is untouched and it still counts as a customer. Support can still enter.' },
  unlock: { title: 'Unlock sign-in', ok: 'Unlock', text: 'Staff can sign in again straight away.' },
  archive: { title: 'Archive company', ok: 'Archive', danger: true, reason: true,
    text: 'Puts the company away: signed out, sign-in refused, removed from the overview and figures. Nothing is deleted; you can reopen it any time.' },
  reopen: { title: 'Reopen company', ok: 'Reopen', text: 'The company becomes active again and its staff can sign in.' },
};

export async function changeStatus(c, action) {
  const a = ACTIONS[action];
  const done = await dialog({
    title: `${a.title}: ${esc(c.name)}`,
    ok: a.ok,
    danger: a.danger,
    body: `<div class="form"><p style="margin:0">${a.text}</p>
      ${a.reason ? `<label class="field"><span>Reason <span class="req">*</span></span>
        <input class="input" name="reason" required minlength="3" maxlength="300" autofocus placeholder="${action === 'lock' ? 'e.g. Invoice overdue' : 'e.g. Customer closed their account'}">
        <span class="hint">Kept on the company record and in the overlord audit log.</span></label>` : ''}</div>`,
    onOk: (data) => api(`companies/${c.id}/status`, { method: 'POST', body: { action, reason: data.reason } }),
  });
  if (done) toast(`${c.name}: ${a.ok.toLowerCase()} done`);
  return Boolean(done);
}
