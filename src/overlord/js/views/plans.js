import { api } from '../api.js';
import { esc, icon, num, toast, emptyState } from '../../../admin/js/ui.js';
import { route } from '../main.js';
import { planBadge } from './common.js';

export async function render(el) {
  const { plans, features, matrix, companies } = await api('plans');
  el.innerHTML = `
    <div class="page-head">
      <div><h1>Plans &amp; features</h1><p>What each plan includes. Changes apply at once to every company on that plan — no update or restart needed.</p></div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="card-head"><div><h2>Plan matrix</h2><p>Tick what each plan includes, set its officer limit, then save that plan.</p></div></div>
      <div class="table-wrap matrix-wrap"><table class="data matrix">
        <thead><tr><th>Feature</th>${plans.map((p) => `<th>${planBadge(p.code)}</th>`).join('')}</tr></thead>
        <tbody>
          ${features.map((f) => `<tr><td><div class="cell-main">${esc(f.label)}</div><div class="cell-sub">${esc(f.detail)}</div></td>
            ${plans.map((p) => `<td><label class="toggle" title="${esc(f.label)} on ${esc(p.label)}"><input type="checkbox" data-plan="${p.code}" data-feature="${f.key}" ${matrix[p.code][f.key] ? 'checked' : ''}><i></i></label></td>`).join('')}</tr>`).join('')}
          <tr><td><div class="cell-main">Field officer limit</div><div class="cell-sub">Active officers per company. Blank = unlimited.</div></td>
            ${plans.map((p) => `<td><input class="input" style="max-width:110px;margin:auto;text-align:center" inputmode="numeric" data-limit="${p.code}" value="${p.maxOfficers ?? ''}" placeholder="Unlimited" aria-label="${esc(p.label)} officer limit"></td>`).join('')}</tr>
          <tr><td></td>${plans.map((p) => `<td><button class="btn sm primary" data-save="${p.code}">Save ${esc(p.label)}</button></td>`).join('')}</tr>
        </tbody>
      </table></div>
    </div>
    <div class="card">
      <div class="card-head"><div><h2>Per-company overrides</h2><p>Force one feature on or off for a single company. Overrides survive plan changes; “Plan” removes one.</p></div></div>
      ${companies.length ? `<div class="table-wrap"><table class="data responsive">
        <thead><tr><th>Company</th><th>Plan</th>${features.map((f) => `<th>${esc(f.label)}</th>`).join('')}</tr></thead>
        <tbody>${companies.map((c) => `<tr>
          <td class="primary"><a href="#/companies/${c.id}" class="cell-main">${esc(c.name)}</a><div class="cell-sub">${esc(c.code)}</div></td>
          <td data-label="Plan">${planBadge(c.plan)}</td>
          ${features.map((f) => {
            const o = c.overrides[f.key];
            const plan = matrix[c.plan][f.key];
            const btn = (val, label) => `<button type="button" class="${(o === undefined ? val === null : o === val) ? 'on' : ''}" data-company="${c.id}" data-feature="${f.key}" data-value="${val}">${label}</button>`;
            return `<td data-label="${esc(f.label)}"><span class="tri" role="group" aria-label="${esc(f.label)} for ${esc(c.name)}">
              ${btn(null, `Plan (${plan ? 'on' : 'off'})`)}${btn(true, 'On')}${btn(false, 'Off')}</span></td>`;
          }).join('')}
        </tr>`).join('')}</tbody></table></div>` : emptyState('No companies', '', 'building')}
    </div>`;

  el.onclick = async (e) => {
    const save = e.target.closest('[data-save]');
    if (save) {
      const plan = save.dataset.save;
      const feats = Object.fromEntries([...el.querySelectorAll(`input[data-plan="${plan}"]`)].map((i) => [i.dataset.feature, i.checked]));
      const raw = el.querySelector(`[data-limit="${plan}"]`).value.trim();
      try {
        await api(`plans/${plan}`, { method: 'PUT', body: { features: feats, maxOfficers: raw === '' ? null : Number(raw) } });
        toast(`${plan[0].toUpperCase()}${plan.slice(1)} plan saved`);
        route();
      } catch (err) {
        toast(err.message, 'bad');
      }
      return;
    }
    const tri = e.target.closest('[data-company]');
    if (tri) {
      const value = tri.dataset.value === 'null' ? null : tri.dataset.value === 'true';
      try {
        await api(`companies/${tri.dataset.company}/overrides`, { method: 'PUT', body: { feature: tri.dataset.feature, enabled: value } });
        toast('Override saved');
        route();
      } catch (err) {
        toast(err.message, 'bad');
      }
    }
  };
}
