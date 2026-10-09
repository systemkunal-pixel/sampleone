import { api, session } from '../api.js';
import { esc, icon, ago, dateTime, dialog, confirmDialog, toast } from '../../../admin/js/ui.js';
import { route } from '../main.js';

export async function render(el) {
  const { overlords } = await api('overlords');
  const me = session.get().overlord.email;
  el.innerHTML = `
    <div class="page-head">
      <div><h1>Overlord accounts</h1><p>People who can use this console. Each signs in with a password and their own authenticator app.</p></div>
      <div class="page-actions"><button class="btn primary" data-action="add">${icon('plus')} Add overlord</button></div>
    </div>
    <div class="warn-box" style="margin-bottom:16px">${icon('shield')} An overlord can enter every company. Keep this list short and deactivate people the day they leave.</div>
    <div class="card"><div class="table-wrap"><table class="data responsive">
      <thead><tr><th>Name</th><th>Status</th><th>Authenticator</th><th>Last sign-in</th><th>Added</th><th class="right">Actions</th></tr></thead>
      <tbody>${overlords.map((o) => `<tr>
        <td class="primary"><div class="cell-main">${esc(o.name)}${o.email === me ? ' <span class="badge">you</span>' : ''}</div><div class="cell-sub">${esc(o.email)}</div></td>
        <td data-label="Status">${o.active ? '<span class="badge ok"><span class="dot"></span>Active</span>' : '<span class="badge"><span class="dot"></span>Inactive</span>'}</td>
        <td data-label="Authenticator">${o.authenticator ? '<span class="badge ok">Set up</span>' : '<span class="badge warn">At next sign-in</span>'}</td>
        <td data-label="Last sign-in">${esc(ago(o.lastLoginAt))}</td>
        <td data-label="Added">${esc(dateTime(o.createdAt))}</td>
        <td class="actions"><div class="row-actions">${o.email === me ? '' : `
          ${o.authenticator ? `<button class="btn sm ghost" data-reset="${o.id}" data-name="${esc(o.name)}">${icon('refresh')} Reset authenticator</button>` : ''}
          <button class="btn sm ${o.active ? 'danger-ghost' : ''}" data-toggle="${o.id}" data-active="${o.active ? 1 : 0}" data-name="${esc(o.name)}">${o.active ? 'Deactivate' : 'Activate'}</button>`}
        </div></td>
      </tr>`).join('')}</tbody>
    </table></div></div>`;

  el.onclick = async (e) => {
    if (e.target.closest('[data-action=add]')) {
      const created = await dialog({
        title: 'Add overlord',
        ok: 'Add overlord',
        body: `<div class="form">
          <label class="field"><span>Name</span><input class="input" name="name" required maxlength="100" autofocus></label>
          <label class="field"><span>Email</span><input class="input" name="email" type="email" required maxlength="190"></label>
          <label class="field"><span>Temporary password</span>
            <div class="input-group"><input class="input" name="password" type="password" required minlength="12" autocomplete="new-password">
              <button type="button" class="btn" data-generate="password" data-kind="password">${icon('dice')} Generate</button></div>
            <span class="hint">12+ characters with letters and numbers. They set up their authenticator app at first sign-in, then can change the password.</span></label>
        </div>`,
        onOk: (data) => api('overlords', { method: 'POST', body: data }),
      });
      if (created) {
        toast('Overlord added');
        route();
      }
      return;
    }
    const reset = e.target.closest('[data-reset]');
    if (reset) {
      if (!(await confirmDialog('Reset authenticator?', `${esc(reset.dataset.name)} is signed out and must set up the authenticator app again at next sign-in. Use this when they lose their phone.`, 'Reset', true))) return;
      await api(`overlords/${reset.dataset.reset}/reset-authenticator`, { method: 'POST' });
      toast('Authenticator reset');
      return route();
    }
    const tog = e.target.closest('[data-toggle]');
    if (tog) {
      const activate = tog.dataset.active !== '1';
      if (!activate && !(await confirmDialog('Deactivate overlord?', `${esc(tog.dataset.name)} is signed out at once and can't sign in again.`, 'Deactivate', true))) return;
      try {
        await api(`overlords/${tog.dataset.toggle}`, { method: 'PATCH', body: { active: activate } });
        toast(activate ? 'Activated' : 'Deactivated');
        route();
      } catch (err) {
        toast(err.message, 'bad');
      }
    }
  };
}
