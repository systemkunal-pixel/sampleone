// Email: the SMTP account LoanDesk sends from (SMTP2GO by default), who gets platform alerts, and the
// log of every email sent.
import { api } from '../api.js';
import { esc, icon, dateTime, ago, toast, dialog, emptyState } from '../../../admin/js/ui.js';
import { route } from '../main.js';

const STATUS = { sent: ['Sent', 'ok'], failed: ['Failed', 'bad'], skipped: ['Not sent', ''], sending: ['Sending…', 'warn'] };
const KIND = {
  test: 'Test', lead: 'Demo request', update: 'Update result', support: 'Support alert', support_owner: 'Support notice to company',
  password_reset: 'Password reset', summary_daily: 'Daily summary', summary_weekly: 'Weekly summary',
};
const SECURITY = [['starttls', 'STARTTLS (ports 2525, 587, 8025, 80)'], ['ssl', 'SSL/TLS (ports 465, 8465, 443)'], ['none', 'None (not recommended)']];

const toggle = (name, on, label, hint) => `
  <label class="row" style="display:flex;gap:12px;align-items:flex-start">
    <span class="toggle" style="flex:none;margin-top:2px"><input type="checkbox" name="${name}" ${on ? 'checked' : ''}><i></i></span>
    <span><b>${label}</b><br><span class="muted small">${hint}</span></span>
  </label>`;

export async function render(el) {
  const { settings: s, log } = await api('mail');
  const d = s.defaults;
  const fresh = !s.host;
  const v = {
    host: s.host || d.host, port: s.port || d.port, security: fresh ? d.security : s.security,
    siteUrl: s.siteUrl || location.origin,
  };

  el.innerHTML = `
    <div class="page-head">
      <div><h1>Email</h1><p>The SMTP account LoanDesk sends email from. Filled in for SMTP2GO; use the SMTP user from your SMTP2GO account.</p></div>
      <div class="page-actions">${s.configured
        ? `<span class="badge ok">${icon('check')} set up</span><button class="btn" data-act="test">${icon('send')} Send test email</button>`
        : '<span class="badge warn">not set up</span>'}</div>
    </div>
    <form class="grid two" id="mail-form" style="grid-template-columns:1fr 1fr" novalidate autocomplete="off">
      <div class="card">
        <div class="card-head"><h2>${icon('mail')} SMTP server</h2></div>
        <div class="card-body form">
          <div class="form-row">
            <label class="field"><span>SMTP server <span class="req">*</span></span>
              <input class="input" name="host" required value="${esc(v.host)}" placeholder="mail.smtp2go.com"></label>
            <label class="field"><span>Port <span class="req">*</span></span>
              <input class="input" name="port" required inputmode="numeric" value="${esc(v.port)}">
              <span class="hint">2525 works on most servers.</span></label>
          </div>
          <label class="field"><span>Encryption</span><select class="select" name="security">
            ${SECURITY.map(([k, l]) => `<option value="${k}" ${k === v.security ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <div class="form-row">
            <label class="field"><span>SMTP username</span>
              <input class="input" name="username" value="${esc(s.username)}" autocomplete="off"></label>
            <label class="field"><span>SMTP password</span>
              <input class="input" name="password" type="password" autocomplete="new-password" placeholder="${s.hasPassword ? 'saved · leave as is to keep' : ''}">
              <span class="hint">${s.hasPassword ? 'Saved encrypted. Type a new one only to change it.' : 'Stored encrypted on this server.'}</span></label>
          </div>
          <div class="form-row">
            <label class="field"><span>From name</span>
              <input class="input" name="fromName" maxlength="100" value="${esc(s.fromName || 'LoanDesk')}"></label>
            <label class="field"><span>From email <span class="req">*</span></span>
              <input class="input" name="fromEmail" type="email" required value="${esc(s.fromEmail)}" placeholder="noreply@datahaat.com">
              <span class="hint">Its domain must be a verified sender domain in SMTP2GO.</span></label>
          </div>
          <label class="field"><span>Site address</span>
            <input class="input" name="siteUrl" value="${esc(v.siteUrl)}" placeholder="https://loandesk.datahaat.com">
            <span class="hint">Used for the links in emails (password resets, buttons). Without it, reset emails are not sent.</span></label>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h2>${icon('alert')} What to send</h2></div>
        <div class="card-body form">
          <label class="field"><span>Platform alerts go to</span>
            <input class="input" name="alertTo" value="${esc(s.alertTo)}" placeholder="Blank = every active overlord">
            <span class="hint">Email addresses separated by commas.</span></label>
          ${toggle('alertLeads', s.alertLeads, 'New demo requests', 'When someone fills in “Book a demo” on the home page.')}
          ${toggle('alertUpdates', s.alertUpdates, 'Update results', 'When an update is installed, rolled back or fails.')}
          ${toggle('alertSupport', s.alertSupport, 'Support sessions', 'When an overlord enters a company as support (the other overlords are told).')}
          ${toggle('summaries', s.summaries, 'Summary emails to company admins', 'Each admin chooses daily, weekly or off on their user record; needs an email address there.')}
          <div class="info-box small">Password-reset emails always go out when email is set up: admins use “Forgot password?” on the admin sign-in page.</div>
          <div class="error-box" id="mail-error" role="alert"></div>
          <div class="row-actions" style="justify-content:flex-start;gap:8px">
            <button class="btn primary" type="submit">${icon('check')} Save settings</button>
          </div>
          ${s.updatedBy ? `<p class="muted small" style="margin:0">Last saved by ${esc(s.updatedBy)} ${esc(ago(s.updatedAt))}.</p>` : ''}
        </div>
      </div>
    </form>
    <div class="card" style="margin-top:16px">
      <div class="card-head"><h2>${icon('audit')} Sent emails</h2><p>The last 100.</p></div>
      ${log.length ? `<div class="table-wrap"><table class="data responsive">
        <thead><tr><th>When</th><th>Type</th><th>To</th><th>Subject</th><th>Status</th></tr></thead>
        <tbody>${log.map((m) => `<tr>
          <td class="primary nowrap"><div class="cell-main">${esc(ago(m.at))}</div><div class="cell-sub">${esc(dateTime(m.at))}</div></td>
          <td data-label="Type">${esc(KIND[m.kind] || m.kind)}${m.company ? `<div class="cell-sub">${esc(m.company)}</div>` : ''}</td>
          <td data-label="To" class="small" style="word-break:break-all">${esc(m.recipients)}</td>
          <td data-label="Subject" class="small">${esc(m.subject)}</td>
          <td data-label="Status"><span class="badge ${STATUS[m.status]?.[1] ?? ''}">${STATUS[m.status]?.[0] || esc(m.status)}</span>
            ${m.error ? `<div class="cell-sub" style="max-width:280px">${esc(m.error)}</div>` : ''}</td>
        </tr>`).join('')}</tbody></table></div>`
        : emptyState('No emails yet', 'Save the settings, then send a test email.', 'mail')}
    </div>`;

  const form = el.querySelector('#mail-form');
  form.security.onchange = () => {
    const ports = { starttls: '2525', ssl: '465' };
    if (ports[form.security.value] && ['2525', '465'].includes(form.port.value)) form.port.value = ports[form.security.value];
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = el.querySelector('#mail-error');
    err.textContent = '';
    const f = new FormData(form);
    const body = {
      host: f.get('host'), port: Number(f.get('port')), security: f.get('security'), username: f.get('username'),
      fromName: f.get('fromName'), fromEmail: f.get('fromEmail'), siteUrl: f.get('siteUrl'), alertTo: f.get('alertTo'),
      alertLeads: form.alertLeads.checked, alertUpdates: form.alertUpdates.checked, alertSupport: form.alertSupport.checked,
      summaries: form.summaries.checked,
      ...(f.get('password') ? { password: f.get('password') } : {}),
    };
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      await api('mail', { method: 'PUT', body });
      toast(s.configured ? 'Email settings saved' : 'Saved. Now send a test email.');
      route();
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
    }
  };

  el.onclick = async (e) => {
    if (e.target.closest('[data-act=test]')) {
      const me = (await api('me')).overlord;
      const done = await dialog({
        title: 'Send a test email',
        ok: 'Send',
        body: `<div class="form"><label class="field"><span>Send to</span>
          <input class="input" name="to" type="email" required value="${esc(me.email)}" autofocus></label>
          <p class="muted small" style="margin:0">Takes up to 15 seconds. If it fails, the reason is shown here and in the log below.</p></div>`,
        onOk: (data) => api('mail/test', { method: 'POST', body: { to: data.to } }),
      });
      if (done) toast(`Test email sent to ${done.to}`);
      route();
    }
  };
}
