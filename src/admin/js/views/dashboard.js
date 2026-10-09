import { api } from '../api.js';
import { esc, icon, inr, inrShort, num, ago, emptyState, helpButton } from '../ui.js';
import { t } from '../../../i18n/i18n.js';
import { setPendingBadge } from '../main.js';
import { describe } from './audit.js';

const pct = (n) => `${Number(n || 0).toFixed(1)}%`;
const loansCount = (n) => (n === 1 ? t('1 loan') : t('{n} loans', { n: num(n) }));

function kpi({ label, value, sub = '', href, cls = '', title = '' }) {
  const tag = href ? 'a' : 'div';
  return `<${tag} class="kpi ${cls}" ${href ? `href="${href}"` : ''} ${title ? `title="${esc(title)}"` : ''}>
    <div class="label">${label}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}
  </${tag}>`;
}

/* Bucket labels come from the server (DPD_BUCKETS in src/js/logic.js) and are translated where shown.
   i18n: t('Current') t('1–30 DPD') t('31–60 DPD') t('61–90 DPD') t('90+ DPD (NPA)') */

/** Portfolio ageing: outstanding by DPD bucket, one-hue ordinal ramp, directly labelled. */
function ageing(buckets, total) {
  const max = Math.max(1, ...buckets.map((b) => b.outstanding));
  return `
    <div class="ageing" role="list">
      ${buckets.map((b) => `
        <a class="ageing-row" role="listitem" href="#/loans?bucket=${encodeURIComponent(b.key)}">
          <span class="lbl">${esc(t(b.label))}</span>
          <span class="track"><span class="bar a-${esc(b.key)}" style="width:${(b.outstanding / max) * 100}%"></span></span>
          <span class="val"><b>${inrShort(b.outstanding)}</b> <span class="muted">· ${loansCount(b.loans)}</span></span>
          <span class="tip">${esc(t(b.label))}<br>${t('{loans} · outstanding {amount}', { loans: loansCount(b.loans), amount: inr(b.outstanding) })}<br>${t('overdue {amount} · {pct} of book', { amount: inr(b.overdue), pct: pct(total ? (b.outstanding / total) * 100 : 0) })}</span>
        </a>`).join('')}
    </div>`;
}

const CHECKLIST_KEY = 'loan-recovery:admin:hide-checklist';
const hidden = () => { try { return localStorage.getItem(CHECKLIST_KEY) === '1'; } catch { return false; } };

/** Setup steps for a new installation; ticks itself off from live data. */
function checklist(s) {
  const steps = [
    { done: s.users.supervisors > 0, label: t('Add a supervisor for each branch'), href: '#/users', guide: 'add-user' },
    { done: s.users.officers > 0, label: t('Add your field officers'), href: '#/users', guide: 'add-user' },
    { done: s.loans.total > 0, label: t('Import your loans'), href: '#/import', guide: 'import-loans' },
    { done: s.loans.total > 0 && s.loans.unassigned === 0, label: t('Assign every loan to an officer'), href: '#/loans?officer=__none', guide: 'assign-loans' },
    { done: null, label: t('Install the app on officers’ phones and train them'), href: '#/help?topic=rollout-plan', guide: 'install-phone' },
  ];
  const known = steps.filter((x) => x.done !== null);
  const doneCount = known.filter((x) => x.done).length;
  if (hidden() || doneCount === known.length) return '';
  return `
    <section class="card checklist" aria-label="${esc(t('Getting started'))}">
      <div class="card-head"><div><h2>${t('Getting started')}</h2><p>${t('{done} of {total} setup steps done. Follow them in order — each has a guide.', { done: doneCount, total: known.length })}</p></div>
        <button class="btn sm ghost" data-act="hide-checklist">${t('Hide')}</button></div>
      <ol class="check-steps">
        ${steps.map((x) => `<li class="${x.done ? 'done' : ''}">
          <span class="check-mark" aria-hidden="true">${x.done ? icon('check') : ''}</span>
          <a href="${x.href}">${esc(x.label)}</a>
          <a class="muted small" href="#/help?topic=${x.guide}">${t('How?')}</a>
          ${x.done ? `<span class="sr-only">${t('(done)')}</span>` : ''}
        </li>`).join('')}
      </ol>
    </section>`;
}

export async function render(el, query, alive) {
  const s = await api('summary');
  if (!alive()) return;
  setPendingBadge(s.pendingDeposits.count);
  const overduePct = s.outstanding ? (s.overdue / s.outstanding) * 100 : 0;
  const nb = s.branches.length;
  const ac = s.loans.active;
  const rc = s.collections.todayCount;
  el.innerHTML = `
    <div class="page-head">
      <div><h1>${t('Dashboard')}</h1><p>${nb === 1 ? t('Portfolio health across 1 branch, as of now.') : t('Portfolio health across {n} branches, as of now.', { n: num(nb) })}</p></div>
      <div class="page-actions">
        ${helpButton('read-dashboard')}
        <a class="btn" href="#/import" data-needs="loan_import">${icon('upload')} ${t('Import loans')}</a>
        <a class="btn primary" href="#/users">${icon('plus')} ${t('Add user')}</a>
      </div>
    </div>

    ${checklist(s)}

    <section class="kpis" aria-label="${esc(t('Key figures'))}">
      ${kpi({ label: t('Total outstanding'), value: inrShort(s.outstanding), sub: ac === 1 ? t('1 active loan') : t('{n} active loans', { n: num(ac) }), title: inr(s.outstanding) })}
      ${kpi({ label: t('Overdue'), value: inrShort(s.overdue), sub: t('{pct} of outstanding', { pct: pct(overduePct) }), cls: s.overdue ? 'alert' : '', title: inr(s.overdue) })}
      ${kpi({ label: t('PAR 30'), value: pct(s.par30Pct), sub: t('Outstanding on loans 30+ days late'), title: t('Portfolio at risk: share of outstanding balance on loans more than 30 days past due') })}
      ${kpi({ label: t('Collected today'), value: inrShort(s.collections.today), sub: rc === 1 ? t('1 receipt · month {amount}', { amount: inrShort(s.collections.month) }) : t('{n} receipts · month {amount}', { n: num(rc), amount: inrShort(s.collections.month) }), title: inr(s.collections.today) })}
      ${kpi({ label: t('Deposits to verify'), value: num(s.pendingDeposits.count), sub: s.pendingDeposits.count ? t('{amount} awaiting supervisors', { amount: inr(s.pendingDeposits.amount) }) : t('All verified'), cls: s.pendingDeposits.count ? 'attention' : '' })}
      ${kpi({ label: t('Unassigned loans'), value: num(s.loans.unassigned), sub: s.loans.unassigned ? t('Assign to an officer →') : t('Every loan has an officer'), href: s.loans.unassigned ? '#/loans?officer=__none' : '', cls: s.loans.unassigned ? 'attention' : '' })}
    </section>

    <div class="grid two">
      <div class="stack">
        <section class="card">
          <div class="card-head"><div><h2>${t('Portfolio ageing')}</h2><p>${t('Outstanding balance by days past due. Select a band to see its loans.')}</p></div></div>
          <div class="card-body">${s.loans.active ? ageing(s.buckets, s.outstanding) : emptyState(t('No active loans'), t('Import loans to see portfolio ageing.'), 'loans')}</div>
        </section>

        <section class="card">
          <div class="card-head"><div><h2>${t('Branches')}</h2><p>${t('Select a branch to open its loans.')}</p></div></div>
          ${s.branches.length ? `
          <div class="table-wrap">
            <table class="data responsive">
              <thead><tr><th>${t('Branch')}</th><th class="right">${t('Loans')}</th><th class="right">${t('Officers')}</th><th class="right">${t('Outstanding')}</th><th class="right">${t('Overdue')}</th><th class="right">${t('PAR 30')}</th><th class="right">${t('To verify')}</th></tr></thead>
              <tbody>
                ${s.branches.map((b) => `
                  <tr class="clickable" data-href="#/loans?branch=${encodeURIComponent(b.branch)}">
                    <td class="primary" data-label="${esc(t('Branch'))}"><div class="cell-main">${esc(b.branch)}</div>${b.unassigned ? `<div class="cell-sub">${b.unassigned === 1 ? t('1 unassigned loan') : t('{n} unassigned loans', { n: num(b.unassigned) })}</div>` : ''}</td>
                    <td class="right num" data-label="${esc(t('Loans'))}">${num(b.loans)}</td>
                    <td class="right num" data-label="${esc(t('Officers'))}">${num(b.officers)}</td>
                    <td class="right num" data-label="${esc(t('Outstanding'))}">${inr(b.outstanding)}</td>
                    <td class="right num" data-label="${esc(t('Overdue'))}">${inr(b.overdue)}</td>
                    <td class="right num" data-label="${esc(t('PAR 30'))}">${pct(b.outstanding ? (b.par30 / b.outstanding) * 100 : 0)}</td>
                    <td class="right num" data-label="${esc(t('To verify'))}">${b.pendingDeposits ? `<span class="badge warn">${b.pendingDeposits}</span>` : '—'}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>` : emptyState(t('No branches yet'), t('Branches appear when you add users or import loans.'), 'bank')}
        </section>
      </div>

      <div class="stack">
        <section class="card">
          <div class="card-head"><div><h2>${t('Team')}</h2><p>${t('Active accounts')}</p></div><a class="btn sm" href="#/users">${t('Manage')}</a></div>
          <div class="card-body">
            <dl class="dl keep">
              <dt>${t('Field officers')}</dt><dd class="num"><b>${num(s.users.officers)}</b></dd>
              <dt>${t('Supervisors')}</dt><dd class="num"><b>${num(s.users.supervisors)}</b></dd>
              <dt>${t('Admins')}</dt><dd class="num"><b>${num(s.users.admins)}</b></dd>
              <dt>${t('Deactivated')}</dt><dd class="num">${num(s.users.inactive)}</dd>
            </dl>
          </div>
        </section>
        <section class="card">
          <div class="card-head"><div><h2>${t('Recent activity')}</h2></div><a class="btn sm" href="#/audit" data-needs="audit_log">${t('View all')}</a></div>
          ${s.recent.length ? `<ul class="activity">${s.recent.map((a) => `
            <li><span class="avatar">${esc((a.user_code || '?').slice(0, 2))}</span>
              <div class="what"><b>${esc(a.user_code || t('System'))}</b> ${esc(describe(a.action))}${a.entity_id ? ` <span class="muted">${esc(a.entity_id)}</span>` : ''}</div>
              <span class="when">${esc(ago(a.at))}</span></li>`).join('')}</ul>` : emptyState(t('No activity yet'), '', 'audit')}
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
