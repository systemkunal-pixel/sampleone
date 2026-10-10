// Clients: the lenders whose accounts this company recovers (e.g. VFS Capital Limited). Each client's
// accounts are imported, reported and billed separately; agents work every client's accounts in their pincodes.
import { api } from '../api.js';
import { esc, icon, inr, num, date, toast, openDrawer, closeDrawer, drawerHead, emptyState, helpButton } from '../ui.js';
import { t, tr } from '../../../i18n/i18n.js';
import { route } from '../main.js';

function form(c) {
  const editing = Boolean(c);
  return `
    ${drawerHead(editing ? t('Edit {name}', { name: esc(c.name) }) : t('Add client'), editing ? esc(c.code) : t('A lender whose accounts you recover.'))}
    <form class="drawer-body form" id="client-form" novalidate>
      <div class="form-row">
        <label class="field"><span>${t('Client code')} <span class="req">*</span></span>
          <input class="input" name="code" required maxlength="20" autocapitalize="characters" value="${esc(c?.code || '')}" placeholder="${esc(t('e.g. VFS'))}" ${editing ? '' : 'autofocus'}>
          <span class="hint">${t('Short code used in lists and reports.')}</span></label>
        <label class="field"><span>${t('Fee %')}</span>
          <input class="input" name="feePct" type="number" min="0" max="100" step="0.01" value="${esc(c?.feePct ?? '')}">
          <span class="hint">${t('Optional. Used in the billing report.')}</span></label>
      </div>
      <label class="field"><span>${t('Full name')} <span class="req">*</span></span>
        <input class="input" name="name" required maxlength="150" value="${esc(c?.name || '')}" placeholder="${esc(t('e.g. VFS Capital Limited'))}" ${editing ? 'autofocus' : ''}></label>
      <h3 style="margin:6px 0 0">${t('Billing contact')}</h3>
      <label class="field"><span>${t('Name')}</span><input class="input" name="contactName" maxlength="100" value="${esc(c?.contactName || '')}"></label>
      <div class="form-row">
        <label class="field"><span>${t('Email')}</span><input class="input" name="contactEmail" type="email" maxlength="190" value="${esc(c?.contactEmail || '')}"></label>
        <label class="field"><span>${t('Phone')}</span><input class="input" name="contactPhone" maxlength="20" value="${esc(c?.contactPhone || '')}"></label>
      </div>
      ${editing ? `<label class="row" style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="active" ${c.active ? 'checked' : ''}> ${t('Active (new files can be imported for this client)')}</label>` : ''}
      <div class="error-box" data-err role="alert"></div>
    </form>
    <div class="drawer-foot">
      <button class="btn" data-close type="button">${t('Cancel')}</button>
      <button class="btn primary" type="submit" form="client-form">${editing ? t('Save changes') : t('Add client')}</button>
    </div>`;
}

function openForm(c) {
  const d = openDrawer(form(c));
  const f = d.querySelector('#client-form');
  d.onsubmit = async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(f));
    const body = { ...data, active: c ? f.active.checked : undefined };
    const err = d.querySelector('[data-err]');
    err.textContent = '';
    const btn = d.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      if (c) await api(`clients/${c.id}`, { method: 'PATCH', body });
      else await api('clients', { method: 'POST', body });
      toast(c ? t('{name} saved', { name: data.name }) : t('{name} added', { name: data.name }));
      closeDrawer();
      route();
    } catch (ex) {
      err.textContent = tr(ex.message);
      btn.disabled = false;
    }
  };
}

// ---------- circles of one client ----------

function circleForm(data, ci) {
  const has = (kind, v) => Boolean(ci && ci[kind].some((x) => (kind === 'districts' ? `${x.state}|${x.district}` : x) === v));
  return `
    ${drawerHead(ci ? t('Edit circle {name}', { name: esc(ci.name) }) : t('Add circle'), esc(data.client.name))}
    <form class="drawer-body form" id="circle-form" novalidate>
      <div class="form-row">
        <label class="field"><span>${t('Circle name')} <span class="req">*</span></span>
          <input class="input" name="name" required maxlength="100" value="${esc(ci?.name || '')}" placeholder="${esc(t('e.g. Kolkata Circle'))}" autofocus></label>
        <label class="field"><span>${t('Fee %')}</span><input class="input" name="feePct" type="number" min="0" max="100" step="0.01" value="${esc(ci?.feePct ?? '')}">
          <span class="hint">${t('Blank = the client’s fee %.')}</span></label>
      </div>
      <p class="muted small" style="margin:0">${t('Tick whole states, or single districts (from any state). An account goes to the most specific match: pincode, then district, then state.')}</p>
      ${data.states.map((s) => `
        <fieldset class="circle-state">
          <label class="row"><input type="checkbox" name="state" value="${esc(s.state)}" ${has('states', s.state) ? 'checked' : ''}> <b>${esc(s.state)}</b> <span class="muted small">${t('whole state')} · ${num(s.accounts)}</span></label>
          <div class="circle-districts">${s.districts.map((d) => `<label class="row"><input type="checkbox" name="district" value="${esc(`${s.state}|${d.district}`)}" ${has('districts', `${s.state}|${d.district}`) ? 'checked' : ''}> ${esc(d.district)} <span class="muted small">${num(d.accounts)}</span></label>`).join('')}</div>
        </fieldset>`).join('')}
      <label class="field"><span>${t('Single pincodes')}</span><textarea class="input" name="pincodes" rows="2" placeholder="711302, 711401">${esc(ci?.pincodes.join(', ') || '')}</textarea>
        <span class="hint">${t('Optional, for edge cases: these pincodes join this circle whatever their district.')}</span></label>
      <div class="error-box" data-err role="alert"></div>
    </form>
    <div class="drawer-foot">
      ${ci ? `<button class="btn danger-ghost" type="button" data-act="delete-circle" style="margin-right:auto">${t('Delete')}</button>` : ''}
      <button class="btn" data-close type="button">${t('Cancel')}</button>
      <button class="btn primary" type="submit" form="circle-form">${t('Save')}</button>
    </div>`;
}

async function renderCircles(el, id) {
  const data = await api(`clients/${id}/circles`);
  el.innerHTML = `
    <div class="page-head">
      <div><a href="#/clients" class="small">${icon('chevronLeft')} ${t('Clients')}</a>
        <h1 style="margin-top:6px">${t('Circles of {client}', { client: esc(data.client.name) })}</h1>
        <p>${t('Billing areas you define. A circle can take whole states or districts from more than one state; a Circle column in the client’s file overrides these rules.')}</p></div>
      <div class="page-actions">${helpButton('circles')}<button class="btn primary" data-act="add-circle">${icon('plus')} ${t('Add circle')}</button></div>
    </div>
    ${data.unmatched ? `<div class="warn-box" style="margin-bottom:16px">${icon('alert')} ${data.unmatched === 1 ? t('1 account is in no circle; it is billed under its state.') : t('{n} accounts are in no circle; they are billed under their state.', { n: num(data.unmatched) })}</div>` : ''}
    <section class="card">
      ${data.circles.length ? `<div class="table-wrap"><table class="data responsive">
        <thead><tr><th>${t('Circle')}</th><th>${t('Covers')}</th><th class="right">${t('Accounts')}</th><th class="right">${t('Fee %')}</th><th></th></tr></thead>
        <tbody>${data.circles.map((ci) => `<tr data-id="${ci.id}">
          <td class="primary"><b>${esc(ci.name)}</b></td>
          <td data-label="${esc(t('Covers'))}" class="small">${[
            ...ci.states.map((s) => `<span class="badge brand">${esc(s)}</span>`),
            ...ci.districts.map((d) => `<span class="badge">${esc(d.district)} <span class="muted">· ${esc(d.state)}</span></span>`),
            ...ci.pincodes.map((p) => `<span class="badge info">${esc(p)}</span>`),
          ].join(' ') || `<span class="muted">${t('Only accounts whose file names this circle')}</span>`}</td>
          <td class="right num" data-label="${esc(t('Accounts'))}">${num(ci.accounts)}</td>
          <td class="right num" data-label="${esc(t('Fee %'))}">${ci.feePct != null ? `${num(ci.feePct)}%` : `<span class="muted">${data.client.feePct != null ? `${num(data.client.feePct)}%` : '—'}</span>`}</td>
          <td class="actions"><button class="icon-btn" data-act="edit-circle" aria-label="${esc(t('Edit'))}">${icon('edit')}</button></td>
        </tr>`).join('')}</tbody></table></div>`
        : emptyState(t('No circles yet'), t('Without circles, collections are billed by state. Add a circle to group districts the way the client bills.'), 'map')}
    </section>`;

  const open = (ci) => {
    const d = openDrawer(circleForm(data, ci));
    const f = d.querySelector('#circle-form');
    d.onclick = async (e) => {
      if (!e.target.closest('[data-act=delete-circle]')) return;
      try {
        await api(`clients/${id}/circles/${ci.id}`, { method: 'DELETE' });
        toast(t('{name} deleted', { name: ci.name }));
        closeDrawer();
        renderCircles(el, id);
      } catch (ex) {
        toast(tr(ex.message), 'bad');
      }
    };
    d.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(f);
      const body = { name: fd.get('name'), feePct: fd.get('feePct'), states: fd.getAll('state'), districts: fd.getAll('district'), pincodes: fd.get('pincodes') };
      try {
        const r = await api(`clients/${id}/circles${ci ? `/${ci.id}` : ''}`, { method: ci ? 'PUT' : 'POST', body });
        toast(r.unmatched ? t('Saved. {n} accounts are still in no circle.', { n: num(r.unmatched) }) : t('Saved. Every account is in a circle.'));
        closeDrawer();
        renderCircles(el, id);
      } catch (ex) {
        d.querySelector('[data-err]').textContent = tr(ex.message);
      }
    };
  };
  el.onclick = (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'add-circle') open(null);
    if (act === 'edit-circle') open(data.circles.find((c) => String(c.id) === e.target.closest('tr').dataset.id));
  };
}

export async function render(el, q, alive) {
  if (q.get('circles')) return renderCircles(el, q.get('circles'));
  const { clients } = await api('clients');
  if (!alive()) return;
  el.innerHTML = `
    <div class="page-head">
      <div><h1>${t('Clients')}</h1><p>${t('The lenders whose accounts you recover. Each client’s accounts are imported, reported and billed separately.')}</p></div>
      <div class="page-actions">${helpButton('clients')}<button class="btn primary" data-act="add">${icon('plus')} ${t('Add client')}</button></div>
    </div>
    <section class="card">
      ${clients.length ? `<div class="table-wrap"><table class="data responsive">
        <thead><tr><th>${t('Client')}</th><th class="right">${t('Accounts')}</th><th class="right">${t('Overdue in file')}</th><th class="right">${t('Fee %')}</th><th>${t('Billing contact')}</th><th>${t('Status')}</th><th></th></tr></thead>
        <tbody>${clients.map((c) => `<tr data-id="${c.id}">
          <td class="primary"><div class="cell-main">${esc(c.name)}</div><div class="cell-sub">${esc(c.code)} · ${t('since {date}', { date: esc(date(c.createdAt)) })}</div></td>
          <td class="right num" data-label="${esc(t('Accounts'))}"><a href="#/loans?client=${c.id}">${num(c.accounts)}</a></td>
          <td class="right num" data-label="${esc(t('Overdue in file'))}">${c.overdue ? inr(c.overdue) : '—'}</td>
          <td class="right num" data-label="${esc(t('Fee %'))}">${c.feePct != null ? `${num(c.feePct)}%` : '—'}</td>
          <td data-label="${esc(t('Billing contact'))}">${esc(c.contactName || '')}${c.contactEmail ? `<div class="cell-sub">${esc(c.contactEmail)}</div>` : ''}${!c.contactName && !c.contactEmail ? '<span class="muted">—</span>' : ''}</td>
          <td data-label="${esc(t('Status'))}">${c.active ? `<span class="badge ok"><span class="dot"></span>${t('Active')}</span>` : `<span class="badge"><span class="dot"></span>${t('Deactivated')}</span>`}</td>
          <td class="actions"><div class="row-actions">
            <a class="btn sm ghost" href="#/clients?circles=${c.id}">${icon('map')} ${t('Circles')}</a>
            <a class="btn sm ghost" href="#/billing?client=${c.id}">${icon('sheet')} ${t('Billing')}</a>
            <a class="btn sm ghost" href="#/import">${icon('upload')} ${t('Import')}</a>
            <button class="icon-btn" data-act="edit" title="${esc(t('Edit'))}" aria-label="${esc(t('Edit {code}', { code: c.code }))}">${icon('edit')}</button></div></td>
        </tr>`).join('')}</tbody></table></div>`
        : emptyState(t('No clients yet'), t('Add the lenders whose accounts you recover, then import each one’s file for that client.'), 'building')}
    </section>`;
  el.onclick = (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'add') openForm(null);
    if (act === 'edit') openForm(clients.find((c) => String(c.id) === e.target.closest('tr').dataset.id));
  };
}
