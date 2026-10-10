// Billing: collections of one client for a period, by State → Circle → District → Branch, with the
// fee and an Excel workbook for the invoice. Each payment counts in the circle it had when collected.
import { api, download } from '../api.js';
import { esc, icon, inr2, num, toast, emptyState, helpButton } from '../ui.js';
import { t, tr } from '../../../i18n/i18n.js';
import { setQuery } from '../main.js';

const monthStart = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
};
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
let open = new Set();

/* i18n: t('State') t('Circle') t('District') t('Branch') */
const LEVELS = ['State', 'Circle', 'District', 'Branch'];

function rows(nodes, depth, path) {
  return nodes.map((n) => {
    const key = `${path}/${n.name}`;
    const kids = (n.children || []).filter((k) => !(depth === 2 && k.name === '—' && n.children.length === 1));
    const canOpen = kids.length > 0 && depth < 3;
    const isOpen = open.has(key);
    return `<tr class="bill-row l${depth}">
      <td>${canOpen ? `<button class="icon-btn caret ${isOpen ? 'open' : ''}" data-key="${esc(key)}" aria-label="${esc(t('Show'))}">${icon(isOpen ? 'chevronDown' : 'chevronRight')}</button>` : '<span class="caret-space" style="display:inline-block;width:34px"></span>'}
        <span class="muted small">${t(LEVELS[depth])}</span> <b>${esc(n.name)}</b></td>
      <td class="right num">${num(n.receipts)}</td>
      <td class="right num">${num(n.accounts)}</td>
      <td class="right num"><b>${inr2(n.billable)}</b></td>
      <td class="right num">${n.pending ? `<span class="badge warn">${inr2(n.pending)}</span>` : '—'}</td>
      <td class="right num">${n.rejected ? `<span class="badge bad">${inr2(n.rejected)}</span>` : '—'}</td>
      <td class="right num">${n.fee ? inr2(n.fee) : '—'}</td>
    </tr>${canOpen && isOpen ? rows(kids, depth + 1, key) : ''}`;
  }).join('');
}

export async function render(el, q, alive) {
  const { clients } = await api('clients');
  if (!alive()) return;
  const client = q.get('client') || String(clients.find((c) => c.active)?.id ?? '');
  const from = q.get('from') || monthStart();
  const to = q.get('to') || today();
  const basis = q.get('basis') || 'verified';
  const params = new URLSearchParams({ client, from, to, basis });
  let data = null;
  let error = '';
  if (client) {
    try {
      data = await api(`billing?${params}`);
    } catch (ex) {
      error = tr(ex.message);
    }
  }
  if (!alive()) return;
  const th = `<tr><th>${t('Area')}</th><th class="right">${t('Receipts')}</th><th class="right">${t('Accounts')}</th><th class="right">${t('Billable')}</th>
    <th class="right">${t('Deposits pending')}</th><th class="right">${t('Rejected')}</th><th class="right">${t('Fee')}</th></tr>`;

  const draw = () => {
    el.innerHTML = `
      <div class="page-head">
        <div><h1>${t('Billing')}</h1><p>${t('Collections of a client for a period, by state, circle, district and branch. Each payment counts in the circle it had on the day it was collected.')}</p></div>
        <div class="page-actions">${helpButton('billing')}${data ? `<button class="btn primary" data-act="xlsx">${icon('download')} ${t('Download Excel')}</button>` : ''}</div>
      </div>
      <form class="toolbar" id="bill-form">
        <select class="select" name="client" aria-label="${esc(t('Client'))}">${clients.map((c) => `<option value="${c.id}" ${String(c.id) === client ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
        <label class="field inline"><span>${t('From')}</span><input class="input" type="date" name="from" value="${esc(from)}"></label>
        <label class="field inline"><span>${t('To')}</span><input class="input" type="date" name="to" value="${esc(to)}"></label>
        <select class="select" name="basis" aria-label="${esc(t('What is billable'))}">
          <option value="verified" ${basis === 'verified' ? 'selected' : ''}>${t('Bill verified collections only')}</option>
          <option value="all" ${basis === 'all' ? 'selected' : ''}>${t('Bill everything recorded')}</option>
        </select>
        <button class="btn" type="submit">${icon('refresh')} ${t('Show')}</button>
      </form>
      ${!clients.length ? emptyState(t('No clients yet'), t('Add clients first; billing is per client.'), 'building') : error ? `<div class="error-box">${esc(error)}</div>` : data ? `
      <div class="mini-kpis">
        <div><span>${t('Billable')}</span><b>${inr2(data.total.billable)}</b></div>
        <div><span>${t('Receipts')} · ${t('Accounts')}</span><b>${num(data.total.receipts)} · ${num(data.total.accounts)}</b></div>
        <div><span>${t('Deposits pending')}</span><b>${inr2(data.total.pending)}</b></div>
        <div><span>${t('Fee')}</span><b>${data.total.fee ? inr2(data.total.fee) : '—'}</b></div>
      </div>
      <section class="card">
        ${data.states.length ? `<div class="table-wrap"><table class="data">
          <thead>${th}</thead><tbody>${rows(data.states, 0, '')}
          <tr class="bill-row l0" style="border-top:2px solid var(--border-strong)"><td><b>${t('Total')}</b></td><td class="right num">${num(data.total.receipts)}</td><td class="right num">${num(data.total.accounts)}</td>
            <td class="right num"><b>${inr2(data.total.billable)}</b></td><td class="right num">${inr2(data.total.pending)}</td><td class="right num">${inr2(data.total.rejected)}</td><td class="right num">${inr2(data.total.fee)}</td></tr>
          </tbody></table></div>` : emptyState(t('No collections in this period'), t('Change the dates, or check that payments were recorded on this client’s accounts.'), 'sheet')}
      </section>
      ${data.circles.length > 1 || data.circles.some((c) => c.states.length > 1) ? `<section class="card" style="margin-top:16px">
        <div class="card-head"><div><h2>${t('Circles in total')}</h2><p>${t('A circle that covers two states appears under each state above; here it is counted once.')}</p></div></div>
        <div class="table-wrap"><table class="data"><thead><tr><th>${t('Circle')}</th><th>${t('States')}</th><th class="right">${t('Receipts')}</th><th class="right">${t('Billable')}</th><th class="right">${t('Fee')}</th></tr></thead>
          <tbody>${data.circles.map((c) => `<tr><td class="primary"><b>${esc(c.name)}</b></td><td>${esc(c.states.join(', '))}</td><td class="right num">${num(c.receipts)}</td><td class="right num">${inr2(c.billable)}</td><td class="right num">${c.fee ? inr2(c.fee) : '—'}</td></tr>`).join('')}</tbody></table></div>
      </section>` : ''}
      <p class="muted small" style="margin-top:12px">${basis === 'verified' ? t('Billable: cash, UPI, cheque and transfers as recorded, and bank deposits once a supervisor verified the slip. Fee: the circle’s fee % where set, otherwise the client’s.') : t('Billable: everything recorded except rejected deposits. Fee: the circle’s fee % where set, otherwise the client’s.')}</p>` : ''}`;
  };
  draw();

  el.onsubmit = (e) => {
    e.preventDefault();
    open = new Set();
    setQuery(Object.fromEntries(new FormData(el.querySelector('#bill-form'))));
  };
  el.onclick = (e) => {
    const k = e.target.closest('[data-key]');
    if (k) {
      if (open.has(k.dataset.key)) open.delete(k.dataset.key);
      else open.add(k.dataset.key);
      return draw();
    }
    if (e.target.closest('[data-act=xlsx]')) {
      download(`billing.xlsx?${params}`, `billing-${from}-to-${to}.xlsx`).catch((ex) => toast(tr(ex.message), 'bad'));
    }
  };
}
