// Areas: accounts grouped by state → district → pincode, and the agent deputed to each pincode.
// Deputing an agent assigns the pincode's accounts to them; new accounts there go to them on import.
import { api, download } from '../api.js';
import { esc, icon, inr, inrShort, num, toast, dialog, emptyState, helpButton } from '../ui.js';
import { t, tr } from '../../../i18n/i18n.js';
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

/* i18n: t('Pincodes') t('Agents') t('Recruitment plan') */
const VIEWS = [['pincodes', 'Pincodes', 'map'], ['agents', 'Agents', 'users'], ['plan', 'Recruitment plan', 'plus']];

function head(data, view) {
  const link = (v) => {
    const p = new URLSearchParams({ ...(data.branch ? { branch: data.branch } : {}), ...(v === 'pincodes' ? {} : { view: v }) });
    return `#/areas${p.toString() ? `?${p}` : ''}`;
  };
  return `
    <div class="page-head">
      <div><h1>${t('Areas')}</h1><p>${t('Accounts by state, district and pincode. Depute an agent to a pincode: its accounts are assigned to them, and new accounts there go to them when you import.')}</p></div>
      <div class="page-actions">${helpButton('areas')}</div>
    </div>
    ${data.branch ? `<nav class="tabs" aria-label="${esc(t('Areas'))}">${VIEWS.map(([v, label, ic]) =>
      `<a href="${link(v)}" class="${v === view ? 'active' : ''}" ${v === view ? 'aria-current="page"' : ''}>${icon(ic)} ${t(label)}</a>`).join('')}</nav>` : ''}`;
}

export async function render(el, q, alive) {
  const branchParam = q.get('branch') || '';
  const [data, { users }] = await Promise.all([api(`areas${branchParam ? `?branch=${encodeURIComponent(branchParam)}` : ''}`), api('users')]);
  if (!alive()) return;
  const view = VIEWS.some(([v]) => v === q.get('view')) ? q.get('view') : 'pincodes';
  el.removeEventListener('toggle', onToggle, true);
  if (data.branch && view === 'plan') return renderPlan(el, q, data, alive);
  if (data.branch && view === 'agents') return renderAgents(el, data, users);
  return renderPincodes(el, q, data, users);
}

function renderPincodes(el, q, data, users) {
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
    ${head(data, 'pincodes')}
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

// ---------- agents: home pincode, range, and the pincodes within reach ----------

function renderAgents(el, data, users) {
  const all = data.states.flatMap((s) => s.districts.flatMap((d) => d.pincodes));
  const deputed = (code) => new Set(all.filter((p) => p.agent?.code === code).map((p) => p.pincode)).size;
  const agents = users.filter((u) => u.role === 'officer' && u.branch === data.branch);
  el.innerHTML = `
    ${head(data, 'agents')}
    <p class="muted" style="margin-top:0">${t('Give each agent a home pincode and how far they travel (Users → edit). Then pick the pincodes within their reach.')}</p>
    <section class="card">
      ${agents.length ? `<div class="table-wrap"><table class="data responsive">
        <thead><tr><th>${t('Agent')}</th><th>${t('Home pincode')}</th><th class="right">${t('Range')}</th><th class="right">${t('Pincodes deputed')}</th><th class="right">${t('Accounts')}</th><th></th></tr></thead>
        <tbody>${agents.map((u) => `<tr>
          <td class="primary"><div class="cell-main">${esc(u.name)}</div><div class="cell-sub">${esc(u.code)}${u.active ? '' : ` · ${t('inactive')}`}</div></td>
          <td data-label="${esc(t('Home pincode'))}">${u.basePincode ? esc(u.basePincode) : `<a href="#/users?q=${encodeURIComponent(u.code)}" class="badge warn">${t('Not set')}</a>`}</td>
          <td class="right num" data-label="${esc(t('Range'))}">${t('{n} km', { n: u.rangeKm || 20 })}</td>
          <td class="right num" data-label="${esc(t('Pincodes deputed'))}">${num(deputed(u.code))}</td>
          <td class="right num" data-label="${esc(t('Accounts'))}"><a href="#/loans?officer=${encodeURIComponent(u.code)}">${num(u.loans)}</a></td>
          <td class="actions"><div class="row-actions">${u.active && u.basePincode ? `<button class="btn sm" data-reach="${esc(u.code)}">${icon('map')} ${t('Pincodes in range')}</button>` : ''}</div></td>
        </tr>`).join('')}</tbody></table></div>`
        : emptyState(t('No agents in {branch} yet', { branch: data.branch }), t('Add field officers with branch {branch} in Users, with their home pincode.', { branch: data.branch }), 'users')}
    </section>`;

  el.onclick = async (e) => {
    const btn = e.target.closest('[data-reach]');
    if (!btn) return;
    const u = agents.find((a) => a.code === btn.dataset.reach);
    let near;
    try {
      near = await api(`areas/nearby/${encodeURIComponent(u.code)}`);
    } catch (ex) {
      return toast(tr(ex.message), 'bad');
    }
    const rows = near.pincodes;
    const done = await dialog({
      title: t('{name}: pincodes within {km} km of {pin}', { name: esc(u.name), km: near.range, pin: esc(near.agent.basePincode) }),
      ok: t('Depute to ticked pincodes'),
      body: rows.length ? `<div class="form">
        <p class="muted small" style="margin:0">${t('Straight-line distance from the centre of the home pincode. Pincodes that already have another agent are not ticked.')}</p>
        <div class="table-wrap" style="max-height:50vh;overflow:auto"><table class="data">
          <thead><tr><th></th><th>${t('Pincode')}</th><th class="right">${t('Km')}</th><th class="right">${t('Accounts')}</th><th>${t('Agent')}</th></tr></thead>
          <tbody>${rows.map((p) => `<tr>
            <td class="check"><input type="checkbox" name="pin" value="${esc(p.pincode)}" ${!p.agent || p.agent === u.code ? 'checked' : ''}></td>
            <td><b>${esc(p.pincode)}</b><div class="cell-sub">${esc(p.district || '')}</div></td>
            <td class="right num">${p.km}${p.approx ? '*' : ''}</td>
            <td class="right num">${num(p.accounts)}</td>
            <td>${p.agent ? esc(p.agent) : `<span class="muted">—</span>`}</td></tr>`).join('')}</tbody></table></div>
        <label class="row" style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="onlyUnassigned"> ${t('Only unassigned accounts')}</label>
      </div>` : `<p>${t('No pincodes with accounts within {km} km.', { km: near.range })}</p>`,
      onOk: (f, form) => {
        const pincodes = [...form.querySelectorAll('input[name=pin]:checked')].map((c) => c.value);
        if (!pincodes.length) throw new Error(t('Tick at least one pincode.'));
        return api('areas/agent', { method: 'POST', body: { branch: data.branch, pincodes, officerCode: u.code, mode: f.onlyUnassigned ? 'unassigned' : 'all' } });
      },
    });
    if (!done) return;
    toast(done.changed === 1 ? t('1 account assigned') : t('{n} accounts assigned', { n: num(done.changed) }));
    route();
  };
}

// ---------- recruitment plan ----------

async function renderPlan(el, q, data, alive) {
  const params = new URLSearchParams({
    branch: data.branch, km: q.get('km') || '20', max: q.get('max') || '250', min: q.get('min') || '20', scope: q.get('scope') || 'open',
  });
  const plan = await api(`areas/plan?${params}`);
  if (!alive()) return;
  const s = plan.summary;
  const row = (a, i) => `<tr>
    <td class="right num">${a.no ?? i + 1}</td>
    <td class="primary"><b>${esc(a.base.pincode)}</b>${a.base.approx ? '*' : ''}<div class="cell-sub">${esc(a.base.district || '')}, ${esc(a.base.state || '')}</div></td>
    <td class="right num" data-label="${esc(t('Accounts'))}">${num(a.accounts)}</td>
    <td class="right num" data-label="${esc(t('Overdue'))}">${inr(a.overdue)}</td>
    <td class="right num" data-label="${esc(t('Farthest'))}">${t('{n} km', { n: a.farthestKm })}</td>
    <td data-label="${esc(t('Covers'))}"><details><summary>${a.pincodes.length === 1 ? t('1 pincode') : t('{n} pincodes', { n: num(a.pincodes.length) })}</summary>
      <div class="small">${a.pincodes.map((p) => `${esc(p.pincode)} <span class="muted">(${p.km} km, ${num(p.accounts)})</span>`).join(', ')}</div></details></td>
  </tr>`;
  const table = (list) => `<div class="table-wrap"><table class="data responsive">
    <thead><tr><th class="right">#</th><th>${t('Recruit in pincode')}</th><th class="right">${t('Accounts')}</th><th class="right">${t('Overdue')}</th><th class="right">${t('Farthest')}</th><th>${t('Covers')}</th></tr></thead>
    <tbody>${list.map(row).join('')}</tbody></table></div>`;

  el.innerHTML = `
    ${head(data, 'plan')}
    <form class="toolbar" id="plan-form">
      <label class="field inline"><span>${t('Range (km)')}</span><input class="input" name="km" type="number" min="1" max="200" value="${esc(params.get('km'))}" style="width:90px"></label>
      <label class="field inline"><span>${t('Most accounts per agent')}</span><input class="input" name="max" type="number" min="10" max="5000" value="${esc(params.get('max'))}" style="width:100px"></label>
      <label class="field inline"><span>${t('Smallest agent')}</span><input class="input" name="min" type="number" min="0" max="1000" value="${esc(params.get('min'))}" style="width:90px"></label>
      <select class="select" name="scope" aria-label="${esc(t('Pincodes'))}">
        <option value="open" ${params.get('scope') === 'open' ? 'selected' : ''}>${t('Pincodes without an agent')}</option>
        <option value="all" ${params.get('scope') === 'all' ? 'selected' : ''}>${t('All pincodes')}</option>
      </select>
      <button class="btn primary" type="submit">${icon('refresh')} ${t('Make plan')}</button>
      <button class="btn" type="button" data-act="xlsx">${icon('download')} ${t('Download Excel')}</button>
    </form>
    <div class="mini-kpis">
      <div><span>${t('Agents to recruit')}</span><b>${num(s.agents)}</b></div>
      <div><span>${t('Accounts they cover')}</span><b>${num(s.accounts)}</b></div>
      <div><span>${t('Overdue they cover')}</span><b>${inrShort(s.overdue)}</b></div>
      <div><span>${t('Thin areas')}</span><b>${num(s.thinAreas)} · ${t('{n} accounts', { n: num(s.thinAccounts) })}</b></div>
    </div>
    <p class="muted small">${t('Each agent lives in the pincode shown and covers pincodes within the range, nearest first, up to the most accounts per agent. The richest areas come first. Distances are straight-line; by road they are usually 20–40% longer. * = pincode located from a neighbouring pincode.')}</p>
    <section class="card">${plan.agents.length ? table(plan.agents) : emptyState(t('Nothing to plan'), t('Every pincode already has an agent, or no account has a pincode.'), 'map')}</section>
    ${plan.thin.length ? `<details class="card" style="margin-top:16px"><summary class="area-head"><b>${t('Thin areas')}</b>
      <span class="area-fig">${t('{n} groups smaller than {min} accounts: cover them by visits from the nearest agent, or by phone.', { n: num(plan.thin.length), min: plan.min })}</span></summary>
      ${table(plan.thin)}</details>` : ''}
    ${plan.unlocated.length ? `<div class="warn-box" style="margin-top:16px">${t('Pincodes that could not be located: {list}', { list: plan.unlocated.map((p) => esc(p.pincode)).join(', ') })}</div>` : ''}`;

  const form = el.querySelector('#plan-form');
  el.onsubmit = (e) => {
    e.preventDefault();
    setQuery({ branch: data.branch, view: 'plan', ...Object.fromEntries(new FormData(form)) });
  };
  el.onclick = (e) => {
    if (e.target.closest('[data-act=xlsx]')) {
      const p = new URLSearchParams({ branch: data.branch, ...Object.fromEntries(new FormData(form)) });
      download(`areas/plan.xlsx?${p}`, 'recruitment-plan.xlsx').catch((ex) => toast(tr(ex.message), 'bad'));
    }
  };
}
