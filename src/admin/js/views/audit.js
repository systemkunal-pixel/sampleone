import { api } from '../api.js';
import { esc, num, dateTime, emptyState, pager } from '../ui.js';
import { setQuery } from '../main.js';

const ACTIONS = {
  login: 'signed in',
  login_failed: 'failed to sign in',
  user_created: 'created user',
  user_updated: 'updated user',
  user_activated: 'reactivated user',
  user_deactivated: 'deactivated user',
  pin_reset: 'reset the PIN/password of',
  password_changed: 'changed their password',
  loans_imported: 'imported loans — import #',
  loans_assigned: 'reassigned loans to',
  deposit_verified: 'verified deposit',
  deposit_rejected: 'rejected deposit',
  reject_payment: 'had a payment refused',
  reject_visit: 'had a visit refused',
};
export const describe = (action) => ACTIONS[action] || action.replace(/_/g, ' ');

function details(d) {
  if (!d) return '';
  return Object.entries(d)
    .filter(([k]) => k !== 'ids')
    .map(([k, v]) => `<span class="badge" style="margin:0 4px 4px 0">${esc(k)}: ${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</span>`)
    .join('');
}

export async function render(el, q, alive) {
  const data = await api(`audit?${q}`);
  if (!alive()) return;
  el.innerHTML = `
    <div class="page-head"><div><h1>Audit log</h1><p>Every sign-in, user change, import, reassignment and deposit decision. ${num(data.total)} entries.</p></div></div>
    <form class="toolbar" id="filters">
      <select class="select" name="action" aria-label="Action">
        <option value="">All actions</option>
        ${data.actions.map((a) => `<option value="${esc(a)}" ${q.get('action') === a ? 'selected' : ''}>${esc(describe(a))}</option>`).join('')}
      </select>
      <label class="search"><span class="sr-only">User code</span><input class="input" name="user" placeholder="User code, e.g. SUP1" value="${esc(q.get('user') || '')}" style="padding-left:11px"></label>
    </form>
    <section class="card">
      ${data.rows.length ? `
      <div class="table-wrap"><table class="data responsive">
        <thead><tr><th>When</th><th>User</th><th>Action</th><th>Subject</th><th>Details</th></tr></thead>
        <tbody>${data.rows.map((r) => `<tr>
          <td class="primary nowrap" data-label="When"><div class="cell-main">${dateTime(r.at)}</div></td>
          <td data-label="User"><b>${esc(r.user_code || '—')}</b></td>
          <td data-label="Action"${r.action.includes('fail') || r.action.includes('reject') ? ' style="color:var(--bad)"' : ''}>${esc(describe(r.action))}</td>
          <td data-label="Subject">${esc(r.entity_id || '—')}</td>
          <td data-label="Details">${details(r.detail)}</td></tr>`).join('')}</tbody>
      </table></div>${pager({ ...data, pageSize: 50 }, 'entries')}`
      : emptyState('No entries', 'Nothing matches these filters.', 'audit')}
    </section>`;

  const form = el.querySelector('#filters');
  const apply = () => setQuery(Object.fromEntries(new FormData(form)));
  el.onchange = (e) => e.target.closest('#filters') && apply();
  el.onsubmit = (e) => {
    e.preventDefault();
    apply();
  };
  el.onclick = (e) => {
    const b = e.target.closest('[data-page]');
    if (b && !b.disabled) setQuery({ ...Object.fromEntries(q), page: b.dataset.page });
  };
}
