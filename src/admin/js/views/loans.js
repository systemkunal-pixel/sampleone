import { api, download } from '../api.js';
import {
  esc, icon, inr, inr2, num, date, dateTime, ageBadge, BUCKETS, toast, openDrawer, closeDrawer, drawerHead,
  confirmDialog, emptyState, pager, helpButton,
} from '../ui.js';
import { t, tr } from '../../../i18n/i18n.js';
import { route, setQuery } from '../main.js';

const loansCount = (n) => (n === 1 ? t('1 loan') : t('{n} loans', { n: num(n) }));

// Visit outcomes (same labels as VISIT_OUTCOMES in the field app) and payment modes, translated where shown.
/* i18n: t('Cash') t('UPI') t('Cheque') t('Bank transfer') t('Bank deposit') */
/* i18n: t('Paid in full') t('Partial payment') t('Promise to pay') t('Borrower not available') t('Door locked')
   t('Refused to pay') t('Disputes the dues') t('Shifted / not traceable') */
const OUTCOMES = {
  PAID: 'Paid in full', PARTIAL: 'Partial payment', PTP: 'Promise to pay', NOT_AVAILABLE: 'Borrower not available',
  DOOR_LOCKED: 'Door locked', REFUSED: 'Refused to pay', DISPUTE: 'Disputes the dues', SHIFTED: 'Shifted / not traceable',
};
const outcomeLabel = (code) => (OUTCOMES[code] ? t(OUTCOMES[code]) : code.replace(/_/g, ' ').toLowerCase());

// English labels, translated where shown.
/* i18n: t('Sort: {label}') t('Days past due') t('Overdue amount') t('Outstanding') t('Loan number') t('Borrower') t('Officer') */
const SORTS = [['dpd', 'Days past due'], ['overdue', 'Overdue amount'], ['outstanding', 'Outstanding'], ['loanNo', 'Loan number'], ['borrower', 'Borrower'], ['officer', 'Officer']];
let selected = new Set();
let lastKey = '';
let officers = [];

const officerName = (code) => officers.find((o) => o.code === code)?.name;

function officerOptions(branch, current, { includeNone = true } = {}) {
  const list = officers.filter((o) => o.active && (!branch || o.branch === branch));
  return `${includeNone ? `<option value="">${t('— Unassigned —')}</option>` : ''}${list.map((o) =>
    `<option value="${esc(o.code)}" ${o.code === current ? 'selected' : ''}>${esc(o.name)} (${esc(o.code)})${branch ? '' : ` · ${esc(o.branch)}`}</option>`).join('')}`;
}

function filterBar(q, branches) {
  const opt = (v, l, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`;
  const branch = q.get('branch') || '';
  const officer = q.get('officer') || '';
  return `
    <form class="toolbar" id="filters" role="search">
      <label class="search"><span class="sr-only">${t('Search loans')}</span>${icon('search')}<input class="input" name="q" type="search" placeholder="${esc(t('Loan no., borrower, phone'))}" value="${esc(q.get('q') || '')}"></label>
      <select class="select" name="branch" aria-label="${esc(t('Branch'))}">${opt('', t('All branches'), branch)}${branches.map((b) => opt(b, b, branch)).join('')}</select>
      <select class="select" name="officer" aria-label="${esc(t('Officer'))}">
        ${opt('', t('All officers'), officer)}${opt('__none', t('Unassigned'), officer)}
        ${officers.filter((o) => !branch || o.branch === branch).map((o) => opt(o.code, o.active ? `${o.name} (${o.code})` : t('{name} ({code}) – inactive', { name: o.name, code: o.code }), officer)).join('')}
      </select>
      <select class="select" name="bucket" aria-label="${esc(t('Days past due'))}">${opt('', t('Any DPD'), q.get('bucket') || '')}${BUCKETS.map(([k, l]) => opt(k, t(l), q.get('bucket') || '')).join('')}${opt('closed', t('Closed'), q.get('bucket') || '')}</select>
      <select class="select" name="sort" aria-label="${esc(t('Sort by'))}">${SORTS.map(([k, l]) => opt(k, t('Sort: {label}', { label: t(l) }), q.get('sort') || 'dpd')).join('')}</select>
      <input type="hidden" name="dir" value="${esc(q.get('dir') || 'desc')}">
    </form>`;
}

function bulkBar(data) {
  if (!selected.size) return '';
  const all = data.ids && selected.size < data.total;
  return `
    <div class="bulkbar" role="region" aria-label="${esc(t('Bulk actions'))}">
      <span class="count">${selected.size === 1 ? t('1 loan selected') : t('{n} loans selected', { n: num(selected.size) })}</span>
      ${all ? `<button class="linkish" data-act="select-all">${t('Select all {n} matching', { n: num(data.total) })}</button>` : ''}
      <span style="flex:1"></span>
      <select class="select" id="bulk-officer" aria-label="${esc(t('Assign to officer'))}">
        <option value="" disabled selected>${t('Assign to officer…')}</option>${officerOptions('', '', { includeNone: false })}
      </select>
      <button class="btn sm primary" data-act="bulk-assign">${t('Assign')}</button>
      <button class="btn sm" data-act="bulk-unassign">${t('Unassign')}</button>
      <button class="btn sm ghost" style="color:inherit" data-act="clear">${t('Clear')}</button>
    </div>`;
}

function table(data, q) {
  if (!data.rows.length) return emptyState(t('No loans match'), t('Change the filters, or import loans.'), 'loans');
  const sort = q.get('sort') || 'dpd';
  const dir = q.get('dir') || 'desc';
  const th = (key, label, cls = '') =>
    `<th class="${cls}"><button class="sort" data-sort="${key}" ${sort === key ? `aria-sort="${dir === 'asc' ? 'ascending' : 'descending'}"` : ''}>${label}${sort === key ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}</button></th>`;
  const pageAll = data.rows.every((r) => selected.has(r.id));
  return `
    <div class="table-wrap">
      <table class="data responsive">
        <thead><tr>
          <th class="check"><input type="checkbox" data-act="page-all" ${pageAll ? 'checked' : ''} aria-label="${esc(t('Select all on this page'))}"></th>
          ${th('loanNo', t('Loan'))}${th('borrower', t('Borrower'))}<th>${t('Branch')}</th>${th('officer', t('Officer'))}
          ${th('outstanding', t('Outstanding'), 'right')}${th('overdue', t('Overdue'), 'right')}${th('dpd', t('Status'))}
        </tr></thead>
        <tbody>
          ${data.rows.map((r) => `
            <tr class="clickable ${selected.has(r.id) ? 'selected' : ''}" data-id="${esc(r.id)}">
              <td class="check"><input type="checkbox" data-act="row" ${selected.has(r.id) ? 'checked' : ''} aria-label="${esc(t('Select {loan}', { loan: r.loanNo }))}"></td>
              <td class="primary" data-label="${esc(t('Loan'))}"><div class="cell-main">${esc(r.loanNo)}</div><div class="cell-sub">${esc(r.product)}</div></td>
              <td data-label="${esc(t('Borrower'))}"><div>${esc(r.borrower.name)}</div><div class="cell-sub">${esc(r.borrower.phone)}${r.borrower.village ? ` · ${esc(r.borrower.village)}` : ''}</div></td>
              <td data-label="${esc(t('Branch'))}">${esc(r.branch)}</td>
              <td data-label="${esc(t('Officer'))}">${r.officerCode ? `${esc(r.officerName || r.officerCode)} <span class="cell-sub">${esc(r.officerCode)}</span>` : `<span class="badge warn">${t('Unassigned')}</span>`}</td>
              <td class="right num" data-label="${esc(t('Outstanding'))}">${inr(r.outstanding)}</td>
              <td class="right num" data-label="${esc(t('Overdue'))}">${r.overdue ? inr(r.overdue) : '<span class="muted">—</span>'}</td>
              <td data-label="${esc(t('Status'))}">${ageBadge(r.bucket, r.dpd)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    ${pager(data, 'loans')}`;
}

// ---------- detail drawer ----------

async function openLoan(id) {
  openDrawer(`${drawerHead(t('Loading…'))}<div class="drawer-body"><div class="empty">${t('Loading…')}</div></div>`);
  let res;
  try {
    res = await api(`loans/${encodeURIComponent(id)}`);
  } catch (ex) {
    toast(tr(ex.message), 'bad');
    closeDrawer();
    return;
  }
  const { loan, status: st, meta } = res;
  const b = loan.borrower;
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const paidUpTo = (() => {
    let pool = loan.payments.filter((p) => p.deposit?.verification !== 'rejected').reduce((s, p) => s + p.amount, 0);
    return loan.installments.map((i) => {
      const paid = Math.min(pool, i.amount);
      pool -= paid;
      return { ...i, paid };
    });
  })();
  const depositTag = (d) => d ? ({ pending: `<span class="badge warn">${t('Pending')}</span>`, verified: `<span class="badge ok">${t('Verified')}</span>`, rejected: `<span class="badge bad">${t('Rejected')}</span>` })[d.verification] : '';
  const d = openDrawer(`
    ${drawerHead(esc(loan.loanNo), `${esc(b.name)} · ${esc(loan.branch)}`)}
    <div class="drawer-body">
      <div class="mini-kpis">
        <div><span>${t('Outstanding')}</span><b>${inr(st.outstanding)}</b></div>
        <div><span>${t('Overdue')}</span><b>${inr(st.overdue)}</b></div>
        <div><span>${t('Days past due')}</span><b>${num(st.dpd)}</b></div>
        <div><span>${t('Next due')}</span><b>${st.nextDue ? date(st.nextDue.date) : '—'}</b></div>
      </div>

      <section class="section">
        <h3>${t('Assigned officer')}</h3>
        <form class="input-group" id="assign-form">
          <select class="select" name="officer" aria-label="${esc(t('Officer'))}">${officerOptions(loan.branch, loan.officerCode)}</select>
          <button class="btn primary" type="submit">${t('Save')}</button>
        </form>
        <div class="muted small" style="margin-top:6px">${t('Only active officers of {branch} are listed. The change shows on their phone within a minute.', { branch: esc(loan.branch) })}</div>
      </section>

      <section class="section">
        <h3>${t('Borrower')}</h3>
        <dl class="dl">
          <dt>${t('Name')}</dt><dd>${esc(b.name)}</dd>
          <dt>${t('Phone')}</dt><dd><a href="tel:${esc(b.phone)}">${esc(b.phone)}</a></dd>
          ${b.business ? `<dt>${t('Business')}</dt><dd>${esc(b.business)}</dd>` : ''}
          <dt>${t('Address')}</dt><dd>${esc([b.address, b.village].filter(Boolean).join(', ') || '—')}${b.lat != null ? ` · <a href="https://www.google.com/maps?q=${b.lat},${b.lng}" target="_blank" rel="noopener">${t('map')}</a>` : ''}</dd>
          ${b.guarantor ? `<dt>${t('Guarantor')}</dt><dd>${esc(b.guarantor.name || '—')}${b.guarantor.phone ? ` · ${esc(b.guarantor.phone)}` : ''}</dd>` : ''}
        </dl>
      </section>

      <section class="section">
        <h3>${t('Loan')}</h3>
        <dl class="dl">
          <dt>${t('Product')}</dt><dd>${esc(loan.product)}</dd>
          <dt>${t('Principal')}</dt><dd>${inr(loan.principal)}</dd>
          <dt>${t('EMI')}</dt><dd>${inr2(loan.emi)} × ${num(loan.installments.length)}</dd>
          <dt>${t('Disbursed')}</dt><dd>${date(loan.disbursedOn)}</dd>
          <dt>${t('Source')}</dt><dd>${meta.importFile ? `${esc(meta.importFile)} · ${dateTime(meta.importedAt)}` : t('Created by script / seed')}</dd>
          <dt>${t('Last updated')}</dt><dd>${dateTime(meta.updatedAt)}</dd>
        </dl>
      </section>

      <section class="section">
        <h3>${t('Payments ({n})', { n: loan.payments.length })}</h3>
        ${loan.payments.length ? `<div class="card table-wrap"><table class="data compact">
          <thead><tr><th>${t('Date')}</th><th class="right">${t('Amount')}</th><th>${t('Mode')}</th><th>${t('Receipt')}</th></tr></thead>
          <tbody>${[...loan.payments].reverse().map((p) => `<tr>
            <td class="nowrap">${dateTime(p.at)}</td><td class="right num">${inr2(p.amount)}</td>
            <td>${esc(t(p.mode))} ${depositTag(p.deposit)}${p.deposit?.note ? `<div class="cell-sub">${esc(p.deposit.note)}</div>` : ''}</td>
            <td class="cell-sub">${esc(p.receiptNo)}<br>${esc(p.officer)}</td></tr>`).join('')}</tbody></table></div>` : `<p class="muted">${t('No payments yet.')}</p>`}
      </section>

      <section class="section">
        <h3>${t('Visits ({n})', { n: loan.visits.length })}</h3>
        ${loan.visits.length ? `<ul class="activity card">${[...loan.visits].reverse().slice(0, 20).map((v) => `
          <li><div class="what"><b>${esc(outcomeLabel(v.outcome))}</b>${v.ptpDate ? ` · ${t('promised {amount} by {date}', { amount: inr(v.ptpAmount), date: date(v.ptpDate) })}` : ''}${v.notes ? `<div class="cell-sub">${esc(v.notes)}</div>` : ''}</div>
          <span class="when">${dateTime(v.at)}<br>${esc(v.officer)}</span></li>`).join('')}</ul>` : `<p class="muted">${t('No visits yet.')}</p>`}
      </section>

      <section class="section">
        <details>
          <summary style="cursor:pointer;font-weight:600">${loan.installments.length === 1 ? t('Repayment schedule (1 installment)') : t('Repayment schedule ({n} installments)', { n: loan.installments.length })}</summary>
          <div class="card table-wrap" style="margin-top:10px"><table class="data compact">
            <thead><tr><th>#</th><th>${t('Due')}</th><th class="right">${t('Amount')}</th><th>${t('Status')}</th></tr></thead>
            <tbody>${paidUpTo.map((i) => `<tr>
              <td>${i.no}</td><td>${date(i.dueDate)}</td><td class="right num">${inr2(i.amount)}</td>
              <td>${i.paid >= i.amount ? `<span class="badge ok">${t('Paid')}</span>` : i.paid > 0 ? `<span class="badge warn">${t('Part · {amount} due', { amount: inr(i.amount - i.paid) })}</span>` : i.dueDate <= today ? `<span class="badge bad">${t('Overdue')}</span>` : `<span class="muted">${t('Upcoming')}</span>`}</td>
            </tr>`).join('')}</tbody></table></div>
        </details>
      </section>
    </div>`);

  d.onsubmit = async (e) => {
    e.preventDefault();
    const officerCode = e.target.officer.value || null;
    try {
      await api(`loans/${encodeURIComponent(loan.id)}`, { method: 'PATCH', body: { officerCode } });
      toast(officerCode ? t('{loan} assigned to {officer}', { loan: loan.loanNo, officer: officerName(officerCode) || officerCode }) : t('{loan} unassigned', { loan: loan.loanNo }));
      closeDrawer();
      route();
    } catch (ex) {
      toast(tr(ex.message), 'bad');
    }
  };
}

// ---------- page ----------

export async function render(el, q, alive) {
  const key = ['q', 'branch', 'officer', 'bucket'].map((k) => q.get(k) || '').join('|');
  if (key !== lastKey) selected = new Set(); // a different result set: drop the selection
  lastKey = key;
  const params = new URLSearchParams(q);
  params.set('pageSize', q.get('pageSize') || '25');
  const [data, { users }, { branches }] = await Promise.all([api(`loans?${params}`), api('users'), api('branches')]);
  if (!alive()) return;
  officers = users.filter((u) => u.role === 'officer');

  const draw = () => {
    el.innerHTML = `
      <div class="page-head">
        <div><h1>${t('Loans')}</h1><p>${t('{loans} · outstanding {outstanding} · overdue {overdue}', { loans: loansCount(data.total), outstanding: inr(data.totals.outstanding), overdue: inr(data.totals.overdue) })}</p></div>
        <div class="page-actions">
          ${helpButton('assign-loans')}
          <button class="btn" data-act="export" data-needs="loan_export">${icon('download')} ${t('Export CSV')}</button>
          <a class="btn primary" href="#/import">${icon('upload')} ${t('Import loans')}</a>
        </div>
      </div>
      ${filterBar(q, branches)}
      ${bulkBar(data)}
      <section class="card">${table(data, q)}</section>`;
  };
  draw();

  const form = () => el.querySelector('#filters');
  const apply = (extra = {}, replace = false) => setQuery({ ...Object.fromEntries(new FormData(form())), page: '', ...extra }, { replace });
  let timer;
  el.oninput = (e) => {
    if (e.target.name !== 'q') return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const pos = e.target.selectionStart;
      apply({}, true);
      setTimeout(() => {
        const input = el.querySelector('input[name=q]');
        input?.focus();
        input?.setSelectionRange(pos, pos);
      }, 120);
    }, 300);
  };
  el.onsubmit = (e) => e.preventDefault();
  el.onchange = (e) => {
    const t2 = e.target;
    if (t2.closest('#filters') && t2.name !== 'q') {
      if (t2.name === 'branch') form().officer.value = '';
      return apply();
    }
    if (t2.dataset.act === 'row') {
      const id = t2.closest('tr').dataset.id;
      if (t2.checked) selected.add(id);
      else selected.delete(id);
      draw();
    }
    if (t2.dataset.act === 'page-all') {
      data.rows.forEach((r) => (t2.checked ? selected.add(r.id) : selected.delete(r.id)));
      draw();
    }
  };
  el.onclick = async (e) => {
    const t2 = e.target;
    const sortBtn = t2.closest('[data-sort]');
    if (sortBtn) {
      const same = (q.get('sort') || 'dpd') === sortBtn.dataset.sort;
      const dir = same && (q.get('dir') || 'desc') === 'desc' ? 'asc' : 'desc';
      return apply({ sort: sortBtn.dataset.sort, dir });
    }
    const pageBtn = t2.closest('[data-page]');
    if (pageBtn && !pageBtn.disabled) return setQuery({ ...Object.fromEntries(q), page: pageBtn.dataset.page });
    const act = t2.closest('[data-act]')?.dataset.act;
    if (act === 'export') {
      const p = new URLSearchParams(q);
      p.delete('page');
      return download(`loans/export?${p}`, 'loans.csv').catch((ex) => toast(tr(ex.message), 'bad'));
    }
    if (act === 'select-all') {
      data.ids.forEach((id) => selected.add(id));
      return draw();
    }
    if (act === 'clear') {
      selected.clear();
      return draw();
    }
    if (act === 'bulk-assign' || act === 'bulk-unassign') {
      const code = act === 'bulk-assign' ? el.querySelector('#bulk-officer').value : null;
      if (act === 'bulk-assign' && !code) return toast(t('Choose an officer first.'), 'bad');
      const who = code ? `${officerName(code)} (${code})` : t('nobody (unassigned)');
      const n = selected.size;
      const msg = n === 1
        ? t(`Assign 1 loan to {who}? Officers' phones update within a minute.`, { who: esc(who) })
        : t(`Assign {n} loans to {who}? Officers' phones update within a minute.`, { n: num(n), who: esc(who) });
      if (!(await confirmDialog(t('Reassign loans?'), msg, t('Reassign')))) return;
      try {
        const { changed } = await api('loans/assign', { method: 'POST', body: { loanIds: [...selected], officerCode: code } });
        toast(changed === 1 ? t('1 loan reassigned') : t('{n} loans reassigned', { n: num(changed) }));
        selected.clear();
        route();
      } catch (ex) {
        toast(tr(ex.message), 'bad');
      }
      return;
    }
    if (t2.closest('input[type=checkbox], a, button, select')) return;
    const row = t2.closest('tr[data-id]');
    if (row) openLoan(row.dataset.id);
  };
}
