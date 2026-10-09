import { api } from '../api.js';
import { esc, icon, num, inrShort, ago, emptyState } from '../../../admin/js/ui.js';
import { companyCell, companyStatus, planBadge } from './common.js';

const kpi = (label, value, sub = '', iconName = '') => `
  <div class="kpi"><div class="label">${iconName ? icon(iconName) : ''}${label}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;

export async function render(el) {
  const { totals: t, companies } = await api('overview');
  el.innerHTML = `
    <div class="page-head">
      <div><h1>Platform overview</h1><p>Every company on LoanDesk: scale, money and activity at a glance. Archived companies are left out.</p></div>
      <div class="page-actions"><a class="btn primary" href="#/companies?new=1">${icon('plus')} New company</a></div>
    </div>
    <div class="kpis six">
      ${kpi('Companies', num(t.companies), `${num(t.active)} active${t.locked ? ` · ${num(t.locked)} locked` : ''}${t.archived ? ` · ${num(t.archived)} archived` : ''}`, 'building')}
      ${kpi('Active in last 7 days', num(t.activeIn7), 'sign-ins, payments or visits', 'refresh')}
      ${kpi('Field officers', num(t.officers), 'active, all companies', 'users')}
      ${kpi('Active loans', num(t.activeLoans), `${inrShort(t.outstanding)} outstanding`, 'loans')}
      ${kpi('Collected · 30 days', inrShort(t.collected30), 'excluding rejected deposits', 'bank')}
      ${kpi('PAR 30', `${t.par30Pct.toFixed(1)}%`, 'outstanding of loans 31+ DPD', 'alert')}
    </div>
    <div class="card">
      <div class="card-head"><div><h2>Companies</h2><p>Click a company for details, support access and housekeeping.</p></div></div>
      ${companies.length ? `
      <div class="table-wrap"><table class="data responsive">
        <thead><tr><th>Company</th><th>Status</th><th>Plan</th><th>Scale</th><th class="right">Outstanding</th><th class="right">PAR 30</th>
          <th class="right">Collected · 30d</th><th>In use</th><th>Last activity</th></tr></thead>
        <tbody>${companies.map(row).join('')}</tbody>
      </table></div>` : emptyState('No companies yet', 'Create the first one from Companies.', 'building')}
    </div>`;
  el.onclick = (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr && !e.target.closest('a')) location.hash = `#/companies/${tr.dataset.id}`;
  };
}

function row(c) {
  const chips = [
    ['Bank deposits', c.deposits30 > 0],
    ['Imports', c.imports > 0],
    ['Supervisors', c.supervisors > 0],
  ].map(([label, on]) => `<span class="chip ${on ? '' : 'off'}">${label}</span>`).join('');
  return `<tr class="clickable" data-id="${c.id}">
    <td class="primary">${companyCell(c)}</td>
    <td data-label="Status">${companyStatus(c.status)}</td>
    <td data-label="Plan">${planBadge(c.plan)}</td>
    <td data-label="Scale"><div class="scale">
      <span title="Field officers">${icon('users')}${num(c.officers)}</span>
      <span title="Supervisors">${icon('shield')}${num(c.supervisors)}</span>
      <span title="Active loans">${icon('loans')}${num(c.activeLoans)}</span>
      ${c.pendingDeposits ? `<span title="Deposits awaiting verification">${icon('bank')}${num(c.pendingDeposits)}</span>` : ''}
    </div></td>
    <td data-label="Outstanding" class="right num">${inrShort(c.outstanding)}</td>
    <td data-label="PAR 30" class="right num">${c.outstanding ? `${c.par30Pct.toFixed(1)}%` : '—'}</td>
    <td data-label="Collected · 30d" class="right num">${c.collected30 ? inrShort(c.collected30) : '—'}</td>
    <td data-label="In use"><div class="chips">${chips}</div></td>
    <td data-label="Last activity" class="nowrap">${esc(ago(c.lastActivity))}</td>
  </tr>`;
}
