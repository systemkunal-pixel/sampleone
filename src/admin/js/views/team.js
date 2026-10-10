// Team: State Heads → District Coordinators → Agents. The hierarchy with figures, importing people under a
// parent officer, adding one person, and moving people. Agents work every client's accounts in their pincodes.
import { api, download } from '../api.js';
import { esc, icon, inr, num, toast, dialog, openDrawer, closeDrawer, drawerHead, emptyState, helpButton, initials } from '../ui.js';
import { t, tr } from '../../../i18n/i18n.js';

/* i18n: t('State Head') t('District Coordinator') t('Agent') t('State Heads') t('District Coordinators') t('Agents') */
const POSTS = {
  state_head: { label: 'State Head', plural: 'State Heads', parent: null, cls: 'sh' },
  coordinator: { label: 'District Coordinator', plural: 'District Coordinators', parent: 'state_head', cls: 'dc' },
  agent: { label: 'Agent', plural: 'Agents', parent: 'coordinator', cls: 'ag' },
};
const postBadge = (p) => `<span class="post ${POSTS[p].cls}">${esc(t(POSTS[p].label))}</span>`;
const MAX_BYTES = 10 * 1024 * 1024;
const added = (n) => (n === 1 ? t('1 person added.') : t('{n} people added.', { n: num(n) }));

let open = new Set();
let imp = { post: 'agent', parent: '', defaultRange: 20, preview: null, payload: null, result: null };

const toBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = () => reject(new Error(t('Could not read the file.')));
  r.readAsDataURL(file);
});

function tabs(view) {
  return `<nav class="tabs" aria-label="${esc(t('Team'))}">
    <a href="#/team" class="${view === 'tree' ? 'active' : ''}">${icon('layers')} ${t('Hierarchy')}</a>
    <a href="#/team?view=import" class="${view === 'import' ? 'active' : ''}">${icon('upload')} ${t('Import people')}</a></nav>`;
}

function head() {
  return `<div class="page-head">
    <div><h1>${t('Team')}</h1><p>${t('State Heads → District Coordinators → Agents. Everyone reports to one person above them, and the team works every client’s accounts.')}</p></div>
    <div class="page-actions">${helpButton('team')}<a class="btn primary" href="#/team?view=import">${icon('plus')} ${t('Import people')}</a></div></div>`;
}

// ---------- hierarchy ----------

function nodeRows(n, depth) {
  const key = n.code;
  const hasKids = n.children.length > 0;
  const isOpen = open.has(key);
  const area = n.post === 'agent'
    ? [n.basePincode, n.rangeKm ? t('{n} km', { n: n.rangeKm }) : ''].filter(Boolean).join(' · ')
    : [...n.districts, ...(n.districts.length ? [] : n.states)].join(', ');
  const row = `<div class="tree-row lvl${depth}" data-code="${esc(n.code)}">
    <div class="who">
      ${hasKids ? `<button class="icon-btn caret ${isOpen ? 'open' : ''}" data-toggle="${esc(key)}" aria-label="${esc(t('Show team'))}">${icon('chevronRight')}</button>` : '<span class="caret-space"></span>'}
      <span class="avatar">${esc(initials(n.name))}</span>
      <div style="min-width:0"><div class="cell-main">${esc(n.name)} ${postBadge(n.post)} ${n.active ? '' : `<span class="badge">${t('inactive')}</span>`}</div>
        <div class="cell-sub">${esc(n.code)}${area ? ` · ${esc(area)}` : ''}${n.phone ? ` · ${esc(n.phone)}` : ''}</div></div>
    </div>
    <div class="num" data-label="${esc(t('Team'))}">${n.post === 'agent' ? '—' : num(n.people)}</div>
    <div class="num" data-label="${esc(t('Accounts'))}">${n.accounts ? `<a href="#/loans?officer=${n.post === 'agent' ? encodeURIComponent(n.code) : ''}">${num(n.accounts)}</a>` : '0'}</div>
    <div class="num" data-label="${esc(t('Overdue in file'))}">${n.due ? inr(n.due) : '—'}</div>
    <div class="num" data-label="${esc(t('Collected this month'))}">${n.collectedMonth ? inr(n.collectedMonth) : '—'}</div>
    <div class="num" data-label="${esc(t('Unassigned'))}">${n.post === 'agent' ? '' : n.unassigned ? `<span class="badge warn">${num(n.unassigned)}</span>` : '0'}</div>
    <div class="row-actions">
      ${n.post !== 'agent' ? `<a class="btn sm ghost" href="#/team?view=import&post=${n.post === 'state_head' ? 'coordinator' : 'agent'}&parent=${encodeURIComponent(n.code)}">${icon('plus')} ${t('Add under')}</a>` : ''}
      ${n.post !== 'state_head' ? `<button class="btn sm ghost" data-move="${esc(n.code)}">${icon('edit')} ${t('Move')}</button>` : ''}
    </div>
  </div>`;
  return row + (hasKids && isOpen ? n.children.map((k) => nodeRows(k, depth + 1)).join('') : '');
}

function findNode(roots, code) {
  for (const r of roots) {
    if (r.code === code) return r;
    const f = findNode(r.children, code);
    if (f) return f;
  }
  return null;
}

async function renderTree(el) {
  const data = await api('team');
  if (!open.size) for (const r of data.roots) open.add(r.code); // State Heads open at first
  const c = data.counts;
  el.innerHTML = `${head()}${tabs('tree')}
    <div class="mini-kpis">
      <div><span>${t('State Heads')}</span><b>${num(c.state_head)}</b></div>
      <div><span>${t('District Coordinators')}</span><b>${num(c.coordinator)}</b></div>
      <div><span>${t('Agents')}</span><b>${num(c.agent)}</b></div>
      <div><span>${t('Without a parent')}</span><b>${c.orphans ? `<span style="color:var(--warn)">${num(c.orphans)}</span>` : '0'}</b></div>
    </div>
    <section class="card">
      ${data.roots.length ? `<div class="tree">
        <div class="tree-row tree-head"><div>${t('Person')}</div><div class="num">${t('Team')}</div><div class="num">${t('Accounts')}</div><div class="num">${t('Overdue in file')}</div><div class="num">${t('Collected this month')}</div><div class="num">${t('Unassigned')}</div><div></div></div>
        ${data.roots.map((r) => nodeRows(r, 0)).join('')}
      </div>` : emptyState(t('No team yet'), t('Start with the State Heads: Import people → post State Head. Then Coordinators under each State Head, and Agents under each Coordinator.'), 'layers')}
    </section>
    <p class="muted small" style="margin-top:12px">${t('Figures add up the tree: a Coordinator’s are their agents’ totals, a State Head’s their Coordinators’. Unassigned = accounts in a Coordinator’s districts with no agent yet.')}</p>`;

  el.onclick = async (e) => {
    const tg = e.target.closest('[data-toggle]');
    if (tg) {
      const k = tg.dataset.toggle;
      if (open.has(k)) open.delete(k);
      else open.add(k);
      return renderTree(el);
    }
    const mv = e.target.closest('[data-move]');
    if (!mv) return;
    const n = findNode(data.roots, mv.dataset.move);
    const want = POSTS[n.post].parent;
    const options = data.parents.filter((p) => p.post === want && p.code !== n.code);
    const done = await dialog({
      title: t('Move {name}', { name: esc(n.name) }),
      ok: t('Move'),
      body: `<div class="form"><label class="field"><span>${t('Reports to')}</span>
        <select class="select" name="parent">${options.map((p) => `<option value="${esc(p.code)}" ${p.code === n.parentCode ? 'selected' : ''}>${esc(p.name)} (${esc(p.code)})${p.districts.length ? ` · ${esc(p.districts.join(', '))}` : p.states.length ? ` · ${esc(p.states.join(', '))}` : ''}</option>`).join('')}</select></label>
        ${n.post === 'coordinator' ? `<label class="field"><span>${t('Districts they look after')}</span><input class="input" name="districts" value="${esc(n.districts.join('; '))}"><span class="hint">${t('Separate with ; — unassigned accounts in these districts show in their app.')}</span></label>` : ''}</div>`,
      onOk: (f) => api(`team/${encodeURIComponent(n.code)}`, { method: 'PATCH', body: { parentCode: f.parent, ...(f.districts !== undefined ? { districts: f.districts } : {}) } }),
    });
    if (done) {
      toast(t('{name} moved', { name: n.name }));
      renderTree(el);
    }
  };
}

// ---------- import ----------

function chain(parents, post, parentCode) {
  const byCode = new Map(parents.map((p) => [p.code, p]));
  const line = [];
  let p = byCode.get(parentCode);
  while (p) {
    line.unshift(p);
    p = byCode.get(p.parentCode);
  }
  return `<div class="chain"><span class="node">${t('Admin')}</span>${line.map((x) => `${icon('chevronRight')}<span class="node ${x.code === parentCode ? 'on' : ''}">${esc(x.name)} · ${esc(t(POSTS[x.post].label))}</span>`).join('')}${icon('chevronRight')}<span class="node new">${t('New {post}', { post: t(POSTS[post].plural) })}</span></div>`;
}

function chooser(parents) {
  const want = POSTS[imp.post].parent;
  const options = parents.filter((p) => p.post === want);
  if (want && !options.some((p) => p.code === imp.parent)) imp.parent = options[0]?.code || '';
  return `
    <div class="grid two" style="grid-template-columns:1.1fr 1fr">
      <section class="card"><div class="card-head"><h2>${icon('users')} ${t('Who are you adding?')}</h2></div><div class="card-body form">
        <label class="field"><span>${t('Post')} <span class="req">*</span></span>
          <select class="select" id="imp-post">${Object.entries(POSTS).map(([k, p]) => `<option value="${k}" ${k === imp.post ? 'selected' : ''}>${esc(t(p.label))}</option>`).join('')}</select>
          <span class="hint">${t('Everyone in the file gets this post.')}</span></label>
        ${want ? `<label class="field"><span>${t('Parent officer (reports to)')} <span class="req">*</span></span>
          <select class="select" id="imp-parent">${options.length ? options.map((p) => `<option value="${esc(p.code)}" ${p.code === imp.parent ? 'selected' : ''}>${esc(p.name)} (${esc(p.code)}) · ${esc(t(POSTS[p.post].label))}${p.districts.length ? ` · ${esc(p.districts.join(', '))}` : p.states.length ? ` · ${esc(p.states.join(', '))}` : ''}</option>`).join('') : `<option value="">${t('— none yet —')}</option>`}</select>
          <span class="hint">${options.length ? t('Only people one level up are listed.') : t('Add the {post} first.', { post: t(POSTS[want].label) })}</span></label>`
          : `<div class="info-box small">${t('State Heads report to the company admin.')}</div>`}
        <div class="field"><span>${t('Reporting line')}</span>${chain(parents, imp.post, want ? imp.parent : null)}</div>
        ${imp.post === 'agent' ? `<label class="field"><span>${t('Default range for agents (km)')}</span><input class="input" id="imp-range" type="number" min="1" max="200" value="${esc(imp.defaultRange)}" style="max-width:200px"><span class="hint">${t('Used when a row has no range.')}</span></label>` : ''}
        <div class="info-box small">${icon('layers')} ${t('The team is not tied to any client. An agent works every account allotted in their pincodes, for every client, with the same structure.')}</div>
      </div></section>
      <section class="card"><div class="card-head"><h2>${icon('upload')} ${t('The list')}</h2><button class="btn sm" data-act="template">${icon('download')} ${t('Download template')}</button></div><div class="card-body stack">
        <label class="dropzone" id="dropzone" tabindex="0">${icon('sheet')}<b>${t('Drop the Excel or CSV file here')}</b><span class="muted small">${t('or click to choose · up to 2,000 people')}</span>
          <input type="file" id="file" accept=".xlsx,.csv" hidden></label>
        <div class="error-box" id="imp-error" role="alert"></div>
        <button class="btn" data-act="one">${icon('plus')} ${t('Add one person instead')}</button>
        <div class="small"><b>${t('Columns')}</b> ${t('(headings are matched loosely)')}:
          <ul style="margin:6px 0 0;padding-left:18px;line-height:1.7">
            <li><b>${t('Name')}*</b>, <b>${t('Mobile')}*</b></li>
            <li><b>${t('Code')}</b> — ${t('blank = made for you')}</li>
            ${imp.post === 'agent' ? `<li><b>${t('Home pincode')}</b>, <b>${t('Range km')}</b></li>` : ''}
            <li><b>${t('State')}</b> / <b>${t('District')}</b> — ${t('the area they look after')}</li>
            <li><b>PIN</b> — ${t('blank = a random 4-digit PIN')}</li>
          </ul></div>
      </div></section>
    </div>`;
}

function review() {
  const p = imp.preview;
  const warned = p.rows.filter((r) => r.warnings.length).length;
  const tile = (label, value, cls = '', sub = '') => `<div class="kpi ${cls}"><div class="label">${label}</div><div class="value">${num(value)}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  const parentName = p.parent ? `${esc(p.parent.name)} (${esc(p.parent.code)})` : t('the company admin');
  return `
    <div class="info-box" style="margin-bottom:16px"><div class="chain">${t('Adding')} <span class="node new">${num(p.rows.length)} ${esc(t(POSTS[p.post].plural))}</span> ${t('under')} <span class="node on">${parentName}</span></div></div>
    <section class="stat-row grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:16px">
      ${tile(t('Rows in file'), p.rows.length + p.errors.length)}
      ${tile(t('Ready'), p.rows.length)}
      ${tile(t('With warnings'), warned, warned ? 'attention' : '', t('imported anyway'))}
      ${tile(t('Can’t import'), p.errors.length, p.errors.length ? 'alert' : '', p.errors.length ? t('fix and upload again') : '')}
    </section>
    <section class="card"><div class="table-wrap" style="max-height:520px;overflow:auto"><table class="data responsive">
      <thead><tr><th>${t('Row')}</th><th>${t('Code')}</th><th>${t('Name')}</th><th>${t('Mobile')}</th>${p.post === 'agent' ? `<th>${t('Home pincode · range')}</th>` : ''}<th>${t('Area')}</th><th>${t('Check')}</th></tr></thead>
      <tbody>
        ${p.rows.map((r) => `<tr>
          <td class="muted">${r.rowNo}</td>
          <td class="primary"><b>${esc(r.code)}</b> ${r.autoCode ? `<span class="badge">${t('auto')}</span>` : ''}</td>
          <td data-label="${esc(t('Name'))}">${esc(r.name)}</td><td data-label="${esc(t('Mobile'))}">${esc(r.phone || '—')}</td>
          ${p.post === 'agent' ? `<td data-label="${esc(t('Home pincode · range'))}">${esc(r.basePincode || '—')} · ${t('{n} km', { n: r.rangeKm })}</td>` : ''}
          <td data-label="${esc(t('Area'))}">${esc(r.districts || r.states || '—')}</td>
          <td data-label="${esc(t('Check'))}">${r.warnings.length ? `<span class="badge warn">${t('Warning')}</span>${r.warnings.map((w) => `<div class="cell-sub" style="color:var(--warn)">${esc(tr(w))}</div>`).join('')}` : `<span class="badge ok">${icon('check')} ${t('Ready')}</span>`}</td>
        </tr>`).join('')}
        ${p.errors.map((e) => `<tr><td class="muted">${e.rowNo}</td><td class="primary">—</td><td>${esc(e.name || '—')}</td><td colspan="${p.post === 'agent' ? 3 : 2}"></td>
          <td><span class="badge bad">${t('Can’t import')}</span>${e.errors.map((m) => `<div class="cell-sub" style="color:var(--bad)">${esc(tr(m))}</div>`).join('')}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="card-body" style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;border-top:1px solid var(--border)">
        ${p.post === 'agent' ? `<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="auto-depute" checked> ${t('After import, depute each agent to the pincodes within their range that have no agent')}</label>` : ''}
        <span style="flex:1"></span>
        <button class="btn" data-act="restart">${t('Cancel')}</button>
        <button class="btn primary" data-act="commit" ${p.rows.length ? '' : 'disabled'}>${icon('check')} ${p.rows.length === 1 ? t('Add 1 person') : t('Add {n} people', { n: num(p.rows.length) })}</button>
      </div></section>
    <p class="muted small" style="margin-top:12px">${icon('key')} ${t('After import you download a logins sheet (code, name, mobile, PIN) to hand to each person. PINs are not shown again.')}</p>`;
}

function loginsCsv(logins) {
  const cell = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return [[t('Code'), t('Name'), t('Mobile'), t('Post'), 'PIN'], ...logins.map((l) => [l.code, l.name, l.phone, l.post, l.pin])].map((r) => r.map(cell).join(',')).join('\r\n');
}

function done() {
  const r = imp.result;
  return `<section class="card"><div class="card-body stack">
    <div class="info-box">${icon('check')} ${added(r.logins.length)}${r.deputed ? ` ${t('{n} accounts were assigned to the new agents by pincode.', { n: num(r.deputed) })}` : ''}</div>
    <div class="warn-box">${icon('key')} ${t('Download the logins now and hand each person their code and PIN privately. The PINs are not shown again.')}</div>
    <div><button class="btn primary" data-act="logins">${icon('download')} ${t('Download logins (CSV)')}</button> <a class="btn" href="#/team">${t('Go to the hierarchy')}</a> <button class="btn" data-act="restart">${icon('upload')} ${t('Import more people')}</button></div>
    <div class="table-wrap"><table class="data"><thead><tr><th>${t('Code')}</th><th>${t('Name')}</th><th>${t('Mobile')}</th><th>PIN</th></tr></thead>
      <tbody>${r.logins.map((l) => `<tr><td><b>${esc(l.code)}</b></td><td>${esc(l.name)}</td><td>${esc(l.phone || '')}</td><td><code>${esc(l.pin)}</code></td></tr>`).join('')}</tbody></table></div>
  </div></section>`;
}

async function renderImport(el, q) {
  const { parents } = await api('team');
  if (q.get('post') && POSTS[q.get('post')]) imp.post = q.get('post');
  if (q.get('parent')) imp.parent = q.get('parent');
  const draw = () => {
    el.innerHTML = `${head()}${tabs('import')}${imp.result ? done() : imp.preview ? review() : chooser(parents)}`;
  };
  draw();

  const send = async (payload) => {
    imp.payload = payload;
    imp.preview = await api('team/preview', { method: 'POST', body: payload });
    draw();
    window.scrollTo(0, 0);
  };
  const base = () => ({ post: imp.post, parentCode: POSTS[imp.post].parent ? imp.parent : null, defaultRange: imp.defaultRange });

  async function upload(file) {
    const err = el.querySelector('#imp-error');
    err.textContent = '';
    if (POSTS[imp.post].parent && !imp.parent) return (err.textContent = t('Choose the parent officer first.'));
    if (!/\.(xlsx|csv)$/i.test(file.name)) return (err.textContent = t('Choose an .xlsx or .csv file.'));
    if (file.size > MAX_BYTES) return (err.textContent = t('The file is larger than 10 MB. Split it into smaller files.'));
    try {
      await send({ ...base(), fileName: file.name, base64: await toBase64(file) });
    } catch (ex) {
      err.textContent = tr(ex.message);
    }
  }

  function addOne() {
    const d = openDrawer(`
      ${drawerHead(t('Add one {post}', { post: t(POSTS[imp.post].label) }), t('Checked the same way as a file.'))}
      <form class="drawer-body form" id="one-form" novalidate>
        <div class="form-row">
          <label class="field"><span>${t('Name')} <span class="req">*</span></span><input class="input" name="name" required maxlength="100" autofocus></label>
          <label class="field"><span>${t('Mobile')} <span class="req">*</span></span><input class="input" name="phone" inputmode="tel" maxlength="20"></label>
        </div>
        <div class="form-row">
          <label class="field"><span>${t('Code')}</span><input class="input" name="code" maxlength="12" autocapitalize="characters"><span class="hint">${t('blank = made for you')}</span></label>
          <label class="field"><span>PIN</span><input class="input" name="pin" inputmode="numeric" maxlength="8"><span class="hint">${t('blank = a random 4-digit PIN')}</span></label>
        </div>
        ${imp.post === 'agent' ? `<div class="form-row">
          <label class="field"><span>${t('Home pincode')}</span><input class="input" name="basePincode" inputmode="numeric" maxlength="6"></label>
          <label class="field"><span>${t('Range km')}</span><input class="input" name="rangeKm" type="number" min="1" max="200" value="${esc(imp.defaultRange)}"></label></div>` : ''}
        <div class="form-row">
          <label class="field"><span>${t('State')}</span><input class="input" name="states" maxlength="300"></label>
          <label class="field"><span>${t('District')}</span><input class="input" name="districts" maxlength="1000"><span class="hint">${t('Several: separate with ;')}</span></label>
        </div>
        <div class="error-box" data-err role="alert"></div>
      </form>
      <div class="drawer-foot"><button class="btn" data-close type="button">${t('Cancel')}</button><button class="btn primary" type="submit" form="one-form">${t('Check')}</button></div>`);
    d.onsubmit = async (e) => {
      e.preventDefault();
      const person = Object.fromEntries(new FormData(d.querySelector('#one-form')));
      try {
        await send({ ...base(), people: [person] });
        closeDrawer();
      } catch (ex) {
        d.querySelector('[data-err]').textContent = tr(ex.message);
      }
    };
  }

  el.onchange = (e) => {
    if (e.target.id === 'imp-post') {
      imp.post = e.target.value;
      imp.parent = '';
      draw();
    }
    if (e.target.id === 'imp-parent') {
      imp.parent = e.target.value;
      draw();
    }
    if (e.target.id === 'imp-range') imp.defaultRange = Number(e.target.value) || 20;
    if (e.target.id === 'file' && e.target.files[0]) upload(e.target.files[0]);
  };
  el.ondragover = (e) => e.target.closest('#dropzone') && e.preventDefault();
  el.ondrop = (e) => {
    if (!e.target.closest('#dropzone')) return;
    e.preventDefault();
    if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]);
  };
  el.onclick = async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'template') download(`team/template?post=${imp.post}`, `team-${imp.post}-template.xlsx`).catch((ex) => toast(tr(ex.message), 'bad'));
    if (act === 'one') {
      if (POSTS[imp.post].parent && !imp.parent) return toast(t('Choose the parent officer first.'), 'bad');
      addOne();
    }
    if (act === 'restart') {
      imp = { ...imp, preview: null, payload: null, result: null };
      draw();
    }
    if (act === 'logins') {
      const url = URL.createObjectURL(new Blob([`﻿${loginsCsv(imp.result.logins)}`], { type: 'text/csv' }));
      Object.assign(document.createElement('a'), { href: url, download: `logins-${new Date().toISOString().slice(0, 10)}.csv` }).click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }
    if (act === 'commit') {
      const btn = e.target.closest('button');
      btn.disabled = true;
      try {
        imp.result = await api('team/commit', { method: 'POST', body: { ...imp.payload, autoDepute: Boolean(el.querySelector('#auto-depute')?.checked) } });
        imp.preview = null;
        toast(added(imp.result.logins.length));
        draw();
      } catch (ex) {
        toast(tr(ex.message), 'bad');
        btn.disabled = false;
      }
    }
  };
}

export async function render(el, q, alive) {
  if (q.get('view') === 'import') {
    if (q.get('post') || q.get('parent')) imp = { ...imp, preview: null, payload: null, result: null };
    return renderImport(el, q, alive);
  }
  return renderTree(el);
}
