import { api, download } from '../api.js';
import {
  esc, icon, inr, inr2, num, date, dateTime, plural, ageBadge, BUCKETS, toast, openDrawer, closeDrawer, drawerHead,
  confirmDialog, emptyState, pager,
} from '../ui.js';
import { route, setQuery } from '../main.js';

const SORTS = [['dpd', 'Days past due'], ['overdue', 'Overdue amount'], ['outstanding', 'Outstanding'], ['loanNo', 'Loan number'], ['borrower', 'Borrower'], ['officer', 'Officer']];
let selected = new Set();
let lastKey = '';
let officers = [];

const officerName = (code) => officers.find((o) => o.code === code)?.name;

function officerOptions(branch, current, { includeNone = true } = {}) {
  const list = officers.filter((o) => o.active && (!branch || o.branch === branch));
  return `${includeNone ? `<option value="">— Unassigned —</option>` : ''}${list.map((o) =>
    `<option value="${esc(o.code)}" ${o.code === current ? 'selected' : ''}>${esc(o.name)} (${esc(o.code)})${branch ? '' : ` · ${esc(o.branch)}`}</option>`).join('')}`;
}

function filterBar(q, branches) {
  const opt = (v, l, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`;
  const branch = q.get('branch') || '';
  const officer = q.get('officer') || '';
  return `
    <form class="toolbar" id="filters" role="search">
      <label class="search"><span class="sr-only">Search loans</span>${icon('search')}<input class="input" name="q" type="search" placeholder="Loan no., borrower, phone" value="${esc(q.get('q') || '')}"></label>
      <select class="select" name="branch" aria-label="Branch">${opt('', 'All branches', branch)}${branches.map((b) => opt(b, b, branch)).join('')}</select>
      <select class="select" name="officer" aria-label="Officer">
        ${opt('', 'All officers', officer)}${opt('__none', 'Unassigned', officer)}
        ${officers.filter((o) => !branch || o.branch === branch).map((o) => opt(o.code, `${o.name} (${o.code})${o.active ? '' : ' – inactive'}`, officer)).join('')}
      </select>
      <select class="select" name="bucket" aria-label="Days past due">${opt('', 'Any DPD', q.get('bucket') || '')}${BUCKETS.map(([k, l]) => opt(k, l, q.get('bucket') || '')).join('')}${opt('closed', 'Closed', q.get('bucket') || '')}</select>
      <select class="select" name="sort" aria-label="Sort by">${SORTS.map(([k, l]) => opt(k, `Sort: ${l}`, q.get('sort') || 'dpd')).join('')}</select>
      <input type="hidden" name="dir" value="${esc(q.get('dir') || 'desc')}">
    </form>`;
}

function bulkBar(data) {
  if (!selected.size) return '';
  const all = data.ids && selected.size < data.total;
  return `
    <div class="bulkbar" role="region" aria-label="Bulk actions">
      <span class="count">${plural(selected.size, 'loan')} selected</span>
      ${all ? `<button class="linkish" data-act="select-all">Select all ${num(data.total)} matching</button>` : ''}
      <span style="flex:1"></span>
      <select class="select" id="bulk-officer" aria-label="Assign to officer">
        <option value="" disabled selected>Assign to officer…</option>${officerOptions('', '', { includeNone: false })}
      </select>
      <button class="btn sm primary" data-act="bulk-assign">Assign</button>
      <button class="btn sm" data-act="bulk-unassign">Unassign</button>
      <button class="btn sm ghost" style="color:inherit" data-act="clear">Clear</button>
    </div>`;
}

function table(data, q) {
  if (!data.rows.length) return emptyState('No loans match', 'Change the filters, or import loans.', 'loans');
  const sort = q.get('sort') || 'dpd';
  const dir = q.get('dir') || 'desc';
  const th = (key, label, cls = '') =>
    `<th class="${cls}"><button class="sort" data-sort="${key}" ${sort === key ? `aria-sort="${dir === 'asc' ? 'ascending' : 'descending'}"` : ''}>${label}${sort === key ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}</button></th>`;
  const pageAll = data.rows.every((r) => selected.has(r.id));
  return `
    <div class="table-wrap">
      <table class="data responsive">
        <thead><tr>
          <th class="check"><input type="checkbox" data-act="page-all" ${pageAll ? 'checked' : ''} aria-label="Select all on this page"></th>
          ${th('loanNo', 'Loan')}${th('borrower', 'Borrower')}<th>Branch</th>${th('officer', 'Officer')}
          ${th('outstanding', 'Outstanding', 'right')}${th('overdue', 'Overdue', 'right')}${th('dpd', 'Status')}
        </tr></thead>
        <tbody>
          ${data.rows.map((r) => `
            <tr class="clickable ${selected.has(r.id) ? 'selected' : ''}" data-id="${esc(r.id)}">
              <td class="check"><input type="checkbox" data-act="row" ${selected.has(r.id) ? 'checked' : ''} aria-label="Select ${esc(r.loanNo)}"></td>
              <td class="primary" data-label="Loan"><div class="cell-main">${esc(r.loanNo)}</div><div class="cell-sub">${esc(r.product)}</div></td>
              <td data-label="Borrower"><div>${esc(r.borrower.name)}</div><div class="cell-sub">${esc(r.borrower.phone)}${r.borrower.village ? ` · ${esc(r.borrower.village)}` : ''}</div></td>
              <td data-label="Branch">${esc(r.branch)}</td>
              <td data-label="Officer">${r.officerCode ? `${esc(r.officerName || r.officerCode)} <span class="cell-sub">${esc(r.officerCode)}</span>` : '<span class="badge warn">Unassigned</span>'}</td>
              <td class="right num" data-label="Outstanding">${inr(r.outstanding)}</td>
              <td class="right num" data-label="Overdue">${r.overdue ? inr(r.overdue) : '<span class="muted">—</span>'}</td>
              <td data-label="Status">${ageBadge(r.bucket, r.dpd)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    ${pager(data, 'loans')}`;
}

// ---------- detail drawer ----------

async function openLoan(id) {
  openDrawer(`${drawerHead('Loading…')}<div class="drawer-body"><div class="empty">Loading…</div></div>`);
  let res;
  try {
    res = await api(`loans/${encodeURIComponent(id)}`);
  } catch (ex) {
    toast(ex.message, 'bad');
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
  const depositTag = (d) => d ? ({ pending: '<span class="badge warn">Pending</span>', verified: '<span class="badge ok">Verified</span>', rejected: '<span class="badge bad">Rejected</span>' })[d.verification] : '';
  const d = openDrawer(`
    ${drawerHead(esc(loan.loanNo), `${esc(b.name)} · ${esc(loan.branch)}`)}
    <div class="drawer-body">
      <div class="mini-kpis">
        <div><span>Outstanding</span><b>${inr(st.outstanding)}</b></div>
        <div><span>Overdue</span><b>${inr(st.overdue)}</b></div>
        <div><span>Days past due</span><b>${num(st.dpd)}</b></div>
        <div><span>Next due</span><b>${st.nextDue ? date(st.nextDue.date) : '—'}</b></div>
      </div>

      <section class="section">
        <h3>Assigned officer</h3>
        <form class="input-group" id="assign-form">
          <select class="select" name="officer" aria-label="Officer">${officerOptions(loan.branch, loan.officerCode)}</select>
          <button class="btn primary" type="submit">Save</button>
        </form>
        <div class="muted small" style="margin-top:6px">Only active officers of ${esc(loan.branch)} are listed. The change shows on their phone within a minute.</div>
      </section>

      <section class="section">
        <h3>Borrower</h3>
        <dl class="dl">
          <dt>Name</dt><dd>${esc(b.name)}</dd>
          <dt>Phone</dt><dd><a href="tel:${esc(b.phone)}">${esc(b.phone)}</a></dd>
          ${b.business ? `<dt>Business</dt><dd>${esc(b.business)}</dd>` : ''}
          <dt>Address</dt><dd>${esc([b.address, b.village].filter(Boolean).join(', ') || '—')}${b.lat != null ? ` · <a href="https://www.google.com/maps?q=${b.lat},${b.lng}" target="_blank" rel="noopener">map</a>` : ''}</dd>
          ${b.guarantor ? `<dt>Guarantor</dt><dd>${esc(b.guarantor.name || '—')}${b.guarantor.phone ? ` · ${esc(b.guarantor.phone)}` : ''}</dd>` : ''}
        </dl>
      </section>

      <section class="section">
        <h3>Loan</h3>
        <dl class="dl">
          <dt>Product</dt><dd>${esc(loan.product)}</dd>
          <dt>Principal</dt><dd>${inr(loan.principal)}</dd>
          <dt>EMI</dt><dd>${inr2(loan.emi)} × ${num(loan.installments.length)}</dd>
          <dt>Disbursed</dt><dd>${date(loan.disbursedOn)}</dd>
          <dt>Source</dt><dd>${meta.importFile ? `${esc(meta.importFile)} · ${dateTime(meta.importedAt)}` : 'Created by script / seed'}</dd>
          <dt>Last updated</dt><dd>${dateTime(meta.updatedAt)}</dd>
        </dl>
      </section>

      <section class="section">
        <h3>Payments (${loan.payments.length})</h3>
        ${loan.payments.length ? `<div class="card table-wrap"><table class="data compact">
          <thead><tr><th>Date</th><th class="right">Amount</th><th>Mode</th><th>Receipt</th></tr></thead>
          <tbody>${[...loan.payments].reverse().map((p) => `<tr>
            <td class="nowrap">${dateTime(p.at)}</td><td class="right num">${inr2(p.amount)}</td>
            <td>${esc(p.mode)} ${depositTag(p.deposit)}${p.deposit?.note ? `<div class="cell-sub">${esc(p.deposit.note)}</div>` : ''}</td>
            <td class="cell-sub">${esc(p.receiptNo)}<br>${esc(p.officer)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No payments yet.</p>'}
      </section>

      <section class="section">
        <h3>Visits (${loan.visits.length})</h3>
        ${loan.visits.length ? `<ul class="activity card">${[...loan.visits].reverse().slice(0, 20).map((v) => `
          <li><div class="what"><b>${esc(v.outcome.replace(/_/g, ' ').toLowerCase())}</b>${v.ptpDate ? ` · promised ${inr(v.ptpAmount)} by ${date(v.ptpDate)}` : ''}${v.notes ? `<div class="cell-sub">${esc(v.notes)}</div>` : ''}</div>
          <span class="when">${dateTime(v.at)}<br>${esc(v.officer)}</span></li>`).join('')}</ul>` : '<p class="muted">No visits yet.</p>'}
      </section>

      <section class="section">
        <details>
          <summary style="cursor:pointer;font-weight:600">Repayment schedule (${loan.installments.length} installments)</summary>
          <div class="card table-wrap" style="margin-top:10px"><table class="data compact">
            <thead><tr><th>#</th><th>Due</th><th class="right">Amount</th><th>Status</th></tr></thead>
            <tbody>${paidUpTo.map((i) => `<tr>
              <td>${i.no}</td><td>${date(i.dueDate)}</td><td class="right num">${inr2(i.amount)}</td>
              <td>${i.paid >= i.amount ? '<span class="badge ok">Paid</span>' : i.paid > 0 ? `<span class="badge warn">Part · ${inr(i.amount - i.paid)} due</span>` : i.dueDate <= today ? '<span class="badge bad">Overdue</span>' : '<span class="muted">Upcoming</span>'}</td>
            </tr>`).join('')}</tbody></table></div>
        </details>
      </section>
    </div>`);

  d.onsubmit = async (e) => {
    e.preventDefault();
    const officerCode = e.target.officer.value || null;
    try {
      await api(`loans/${encodeURIComponent(loan.id)}`, { method: 'PATCH', body: { officerCode } });
      toast(officerCode ? `${loan.loanNo} assigned to ${officerName(officerCode) || officerCode}` : `${loan.loanNo} unassigned`);
      closeDrawer();
      route();
    } catch (ex) {
      toast(ex.message, 'bad');
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
        <div><h1>Loans</h1><p>${plural(data.total, 'loan')} · outstanding ${inr(data.totals.outstanding)} · overdue ${inr(data.totals.overdue)}</p></div>
        <div class="page-actions">
          <button class="btn" data-act="export">${icon('download')} Export CSV</button>
          <a class="btn primary" href="#/import">${icon('upload')} Import loans</a>
        </div>
      </div>
      ${filterBar(q, branches)}
      ${bulkBar(data)}
      <section class="card">${table(data, q)}</section>`;
  };
  draw();

  const form = () => el.querySelector('#filters');
  const apply = (extra = {}, replace = false) => setQuery({ ...Object.fromEntries(new FormData(form())), page: '', ...extra }, { replace });
  let t;
  el.oninput = (e) => {
    if (e.target.name !== 'q') return;
    clearTimeout(t);
    t = setTimeout(() => {
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
      return download(`loans/export?${p}`, 'loans.csv').catch((ex) => toast(ex.message, 'bad'));
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
      if (act === 'bulk-assign' && !code) return toast('Choose an officer first.', 'bad');
      const who = code ? `${officerName(code)} (${code})` : 'nobody (unassigned)';
      if (!(await confirmDialog('Reassign loans?', `Assign ${plural(selected.size, 'loan')} to ${esc(who)}? Officers' phones update within a minute.`, 'Reassign'))) return;
      try {
        const { changed } = await api('loans/assign', { method: 'POST', body: { loanIds: [...selected], officerCode: code } });
        toast(`${plural(changed, 'loan')} reassigned`);
        selected.clear();
        route();
      } catch (ex) {
        toast(ex.message, 'bad');
      }
      return;
    }
    if (t2.closest('input[type=checkbox], a, button, select')) return;
    const row = t2.closest('tr[data-id]');
    if (row) openLoan(row.dataset.id);
  };
}
