// Team screens for State Heads, Coordinators and branch supervisors: the dashboard (figures worked out on the
// server from what agents record), each agent's daily report, targets, and — on an account — moving it to
// another agent and handling a difficult case. The agent's own daily report (reportTable) is shared with app.js.
import { isoDate, formatINR, AGE_BANDS, outcomeLabel } from './logic.js';
import * as store from './store.js';
import { esc, plural, toast, fmtDate, fmtWhen, header } from './ui.js';
import { t, tr } from '../i18n/i18n.js';

// i18n: t('State Head') t('District Coordinator') t('Agent')
// i18n: t('0–30 days') t('31–60 days') t('61–90 days') t('91–180 days') t('181–365 days') t('1–2 years') t('Over 2 years')
const POST_NAMES = { state_head: 'State Head', coordinator: 'District Coordinator', agent: 'Agent' };
/** The company's own name for a post (Team → Settings in the admin console), or the standard one. */
export const postLabel = (post) => store.getState().settings?.posts?.[post] || t(POST_NAMES[post] || post);

const view = { date: null }; // the day the dashboard shows; kept while moving between team screens
const pct = (v) => (v == null ? '—' : `${Number(v).toFixed(1)}%`);
const CASE_TEXT = () => ({ 1: t('Difficult case · with the coordinator'), 2: t('Escalated · with the agency head') });

// ---------- the daily report, in the agency's format ----------

function reportRows(r) {
  return [
    [t('Accounts assigned'), String(r.assigned)],
    [t('Customers contacted'), String(r.contacted)],
    [t('Visits made'), String(r.visits)],
    [t('Calls made'), String(r.calls)],
    [t('PTP obtained'), r.ptpObtained ? `${r.ptpObtained} · ${formatINR(r.ptpAmount)}` : '0'],
    [t('Amount collected'), formatINR(r.collected)],
    [t('PTP due tomorrow'), r.ptpDueTomorrow ? `${r.ptpDueTomorrow} · ${formatINR(r.ptpDueTomorrowAmount)}` : '0'],
    [t('No-contact cases'), String(r.noContact)],
    [t('Not attempted'), String(r.notAttempted)],
    [t('Difficult cases'), String(r.difficult)],
  ];
}

export function reportTable(r) {
  return `<table class="kv report"><thead><tr><th>${t('Particular')}</th><th>${t('Details')}</th></tr></thead>
    <tbody>${reportRows(r).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</tbody></table>`;
}

/** The report as text, to send on WhatsApp or SMS. */
export function reportText(name, code, r, extra = []) {
  return [t('Daily report · {name} ({code}) · {date}', { name, code, date: fmtDate(r.date) }), ...reportRows(r).map(([k, v]) => `${k}: ${v}`), ...extra].join('\n');
}

/** Progress against the agent's standing targets. */
export function targetTable(target, done) {
  if (!target || ![target.dayAmount, target.dayVisits, target.weekAmount, target.monthAmount].some((v) => v != null)) return '';
  const line = (label, got, goal, money = true) => (goal == null ? '' : `<tr><td>${esc(label)}</td><td>${money ? formatINR(got) : got} / ${money ? formatINR(goal) : goal} · <b>${goal > 0 ? pct((got / goal) * 100) : '—'}</b></td></tr>`);
  return `<h3 class="mt">${t('Targets')}</h3><table class="kv">
    ${line(t('Collected today'), done.today, target.dayAmount)}
    ${line(t('Visits today'), done.visits, target.dayVisits, false)}
    ${line(t('This week'), done.week, target.weekAmount)}
    ${line(t('This month'), done.month, target.monthAmount)}
  </table><p class="muted small">${esc(t('Targets set from {date}.', { date: fmtDate(target.fromDate) }))}</p>`;
}

// ---------- dashboard ----------

function listItem(r) {
  const lines = [];
  if (r.ptpDate) lines.push(t('PTP {amount} on {date}', { amount: formatINR(r.ptpAmount), date: fmtDate(r.ptpDate) }));
  if (r.caseLevel) lines.push(`${CASE_TEXT()[r.caseLevel]}: ${r.caseNote || ''}`);
  else if (r.lastAt) lines.push(t('Last: {outcome} · {when}', { outcome: r.lastType === 'payment' ? t('Payment') : t(outcomeLabel(r.lastOutcome)), when: fmtWhen(r.lastAt) }));
  else lines.push(t('Never visited or called'));
  return `<a class="card loan-card" href="#/loan/${esc(r.id)}">
    <div class="row between"><strong>${esc(r.name)}</strong><strong class="bad">${formatINR(r.overdue)}</strong></div>
    <div class="muted small">${esc(r.loanNo)} · ${esc(r.officerName || r.officerCode || t('unassigned'))} · ${esc([r.district, r.pincode].filter(Boolean).join(' '))} · ${esc(t('{n} DPD', { n: r.dpd }))}</div>
    <div class="small mt-s">${lines.map(esc).join('<br>')}</div>
  </a>`;
}

function listSection(id, title, rows, total) {
  if (!total) return '';
  return `<details class="card" id="${id}"><summary>${esc(title)} · ${total}${rows.length < total ? ` ${esc(t('(showing {n})', { n: rows.length }))}` : ''}</summary>
    ${rows.map(listItem).join('')}</details>`;
}

function rollupCard(r) {
  return `<a class="card loan-card" href="#/team/${esc(r.code)}">
    <div class="row between"><strong>${esc(r.name)}</strong><span class="tag">${esc(t('Recovery {pct}', { pct: pct(r.recoveryPct) }))}</span></div>
    <div class="muted small">${esc(t('{agents} agents · {accounts} accounts · overdue {amount}', { agents: r.agents, accounts: r.accounts, amount: formatINR(r.overdue) }))}</div>
    <div class="small mt-s">${esc(t('Today {today} · this month {month}', { today: formatINR(r.collectedToday), month: formatINR(r.collectedMonth) }))}${r.monthTarget ? ` · ${esc(t('target {amount}', { amount: formatINR(r.monthTarget) }))}` : ''}</div>
    <div class="small">${esc(t('Contacted {n} · {visits} visits · {calls} calls · {ptp} PTP · {none} no contact', { n: r.contacted, visits: r.visits, calls: r.calls, ptp: r.ptpObtained, none: r.noContact }))}</div>
  </a>`;
}

function agentCard(a) {
  const r = a.report;
  const tags = [
    a.achievement?.month != null ? `<span class="tag ${a.achievement.month >= 100 ? 'tag-ok' : ''}">${esc(t('Month {pct}', { pct: pct(a.achievement.month) }))}</span>` : '',
    r.noContact ? `<span class="tag tag-warn">${esc(t('{n} no contact', { n: r.noContact }))}</span>` : '',
    r.notAttempted ? `<span class="tag">${esc(t('{n} not attempted', { n: r.notAttempted }))}</span>` : '',
    r.difficult ? `<span class="tag tag-bad">${esc(t('{n} difficult', { n: r.difficult }))}</span>` : '',
  ].join('');
  return `<a class="card loan-card" href="#/agent/${esc(a.code)}">
    <div class="row between"><strong>${esc(a.name)} <span class="muted small">${esc(a.code)}</span></strong><strong>${formatINR(r.collected)}</strong></div>
    <div class="small">${esc(t('Contacted {n} of {assigned} · {visits} visits · {calls} calls · {ptp} PTP', { n: r.contacted, assigned: r.assigned, visits: r.visits, calls: r.calls, ptp: r.ptpObtained }))}</div>
    <div class="muted small">${esc(t('This month {amount} · recovery {pct}', { amount: formatINR(a.collectedMonth), pct: pct(a.recoveryPct) }))}</div>
    ${tags ? `<div class="tags mt-s">${tags}</div>` : ''}
  </a>`;
}

const stat = (label, value, sub = '', href = '', cls = '') =>
  `<${href ? `a href="${href}"` : 'div'} class="stat ${cls}"><span>${esc(label)}</span><strong>${value}</strong>${sub ? `<small>${esc(sub)}</small>` : ''}</${href ? 'a' : 'div'}>`;

export async function viewTeam(under = null) {
  const today = isoDate();
  view.date ||= today;
  let res = null;
  let error = '';
  try {
    res = await store.fetchDesk(view.date, under);
  } catch (err) {
    error = tr(err.message);
  }
  const back = under ? '#/team' : '';
  if (!res) return `${header(t('Team'), back, 'team-dashboard')}<p class="note bad">${esc(error)}</p>`;
  const d = res.data;
  const T = d.totals;
  const day = T.day;
  const me = store.user();
  const pendingDeposits = store.getState().loans.flatMap((l) => l.payments).filter((p) => p.deposit?.verification === 'pending').length;
  const maxAge = Math.max(1, ...d.ages.map((a) => a.count));
  const who = d.scope ? `${d.scope.name} · ${postLabel(d.scope.post)}` : me.name;
  return `
    ${header(t('Team'), back, 'team-dashboard')}
    <p class="muted small">${esc(who)}</p>
    <div class="row between mt-s">
      <label class="small">${t('Day')} <input type="date" id="desk-date" max="${today}" value="${esc(view.date)}"></label>
      ${d.choices.length ? `<select id="desk-under" aria-label="${esc(t('Whose team'))}">
        <option value="">${esc(t('My whole team'))}</option>
        ${d.choices.map((c) => `<option value="${esc(c.code)}" ${c.code === under ? 'selected' : ''}>${esc(c.name)} · ${esc(postLabel(c.post))}</option>`).join('')}
      </select>` : ''}
    </div>
    ${res.cached ? `<p class="note warn-note">${esc(t('Offline — showing the figures loaded at {when}.', { when: fmtWhen(res.cached) }))}</p>` : ''}
    <section class="grid2 mt">
      ${stat(view.date === today ? t('Today’s collection') : t('Collection on {date}', { date: fmtDate(view.date) }), formatINR(T.collectedToday), plural(day.receipts, t('1 receipt'), t('{n} receipts')))}
      ${stat(t('Month to date'), formatINR(T.collectedMonth), t('This week {amount}', { amount: formatINR(T.collectedWeek) }))}
      ${stat(t('Recovery %'), pct(T.recoveryPct), t('of {amount} overdue on the 1st', { amount: formatINR(T.openingOverdue) }))}
      ${stat(t('Total overdue'), formatINR(T.overdue), t('Outstanding {amount}', { amount: formatINR(T.outstanding) }))}
      ${stat(t('Customers contacted'), String(day.contacted), t('{visits} visits · {calls} calls', { visits: day.visits, calls: day.calls }))}
      ${stat(t('PTP due today'), String(T.ptpToday), formatINR(T.ptpTodayAmount), '#ptp-today')}
      ${stat(t('Broken PTP'), String(T.broken), formatINR(T.brokenAmount), '#broken', T.broken ? 'warn' : '')}
      ${stat(t('No contact'), String(T.noContact), t('{n} never visited or called', { n: T.untouched }), '#no-contact')}
      ${stat(t('High-value accounts'), String(T.highValue), t('overdue {amount} or more', { amount: formatINR(d.settings.highValue) }), '#high-value')}
      ${stat(t('Difficult cases'), String(T.difficult), t('{n} with the agency head', { n: T.escalated }), '#difficult', T.difficult ? 'warn' : '')}
      ${stat(t('Accounts'), String(T.accounts), t('{n} unassigned', { n: T.unassigned }))}
      ${stat(t('Deposits to verify'), String(pendingDeposits), '', '#/deposits', pendingDeposits ? 'warn' : '')}
    </section>

    <section class="card">
      <h2>${t('Ageing')}</h2>
      <div class="bars">${d.ages.map((a, i) => `
        <div class="bar-row"><span class="bar-label">${esc(t(a.label))}</span>
          <span class="bar-track"><span class="bar age-${i}" style="width:${(a.count / maxAge) * 100}%"></span></span>
          <span class="bar-val">${a.count} · ${formatINR(a.overdue)}</span></div>`).join('')}</div>
    </section>

    ${d.regions.length ? `<h2 class="mt">${esc(t('By {post}', { post: postLabel('state_head') }))}</h2>${d.regions.map(rollupCard).join('')}` : ''}
    ${d.areas.length ? `<h2 class="mt">${esc(t('By {post}', { post: postLabel('coordinator') }))}</h2>${d.areas.map(rollupCard).join('')}` : ''}

    <div class="row between section-head mt">
      <h2>${esc(t('{post}: daily report', { post: postLabel('agent') }))}</h2>
      <a class="btn small" href="#/targets">🎯 ${t('Set targets')}</a>
    </div>
    ${d.agents.length ? d.agents.map(agentCard).join('') : `<p class="empty card">${t('Nobody in your team yet.')}</p>`}

    <h2 class="mt">${t('Accounts to act on')}</h2>
    ${listSection('ptp-today', t('PTP due today'), d.lists.ptpToday, T.ptpToday)}
    ${listSection('broken', t('Broken PTP'), d.lists.broken, T.broken)}
    ${listSection('no-contact', t('No contact on the last attempt'), d.lists.noContact, T.noContact)}
    ${listSection('high-value', t('High-value accounts'), d.lists.highValue, T.highValue)}
    ${listSection('difficult', t('Difficult cases'), d.lists.difficult, T.difficult)}
    <p class="muted small">${t('Recovery % = collected this month ÷ overdue on the 1st of the month.')} <a href="#/summary">${t('Today’s receipts and visits')}</a></p>`;
}

// ---------- one agent ----------

export function viewAgent(code) {
  const d = store.getState().desk?.data;
  const a = d?.agents.find((x) => x.code === code);
  if (!a) return `${header(t('Agent'), '#/team', 'team-dashboard')}<p class="empty card">${t('Open the Team screen first.')}</p>`;
  const mine = (list) => list.filter((r) => r.officerCode === code);
  return `
    ${header(a.name, '#/team', 'team-dashboard')}
    <section class="card">
      <div class="row between"><span class="muted small">${esc(a.code)} · ${esc(postLabel(a.post || 'agent'))}</span><span class="small">${esc(fmtDate(d.date))}</span></div>
      ${reportTable(a.report)}
      <table class="kv mt"><tbody>
        <tr><td>${t('This week')}</td><td>${formatINR(a.collectedWeek)}</td></tr>
        <tr><td>${t('Month to date')}</td><td>${formatINR(a.collectedMonth)}</td></tr>
        <tr><td>${t('Recovery %')}</td><td>${pct(a.recoveryPct)}</td></tr>
        <tr><td>${t('Total overdue')}</td><td>${formatINR(a.overdue)}</td></tr>
      </tbody></table>
      ${targetTable(a.target, { today: a.report.collected, visits: a.report.visits, week: a.collectedWeek, month: a.collectedMonth })}
      <div class="actions mt">
        ${a.phone ? `<a class="btn" href="tel:${esc(a.phone)}">📞 ${t('Call')}</a>` : ''}
        <button class="btn" data-action="agent-accounts" data-code="${esc(a.code)}">👥 ${t('Their accounts')}</button>
        <a class="btn" href="#/targets/${esc(a.code)}">🎯 ${t('Set target')}</a>
      </div>
    </section>
    ${listSection('ptp-today', t('PTP due today'), mine(d.lists.ptpToday), mine(d.lists.ptpToday).length)}
    ${listSection('broken', t('Broken PTP'), mine(d.lists.broken), mine(d.lists.broken).length)}
    ${listSection('no-contact', t('No contact on the last attempt'), mine(d.lists.noContact), mine(d.lists.noContact).length)}
    ${listSection('difficult', t('Difficult cases'), mine(d.lists.difficult), mine(d.lists.difficult).length)}`;
}

// ---------- targets ----------

export function viewTargets(code = null) {
  const { team, desk } = store.getState();
  const current = new Map((desk?.data?.agents || []).map((a) => [a.code, a.target]));
  const pre = code ? current.get(code) : null;
  const v = (k) => (pre?.[k] != null ? esc(pre[k]) : '');
  return `
    ${header(t('Set targets'), code ? `#/agent/${code}` : '#/team', 'team-targets')}
    <form id="targets-form" class="card form">
      <p class="muted small">${t('A target stays in force from its date until you set a new one. Leave a box empty for no target.')}</p>
      <fieldset class="modes"><legend>${esc(t('{post}s', { post: postLabel('agent') }))}</legend>
        ${team.length > 1 ? `<label class="radio"><input type="checkbox" data-action="all-agents" ${code ? '' : 'checked'}> <b>${t('All')}</b></label>` : ''}
        ${team.map((a) => `<label class="radio"><input type="checkbox" name="agent" value="${esc(a.code)}" ${!code || a.code === code ? 'checked' : ''}> ${esc(a.name)} <span class="muted small">${esc(a.code)}${current.get(a.code)?.monthAmount != null ? ` · ${esc(t('month {amount}', { amount: formatINR(current.get(a.code).monthAmount) }))}` : ''}</span></label>`).join('') || `<p class="muted">${t('Nobody in your team yet.')}</p>`}
      </fieldset>
      <label>${t('From')}<input name="fromDate" type="date" value="${isoDate()}" required></label>
      <label>${t('Daily collection (₹)')}<input name="dayAmount" type="number" min="0" step="1" inputmode="numeric" value="${v('dayAmount')}"></label>
      <label>${t('Daily visits')}<input name="dayVisits" type="number" min="0" step="1" inputmode="numeric" value="${v('dayVisits')}"></label>
      <label>${t('Weekly collection (₹)')}<input name="weekAmount" type="number" min="0" step="1" inputmode="numeric" value="${v('weekAmount')}"></label>
      <label>${t('Monthly collection (₹)')}<input name="monthAmount" type="number" min="0" step="1" inputmode="numeric" value="${v('monthAmount')}"></label>
      <p class="error" id="targets-error" role="alert"></p>
      <button class="btn primary big" type="submit">${t('Save targets')}</button>
    </form>`;
}

// ---------- on an account: move it, handle a difficult case ----------

export function loanTools(loan) {
  const { team } = store.getState();
  const c = loan.case;
  const actions = !c
    ? [['raise', t('Mark as difficult case'), '']]
    : c.level === 1
      ? [['escalate', t('Escalate to agency head'), 'danger'], ['resolve', t('Mark resolved'), 'primary']]
      : [['resolve', t('Mark resolved'), 'primary']];
  return `
    ${team.length ? `<section class="card">
      <h2>${t('Allocation')}</h2>
      <form id="assign-form" class="row" data-loan="${esc(loan.id)}">
        <select name="officerCode" aria-label="${esc(t('Agent'))}" required>
          ${loan.officerCode ? '' : `<option value="" selected disabled>${esc(t('Choose an agent…'))}</option>`}
          ${team.map((a) => `<option value="${esc(a.code)}" ${a.code === loan.officerCode ? 'selected' : ''}>${esc(a.name)} (${esc(a.code)})</option>`).join('')}
        </select>
        <button class="btn small" type="submit">${t('Move')}</button>
      </form>
    </section>` : ''}
    <section class="card">
      <h2>${t('Difficult case')}</h2>
      ${c ? `<p><span class="tag ${c.level >= 2 ? 'tag-bad' : 'tag-warn'}">${esc(CASE_TEXT()[c.level])}</span></p>
        <p>${esc(c.note || '')}</p><p class="muted small">${esc(t('By {code} · {when}', { code: c.by || '—', when: fmtWhen(c.at) }))}</p>`
    : `<p class="muted small">${t('Not a difficult case. Agents mark one when they log a visit; you can also mark it here.')}</p>`}
      <form id="case-form" class="form" data-loan="${esc(loan.id)}">
        <label>${t('Note')}<textarea name="note" rows="2" maxlength="300" required placeholder="${esc(t('What happened, or why?'))}"></textarea></label>
        <p class="error" id="case-error" role="alert"></p>
        <div class="actions">${actions.map(([a, label, cls]) => `<button class="btn ${cls}" type="submit" name="action" value="${a}">${esc(label)}</button>`).join('')}</div>
      </form>
    </section>`;
}

/** Badge for an account that is a difficult case (agents see it on their accounts). */
export const caseTag = (loan) => (loan.case ? `<span class="tag ${loan.case.level >= 2 ? 'tag-bad' : 'tag-warn'}">${esc(CASE_TEXT()[loan.case.level])}</span>` : '');

// ---------- events (called from app.js) ----------

export async function handleSubmit(form, data, submitter) {
  if (form.id === 'targets-form') {
    const agents = [...form.querySelectorAll('[name=agent]:checked')].map((i) => i.value);
    const $err = form.querySelector('#targets-error');
    if (!agents.length) {
      $err.textContent = t('Choose at least one person.');
      return true;
    }
    return busy(form, $err, async () => {
      await store.deskAction('targets', {
        officerCodes: agents, fromDate: data.fromDate, dayAmount: data.dayAmount, dayVisits: data.dayVisits, weekAmount: data.weekAmount, monthAmount: data.monthAmount,
      });
      toast(agents.length === 1 ? t('Target saved') : t('Targets saved for {n} people', { n: agents.length }));
      location.hash = '#/team';
    });
  }
  if (form.id === 'assign-form') {
    const $err = document.getElementById('case-error');
    return busy(form, $err, async () => {
      const r = await store.deskAction('assign', { loanIds: [form.dataset.loan], officerCode: data.officerCode });
      toast(r.changed ? t('Account moved to {code}', { code: data.officerCode }) : t('No change'));
    });
  }
  if (form.id === 'case-form') {
    const $err = form.querySelector('#case-error');
    if (!String(data.note || '').trim()) {
      $err.textContent = t('Add a note: what happened, or why.');
      return true;
    }
    return busy(form, $err, async () => {
      await store.deskAction(`cases/${encodeURIComponent(form.dataset.loan)}`, { action: submitter?.value, note: data.note });
      toast({ raise: t('Marked as difficult case'), escalate: t('Escalated to the agency head'), resolve: t('Case resolved') }[submitter?.value] || t('Saved'));
    });
  }
  return false;
}

async function busy(form, $err, fn) {
  const buttons = form.querySelectorAll('button');
  buttons.forEach((b) => (b.disabled = true));
  if ($err) $err.textContent = '';
  try {
    await fn();
  } catch (err) {
    if ($err) $err.textContent = tr(err.message);
    else toast(tr(err.message), 'bad');
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
  return true;
}

export function handleChange(el) {
  if (el.id === 'desk-date') {
    view.date = el.value || isoDate();
    return 'route';
  }
  if (el.id === 'desk-under') {
    location.hash = el.value ? `#/team/${el.value}` : '#/team';
    return 'nav';
  }
  if (el.dataset.action === 'all-agents') {
    el.form.querySelectorAll('[name=agent]').forEach((i) => (i.checked = el.checked));
    return 'done';
  }
  return false;
}
