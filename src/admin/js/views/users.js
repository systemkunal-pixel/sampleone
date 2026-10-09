import { api } from '../api.js';
import {
  esc, icon, initials, num, ago, roleBadge, statusBadge, toast, openDrawer, closeDrawer, drawerHead,
  dialog, confirmDialog, emptyState, generateSecret, helpButton,
} from '../ui.js';
import { route, setQuery } from '../main.js';

const ROLES = [
  ['officer', 'Field officer', 'Collects payments in the mobile app. 4–8 digit PIN.'],
  ['supervisor', 'Supervisor', 'Verifies bank deposits for one branch. 4–8 digit PIN.'],
  ['admin', 'Admin', 'Uses this console. Password of 10+ characters.'],
];
const isAdmin = (role) => role === 'admin';
const credLabel = (role) => (isAdmin(role) ? 'Password' : 'PIN');
const credHint = (role) => (isAdmin(role) ? 'At least 10 characters, with letters and numbers.' : '4–8 digits. Share it with the user privately.');

let cache = { users: [], branches: [] };

function credentialField(role, required = true) {
  return `
    <label class="field" data-cred><span>${credLabel(role)} ${required ? '<span class="req">*</span>' : ''}</span>
      <div class="input-group">
        <input class="input" name="pin" type="password" ${required ? 'required' : ''} autocomplete="new-password"
          ${isAdmin(role) ? 'minlength="10"' : 'inputmode="numeric" pattern="[0-9]{4,8}" maxlength="8"'}>
        <button type="button" class="btn" data-generate="pin" data-kind="${isAdmin(role) ? 'password' : 'pin'}">${icon('dice')} Generate</button>
      </div>
      <span class="hint">${credHint(role)}</span>
    </label>`;
}

function userForm(u) {
  const editing = Boolean(u);
  const role = u?.role || 'officer';
  return `
    ${drawerHead(editing ? `Edit ${esc(u.name)}` : 'Add user', editing ? `${esc(u.code)} · created ${esc(ago(u.createdAt))}` : 'Create a login for a field officer, supervisor or admin.')}
    <form class="drawer-body form" id="user-form" novalidate>
      <div class="form-row">
        <label class="field"><span>User code <span class="req">*</span></span>
          <input class="input" name="code" required maxlength="12" autocapitalize="characters" placeholder="e.g. FO42"
            value="${esc(u?.code || '')}" ${editing ? 'readonly' : 'autofocus'}>
          <span class="hint">${editing ? 'Codes cannot be changed.' : 'Letters and digits; used to sign in.'}</span>
        </label>
        <label class="field"><span>Full name <span class="req">*</span></span>
          <input class="input" name="name" required maxlength="100" value="${esc(u?.name || '')}" ${editing ? 'autofocus' : ''}>
        </label>
      </div>
      <fieldset class="field" style="border:0;padding:0;margin:0"><span>Role <span class="req">*</span></span>
        <div class="roles">
          ${ROLES.map(([value, label, desc]) => `
            <label class="role-opt"><input type="radio" name="role" value="${value}" ${role === value ? 'checked' : ''}>
              <b>${label}</b><small>${desc}</small></label>`).join('')}
        </div>
      </fieldset>
      <label class="field"><span>Branch <span class="req">*</span></span>
        <input class="input" name="branch" required maxlength="100" list="branch-list" value="${esc(u?.branch || (role === 'admin' ? 'Head Office' : ''))}" placeholder="e.g. Lucknow Rural">
        <datalist id="branch-list">${cache.branches.map((b) => `<option value="${esc(b)}">`).join('')}</datalist>
        <span class="hint">Officers only see loans of their branch; supervisors verify deposits for it.</span>
      </label>
      <div data-cred-slot>${editing ? '' : credentialField(role)}</div>
      ${editing && u.role === 'officer' && u.loans ? `<div class="info-box">${icon('loans')} ${num(u.loans)} loan(s) are assigned to ${esc(u.code)}. To change their branch or role, <a href="#/loans?officer=${encodeURIComponent(u.code)}">reassign the loans</a> first.</div>` : ''}
      <div class="error-box" data-err role="alert"></div>
    </form>
    <div class="drawer-foot">
      <button class="btn" data-close type="button">Cancel</button>
      <button class="btn primary" type="submit" form="user-form">${editing ? 'Save changes' : 'Create user'}</button>
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
      ? `<div class="warn-box" style="margin-bottom:12px">${icon('key')} Changing to ${isAdmin(role) ? 'admin' : 'a field role'} needs a new ${credLabel(role).toLowerCase()}.</div>${credentialField(role)}`
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
      err.textContent = 'Fill in the code, name and branch.';
      return;
    }
    const btn = d.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      if (u) {
        await api(`users/${encodeURIComponent(u.code)}`, {
          method: 'PATCH', body: { name: data.name, role: data.role, branch: data.branch, ...(data.pin ? { pin: data.pin } : {}) },
        });
        toast(`${u.code} updated`);
      } else {
        await api('users', { method: 'POST', body: data });
        toast(`${data.code.toUpperCase()} created`);
      }
      const shown = data.pin;
      closeDrawer();
      if (shown) showSecret(`${credLabel(data.role)} for ${(u?.code || data.code).toUpperCase()}`, shown);
      route();
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
    }
  };
}

function showSecret(title, secret) {
  dialog({
    title,
    cancel: null,
    ok: 'Done',
    body: `<p>Share this with the user privately. It won't be shown again.</p>
      <div class="secret"><span>${esc(secret)}</span><button type="button" class="icon-btn" data-copy="${esc(secret)}" aria-label="Copy">${icon('copy')}</button></div>`,
  });
  document.getElementById('dlg').querySelector('[data-copy]').onclick = async (e) => {
    try {
      await navigator.clipboard.writeText(e.currentTarget.dataset.copy);
      toast('Copied');
    } catch {
      toast('Copy failed — select and copy it manually', 'bad');
    }
  };
}

async function resetPin(u) {
  const kind = isAdmin(u.role) ? 'password' : 'pin';
  const result = await dialog({
    title: `Reset ${credLabel(u.role).toLowerCase()} for ${esc(u.name)}`,
    ok: `Reset ${credLabel(u.role).toLowerCase()}`,
    body: `
      <p>${esc(u.code)} will be signed out on all devices and must use the new ${credLabel(u.role).toLowerCase()}.</p>
      <label class="field"><span>New ${credLabel(u.role).toLowerCase()}</span>
        <div class="input-group">
          <input class="input" name="pin" type="text" required autocomplete="off" value="${generateSecret(kind)}">
          <button type="button" class="btn" data-generate="pin" data-kind="${kind}">${icon('dice')} New</button>
        </div>
        <span class="hint">${credHint(u.role)}</span>
      </label>`,
    onOk: async ({ pin }) => {
      await api(`users/${encodeURIComponent(u.code)}/reset-pin`, { method: 'POST', body: { pin } });
      return { pin };
    },
  });
  if (result?.pin) showSecret(`New ${credLabel(u.role).toLowerCase()} for ${u.code}`, result.pin);
}

async function toggleActive(u) {
  const deactivate = u.active;
  const ok = await confirmDialog(
    deactivate ? `Deactivate ${esc(u.name)}?` : `Reactivate ${esc(u.name)}?`,
    deactivate
      ? `${esc(u.code)} will be signed out immediately and won't be able to sign in. Their records are kept.`
      : `${esc(u.code)} will be able to sign in again with their existing ${credLabel(u.role).toLowerCase()}.`,
    deactivate ? 'Deactivate' : 'Reactivate',
    deactivate,
  );
  if (!ok) return;
  try {
    await api(`users/${encodeURIComponent(u.code)}`, { method: 'PATCH', body: { active: !u.active } });
    toast(`${u.code} ${deactivate ? 'deactivated' : 'reactivated'}`);
    route();
  } catch (ex) {
    if (ex.status === 409) {
      const go = await confirmDialog('Loans still assigned', `${esc(ex.message)}`, 'Reassign loans');
      if (go) location.hash = `#/loans?officer=${encodeURIComponent(u.code)}`;
    } else toast(ex.message, 'bad');
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
  const sel = (name, value, options) => `<select class="select" name="${name}" aria-label="${name}">${options.map(([v, l]) => `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const counts = { active: users.filter((u) => u.active).length, inactive: users.filter((u) => !u.active).length };

  el.innerHTML = `
    <div class="page-head">
      <div><h1>Users</h1><p>${num(counts.active)} active · ${num(counts.inactive)} deactivated</p></div>
      <div class="page-actions">${helpButton('add-user')}<button class="btn primary" data-act="add">${icon('plus')} Add user</button></div>
    </div>
    <form class="toolbar" id="filters" role="search">
      <label class="search"><span class="sr-only">Search users</span>${icon('search')}<input class="input" name="q" type="search" placeholder="Search name or code" value="${esc(q.get('q') || '')}"></label>
      ${sel('role', q.get('role') || '', [['', 'All roles'], ['officer', 'Field officers'], ['supervisor', 'Supervisors'], ['admin', 'Admins']])}
      ${sel('branch', q.get('branch') || '', [['', 'All branches'], ...branches.map((b) => [b, b])])}
      ${sel('status', q.get('status') || 'active', [['active', 'Active'], ['inactive', 'Deactivated'], ['all', 'All statuses']])}
    </form>
    <section class="card">
      ${rows.length ? `
      <div class="table-wrap">
        <table class="data responsive">
          <thead><tr><th>User</th><th>Role</th><th>Branch</th><th class="right">Loans</th><th>Last sign-in</th><th>Status</th><th class="right"><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>
            ${rows.map((u) => `
              <tr data-code="${esc(u.code)}">
                <td class="primary" data-label="User"><div style="display:flex;gap:10px;align-items:center">
                  <span class="avatar">${esc(initials(u.name))}</span>
                  <div><div class="cell-main">${esc(u.name)}</div><div class="cell-sub">${esc(u.code)}</div></div></div></td>
                <td data-label="Role">${roleBadge(u.role)}</td>
                <td data-label="Branch">${esc(u.branch)}</td>
                <td class="right num" data-label="Loans">${u.role === 'officer' ? `<a href="#/loans?officer=${encodeURIComponent(u.code)}">${num(u.loans)}</a>` : '<span class="muted">—</span>'}</td>
                <td data-label="Last sign-in" title="${esc(u.lastLoginAt || '')}">${esc(ago(u.lastLoginAt))}</td>
                <td data-label="Status">${statusBadge(u.active)}</td>
                <td class="actions" data-label="">
                  <div class="row-actions">
                    <button class="icon-btn" data-act="edit" title="Edit" aria-label="Edit ${esc(u.code)}">${icon('edit')}</button>
                    <button class="icon-btn" data-act="pin" title="Reset ${credLabel(u.role)}" aria-label="Reset ${credLabel(u.role)} for ${esc(u.code)}">${icon('key')}</button>
                    <button class="icon-btn ${u.active ? 'danger' : ''}" data-act="toggle" title="${u.active ? 'Deactivate' : 'Reactivate'}" aria-label="${u.active ? 'Deactivate' : 'Reactivate'} ${esc(u.code)}">${icon('power')}</button>
                  </div>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="table-foot"><span>${num(rows.length)} of ${num(users.length)} users</span></div>`
      : emptyState('No users match', users.length ? 'Try clearing the filters.' : 'Add your first user to get started.', 'users')}
    </section>`;

  const form = el.querySelector('#filters');
  const apply = (replace) => setQuery(Object.fromEntries(new FormData(form)), { replace });
  let t;
  el.oninput = (e) => {
    if (e.target.name !== 'q') return;
    clearTimeout(t);
    t = setTimeout(() => {
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
