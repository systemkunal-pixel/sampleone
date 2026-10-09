import { api } from '../api.js';
import {
  esc, icon, num, inrShort, date, dateTime, ago, plural, toast, dialog, confirmDialog, openDrawer, closeDrawer, drawerHead,
  emptyState, generateSecret,
} from '../../../admin/js/ui.js';
import { route, setQuery } from '../main.js';
import { companyCell, companyStatus, planBadge, PLAN_LABEL, enterSupport, changeStatus } from './common.js';

const FEATURE_LABEL = { loan_import: 'Loan import', bank_deposits: 'Bank deposits & verification', loan_export: 'CSV export', audit_log: 'Audit log screen' };

export function render(el, query, rest) {
  return rest[0] ? renderDetail(el, Number(rest[0])) : renderList(el, query);
}

// ---------- list ----------

async function renderList(el, query) {
  const q = (query.get('q') || '').toLowerCase();
  const status = query.get('status') || '';
  const { companies } = await api(`companies?archived=${status === 'archived' || status === 'all' ? '1' : '0'}`);
  const rows = companies.filter((c) =>
    (!status || status === 'all' || c.status === status) &&
    (!q || `${c.name} ${c.code} ${c.contact.email || ''}`.toLowerCase().includes(q)));
  el.innerHTML = `
    <div class="page-head">
      <div><h1>Companies</h1><p>Each lending company is a separate workspace: its own staff, loans and audit trail.</p></div>
      <div class="page-actions"><button class="btn primary" data-action="new">${icon('plus')} New company</button></div>
    </div>
    <div class="toolbar">
      <label class="search">${icon('search')}<input class="input" type="search" name="q" placeholder="Search name, code or email" value="${esc(query.get('q') || '')}" aria-label="Search companies"></label>
      <select class="select" name="status" aria-label="Status">
        ${[['', 'Active and locked'], ['active', 'Active'], ['locked', 'Locked'], ['archived', 'Archived'], ['all', 'All, incl. archived']]
          .map(([v, l]) => `<option value="${v}" ${v === status ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>
    <div class="card">
      ${rows.length ? `
      <div class="table-wrap"><table class="data responsive">
        <thead><tr><th>Company</th><th>Status</th><th>Plan</th><th class="right">Admins</th><th class="right">Officers</th><th>Contact</th><th>Idle</th><th class="right">Actions</th></tr></thead>
        <tbody>${rows.map(listRow).join('')}</tbody>
      </table></div>` : emptyState('No companies match', 'Change the search or status filter.', 'building')}
    </div>`;

  el.onclick = async (e) => {
    const btn = e.target.closest('[data-action]');
    if (btn) {
      const c = companies.find((x) => x.id === Number(btn.dataset.id));
      if (btn.dataset.action === 'new') return openCreate();
      if (btn.dataset.action === 'enter') return enterSupport(c);
      return;
    }
    const tr = e.target.closest('tr[data-id]');
    if (tr && !e.target.closest('a,button')) location.hash = `#/companies/${tr.dataset.id}`;
  };
  let timer;
  el.oninput = (e) => {
    if (e.target.name !== 'q') return;
    clearTimeout(timer);
    timer = setTimeout(() => setQuery({ q: e.target.value.trim(), status }, { replace: true }), 300);
  };
  el.onchange = (e) => {
    if (e.target.name === 'status') setQuery({ q: query.get('q') || '', status: e.target.value });
  };
  if (query.get('new') === '1') {
    history.replaceState(null, '', '#/companies');
    openCreate();
  }
}

function listRow(c) {
  return `<tr class="clickable" data-id="${c.id}">
    <td class="primary">${companyCell(c)}</td>
    <td data-label="Status">${companyStatus(c.status)}${c.statusReason && c.status !== 'active' ? `<div class="cell-sub">${esc(c.statusReason)}</div>` : ''}</td>
    <td data-label="Plan">${planBadge(c.plan)}</td>
    <td data-label="Admins" class="right num">${num(c.admins)}</td>
    <td data-label="Officers" class="right num">${num(c.officers)}${c.maxOfficers != null ? `<span class="cell-sub"> / ${num(c.maxOfficers)}</span>` : ''}</td>
    <td data-label="Contact">${c.contact.name || c.contact.email ? `<div>${esc(c.contact.name || '')}</div><div class="cell-sub">${esc(c.contact.email || c.contact.phone || '')}</div>` : '<span class="muted">—</span>'}</td>
    <td data-label="Idle" class="nowrap">${c.idleDays == null ? '<span class="muted">never used</span>' : c.idleDays === 0 ? 'active today' : `${plural(c.idleDays, 'day')}`}</td>
    <td class="actions"><div class="row-actions">
      ${c.status === 'archived' ? '' : `<button class="btn sm" data-action="enter" data-id="${c.id}" title="Enter as support">${icon('enter')} Enter</button>`}
      <a class="btn sm ghost" href="#/companies/${c.id}">Open ${icon('chevronRight')}</a>
    </div></td>
  </tr>`;
}

// ---------- create / edit ----------

const planOptions = (sel) => Object.entries(PLAN_LABEL).map(([v, l]) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${l}</option>`).join('');

function contactFields(c = {}) {
  return `
    <div class="form-row">
      <label class="field"><span>Contact person</span><input class="input" name="contactName" maxlength="100" value="${esc(c.name || '')}"></label>
      <label class="field"><span>Contact phone</span><input class="input" name="contactPhone" maxlength="20" inputmode="tel" value="${esc(c.phone || '')}"></label>
    </div>
    <label class="field"><span>Contact email</span><input class="input" name="contactEmail" type="email" maxlength="190" value="${esc(c.email || '')}"></label>`;
}

function openCreate() {
  const d = openDrawer(`
    ${drawerHead('New company', 'Creates the workspace and its first admin.')}
    <form class="drawer-body form" id="co-form" novalidate>
      <label class="field"><span>Company name <span class="req">*</span></span>
        <input class="input" name="name" required maxlength="150" autofocus placeholder="e.g. Sanjivani Microfinance Pvt Ltd"></label>
      <div class="form-row">
        <label class="field"><span>Company code <span class="req">*</span></span>
          <input class="input" name="code" required maxlength="12" autocapitalize="characters" placeholder="e.g. SANJIVANI">
          <span class="hint">2–12 letters/digits. Staff type it when signing in. Can't be changed later.</span></label>
        <label class="field"><span>Plan</span><select class="select" name="plan">${planOptions('regular')}</select></label>
      </div>
      ${contactFields()}
      <h3 style="margin-top:6px">First admin</h3>
      <div class="form-row">
        <label class="field"><span>Admin code <span class="req">*</span></span><input class="input" name="adminCode" required maxlength="12" autocapitalize="characters" value="ADMIN"></label>
        <label class="field"><span>Admin name <span class="req">*</span></span><input class="input" name="adminName" required maxlength="100"></label>
      </div>
      <label class="field"><span>Admin password <span class="req">*</span></span>
        <div class="input-group"><input class="input" name="adminPassword" type="password" required minlength="10" autocomplete="new-password">
          <button type="button" class="btn" data-gen>${icon('dice')} Generate</button></div>
        <span class="hint">10+ characters with letters and numbers. Share it privately; they can change it after signing in.</span></label>
      <div class="error-box" data-err role="alert"></div>
    </form>
    <div class="drawer-foot"><button class="btn" data-close type="button">Cancel</button>
      <button class="btn primary" type="submit" form="co-form">Create company</button></div>`);
  const form = d.querySelector('#co-form');
  d.querySelector('[data-gen]').onclick = () => {
    form.adminPassword.value = generateSecret('password');
    form.adminPassword.type = 'text';
  };
  form.code.oninput = () => (form.code.value = form.code.value.toUpperCase().replace(/[^A-Z0-9]/g, ''));
  d.onsubmit = async (e) => {
    e.preventDefault();
    const btn = d.querySelector('[type=submit]');
    btn.disabled = true;
    const f = Object.fromEntries(new FormData(form));
    try {
      const { id } = await api('companies', {
        method: 'POST',
        body: {
          name: f.name, code: f.code, plan: f.plan, contactName: f.contactName, contactEmail: f.contactEmail, contactPhone: f.contactPhone,
          admin: { code: f.adminCode, name: f.adminName, password: f.adminPassword },
        },
      });
      closeDrawer();
      toast(`${f.name} created`);
      await dialog({
        title: 'Company created',
        cancel: '',
        ok: 'Done',
        body: `<p>Send these sign-in details to the company privately:</p>
          <dl class="dl keep"><dt>Admin console</dt><dd>${esc(new URL('../admin/', location.href).href)}</dd>
          <dt>Company code</dt><dd><b>${esc(f.code.toUpperCase())}</b></dd><dt>Admin code</dt><dd><b>${esc(f.adminCode.toUpperCase())}</b></dd>
          <dt>Password</dt><dd><code>${esc(f.adminPassword)}</code></dd></dl>`,
      });
      location.hash = `#/companies/${id}`;
    } catch (err) {
      d.querySelector('[data-err]').textContent = err.message;
      btn.disabled = false;
    }
  };
}

function openEdit(c) {
  const d = openDrawer(`
    ${drawerHead(`Edit ${esc(c.name)}`, `${esc(c.code)} · company code can't change`)}
    <form class="drawer-body form" id="co-form" novalidate>
      <label class="field"><span>Company name <span class="req">*</span></span><input class="input" name="name" required maxlength="150" value="${esc(c.name)}" autofocus></label>
      <div class="form-row">
        <label class="field"><span>Plan</span><select class="select" name="plan">${planOptions(c.plan)}</select></label>
        <label class="field"><span>Field officer limit</span><input class="input" name="maxOfficers" inputmode="numeric" value="${c.maxOfficers ?? ''}" placeholder="Plan default">
          <span class="hint">Blank uses the plan's limit.</span></label>
      </div>
      ${contactFields(c.contact)}
      <div class="error-box" data-err role="alert"></div>
    </form>
    <div class="drawer-foot"><button class="btn" data-close type="button">Cancel</button>
      <button class="btn primary" type="submit" form="co-form">Save changes</button></div>`);
  const form = d.querySelector('#co-form');
  d.onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    try {
      await api(`companies/${c.id}`, {
        method: 'PATCH',
        body: { ...f, maxOfficers: f.maxOfficers.trim() === '' ? null : Number(f.maxOfficers) },
      });
      closeDrawer();
      toast('Company updated');
      route();
    } catch (err) {
      d.querySelector('[data-err]').textContent = err.message;
    }
  };
}

function adminDialog(c, admin) {
  const reset = Boolean(admin);
  return dialog({
    title: reset ? `New password for ${esc(admin.code)}` : `Add an admin to ${esc(c.name)}`,
    ok: reset ? 'Set password' : 'Add admin',
    body: `<div class="form">
      ${reset ? `<p style="margin:0">For when ${esc(admin.name)} is locked out. Their sessions end, and the account is re-activated if it was off.</p>` : `
      <div class="form-row">
        <label class="field"><span>Admin code</span><input class="input" name="code" required maxlength="12" autocapitalize="characters" autofocus></label>
        <label class="field"><span>Full name</span><input class="input" name="name" required maxlength="100"></label>
      </div>`}
      <label class="field"><span>Password</span>
        <div class="input-group"><input class="input" name="password" type="password" required minlength="10" autocomplete="new-password" ${reset ? 'autofocus' : ''}>
          <button type="button" class="btn" data-generate="password" data-kind="password">${icon('dice')} Generate</button></div>
        <span class="hint">10+ characters with letters and numbers. Copy it before closing.</span></label>
    </div>`,
    onOk: (data) => reset
      ? api(`companies/${c.id}/admins/${encodeURIComponent(admin.code)}/password`, { method: 'POST', body: { password: data.password } })
      : api(`companies/${c.id}/admins`, { method: 'POST', body: data }),
  });
}

// ---------- detail ----------

async function renderDetail(el, id) {
  const { company: c, admins, entitlements: ent, support, history } = await api(`companies/${id}`);
  const isEmpty = !c.loans && !c.officers && !c.supervisors && !admins.length;
  el.innerHTML = `
    <div class="page-head">
      <div>
        <a href="#/companies" class="small">${icon('chevronLeft')} Companies</a>
        <h1 style="margin-top:6px">${esc(c.name)}</h1>
        <p>${esc(c.code)} · ${companyStatus(c.status)} ${planBadge(c.plan)} · since ${esc(date(c.createdAt))}</p>
      </div>
      <div class="page-actions">
        ${c.status !== 'archived' ? `<button class="btn primary" data-action="enter">${icon('enter')} Enter as support</button>` : ''}
        <button class="btn" data-action="edit">${icon('edit')} Edit</button>
        ${c.status === 'active' ? `<button class="btn danger-ghost" data-action="lock">${icon('lock')} Lock sign-in</button>` : ''}
        ${c.status === 'locked' ? `<button class="btn" data-action="unlock">${icon('lock')} Unlock</button>` : ''}
        ${c.status !== 'archived' ? `<button class="btn danger-ghost" data-action="archive">${icon('archive')} Archive</button>` : `<button class="btn primary" data-action="reopen">${icon('refresh')} Reopen</button>`}
      </div>
    </div>
    ${c.status !== 'active' ? `<div class="warn-box" style="margin-bottom:16px">${icon('alert')} <b>${c.status === 'locked' ? 'Sign-in locked' : 'Archived'}</b> ${esc(dateTime(c.statusAt))} by ${esc(c.statusBy || '—')}: ${esc(c.statusReason || 'no reason given')}</div>` : ''}
    <div class="mini-kpis">
      <div><span>Field officers</span><b>${num(c.officers)}${ent.maxOfficers != null ? ` / ${num(ent.maxOfficers)}` : ''}</b></div>
      <div><span>Supervisors · admins</span><b>${num(c.supervisors)} · ${num(c.admins)}</b></div>
      <div><span>Active loans</span><b>${num(c.activeLoans)}</b></div>
      <div><span>Outstanding</span><b>${inrShort(c.outstanding)}</b></div>
      <div><span>PAR 30</span><b>${c.outstanding ? `${c.par30Pct.toFixed(1)}%` : '—'}</b></div>
      <div><span>Collected · 30 days</span><b>${inrShort(c.collected30)}</b></div>
      <div><span>Deposits to verify</span><b>${num(c.pendingDeposits)}</b></div>
      <div><span>Last activity</span><b>${esc(ago(c.lastActivity))}</b></div>
    </div>
    <div class="grid two">
      <div class="stack">
        <div class="card">
          <div class="card-head"><div><h2>Admins</h2><p>The people who run this company's admin console.</p></div>
            <button class="btn sm" data-action="add-admin">${icon('plus')} Add admin</button></div>
          ${admins.length ? `<div class="table-wrap"><table class="data responsive">
            <thead><tr><th>Admin</th><th>Status</th><th>Last sign-in</th><th class="right">Actions</th></tr></thead>
            <tbody>${admins.map((a) => `<tr>
              <td class="primary"><div class="cell-main">${esc(a.name)}</div><div class="cell-sub">${esc(a.code)}</div></td>
              <td data-label="Status">${a.active ? '<span class="badge ok"><span class="dot"></span>Active</span>' : '<span class="badge"><span class="dot"></span>Inactive</span>'}</td>
              <td data-label="Last sign-in">${esc(ago(a.lastLoginAt))}</td>
              <td class="actions"><div class="row-actions"><button class="btn sm ghost" data-action="reset" data-code="${esc(a.code)}">${icon('key')} New password</button></div></td>
            </tr>`).join('')}</tbody></table></div>` : emptyState('No admins', 'Add one so the company can sign in.', 'users')}
        </div>
        <div class="card">
          <div class="card-head"><div><h2>Support sessions</h2><p>Every time LoanDesk entered this company.</p></div><a class="btn sm ghost" href="#/support">All ${icon('chevronRight')}</a></div>
          ${support.length ? `<div class="table-wrap"><table class="data responsive"><thead><tr><th>When</th><th>Who</th><th>Reason</th></tr></thead><tbody>
            ${support.map((s) => `<tr><td class="primary nowrap">${esc(dateTime(s.startedAt))}</td><td data-label="Who">${esc(s.overlord)}</td><td data-label="Reason">${esc(s.reason)}</td></tr>`).join('')}
          </tbody></table></div>` : emptyState('Never entered', 'Use “Enter as support” to help this company from inside.', 'headset')}
        </div>
        <div class="card">
          <div class="card-head"><div><h2>Overlord history</h2><p>Changes made to this company from the overlord console.</p></div><a class="btn sm ghost" href="#/audit?company=${c.id}">All ${icon('chevronRight')}</a></div>
          ${history.length ? `<div class="card-body"><ul class="stack" style="gap:8px;list-style:none;padding:0;margin:0">
            ${history.map((h) => `<li class="small"><b>${esc(h.action.replace(/_/g, ' '))}</b> · ${esc(h.who || '')} · <span class="muted">${esc(dateTime(h.at))}</span>
              ${h.detail?.reason ? `<div class="muted">${esc(h.detail.reason)}</div>` : ''}</li>`).join('')}
          </ul></div>` : emptyState('No changes yet', '', 'audit')}
        </div>
      </div>
      <div class="stack">
        <div class="card">
          <div class="card-head"><h2>Details</h2></div>
          <div class="card-body"><dl class="dl">
            <dt>Company code</dt><dd><b>${esc(c.code)}</b> <span class="muted small">staff type this when signing in</span></dd>
            <dt>Plan</dt><dd>${planBadge(c.plan)}</dd>
            <dt>Officer limit</dt><dd>${ent.maxOfficers == null ? 'Unlimited' : num(ent.maxOfficers)}${c.maxOfficers != null ? ' <span class="muted small">(company override)</span>' : ''}</dd>
            <dt>Contact</dt><dd>${esc(c.contact.name || '—')}${c.contact.phone ? `<br>${esc(c.contact.phone)}` : ''}${c.contact.email ? `<br><a href="mailto:${esc(c.contact.email)}">${esc(c.contact.email)}</a>` : ''}</dd>
            <dt>Loan imports</dt><dd>${num(c.imports)}</dd>
            <dt>Created</dt><dd>${esc(dateTime(c.createdAt))}</dd>
          </dl></div>
        </div>
        <div class="card">
          <div class="card-head"><div><h2>Features</h2><p>From the ${esc(PLAN_LABEL[c.plan])} plan, with this company's overrides.</p></div><a class="btn sm ghost" href="#/plans">Plans ${icon('chevronRight')}</a></div>
          <div class="card-body"><ul class="stack" style="gap:8px;list-style:none;padding:0;margin:0">
            ${Object.entries(ent.features).map(([k, on]) => `<li class="row" style="display:flex;justify-content:space-between;gap:8px">
              <span>${esc(FEATURE_LABEL[k] || k)}</span>
              <span>${k in ent.overrides ? '<span class="badge info">override</span> ' : ''}${on ? '<span class="badge ok">On</span>' : '<span class="badge">Off</span>'}</span></li>`).join('')}
          </ul></div>
        </div>
        ${isEmpty ? `<div class="card"><div class="card-head"><div><h2>Demo data</h2><p>For testing: fills this empty company with a sample branch.</p></div></div>
          <div class="card-body"><button class="btn" data-action="demo">${icon('dice')} Load demo data</button></div></div>` : ''}
      </div>
    </div>`;

  el.onclick = async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const a = btn.dataset.action;
    if (a === 'enter') return enterSupport(c);
    if (a === 'edit') return openEdit(c);
    if (['lock', 'unlock', 'archive', 'reopen'].includes(a)) {
      if (await changeStatus(c, a)) route();
      return;
    }
    if (a === 'add-admin' || a === 'reset') {
      const admin = a === 'reset' ? admins.find((x) => x.code === btn.dataset.code) : null;
      if (await adminDialog(c, admin)) {
        toast(admin ? `Password changed for ${admin.code}` : 'Admin added');
        route();
      }
      return;
    }
    if (a === 'demo') {
      if (!(await confirmDialog('Load demo data?', `Adds a demo branch to <b>${esc(c.name)}</b> with officers, a supervisor, an admin and sample loans. Only for testing companies.`, 'Load demo data'))) return;
      try {
        const res = await api(`companies/${c.id}/demo`, { method: 'POST' });
        await dialog({ title: 'Demo data loaded', cancel: '', ok: 'Done', body: `<p>Company code <b>${esc(c.code)}</b>, ${esc(res.logins)}.</p>` });
        route();
      } catch (err) {
        toast(err.message, 'bad');
      }
    }
  };
}
