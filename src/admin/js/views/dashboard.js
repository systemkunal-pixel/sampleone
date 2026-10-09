import { api } from '../api.js';
import { esc, icon, inr, inrShort, num, plural, ago, emptyState, helpButton } from '../ui.js';
import { setPendingBadge } from '../main.js';
import { describe } from './audit.js';

const pct = (n) => `${Number(n || 0).toFixed(1)}%`;

function kpi({ label, value, sub = '', href, cls = '', title = '' }) {
  const tag = href ? 'a' : 'div';
  return `<${tag} class="kpi ${cls}" ${href ? `href="${href}"` : ''} ${title ? `title="${esc(title)}"` : ''}>
    <div class="label">${label}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}
  </${tag}>`;
}

/** Portfolio ageing: outstanding by DPD bucket, one-hue ordinal ramp, directly labelled. */
function ageing(buckets, total) {
  const max = Math.max(1, ...buckets.map((b) => b.outstanding));
  return `
    <div class="ageing" role="list">
      ${buckets.map((b) => `
        <a class="ageing-row" role="listitem" href="#/loans?bucket=${encodeURIComponent(b.key)}">
          <span class="lbl">${esc(b.label)}</span>
          <span class="track"><span class="bar a-${esc(b.key)}" style="width:${(b.outstanding / max) * 100}%"></span></span>
          <span class="val"><b>${inrShort(b.outstanding)}</b> <span class="muted">· ${plural(b.loans, 'loan')}</span></span>
          <span class="tip">${esc(b.label)}<br>${plural(b.loans, 'loan')} · outstanding ${inr(b.outstanding)}<br>overdue ${inr(b.overdue)} · ${pct(total ? (b.outstanding / total) * 100 : 0)} of book</span>
        </a>`).join('')}
    </div>`;
}

const CHECKLIST_KEY = 'loan-recovery:admin:hide-checklist';
const hidden = () => { try { return localStorage.getItem(CHECKLIST_KEY) === '1'; } catch { return false; } };

/** Setup steps for a new installation; ticks itself off from live data. */
function checklist(s) {
  const steps = [
    { done: s.users.supervisors > 0, label: 'Add a supervisor for each branch', href: '#/users', guide: 'add-user' },
    { done: s.users.officers > 0, label: 'Add your field officers', href: '#/users', guide: 'add-user' },
    { done: s.loans.total > 0, label: 'Import your loans', href: '#/import', guide: 'import-loans' },
    { done: s.loans.total > 0 && s.loans.unassigned === 0, label: 'Assign every loan to an officer', href: '#/loans?officer=__none', guide: 'assign-loans' },
    { done: null, label: 'Install the app on officers’ phones and train them', href: '#/help?topic=rollout-plan', guide: 'install-phone' },
  ];
  const known = steps.filter((x) => x.done !== null);
  const doneCount = known.filter((x) => x.done).length;
  if (hidden() || doneCount === known.length) return '';
  return `
    <section class="card checklist" aria-label="Getting started">
      <div class="card-head"><div><h2>Getting started</h2><p>${doneCount} of ${known.length} setup steps done. Follow them in order — each has a guide.</p></div>
        <button class="btn sm ghost" data-act="hide-checklist">Hide</button></div>
      <ol class="check-steps">
        ${steps.map((x) => `<li class="${x.done ? 'done' : ''}">
          <span class="check-mark" aria-hidden="true">${x.done ? icon('check') : ''}</span>
          <a href="${x.href}">${esc(x.label)}</a>
          <a class="muted small" href="#/help?topic=${x.guide}">How?</a>
          ${x.done ? '<span class="sr-only">(done)</span>' : ''}
        </li>`).join('')}
      </ol>
    </section>`;
}

export async function render(el, query, alive) {
  const s = await api('summary');
  if (!alive()) return;
  setPendingBadge(s.pendingDeposits.count);
  const overduePct = s.outstanding ? (s.overdue / s.outstanding) * 100 : 0;
  el.innerHTML = `
    <div class="page-head">
      <div><h1>Dashboard</h1><p>Portfolio health across ${plural(s.branches.length, 'branch', 'branches')}, as of now.</p></div>
      <div class="page-actions">
        ${helpButton('read-dashboard')}
        <a class="btn" href="#/import">${icon('upload')} Import loans</a>
        <a class="btn primary" href="#/users">${icon('plus')} Add user</a>
      </div>
    </div>

    ${checklist(s)}

    <section class="kpis" aria-label="Key figures">
      ${kpi({ label: 'Total outstanding', value: inrShort(s.outstanding), sub: `${plural(s.loans.active, 'active loan')}`, title: inr(s.outstanding) })}
      ${kpi({ label: 'Overdue', value: inrShort(s.overdue), sub: `${pct(overduePct)} of outstanding`, cls: s.overdue ? 'alert' : '', title: inr(s.overdue) })}
      ${kpi({ label: 'PAR 30', value: pct(s.par30Pct), sub: 'Outstanding on loans 30+ days late', title: 'Portfolio at risk: share of outstanding balance on loans more than 30 days past due' })}
      ${kpi({ label: 'Collected today', value: inrShort(s.collections.today), sub: `${plural(s.collections.todayCount, 'receipt')} · month ${inrShort(s.collections.month)}`, title: inr(s.collections.today) })}
      ${kpi({ label: 'Deposits to verify', value: num(s.pendingDeposits.count), sub: s.pendingDeposits.count ? `${inr(s.pendingDeposits.amount)} awaiting supervisors` : 'All verified', cls: s.pendingDeposits.count ? 'attention' : '' })}
      ${kpi({ label: 'Unassigned loans', value: num(s.loans.unassigned), sub: s.loans.unassigned ? 'Assign to an officer →' : 'Every loan has an officer', href: s.loans.unassigned ? '#/loans?officer=__none' : '', cls: s.loans.unassigned ? 'attention' : '' })}
    </section>

    <div class="grid two">
      <div class="stack">
        <section class="card">
          <div class="card-head"><div><h2>Portfolio ageing</h2><p>Outstanding balance by days past due. Select a band to see its loans.</p></div></div>
          <div class="card-body">${s.loans.active ? ageing(s.buckets, s.outstanding) : emptyState('No active loans', 'Import loans to see portfolio ageing.', 'loans')}</div>
        </section>

        <section class="card">
          <div class="card-head"><div><h2>Branches</h2><p>Select a branch to open its loans.</p></div></div>
          ${s.branches.length ? `
          <div class="table-wrap">
            <table class="data responsive">
              <thead><tr><th>Branch</th><th class="right">Loans</th><th class="right">Officers</th><th class="right">Outstanding</th><th class="right">Overdue</th><th class="right">PAR 30</th><th class="right">To verify</th></tr></thead>
              <tbody>
                ${s.branches.map((b) => `
                  <tr class="clickable" data-href="#/loans?branch=${encodeURIComponent(b.branch)}">
                    <td class="primary" data-label="Branch"><div class="cell-main">${esc(b.branch)}</div>${b.unassigned ? `<div class="cell-sub">${plural(b.unassigned, 'unassigned loan')}</div>` : ''}</td>
                    <td class="right num" data-label="Loans">${num(b.loans)}</td>
                    <td class="right num" data-label="Officers">${num(b.officers)}</td>
                    <td class="right num" data-label="Outstanding">${inr(b.outstanding)}</td>
                    <td class="right num" data-label="Overdue">${inr(b.overdue)}</td>
                    <td class="right num" data-label="PAR 30">${pct(b.outstanding ? (b.par30 / b.outstanding) * 100 : 0)}</td>
                    <td class="right num" data-label="To verify">${b.pendingDeposits ? `<span class="badge warn">${b.pendingDeposits}</span>` : '—'}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>` : emptyState('No branches yet', 'Branches appear when you add users or import loans.', 'bank')}
        </section>
      </div>

      <div class="stack">
        <section class="card">
          <div class="card-head"><div><h2>Team</h2><p>Active accounts</p></div><a class="btn sm" href="#/users">Manage</a></div>
          <div class="card-body">
            <dl class="dl keep">
              <dt>Field officers</dt><dd class="num"><b>${num(s.users.officers)}</b></dd>
              <dt>Supervisors</dt><dd class="num"><b>${num(s.users.supervisors)}</b></dd>
              <dt>Admins</dt><dd class="num"><b>${num(s.users.admins)}</b></dd>
              <dt>Deactivated</dt><dd class="num">${num(s.users.inactive)}</dd>
            </dl>
          </div>
        </section>
        <section class="card">
          <div class="card-head"><div><h2>Recent activity</h2></div><a class="btn sm" href="#/audit">View all</a></div>
          ${s.recent.length ? `<ul class="activity">${s.recent.map((a) => `
            <li><span class="avatar">${esc((a.user_code || '?').slice(0, 2))}</span>
              <div class="what"><b>${esc(a.user_code || 'System')}</b> ${esc(describe(a.action))}${a.entity_id ? ` <span class="muted">${esc(a.entity_id)}</span>` : ''}</div>
              <span class="when">${esc(ago(a.at))}</span></li>`).join('')}</ul>` : emptyState('No activity yet', '', 'audit')}
        </section>
      </div>
    </div>`;

  el.onclick = (e) => {
    if (e.target.closest('[data-act=hide-checklist]')) {
      try { localStorage.setItem(CHECKLIST_KEY, '1'); } catch { /* private mode */ }
      e.target.closest('.checklist')?.remove();
      return;
    }
    const row = e.target.closest('tr[data-href]');
    if (row) location.hash = row.dataset.href;
  };
}
