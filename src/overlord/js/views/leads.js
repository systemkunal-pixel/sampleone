import { api } from '../api.js';
import { esc, icon, num, dateTime, ago, toast, dialog, emptyState } from '../../../admin/js/ui.js';
import { route, setQuery } from '../main.js';

const STATUS = {
  new: ['New', 'warn'], contacted: ['Contacted', 'info'], demo_done: ['Demo done', 'brand'], won: ['Won', 'ok'], lost: ['Lost', ''],
};
const LANG = { en: 'English', hi: 'Hindi', bn: 'Bengali' };
const badge = (s) => `<span class="badge ${STATUS[s]?.[1] ?? ''}">${STATUS[s]?.[0] || esc(s)}</span>`;

export async function render(el, query) {
  const status = query.get('status') || '';
  const { leads, counts } = await api(`leads${status ? `?status=${status}` : ''}`);
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  el.innerHTML = `
    <div class="page-head">
      <div><h1>Demo requests</h1><p>People who asked for a demo on the LoanDesk home page. Call new requests within a working day.</p></div>
      <div class="page-actions"><a class="btn" href="../" target="_blank" rel="noopener">${icon('enter')} Open home page</a></div>
    </div>
    <div class="toolbar"><div class="seg" role="group" aria-label="Status">
      <button class="seg-btn ${status ? '' : 'active'}" data-status="">All ${num(total)}</button>
      ${Object.entries(STATUS).map(([k, [l]]) => `<button class="seg-btn ${status === k ? 'active' : ''}" data-status="${k}">${l} ${num(counts[k] || 0)}</button>`).join('')}
    </div></div>
    <div class="card">
      ${leads.length ? `<div class="table-wrap"><table class="data responsive">
        <thead><tr><th>Received</th><th>Name</th><th>Organisation</th><th>Contact</th><th class="right">Officers</th><th>Message</th><th>Status</th><th></th></tr></thead>
        <tbody>${leads.map((l) => `<tr>
          <td class="primary nowrap"><div class="cell-main">${esc(ago(l.at))}</div><div class="cell-sub">${esc(dateTime(l.at))}${l.lang && l.lang !== 'en' ? ` · ${esc(LANG[l.lang] || l.lang)}` : ''}</div></td>
          <td data-label="Name">${esc(l.name)}</td>
          <td data-label="Organisation">${esc(l.company)}</td>
          <td data-label="Contact"><a href="tel:+91${esc(l.phone)}">${esc(l.phone)}</a>${l.email ? `<div class="cell-sub"><a href="mailto:${esc(l.email)}">${esc(l.email)}</a></div>` : ''}</td>
          <td data-label="Officers" class="right num">${l.officers ?? '—'}</td>
          <td data-label="Message" class="small">${esc(l.message || '')}${l.note ? `<div class="cell-sub">Note: ${esc(l.note)}</div>` : ''}</td>
          <td data-label="Status">${badge(l.status)}${l.updated_by ? `<div class="cell-sub">${esc(l.updated_by)}</div>` : ''}</td>
          <td class="actions"><div class="row-actions"><button class="btn sm ghost" data-edit="${l.id}">${icon('edit')} Update</button></div></td>
        </tr>`).join('')}</tbody></table></div>`
        : emptyState('No demo requests yet', 'They appear here when someone fills in “Book a demo” on the home page.', 'users')}
    </div>`;

  el.onclick = async (e) => {
    const s = e.target.closest('[data-status]');
    if (s) return setQuery({ status: s.dataset.status });
    const ed = e.target.closest('[data-edit]');
    if (!ed) return;
    const l = leads.find((x) => x.id === Number(ed.dataset.edit));
    const done = await dialog({
      title: `${esc(l.name)} · ${esc(l.company)}`,
      ok: 'Save',
      body: `<div class="form">
        <label class="field"><span>Status</span><select class="select" name="status">
          ${Object.entries(STATUS).map(([k, [lab]]) => `<option value="${k}" ${k === l.status ? 'selected' : ''}>${lab}</option>`).join('')}</select></label>
        <label class="field"><span>Note</span><textarea class="input" name="note" rows="3" maxlength="1000">${esc(l.note || '')}</textarea></label>
      </div>`,
      onOk: (f) => api(`leads/${l.id}`, { method: 'PATCH', body: f }),
    });
    if (done) {
      toast('Saved');
      route();
    }
  };
}
