import { api } from '../api.js';
import {
  esc, icon, initials, num, ago, roleBadge, statusBadge, toast, openDrawer, closeDrawer, drawerHead,
  dialog, confirmDialog, emptyState, generateSecret, helpButton,
} from '../ui.js';
import { t, tr } from '../../../i18n/i18n.js';
import { route, setQuery } from '../main.js';

// English labels, translated where shown: t(label), t(desc).
/* i18n: t('Field officer') t('Collects payments in the mobile app. 4–8 digit PIN.')
   t('Supervisor') t('Verifies bank deposits for one branch. 4–8 digit PIN.')
   t('Admin') t('Uses this console. Password of 10+ characters.') */
const ROLES = [
  ['officer', 'Field officer', 'Collects payments in the mobile app. 4–8 digit PIN.'],
  ['supervisor', 'Supervisor', 'Verifies bank deposits for one branch. 4–8 digit PIN.'],
  ['admin', 'Admin', 'Uses this console. Password of 10+ characters.'],
];
const isAdmin = (role) => role === 'admin';
const credLabel = (role) => (isAdmin(role) ? t('Password') : t('PIN'));
const credHint = (role) => (isAdmin(role) ? t('At least 10 characters, with letters and numbers.') : t('4–8 digits. Share it with the user privately.'));

let cache = { users: [], branches: [] };

function credentialField(role, required = true) {
  return `
    <label class="field" data-cred><span>${credLabel(role)} ${required ? '<span class="req">*</span>' : ''}</span>
      <div class="input-group">
        <input class="input" name="pin" type="password" ${required ? 'required' : ''} autocomplete="new-password"
          ${isAdmin(role) ? 'minlength="10"' : 'inputmode="numeric" pattern="[0-9]{4,8}" maxlength="8"'}>
        <button type="button" class="btn" data-generate="pin" data-kind="${isAdmin(role) ? 'password' : 'pin'}">${icon('dice')} ${t('Generate')}</button>
      </div>
      <span class="hint">${credHint(role)}</span>
    </label>`;
}

function userForm(u) {
  const editing = Boolean(u);
  const role = u?.role || 'officer';
  return `
    ${drawerHead(editing ? t('Edit {name}', { name: esc(u.name) }) : t('Add user'), editing ? t('{code} · created {when}', { code: esc(u.code), when: esc(ago(u.createdAt)) }) : t('Create a login for a field officer, supervisor or admin.'))}
    <form class="drawer-body form" id="user-form" novalidate>
      <div class="form-row">
        <label class="field"><span>${t('User code')} <span class="req">*</span></span>
          <input class="input" name="code" required maxlength="12" autocapitalize="characters" placeholder="${esc(t('e.g. FO42'))}"
            value="${esc(u?.code || '')}" ${editing ? 'readonly' : 'autofocus'}>
          <span class="hint">${editing ? t('Codes cannot be changed.') : t('Letters and digits; used to sign in.')}</span>
        </label>
        <label class="field"><span>${t('Full name')} <span class="req">*</span></span>
          <input class="input" name="name" required maxlength="100" value="${esc(u?.name || '')}" ${editing ? 'autofocus' : ''}>
        </label>
      </div>
      <fieldset class="field" style="border:0;padding:0;margin:0"><span>${t('Role')} <span class="req">*</span></span>
        <div class="roles">
          ${ROLES.map(([value, label, desc]) => `
            <label class="role-opt"><input type="radio" name="role" value="${value}" ${role === value ? 'checked' : ''}>
              <b>${esc(t(label))}</b><small>${esc(t(desc))}</small></label>`).join('')}
        </div>
      </fieldset>
      <label class="field"><span>${t('Branch')} <span class="req">*</span></span>
        <input class="input" name="branch" required maxlength="100" list="branch-list" value="${esc(u?.branch || (role === 'admin' ? 'Head Office' : ''))}" placeholder="${esc(t('e.g. Lucknow Rural'))}">
        <datalist id="branch-list">${cache.branches.map((b) => `<option value="${esc(b)}">`).join('')}</datalist>
        <span class="hint">${t('Officers only see loans of their branch; supervisors verify deposits for it.')}</span>
      </label>
      <div data-cred-slot>${editing ? '' : credentialField(role)}</div>
      ${editing && u.role === 'officer' && u.loans ? `<div class="info-box">${icon('loans')} ${(() => {
        const link = `<a href="#/loans?officer=${encodeURIComponent(u.code)}">${t('reassign the loans')}</a>`;
        return u.loans === 1
          ? t('1 loan is assigned to {code}. To change their branch or role, {link} first.', { code: esc(u.code), link })
          : t('{n} loans are assigned to {code}. To change their branch or role, {link} first.', { n: num(u.loans), code: esc(u.code), link });
      })()}</div>` : ''}
      <div class="error-box" data-err role="alert"></div>
    </form>
    <div class="drawer-foot">
      <button class="btn" data-close type="button">${t('Cancel')}</button>
      <button class="btn primary" type="submit" form="user-form">${editing ? t('Save changes') : t('Create user')}</button>
    </div>`;
}

function openUserForm(u) {
  const d = openDrawer(userForm(u));
  const form = d.querySelector('#user-form');
  const slot = d.querySelector('[data-cred-slot]');
  d.onchange = (e) => {
    if (e.target.name !== 'role') return;
    const role = e.target.value;
    if (!u) slot.innerHTML = credentialField(role);
    // Switching between admin and field roles needs a new credential of the other kind.
    else slot.innerHTML = isAdmin(role) !== isAdmin(u.role)
      ? `<div class="warn-box" style="margin-bottom:12px">${icon('key')} ${isAdmin(role) ? t('Changing to admin needs a new password.') : t('Changing to a field role needs a new PIN.')}</div>${credentialField(role)}`
      : '';
    if (role === 'admin' && !form.branch.value) form.branch.value = 'Head Office';
  };
  d.onclick = (e) => {
    const gen = e.target.closest('[data-generate]');
    if (!gen) return;
    form.pin.value = generateSecret(gen.dataset.kind);
    form.pin.type = 'text';
  };
  d.onsubmit = async (e) => {
    e.preventDefault();
    const err = d.querySelector('[data-err]');
    const data = Object.fromEntries(new FormData(form));
    err.textContent = '';
    const missing = ['code', 'name', 'branch'].filter((k) => !String(data[k] || '').trim());
    if (missing.length) {
      err.textContent = t('Fill in the code, name and branch.');
      return;
    }
    const btn = d.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      if (u) {
        await api(`users/${encodeURIComponent(u.code)}`, {
          method: 'PATCH', body: { name: data.name, role: data.role, branch: data.branch, ...(data.pin ? { pin: data.pin } : {}) },
        });
        toast(t('{code} updated', { code: u.code }));
      } else {
        await api('users', { method: 'POST', body: data });
        toast(t('{code} created', { code: data.code.toUpperCase() }));
      }
      const shown = data.pin;
      closeDrawer();
      const who = (u?.code || data.code).toUpperCase();
      if (shown) showSecret(isAdmin(data.role) ? t('Password for {code}', { code: who }) : t('PIN for {code}', { code: who }), shown);
      route();
    } catch (ex) {
      err.textContent = tr(ex.message);
      btn.disabled = false;
    }
  };
}

function showSecret(title, secret) {
  dialog({
    title,
    cancel: null,
    ok: t('Done'),
    body: `<p>${t(`Share this with the user privately. It won't be shown again.`)}</p>
      <div class="secret"><span>${esc(secret)}</span><button type="button" class="icon-btn" data-copy="${esc(secret)}" aria-label="${esc(t('Copy'))}">${icon('copy')}</button></div>`,
  });
  document.getElementById('dlg').querySelector('[data-copy]').onclick = async (e) => {
    try {
      await navigator.clipboard.writeText(e.currentTarget.dataset.copy);
      toast(t('Copied'));
    } catch {
      toast(t('Copy failed — select and copy it manually'), 'bad');
    }
  };
}

async function resetPin(u) {
  const kind = isAdmin(u.role) ? 'password' : 'pin';
  const pw = isAdmin(u.role);
  const result = await dialog({
    title: pw ? t('Reset password for {name}', { name: esc(u.name) }) : t('Reset PIN for {name}', { name: esc(u.name) }),
    ok: pw ? t('Reset password') : t('Reset PIN'),
    body: `
      <p>${pw ? t('{code} will be signed out on all devices and must use the new password.', { code: esc(u.code) }) : t('{code} will be signed out on all devices and must use the new PIN.', { code: esc(u.code) })}</p>
      <label class="field"><span>${pw ? t('New password') : t('New PIN')}</span>
        <div class="input-group">
          <input class="input" name="pin" type="text" required autocomplete="off" value="${generateSecret(kind)}">
          <button type="button" class="btn" data-generate="pin" data-kind="${kind}">${icon('dice')} ${t('New')}</button>
        </div>
        <span class="hint">${credHint(u.role)}</span>
      </label>`,
    onOk: async ({ pin }) => {
      await api(`users/${encodeURIComponent(u.code)}/reset-pin`, { method: 'POST', body: { pin } });
      return { pin };
    },
  });
  if (result?.pin) showSecret(pw ? t('New password for {code}', { code: u.code }) : t('New PIN for {code}', { code: u.code }), result.pin);
}

async function toggleActive(u) {
  const deactivate = u.active;
  const ok = await confirmDialog(
    deactivate ? t('Deactivate {name}?', { name: esc(u.name) }) : t('Reactivate {name}?', { name: esc(u.name) }),
    deactivate
      ? t(`{code} will be signed out immediately and won't be able to sign in. Their records are kept.`, { code: esc(u.code) })
      : isAdmin(u.role)
        ? t('{code} will be able to sign in again with their existing password.', { code: esc(u.code) })
        : t('{code} will be able to sign in again with their existing PIN.', { code: esc(u.code) }),
    deactivate ? t('Deactivate') : t('Reactivate'),
    deactivate,
  );
  if (!ok) return;
  try {
    await api(`users/${encodeURIComponent(u.code)}`, { method: 'PATCH', body: { active: !u.active } });
    toast(deactivate ? t('{code} deactivated', { code: u.code }) : t('{code} reactivated', { code: u.code }));
    route();
  } catch (ex) {
    if (ex.status === 409) {
      const go = await confirmDialog(t('Loans still assigned'), `${esc(tr(ex.message))}`, t('Reassign loans'));
      if (go) location.hash = `#/loans?officer=${encodeURIComponent(u.code)}`;
    } else toast(tr(ex.message), 'bad');
  }
}

function filtered(users, q) {
  const text = (q.get('q') || '').trim().toLowerCase();
  const role = q.get('role') || '';
  const branch = q.get('branch') || '';
  const status = q.get('status') || 'active';
  return users.filter((u) =>
    (!text || `${u.code} ${u.name}`.toLowerCase().includes(text)) &&
    (!role || u.role === role) &&
    (!branch || u.branch === branch) &&
    (status === 'all' || (status === 'active') === u.active));
}

export async function render(el, q, alive) {
  const [{ users }, { branches }] = await Promise.all([api('users'), api('branches')]);
  if (!alive()) return;
  cache = { users, branches };
  const rows = filtered(users, q);
  const sel = (name, label, value, options) => `<select class="select" name="${name}" aria-label="${esc(label)}">${options.map(([v, l]) => `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const counts = { active: users.filter((u) => u.active).length, inactive: users.filter((u) => !u.active).length };

  el.innerHTML = `
    <div class="page-head">
      <div><h1>${t('Users')}</h1><p>${t('{active} active · {inactive} deactivated', { active: num(counts.active), inactive: num(counts.inactive) })}</p></div>
      <div class="page-actions">${helpButton('add-user')}<button class="btn primary" data-act="add">${icon('plus')} ${t('Add user')}</button></div>
    </div>
    <form class="toolbar" id="filters" role="search">
      <label class="search"><span class="sr-only">${t('Search users')}</span>${icon('search')}<input class="input" name="q" type="search" placeholder="${esc(t('Search name or code'))}" value="${esc(q.get('q') || '')}"></label>
      ${sel('role', t('Role'), q.get('role') || '', [['', t('All roles')], ['officer', t('Field officers')], ['supervisor', t('Supervisors')], ['admin', t('Admins')]])}
      ${sel('branch', t('Branch'), q.get('branch') || '', [['', t('All branches')], ...branches.map((b) => [b, b])])}
      ${sel('status', t('Status'), q.get('status') || 'active', [['active', t('Active')], ['inactive', t('Deactivated')], ['all', t('All statuses')]])}
    </form>
    <section class="card">
      ${rows.length ? `
      <div class="table-wrap">
        <table class="data responsive">
          <thead><tr><th>${t('User')}</th><th>${t('Role')}</th><th>${t('Branch')}</th><th class="right">${t('Loans')}</th><th>${t('Last sign-in')}</th><th>${t('Status')}</th><th class="right"><span class="sr-only">${t('Actions')}</span></th></tr></thead>
          <tbody>
            ${rows.map((u) => `
              <tr data-code="${esc(u.code)}">
                <td class="primary" data-label="${esc(t('User'))}"><div style="display:flex;gap:10px;align-items:center">
                  <span class="avatar">${esc(initials(u.name))}</span>
                  <div><div class="cell-main">${esc(u.name)}</div><div class="cell-sub">${esc(u.code)}</div></div></div></td>
                <td data-label="${esc(t('Role'))}">${roleBadge(u.role)}</td>
                <td data-label="${esc(t('Branch'))}">${esc(u.branch)}</td>
                <td class="right num" data-label="${esc(t('Loans'))}">${u.role === 'officer' ? `<a href="#/loans?officer=${encodeURIComponent(u.code)}">${num(u.loans)}</a>` : '<span class="muted">—</span>'}</td>
                <td data-label="${esc(t('Last sign-in'))}" title="${esc(u.lastLoginAt || '')}">${esc(ago(u.lastLoginAt))}</td>
                <td data-label="${esc(t('Status'))}">${statusBadge(u.active)}</td>
                <td class="actions" data-label="">
                  <div class="row-actions">
                    <button class="icon-btn" data-act="edit" title="${esc(t('Edit'))}" aria-label="${esc(t('Edit {code}', { code: u.code }))}">${icon('edit')}</button>
                    <button class="icon-btn" data-act="pin" title="${esc(isAdmin(u.role) ? t('Reset password') : t('Reset PIN'))}" aria-label="${esc(isAdmin(u.role) ? t('Reset password for {name}', { name: u.code }) : t('Reset PIN for {name}', { name: u.code }))}">${icon('key')}</button>
                    <button class="icon-btn ${u.active ? 'danger' : ''}" data-act="toggle" title="${esc(u.active ? t('Deactivate') : t('Reactivate'))}" aria-label="${esc(u.active ? t('Deactivate {code}', { code: u.code }) : t('Reactivate {code}', { code: u.code }))}">${icon('power')}</button>
                  </div>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="table-foot"><span>${users.length === 1 ? t('{shown} of 1 user', { shown: num(rows.length) }) : t('{shown} of {n} users', { shown: num(rows.length), n: num(users.length) })}</span></div>`
      : emptyState(t('No users match'), users.length ? t('Try clearing the filters.') : t('Add your first user to get started.'), 'users')}
    </section>`;

  const form = el.querySelector('#filters');
  const apply = (replace) => setQuery(Object.fromEntries(new FormData(form)), { replace });
  let timer;
  el.oninput = (e) => {
    if (e.target.name !== 'q') return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const pos = e.target.selectionStart;
      apply(true);
      requestAnimationFrame(() => {
        const input = el.querySelector('input[name=q]');
        input?.focus();
        input?.setSelectionRange(pos, pos);
      });
    }, 250);
  };
  el.onchange = (e) => e.target.closest('#filters') && e.target.name !== 'q' && apply(false);
  el.onsubmit = (e) => e.preventDefault();
  el.onclick = (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const u = users.find((x) => x.code === btn.closest('tr')?.dataset.code);
    if (btn.dataset.act === 'add') openUserForm(null);
    if (btn.dataset.act === 'edit') openUserForm(u);
    if (btn.dataset.act === 'pin') resetPin(u);
    if (btn.dataset.act === 'toggle') toggleActive(u);
  };
}
