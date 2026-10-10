// Areas: accounts grouped by state → district → pincode, and the agent deputed to each pincode.
// Deputing an agent assigns the pincode's accounts to them; new accounts there go to them on import.
import { api } from '../api.js';
import { esc, icon, inr, num, toast, dialog, emptyState, helpButton } from '../ui.js';
import { t } from '../../../i18n/i18n.js';
import { route, setQuery } from '../main.js';

let selected = new Set(); // pincodes ticked for a bulk deputation
let open = new Set(); // expanded states and districts
let lastBranch = '';

// <details> toggle events don't bubble; one capturing listener on the view remembers what is expanded.
function onToggle(e) {
  const key = e.target.dataset?.areaKey;
  if (!key) return;
  if (e.target.open) open.add(key);
  else open.delete(key);
}

const accounts = (n) => (n === 1 ? t('1 account') : t('{n} accounts', { n: num(n) }));

function agentCell(p) {
  if (p.agent) {
    return `<b>${esc(p.agent.name)}</b> <span class="cell-sub">${esc(p.agent.code)}${p.agent.active ? '' : ` · ${t('inactive')}`}</span>`;
  }
  return `<span class="badge warn">${t('No agent')}</span>`;
}

function pincodeRows(d) {
  return d.pincodes.map((p) => {
    const others = p.officers.filter((o) => o.code !== p.agent?.code);
    return `<tr>
      <td class="check"><input type="checkbox" data-pin="${esc(p.pincode)}" ${selected.has(p.pincode) ? 'checked' : ''} ${p.pincode === '—' ? 'disabled' : ''} aria-label="${esc(t('Select pincode {pin}', { pin: p.pincode }))}"></td>
      <td class="primary"><a href="#/loans?pincode=${encodeURIComponent(p.pincode)}"><b>${esc(p.pincode)}</b></a></td>
      <td class="right num" data-label="${esc(t('Accounts'))}">${num(p.accounts)}</td>
      <td class="right num" data-label="${esc(t('Overdue'))}">${inr(p.overdue)}</td>
      <td data-label="${esc(t('Agent'))}">${agentCell(p)}${others.length ? `<div class="cell-sub">${t('Also: {list}', { list: others.map((o) => `${esc(o.code)} (${num(o.n)})`).join(', ') })}</div>` : ''}</td>
      <td class="right num" data-label="${esc(t('Unassigned'))}">${p.unassigned ? `<span class="badge warn">${num(p.unassigned)}</span>` : '0'}</td>
      <td class="actions"><div class="row-actions">${p.pincode === '—' ? '' : `<button class="btn sm ghost" data-depute="${esc(p.pincode)}">${icon('users')} ${p.agent ? t('Change agent') : t('Depute agent')}</button>`}</div></td>
    </tr>`;
  }).join('');
}

const figures = (n) => `<span class="area-fig">${accounts(n.accounts)} · ${inr(n.overdue)}${n.unassigned ? ` · <span class="badge warn">${t('{n} unassigned', { n: num(n.unassigned) })}</span>` : ''}</span>`;

export async function render(el, q, alive) {
  const branchParam = q.get('branch') || '';
  const [data, { users }] = await Promise.all([api(`areas${branchParam ? `?branch=${encodeURIComponent(branchParam)}` : ''}`), api('users')]);
  if (!alive()) return;
  if (data.branch !== lastBranch) {
    selected = new Set();
    lastBranch = data.branch;
  }
  const officers = users.filter((u) => u.role === 'officer' && u.active && u.branch === data.branch);
  const find = (q.get('q') || '').trim().toLowerCase();
  const onlyOpen = q.get('show') === 'noagent';
  const all = data.states.flatMap((s) => s.districts.flatMap((d) => d.pincodes));
  // A pincode can sit in two districts in the lender's file; count each pincode once.
  const pinCount = new Set(all.map((p) => p.pincode)).size;
  const withAgent = new Set(all.filter((p) => p.agent).map((p) => p.pincode)).size;

  // Filtering keeps the tree, dropping what doesn't match.
  const states = data.states.map((s) => ({
    ...s,
    districts: s.districts.map((d) => ({
      ...d,
      pincodes: d.pincodes.filter((p) =>
        (!onlyOpen || !p.agent) &&
        (!find || p.pincode.includes(find) || d.district.toLowerCase().includes(find) || s.state.toLowerCase().includes(find))),
    })).filter((d) => d.pincodes.length),
  })).filter((s) => s.districts.length);
  const expandAll = Boolean(find);

  el.innerHTML = `
    <div class="page-head">
      <div><h1>${t('Areas')}</h1><p>${t('Accounts by state, district and pincode. Depute an agent to a pincode: its accounts are assigned to them, and new accounts there go to them when you import.')}</p></div>
      <div class="page-actions">${helpButton('areas')}</div>
    </div>
    ${data.branch ? `
    <div class="mini-kpis">
      <div><span>${t('Pincodes')}</span><b>${num(pinCount)}</b></div>
      <div><span>${t('With an agent')}</span><b>${num(withAgent)}</b></div>
      <div><span>${t('Without an agent')}</span><b>${num(pinCount - withAgent)}</b></div>
      <div><span>${t('Unassigned accounts')}</span><b>${num(all.reduce((s, p) => s + p.unassigned, 0))}</b></div>
    </div>
    <form class="toolbar" id="filters" role="search">
      <label class="search"><span class="sr-only">${t('Search areas')}</span>${icon('search')}<input class="input" name="q" type="search" placeholder="${esc(t('Pincode, district or state'))}" value="${esc(q.get('q') || '')}"></label>
      ${data.branches.length > 1 ? `<select class="select" name="branch" aria-label="${esc(t('Branch'))}">${data.branches.map((b) => `<option value="${esc(b)}" ${b === data.branch ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select>` : `<input type="hidden" name="branch" value="${esc(data.branch)}">`}
      <select class="select" name="show" aria-label="${esc(t('Show'))}">
        <option value="">${t('All pincodes')}</option>
        <option value="noagent" ${onlyOpen ? 'selected' : ''}>${t('Pincodes without an agent')}</option>
      </select>
    </form>
    <div id="bulk"></div>
    ${officers.length ? '' : `<div class="warn-box" style="margin-bottom:16px">${icon('users')} ${t('Add field officers with branch {branch} in Users first; agents are chosen from them.', { branch: `<b>${esc(data.branch)}</b>` })}</div>`}
    ${states.length ? states.map((s) => `
      <details class="card area" data-area-key="s:${esc(s.state)}" ${expandAll || open.has(`s:${s.state}`) ? 'open' : ''}>
        <summary class="area-head">${icon('chevronRight', 'area-caret')}<b>${esc(s.state)}</b>${figures(s)}</summary>
        ${s.districts.map((d) => `
          <details class="area-district" data-area-key="d:${esc(s.state)}|${esc(d.district)}" ${expandAll || open.has(`d:${s.state}|${d.district}`) ? 'open' : ''}>
            <summary class="area-head">${icon('chevronRight', 'area-caret')}<b>${esc(d.district)}</b>${figures(d)}
              <span style="flex:1"></span><button type="button" class="btn sm ghost" data-select-district="${esc(s.state)}|${esc(d.district)}">${t('Select all {n}', { n: num(d.pincodes.length) })}</button></summary>
            <div class="table-wrap"><table class="data responsive">
              <thead><tr><th class="check"></th><th>${t('Pincode')}</th><th class="right">${t('Accounts')}</th><th class="right">${t('Overdue')}</th><th>${t('Agent')}</th><th class="right">${t('Unassigned')}</th><th></th></tr></thead>
              <tbody>${pincodeRows(d)}</tbody>
            </table></div>
          </details>`).join('')}
      </details>`).join('') : emptyState(t('No pincodes match'), t('Try clearing the search.'), 'map')}
    ` : emptyState(t('No accounts with a pincode yet'), t('Import a file with a pincode column (for example a lender’s recovery list) and the accounts appear here by state, district and pincode.'), 'map')}`;

  const bulk = () => {
    const box = el.querySelector('#bulk');
    if (!box) return;
    box.innerHTML = selected.size ? `
      <div class="bulkbar" role="region" aria-label="${esc(t('Bulk actions'))}">
        <span class="count">${selected.size === 1 ? t('1 pincode selected') : t('{n} pincodes selected', { n: num(selected.size) })}</span>
        <span style="flex:1"></span>
        <button class="btn sm primary" data-act="bulk-depute">${t('Depute agent')}</button>
        <button class="btn sm ghost" style="color:inherit" data-act="clear">${t('Clear')}</button>
      </div>` : '';
  };
  bulk();

  async function depute(pincodes) {
    const one = pincodes.length === 1 ? all.find((p) => p.pincode === pincodes[0]) : null;
    const n = all.filter((p) => pincodes.includes(p.pincode)).reduce((s, p) => s + p.accounts, 0);
    const done = await dialog({
      title: one ? t('Agent for pincode {pin}', { pin: esc(one.pincode) }) : t('Agent for {n} pincodes', { n: num(pincodes.length) }),
      ok: t('Save'),
      body: `<div class="form">
        <p style="margin:0">${t('{accounts} in {branch}.', { accounts: accounts(n), branch: esc(data.branch) })}</p>
        <label class="field"><span>${t('Agent')}</span>
          <select class="select" name="officer">
            <option value="">${t('— No agent —')}</option>
            ${officers.map((o) => `<option value="${esc(o.code)}" ${o.code === one?.agent?.code ? 'selected' : ''}>${esc(o.name)} (${esc(o.code)})</option>`).join('')}
          </select></label>
        <fieldset class="field" style="border:0;padding:0;margin:0"><span>${t('Which accounts')}</span>
          <label class="row" style="display:flex;gap:8px;align-items:center"><input type="radio" name="mode" value="all" checked> ${t('All accounts in these pincodes (moves them from other officers)')}</label>
          <label class="row" style="display:flex;gap:8px;align-items:center"><input type="radio" name="mode" value="unassigned"> ${t('Only unassigned accounts')}</label>
        </fieldset>
        <p class="muted small" style="margin:0">${t('New accounts in these pincodes are assigned to this agent when you import.')}</p>
      </div>`,
      onOk: (f) => api('areas/agent', { method: 'POST', body: { branch: data.branch, pincodes, officerCode: f.officer || null, mode: f.mode } }),
    });
    if (!done) return;
    toast(done.changed === 1 ? t('1 account assigned') : t('{n} accounts assigned', { n: num(done.changed) }));
    selected = new Set();
    route();
  }

  el.removeEventListener('toggle', onToggle, true);
  el.addEventListener('toggle', onToggle, true);

  const form = el.querySelector('#filters');
  let timer;
  el.oninput = (e) => {
    if (e.target.name !== 'q') return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      setQuery(Object.fromEntries(new FormData(form)), { replace: true });
      requestAnimationFrame(() => {
        const input = el.querySelector('input[name=q]');
        input?.focus();
        input?.setSelectionRange(input.value.length, input.value.length);
      });
    }, 300);
  };
  el.onchange = (e) => {
    if (e.target.dataset.pin) {
      if (e.target.checked) selected.add(e.target.dataset.pin);
      else selected.delete(e.target.dataset.pin);
      return bulk();
    }
    if (e.target.closest('#filters') && e.target.name !== 'q') setQuery(Object.fromEntries(new FormData(form)));
  };
  el.onsubmit = (e) => e.preventDefault();
  el.onclick = (e) => {
    const sd = e.target.closest('[data-select-district]');
    if (sd) {
      e.preventDefault();
      const [st, di] = sd.dataset.selectDistrict.split('|');
      const d = states.find((s) => s.state === st)?.districts.find((x) => x.district === di);
      const pins = d.pincodes.map((p) => p.pincode).filter((p) => p !== '—');
      const allOn = pins.every((p) => selected.has(p));
      for (const p of pins) allOn ? selected.delete(p) : selected.add(p);
      sd.closest('details').querySelectorAll('[data-pin]').forEach((c) => (c.checked = selected.has(c.dataset.pin)));
      if (!sd.closest('details').open) sd.closest('details').open = true;
      return bulk();
    }
    const one = e.target.closest('[data-depute]');
    if (one) return depute([one.dataset.depute]);
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'bulk-depute') depute([...selected]);
    if (act === 'clear') {
      selected = new Set();
      el.querySelectorAll('[data-pin]').forEach((c) => (c.checked = false));
      bulk();
    }
  };
}
