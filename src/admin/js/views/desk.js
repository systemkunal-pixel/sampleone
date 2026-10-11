// Recovery desk: the coordinators' dashboard and the agents' daily report for the whole company or one person's
// team, worked out from what agents record. Targets per agent, difficult cases with the agency head, Excel.
import { api, download } from '../api.js';
import { esc, icon, inr, inrShort, num, toast, dialog, emptyState, helpButton } from '../ui.js';
import { t, tr } from '../../../i18n/i18n.js';
import { setQuery, postLabel, settings } from '../main.js';

/* Labels from the server (AGE_BANDS and visit outcomes in src/js/logic.js), translated where shown.
   i18n: t('0–30 days') t('31–60 days') t('61–90 days') t('91–180 days') t('181–365 days') t('1–2 years') t('Over 2 years')
   i18n: t('Paid in full') t('Partial payment') t('Promise to pay') t('Borrower not available') t('Door locked') t('Refused to pay')
         t('Disputes the dues') t('Shifted / not traceable') t('Phone not answered / switched off') */
const OUTCOMES = {
  PAID: 'Paid in full', PARTIAL: 'Partial payment', PTP: 'Promise to pay', NOT_AVAILABLE: 'Borrower not available', DOOR_LOCKED: 'Door locked',
  REFUSED: 'Refused to pay', DISPUTE: 'Disputes the dues', SHIFTED: 'Shifted / not traceable', NO_ANSWER: 'Phone not answered / switched off',
};
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const pct = (v) => (v == null ? '—' : `${Number(v).toFixed(1)}%`);
const fmtWhen = (s) => (s ? s.replace('T', ' ').slice(0, 16) : '');
const LISTS = [
  ['ptpToday', 'PTP due today', 'ptpToday'], ['broken', 'Broken PTP', 'broken'], ['noContact', 'No contact on the last attempt', 'noContact'],
  ['highValue', 'High-value accounts', 'highValue'], ['difficult', 'Difficult cases', 'difficult'],
];
/* i18n: t('PTP due today') t('Broken PTP') t('No contact on the last attempt') t('High-value accounts') t('Difficult cases') */
let tab = 'ptpToday';
const caseText = (level) => ['', t('With the coordinator'), t('With the agency head')][level] || '';

function kpi(label, value, sub = '', cls = '', href = '') {
  const tag = href ? 'a' : 'div';
  return `<${tag} class="kpi ${cls}" ${href ? `href="${href}"` : ''}><div class="label">${esc(label)}</div><div class="value">${value}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</${tag}>`;
}

function rollTable(rows, post) {
  if (!rows.length) return '';
  return `<section class="card" style="margin-top:16px">
    <div class="card-head"><div><h2>${esc(t('By {post}', { post: postLabel(post) }))}</h2><p>${t('Select a name to see only their team.')}</p></div></div>
    <div class="table-wrap"><table class="data responsive">
      <thead><tr><th>${esc(postLabel(post))}</th><th class="right">${esc(postLabel('agent', true))}</th><th class="right">${t('Accounts')}</th><th class="right">${t('Overdue')}</th>
        <th class="right">${t('Contacted')}</th><th class="right">${t('Visits')}</th><th class="right">${t('Calls')}</th><th class="right">${t('PTP')}</th><th class="right">${t('No contact')}</th>
        <th class="right">${t('Today')}</th><th class="right">${t('Month to date')}</th><th class="right">${t('Month target')}</th><th class="right">${t('Recovery %')}</th></tr></thead>
      <tbody>${rows.map((r) => `<tr class="clickable" data-under="${esc(r.code)}">
        <td class="primary" data-label="${esc(postLabel(post))}"><div class="cell-main">${esc(r.name)}</div><div class="cell-sub">${esc(r.code)}</div></td>
        <td class="right num" data-label="${esc(postLabel('agent', true))}">${num(r.agents)}</td>
        <td class="right num" data-label="${esc(t('Accounts'))}">${num(r.accounts)}</td>
        <td class="right num" data-label="${esc(t('Overdue'))}">${inr(r.overdue)}</td>
        <td class="right num" data-label="${esc(t('Contacted'))}">${num(r.contacted)}</td>
        <td class="right num" data-label="${esc(t('Visits'))}">${num(r.visits)}</td>
        <td class="right num" data-label="${esc(t('Calls'))}">${num(r.calls)}</td>
        <td class="right num" data-label="${esc(t('PTP'))}">${num(r.ptpObtained)}</td>
        <td class="right num" data-label="${esc(t('No contact'))}">${num(r.noContact)}</td>
        <td class="right num" data-label="${esc(t('Today'))}">${inr(r.collectedToday)}</td>
        <td class="right num" data-label="${esc(t('Month to date'))}"><b>${inr(r.collectedMonth)}</b></td>
        <td class="right num" data-label="${esc(t('Month target'))}">${r.monthTarget ? inr(r.monthTarget) : '—'}</td>
        <td class="right num" data-label="${esc(t('Recovery %'))}">${pct(r.recoveryPct)}</td>
      </tr>`).join('')}</tbody></table></div></section>`;
}

function agentTable(agents) {
  return `<section class="card" style="margin-top:16px">
    <div class="card-head"><div><h2>${esc(t('{post}: daily report', { post: postLabel('agent') }))}</h2>
      <p>${t('Worked out from the payments, visits and calls each agent recorded — nobody fills in a report.')}</p></div>
      <button class="btn sm" data-act="targets">${icon('target')} ${t('Set targets')}</button></div>
    ${agents.length ? `<div class="table-wrap"><table class="data responsive">
      <thead><tr><th>${esc(postLabel('agent'))}</th><th class="right">${t('Accounts assigned')}</th><th class="right">${t('Customers contacted')}</th><th class="right">${t('Visits made')}</th>
        <th class="right">${t('Calls made')}</th><th class="right">${t('PTP obtained')}</th><th class="right">${t('Amount collected')}</th><th class="right">${t('PTP due tomorrow')}</th>
        <th class="right">${t('No-contact cases')}</th><th class="right">${t('Not attempted')}</th><th class="right">${t('Difficult cases')}</th>
        <th class="right">${t('Month to date')}</th><th class="right">${t('Month target')}</th><th class="right">${t('Recovery %')}</th></tr></thead>
      <tbody>${agents.map((a) => {
        const r = a.report;
        return `<tr>
        <td class="primary" data-label="${esc(postLabel('agent'))}"><div class="cell-main">${esc(a.name)}</div><div class="cell-sub">${esc(a.code)}${a.active ? '' : ` · ${t('deactivated')}`}</div></td>
        <td class="right num" data-label="${esc(t('Accounts assigned'))}">${num(r.assigned)}</td>
        <td class="right num" data-label="${esc(t('Customers contacted'))}">${num(r.contacted)}</td>
        <td class="right num" data-label="${esc(t('Visits made'))}">${num(r.visits)}${a.target?.dayVisits ? `<span class="muted"> / ${num(a.target.dayVisits)}</span>` : ''}</td>
        <td class="right num" data-label="${esc(t('Calls made'))}">${num(r.calls)}</td>
        <td class="right num" data-label="${esc(t('PTP obtained'))}">${num(r.ptpObtained)}</td>
        <td class="right num" data-label="${esc(t('Amount collected'))}"><b>${inr(r.collected)}</b>${a.target?.dayAmount ? `<div class="cell-sub">${pct(a.achievement.day)}</div>` : ''}</td>
        <td class="right num" data-label="${esc(t('PTP due tomorrow'))}">${r.ptpDueTomorrow ? `${num(r.ptpDueTomorrow)} · ${inr(r.ptpDueTomorrowAmount)}` : '0'}</td>
        <td class="right num" data-label="${esc(t('No-contact cases'))}">${num(r.noContact)}</td>
        <td class="right num" data-label="${esc(t('Not attempted'))}">${num(r.notAttempted)}</td>
        <td class="right num" data-label="${esc(t('Difficult cases'))}">${r.difficult ? `<span class="badge warn">${num(r.difficult)}</span>` : '0'}</td>
        <td class="right num" data-label="${esc(t('Month to date'))}">${inr(a.collectedMonth)}</td>
        <td class="right num" data-label="${esc(t('Month target'))}">${a.target?.monthAmount != null ? `${inr(a.target.monthAmount)}<div class="cell-sub">${pct(a.achievement.month)}</div>` : '—'}</td>
        <td class="right num" data-label="${esc(t('Recovery %'))}">${pct(a.recoveryPct)}</td>
      </tr>`;
      }).join('')}</tbody></table></div>` : emptyState(t('Nobody in this team yet'), t('Add people in Team → Import people.'), 'layers')}
  </section>`;
}

function listTable(d) {
  const rows = d.lists[tab];
  const total = { ptpToday: d.totals.ptpToday, broken: d.totals.broken, noContact: d.totals.noContact, highValue: d.totals.highValue, difficult: d.totals.difficult }[tab];
  return `<section class="card" style="margin-top:16px">
    <div class="card-head"><div><h2>${t('Accounts to act on')}</h2></div></div>
    <nav class="tabs" style="padding:0 16px">${LISTS.map(([k, label]) => `<a href="#" data-tab="${k}" class="${k === tab ? 'active' : ''}">${esc(t(label))} <span class="count">${num({ ptpToday: d.totals.ptpToday, broken: d.totals.broken, noContact: d.totals.noContact, highValue: d.totals.highValue, difficult: d.totals.difficult }[k])}</span></a>`).join('')}</nav>
    ${rows.length ? `<div class="table-wrap"><table class="data responsive">
      <thead><tr><th>${t('Loan')}</th><th>${esc(postLabel('agent'))}</th><th>${t('Area')}</th><th class="right">${t('Overdue')}</th><th class="right">${t('DPD')}</th>
        <th>${tab === 'difficult' ? t('Case') : t('PTP / last contact')}</th>${tab === 'difficult' ? `<th></th>` : ''}</tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td class="primary" data-label="${esc(t('Loan'))}"><a href="#/loans?q=${encodeURIComponent(r.loanNo)}"><div class="cell-main">${esc(r.name)}</div><div class="cell-sub">${esc(r.loanNo)}${r.client ? ` · ${esc(r.client)}` : ''}</div></a></td>
        <td data-label="${esc(postLabel('agent'))}">${esc(r.officerName || r.officerCode || t('Unassigned'))}</td>
        <td data-label="${esc(t('Area'))}">${esc([r.district, r.pincode].filter(Boolean).join(' · '))}</td>
        <td class="right num" data-label="${esc(t('Overdue'))}">${inr(r.overdue)}</td>
        <td class="right num" data-label="${esc(t('DPD'))}">${num(r.dpd)}</td>
        <td data-label="${esc(tab === 'difficult' ? t('Case') : t('PTP / last contact'))}">${tab === 'difficult'
          ? `<span class="badge ${r.caseLevel >= 2 ? 'bad' : 'warn'}">${esc(caseText(r.caseLevel))}</span><div class="cell-sub">${esc(r.caseNote || '')} · ${esc(r.caseBy || '')} ${esc(fmtWhen(r.caseAt))}</div>`
          : `${r.ptpDate ? `${t('PTP {amount} on {date}', { amount: inr(r.ptpAmount), date: esc(r.ptpDate) })}<br>` : ''}<span class="cell-sub">${r.lastAt ? `${esc(fmtWhen(r.lastAt))} · ${esc(r.lastType === 'payment' ? t('Payment') : t(OUTCOMES[r.lastOutcome] || r.lastOutcome))}` : t('Never visited or called')}</span>`}</td>
        ${tab === 'difficult' ? `<td class="right nowrap">${r.caseLevel === 1 ? `<button class="btn sm" data-case="escalate" data-loan="${esc(r.id)}">${t('Take over')}</button> ` : ''}<button class="btn sm" data-case="resolve" data-loan="${esc(r.id)}">${t('Resolve')}</button></td>` : ''}
      </tr>`).join('')}</tbody></table></div>
      ${rows.length < total ? `<p class="muted small" style="padding:0 16px 12px">${t('Showing the {n} largest by overdue; the Excel download has the same.', { n: num(rows.length) })}</p>` : ''}`
    : emptyState(t('Nothing here'), '', 'check')}
  </section>`;
}

export async function render(el, q, alive) {
  const date = q.get('date') || today();
  const under = q.get('under') || '';
  const params = new URLSearchParams({ date, ...(under ? { under } : {}) });
  const d = await api(`desk?${params}`);
  if (!alive()) return;
  const T = d.totals;
  const day = T.day;
  const s = settings();
  const maxAge = Math.max(1, ...d.ages.map((a) => a.count));

  const draw = () => {
    el.innerHTML = `
      <div class="page-head">
        <div><h1>${t('Recovery desk')}</h1><p>${d.scope ? esc(t('{name} ({post}) and their team', { name: d.scope.name, post: postLabel(d.scope.post) })) : t('The whole company: every coordinator’s dashboard and every agent’s daily report.')}</p></div>
        <div class="page-actions">${helpButton('recovery-desk')}<button class="btn primary" data-act="xlsx">${icon('download')} ${t('Download Excel')}</button></div>
      </div>
      <form class="toolbar" id="desk-form">
        <label class="field inline"><span>${t('Day')}</span><input class="input" type="date" name="date" max="${today()}" value="${esc(date)}"></label>
        <select class="select" name="under" aria-label="${esc(t('Whose team'))}">
          <option value="">${t('Whole company')}</option>
          ${d.choices.map((c) => `<option value="${esc(c.code)}" ${c.code === under ? 'selected' : ''}>${c.post === 'coordinator' ? '— ' : ''}${esc(c.name)} · ${esc(postLabel(c.post))}</option>`).join('')}
        </select>
        <button class="btn" type="submit">${icon('refresh')} ${t('Show')}</button>
        ${under ? `<a class="btn ghost" href="#/desk?date=${esc(date)}">${t('Whole company')}</a>` : ''}
      </form>

      <section class="kpis">
        ${kpi(date === today() ? t('Today’s collection') : t('Collection on {date}', { date }), inrShort(T.collectedToday), day.receipts === 1 ? t('1 receipt') : t('{n} receipts', { n: num(day.receipts) }))}
        ${kpi(t('Month to date'), inrShort(T.collectedMonth), t('This week {amount}', { amount: inrShort(T.collectedWeek) }))}
        ${kpi(t('Recovery %'), pct(T.recoveryPct), t('of {amount} overdue on the 1st', { amount: inrShort(T.openingOverdue) }))}
        ${kpi(t('Total overdue'), inrShort(T.overdue), t('Outstanding {amount}', { amount: inrShort(T.outstanding) }), T.overdue ? 'alert' : '')}
        ${kpi(t('Customers contacted'), num(day.contacted), t('{visits} visits · {calls} calls', { visits: num(day.visits), calls: num(day.calls) }))}
        ${kpi(t('PTP due today'), num(T.ptpToday), inr(T.ptpTodayAmount))}
        ${kpi(t('Broken PTP'), num(T.broken), inr(T.brokenAmount), T.broken ? 'attention' : '')}
        ${kpi(t('No contact'), num(T.noContact), t('{n} never visited or called', { n: num(T.untouched) }))}
        ${kpi(t('High-value accounts'), num(T.highValue), t('overdue {amount} or more', { amount: inr(s.highValue) }))}
        ${kpi(t('Difficult cases'), num(T.difficult), t('{n} with the agency head', { n: num(T.escalated) }), T.escalated ? 'attention' : '')}
        ${kpi(t('Accounts'), num(T.accounts), t('{n} unassigned', { n: num(T.unassigned) }), '', T.unassigned ? '#/loans?officer=__none' : '')}
        ${kpi(t('PTP obtained today'), num(day.ptpObtained), inr(day.ptpAmount))}
      </section>

      <section class="card">
        <div class="card-head"><div><h2>${t('Ageing')}</h2><p>${t('Accounts by days past due. Recovery lists are mostly over 90 days, so that band is split further.')}</p></div></div>
        <div class="card-body"><div class="ageing">${d.ages.map((a, i) => `
          <div class="ageing-row"><span class="lbl">${esc(t(a.label))}</span>
            <span class="track"><span class="bar ab-${i}" style="width:${(a.count / maxAge) * 100}%"></span></span>
            <span class="val"><b>${num(a.count)}</b> <span class="muted">· ${inrShort(a.overdue)}</span></span></div>`).join('')}</div></div>
      </section>

      ${rollTable(d.regions, 'state_head')}
      ${rollTable(d.areas, 'coordinator')}
      ${agentTable(d.agents)}
      ${listTable(d)}
      <p class="muted small" style="margin-top:12px">${t('Recovery % = collected this month ÷ overdue on the 1st of the month. A payment counts for the agent who collected it.')}</p>`;
  };
  draw();

  el.onsubmit = (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    setQuery({ date: f.date, under: f.under });
  };
  el.onclick = async (e) => {
    const row = e.target.closest('tr[data-under]');
    if (row) return setQuery({ date, under: row.dataset.under });
    const tb = e.target.closest('[data-tab]');
    if (tb) {
      e.preventDefault();
      tab = tb.dataset.tab;
      return draw();
    }
    if (e.target.closest('[data-act=xlsx]')) {
      return download(`desk.xlsx?${params}`, `recovery-report-${date}${under ? `-${under}` : ''}.xlsx`).catch((ex) => toast(tr(ex.message), 'bad'));
    }
    if (e.target.closest('[data-act=targets]')) return setTargets(d.agents);
    const c = e.target.closest('[data-case]');
    if (c) {
      const action = c.dataset.case;
      const done = await dialog({
        title: action === 'resolve' ? t('Resolve the case') : t('Take over the case'),
        body: `<p class="muted">${action === 'resolve' ? t('What was done? The note is kept with the account.') : t('The case moves to the agency head (admins). Say why.')}</p>
          <label class="field"><span>${t('Note')}</span><textarea class="input" name="note" rows="3" maxlength="300" required></textarea></label>`,
        ok: action === 'resolve' ? t('Resolve') : t('Take over'),
        onOk: async (f) => {
          if (!String(f.note || '').trim()) throw new Error(t('Add a note: what happened, or why.'));
          return api(`cases/${encodeURIComponent(c.dataset.loan)}`, { method: 'POST', body: { action, note: f.note } });
        },
      });
      if (done) {
        toast(action === 'resolve' ? t('Case resolved') : t('Escalated to the agency head'));
        render(el, q, alive);
      }
    }
  };
}

async function setTargets(agents) {
  if (!agents.length) return toast(t('Nobody in this team yet'), 'bad');
  const done = await dialog({
    title: t('Set targets'),
    ok: t('Save targets'),
    body: `<div class="form">
      <p class="muted">${t('A target stays in force from its date until you set a new one. Leave a box empty for no target.')}</p>
      <div class="form-row">
        <label class="field"><span>${t('From')}</span><input class="input" type="date" name="fromDate" value="${today()}" required></label>
        <label class="field"><span>${t('Daily visits')}</span><input class="input" type="number" min="0" name="dayVisits"></label>
      </div>
      <div class="form-row">
        <label class="field"><span>${t('Daily collection (₹)')}</span><input class="input" type="number" min="0" name="dayAmount"></label>
        <label class="field"><span>${t('Weekly collection (₹)')}</span><input class="input" type="number" min="0" name="weekAmount"></label>
        <label class="field"><span>${t('Monthly collection (₹)')}</span><input class="input" type="number" min="0" name="monthAmount"></label>
      </div>
      <fieldset class="field"><legend>${esc(postLabel('agent', true))}</legend>
        <label class="check"><input type="checkbox" data-all checked> <b>${t('All')} (${num(agents.length)})</b></label>
        <div style="max-height:30vh;overflow:auto;columns:2">${agents.map((a) => `<label class="check" style="display:block"><input type="checkbox" name="agent" value="${esc(a.code)}" checked> ${esc(a.name)} <span class="muted small">${esc(a.code)}${a.target?.monthAmount != null ? ` · ${esc(t('month {amount}', { amount: inr(a.target.monthAmount) }))}` : ''}</span></label>`).join('')}</div>
      </fieldset></div>`,
    onOk: async (f, form) => {
      const codes = [...form.querySelectorAll('[name=agent]:checked')].map((i) => i.value);
      if (!codes.length) throw new Error(t('Choose at least one person.'));
      return api('desk/targets', { method: 'POST', body: { officerCodes: codes, fromDate: f.fromDate, dayAmount: f.dayAmount, dayVisits: f.dayVisits, weekAmount: f.weekAmount, monthAmount: f.monthAmount } });
    },
  });
  if (done) {
    toast(done.count === 1 ? t('Target saved') : t('Targets saved for {n} people', { n: num(done.count) }));
    setQuery(Object.fromEntries(new URLSearchParams(location.hash.split('?')[1] || '')));
  }
}

// "All" in the targets dialog ticks or clears every agent.
document.addEventListener('change', (e) => {
  if (!e.target.matches?.('[data-all]')) return;
  e.target.closest('form')?.querySelectorAll('[name=agent]').forEach((i) => (i.checked = e.target.checked));
});
