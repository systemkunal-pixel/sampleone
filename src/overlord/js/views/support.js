import { api } from '../api.js';
import { esc, icon, num, dateTime, emptyState, pager, openDrawer, drawerHead, confirmDialog, toast } from '../../../admin/js/ui.js';
import { route, setQuery } from '../main.js';

function duration(s) {
  const end = s.endedAt || (s.live ? null : s.expiresAt);
  if (!end) return '';
  const mins = Math.max(1, Math.round((Date.parse(end.replace(' ', 'T')) - Date.parse(s.startedAt.replace(' ', 'T'))) / 60000));
  return `${num(mins)} min`;
}

export async function render(el, query) {
  const data = await api(`support-sessions?page=${Number(query.get('page')) || 1}`);
  el.innerHTML = `
    <div class="page-head">
      <div><h1>Support sessions</h1><p>Every entry into a company's account: who, where, why and for how long. This log can't be edited.</p></div>
    </div>
    <div class="card">
      ${data.rows.length ? `
      <div class="table-wrap"><table class="data responsive">
        <thead><tr><th>Company</th><th>Overlord</th><th>Reason</th><th>Started</th><th>Ended</th><th class="right">Actions logged</th><th>IP</th><th></th></tr></thead>
        <tbody>${data.rows.map((s) => `<tr>
          <td class="primary"><a href="#/companies/${s.companyId}" class="cell-main">${esc(s.companyName)}</a><div class="cell-sub">${esc(s.companyCode)}</div></td>
          <td data-label="Overlord">${esc(s.overlord)}<div class="cell-sub">${esc(s.overlordEmail)}</div></td>
          <td data-label="Reason">${esc(s.reason)}</td>
          <td data-label="Started" class="nowrap">${esc(dateTime(s.startedAt))}</td>
          <td data-label="Ended" class="nowrap">${s.live ? '<span class="live">Live now</span>' : `${esc(dateTime(s.endedAt || s.expiresAt))}<div class="cell-sub">${s.endedAt ? 'exited' : 'timed out'} · ${duration(s)}</div>`}</td>
          <td data-label="Actions logged" class="right num">${s.actions ? `<button class="btn sm ghost" data-actions="${s.id}">${num(s.actions)}</button>` : '0'}</td>
          <td data-label="IP" class="nowrap"><code>${esc(s.ip || '—')}</code></td>
          <td class="actions"><div class="row-actions">${s.live ? `<button class="btn sm danger-ghost" data-end="${s.id}">End now</button>` : ''}</div></td>
        </tr>`).join('')}</tbody>
      </table></div>
      ${pager({ page: data.page, pages: data.pages, total: data.total, pageSize: 50 }, 'sessions')}`
      : emptyState('No support sessions yet', 'Use “Enter as support” on a company to help it from inside. Each entry is listed here.', 'headset')}
    </div>`;
  el.onclick = async (e) => {
    const page = e.target.closest('[data-page]');
    if (page) return setQuery({ page: page.dataset.page });
    const end = e.target.closest('[data-end]');
    if (end) {
      if (!(await confirmDialog('End this support session?', 'The support tab is signed out straight away.', 'End session', true))) return;
      await api(`support-sessions/${end.dataset.end}/end`, { method: 'POST' });
      toast('Support session ended');
      return route();
    }
    const act = e.target.closest('[data-actions]');
    if (act) {
      const s = data.rows.find((r) => r.id === Number(act.dataset.actions));
      const { rows } = await api(`support-sessions/${s.id}/actions`);
      openDrawer(`${drawerHead(`What support did in ${esc(s.companyName)}`, `${esc(s.overlord)} · ${esc(dateTime(s.startedAt))}`)}
        <div class="drawer-body"><p class="muted small" style="margin-top:0">Reason: ${esc(s.reason)}</p>
          <ul class="stack" style="gap:10px;list-style:none;padding:0;margin:0">${rows.map((r) => `<li><b>${esc(r.action.replace(/_/g, ' '))}</b>
            ${r.entityId ? `<code>${esc(r.entityId)}</code>` : ''} <span class="muted small">${esc(dateTime(r.at))}</span>
            ${r.detail ? `<div class="muted small">${esc(JSON.stringify(r.detail))}</div>` : ''}</li>`).join('')}</ul></div>`);
    }
  };
}
