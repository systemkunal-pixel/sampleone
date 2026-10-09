import { api } from '../api.js';
import { esc, dateTime, emptyState, pager } from '../../../admin/js/ui.js';
import { setQuery } from '../main.js';

const LABELS = {
  login: 'Signed in', login_failed: 'Wrong password', code_failed: 'Wrong authenticator code', authenticator_enrolled: 'Set up authenticator',
  password_changed: 'Changed own password', company_created: 'Created company', company_updated: 'Edited company',
  company_locked: 'Locked sign-in', company_unlocked: 'Unlocked sign-in', company_archived: 'Archived company', company_reopened: 'Reopened company',
  admin_added: 'Added company admin', admin_password_reset: "Reset an admin's password", demo_loaded: 'Loaded demo data',
  support_started: 'Entered as support', support_ended: 'Ended a support session', plan_updated: 'Changed a plan',
  feature_override: 'Feature override', overlord_added: 'Added overlord', overlord_activated: 'Activated overlord',
  overlord_deactivated: 'Deactivated overlord', authenticator_reset: 'Reset an authenticator', overlord_password_reset: 'Reset an overlord password (server)',
  overlord_2fa_reset: 'Reset an authenticator (server)',
};
const label = (a) => LABELS[a] || a.replace(/_/g, ' ');

function detail(d) {
  if (!d) return '';
  if (d.reason) return esc(d.reason);
  return esc(Object.entries(d).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · '));
}

export async function render(el, query) {
  const params = new URLSearchParams({ page: query.get('page') || 1 });
  if (query.get('action')) params.set('action', query.get('action'));
  if (query.get('company')) params.set('company', query.get('company'));
  const data = await api(`audit?${params}`);
  el.innerHTML = `
    <div class="page-head">
      <div><h1>Overlord audit log</h1><p>Everything done in this console, newest first. Entries can't be edited or deleted.</p></div>
    </div>
    <div class="toolbar">
      <select class="select" name="action" aria-label="Action">
        <option value="">All actions</option>
        ${data.actions.map((a) => `<option value="${esc(a)}" ${a === query.get('action') ? 'selected' : ''}>${esc(label(a))}</option>`).join('')}
      </select>
      ${query.get('company') ? `<a class="btn sm ghost" href="#/audit">Show all companies</a>` : ''}
    </div>
    <div class="card">
      ${data.rows.length ? `<div class="table-wrap"><table class="data responsive">
        <thead><tr><th>When</th><th>Who</th><th>What</th><th>Company</th><th>Details</th><th>IP</th></tr></thead>
        <tbody>${data.rows.map((r) => `<tr>
          <td class="primary nowrap">${esc(dateTime(r.at))}</td>
          <td data-label="Who">${esc(r.who || '—')}</td>
          <td data-label="What"><b>${esc(label(r.action))}</b></td>
          <td data-label="Company">${r.companyCode ? `${esc(r.companyName)} <span class="cell-sub">${esc(r.companyCode)}</span>` : '<span class="muted">—</span>'}</td>
          <td data-label="Details" class="small">${detail(r.detail) || '<span class="muted">—</span>'}</td>
          <td data-label="IP"><code>${esc(r.ip || '—')}</code></td>
        </tr>`).join('')}</tbody></table></div>
        ${pager({ page: data.page, pages: data.pages, total: data.total, pageSize: 50 }, 'entries')}`
        : emptyState('Nothing logged yet', '', 'audit')}
    </div>`;
  el.onchange = (e) => {
    if (e.target.name === 'action') setQuery({ action: e.target.value, company: query.get('company') || '' });
  };
  el.onclick = (e) => {
    const p = e.target.closest('[data-page]');
    if (p) setQuery({ page: p.dataset.page, action: query.get('action') || '', company: query.get('company') || '' });
  };
}
