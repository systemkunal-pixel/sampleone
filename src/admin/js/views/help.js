import { CATEGORIES, ROLES, TOPICS, topicsFor, topicById, topicHtml } from '../../../help/content.js';
import { esc, icon, emptyState } from '../ui.js';
import { setQuery } from '../main.js';

const AUDIENCES = [['', 'All roles'], ['admin', 'Admins'], ['supervisor', 'Supervisors'], ['officer', 'Field officers']];

function audienceBadges(t) {
  return t.audience.map((r) => `<span class="badge">${esc(ROLES[r])}</span>`).join(' ');
}

/** Prints every topic in the list, fully expanded, as a training handout. */
function printGuide(list, roleLabel) {
  const area = document.createElement('div');
  area.id = 'print-area';
  area.innerHTML = `
    <h1>LoanDesk — ${esc(roleLabel)} guide</h1>
    <p class="muted">Printed ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</p>
    ${CATEGORIES.map((c) => {
      const items = list.filter((t) => t.category === c.id);
      return items.length ? `<h2 class="print-cat">${esc(c.label)}</h2>${items.map((t) => `
        <section class="help-article print-topic"><h3>${esc(t.title)}</h3><p class="muted">${esc(t.summary)}</p>${topicHtml(t)}</section>`).join('')}` : '';
    }).join('')}`;
  document.body.append(area);
  document.body.classList.add('printing');
  const done = () => {
    document.body.classList.remove('printing');
    area.remove();
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  window.print();
  setTimeout(() => document.body.contains(area) && done(), 60000);
}

export async function render(el, q) {
  const role = q.get('role') || '';
  const text = q.get('q') || '';
  const list = topicsFor(role || null, text);
  const current = topicById(q.get('topic') || '') || (text ? list[0] : topicById(role === 'officer' ? 'welcome' : role === 'supervisor' ? 'verify-deposit' : 'admin-first-day'));
  const roleLabel = AUDIENCES.find(([r]) => r === role)[1];

  el.innerHTML = `
    <div class="page-head">
      <div><h1>Help &amp; guides</h1><p>The user manual: how-to guides, daily routines, a rollout plan, troubleshooting and a glossary — for every role.</p></div>
      <div class="page-actions">
        <button class="btn" data-act="print" title="Print or save as PDF - for training handouts">${icon('file')} Print guide${role ? ` for ${esc(roleLabel.toLowerCase())}` : ' (all roles)'}</button>
      </div>
    </div>
    <form class="toolbar" id="filters" role="search">
      <label class="search"><span class="sr-only">Search help</span>${icon('search')}<input class="input" name="q" type="search" placeholder="Search, e.g. import, PIN, deposit" value="${esc(text)}"></label>
      <div class="seg" role="tablist" aria-label="Show topics for">
        ${AUDIENCES.map(([r, label]) => `<button type="button" class="seg-btn ${r === role ? 'active' : ''}" data-role="${r}" role="tab" aria-selected="${r === role}">${label}</button>`).join('')}
      </div>
    </form>
    <div class="help-layout ${current ? 'has-topic' : ''}">
      <nav class="card help-index" aria-label="Help topics">
        ${list.length ? CATEGORIES.map((c) => {
          const items = list.filter((t) => t.category === c.id);
          if (!items.length) return '';
          return `<div class="help-cat">${esc(c.label)}</div>${items.map((t) => `
            <a href="#/help?${new URLSearchParams({ ...(role ? { role } : {}), ...(text ? { q: text } : {}), topic: t.id })}"
               class="help-link ${current?.id === t.id ? 'active' : ''}">${esc(t.title)}</a>`).join('')}`;
        }).join('') : emptyState('Nothing found', 'Try another word.', 'search')}
      </nav>
      <article class="card help-content">
        ${current ? `
          <div class="card-head"><div><h2>${esc(current.title)}</h2><p>${esc(current.summary)}</p></div>
            <div class="help-for">${audienceBadges(current)}</div></div>
          <div class="card-body help-article">${topicHtml(current)}</div>`
        : emptyState('Choose a topic', 'Pick a guide from the list.', 'file')}
      </article>
    </div>
    <p class="muted small">${TOPICS.length} topics. Field officers and supervisors see their guides in the phone app under <b>?</b> or Settings → Help.</p>`;

  const form = el.querySelector('#filters');
  let t;
  el.oninput = (e) => {
    if (e.target.name !== 'q') return;
    clearTimeout(t);
    t = setTimeout(() => {
      const pos = e.target.selectionStart;
      setQuery({ role, q: e.target.value }, { replace: true });
      setTimeout(() => {
        const input = el.querySelector('input[name=q]');
        input?.focus();
        input?.setSelectionRange(pos, pos);
      }, 60);
    }, 250);
  };
  el.onsubmit = (e) => e.preventDefault();
  el.onclick = (e) => {
    const r = e.target.closest('[data-role]');
    if (r) return setQuery({ role: r.dataset.role, q: form.q.value });
    if (e.target.closest('[data-act=print]')) printGuide(list, roleLabel === 'All roles' ? 'Complete' : roleLabel.replace(/s$/, ''));
    if (e.target.closest('.help-link') && window.innerWidth < 1024) setTimeout(() => el.querySelector('.help-content')?.scrollIntoView({ behavior: 'smooth' }), 80);
  };
}
