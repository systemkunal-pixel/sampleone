import { api } from '../api.js';
import { esc, num, dateTime, emptyState, pager, helpButton } from '../ui.js';
import { t } from '../../../i18n/i18n.js';
import { setQuery } from '../main.js';

// English descriptions, translated where shown: describe() returns t(ACTIONS[action]).
/* i18n: t('signed in') t('failed to sign in') t('created user') t('updated user') t('reactivated user')
   t('deactivated user') t('reset the PIN/password of') t('changed their password') t('imported loans — import #')
   t('reassigned loans to') t('verified deposit') t('rejected deposit') t('had a payment refused') t('had a visit refused')
   t('asked for a password-reset email') t('asked for a password reset, but has no email address') t('set a new password from the reset email') */
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
  password_reset_requested: 'asked for a password-reset email',
  password_reset_no_email: 'asked for a password reset, but has no email address',
  password_reset_by_email: 'set a new password from the reset email',
};
export const describe = (action) => (ACTIONS[action] ? t(ACTIONS[action]) : action.replace(/_/g, ' '));

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
    <div class="page-head"><div><h1>${t('Audit log')}</h1><p>${data.total === 1 ? t('Every sign-in, user change, import, reassignment and deposit decision. 1 entry.') : t('Every sign-in, user change, import, reassignment and deposit decision. {n} entries.', { n: num(data.total) })}</p></div>
      <div class="page-actions">${helpButton('audit-log')}</div></div>
    <form class="toolbar" id="filters">
      <select class="select" name="action" aria-label="${esc(t('Action'))}">
        <option value="">${t('All actions')}</option>
        ${data.actions.map((a) => `<option value="${esc(a)}" ${q.get('action') === a ? 'selected' : ''}>${esc(describe(a))}</option>`).join('')}
      </select>
      <label class="search"><span class="sr-only">${t('User code')}</span><input class="input" name="user" placeholder="${esc(t('User code, e.g. SUP1'))}" value="${esc(q.get('user') || '')}" style="padding-left:11px"></label>
    </form>
    <section class="card">
      ${data.rows.length ? `
      <div class="table-wrap"><table class="data responsive">
        <thead><tr><th>${t('When')}</th><th>${t('User')}</th><th>${t('Action')}</th><th>${t('Subject')}</th><th>${t('Details')}</th></tr></thead>
        <tbody>${data.rows.map((r) => `<tr>
          <td class="primary nowrap" data-label="${esc(t('When'))}"><div class="cell-main">${dateTime(r.at)}</div></td>
          <td data-label="${esc(t('User'))}"><b>${esc(r.user_code || '—')}</b>${r.support_name ? `<div class="cell-sub">${t('LoanDesk support · {name}', { name: esc(r.support_name) })}</div>` : ''}</td>
          <td data-label="${esc(t('Action'))}"${r.action.includes('fail') || r.action.includes('reject') ? ' style="color:var(--bad)"' : ''}>${esc(describe(r.action))}</td>
          <td data-label="${esc(t('Subject'))}">${esc(r.entity_id || '—')}</td>
          <td data-label="${esc(t('Details'))}">${details(r.detail)}</td></tr>`).join('')}</tbody>
      </table></div>${pager({ ...data, pageSize: 50 }, 'entries')}`
      : emptyState(t('No entries'), t('Nothing matches these filters.'), 'audit')}
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
